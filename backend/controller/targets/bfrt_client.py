"""Small native BF Runtime transport with bounded calls and stream lifecycle."""
from collections import deque
from datetime import datetime, timezone
import json
from queue import Queue
from threading import Event, Lock, Thread
import time

import grpc

from .bfrt_proto import bfruntime_pb2 as pb, bfruntime_pb2_grpc
from .bfrt_metadata import BfRtMetadata, decode_fields, field_type


class BfRtError(grpc.RpcError):
    def __init__(self, code, message, errors=None):
        self._code = code
        self._message = message
        self.errors = errors or []
    def code(self): return self._code
    def details(self): return self._message
    def debug_error_string(self): return self._message
    def trailing_metadata(self): return ()
    def __str__(self): return self._message


def check_status(statuses):
    failed = [(index, item) for index, item in enumerate(statuses) if item.canonical_code]
    if failed:
        index, first = failed[0]
        code = next((code for code in grpc.StatusCode if code.value[0] == first.canonical_code), grpc.StatusCode.UNKNOWN)
        raise BfRtError(code, "; ".join(f"Entry {index}: {item.message}" for index, item in failed),
                       [{"index": index, "code": item.canonical_code, "message": item.message} for index, item in failed])


def native_error(error):
    from google.rpc import status_pb2
    from google.protobuf.message import DecodeError
    try:
        for key, value in error.trailing_metadata() or ():
            if key != "grpc-status-details-bin":
                continue
            status = status_pb2.Status.FromString(value)
            details = []
            for item in status.details:
                detail = pb.Error()
                if item.Unpack(detail):
                    details.append(detail)
            check_status(details)
    except DecodeError:
        pass
    raise error


def validate_bundle_scope(bundle, pipe_id):
    profiles = bundle.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("Tofino program bundle requires at least one pipeline profile")
    for profile in profiles:
        if (not isinstance(profile, dict) or profile.get("pipe_scope") != [pipe_id]
                or type(profile["pipe_scope"][0]) is not int):
            raise ValueError(f"Program profile pipe_scope must match the selected connection pipe [{pipe_id}]")


class BfRtClient:
    def __init__(self, address, device_id=0, client_id=0, pipe_id=0, timeout=15, read_only=False):
        if not isinstance(read_only, bool):
            raise ValueError("read_only must be a boolean")
        self.read_only = read_only
        self.address, self.device_id, self.client_id = address, device_id, client_id
        self.pipe_id, self.timeout = pipe_id, timeout
        self.channel = None
        self.stub = None
        self.stream = None
        self.requests = Queue()
        self.subscribed = Event()
        self.stream_error = None
        self.program_name = None
        self.metadata = None
        self.program_pipes = []
        self.entry_scopes = {}
        self.events = deque(maxlen=1000)
        self.sequence = 0
        self.dropped = 0
        self.event_bytes = 0
        self.event_lock = Lock()
        self.closed = False
        # Each stream reader belongs to one connection generation. A reader
        # from a replaced stream may finish late and must not touch the
        # state of the current connection.
        self.generation = 0
        # Guards closed, generation and stream_error together, so a reader's
        # generation check and its error report cannot interleave with a
        # reconnect.
        self.state_lock = Lock()

    def connect(self):
        self.channel = grpc.insecure_channel(self.address, options=[("grpc.max_receive_message_length", 128 * 1024 * 1024)])
        grpc.channel_ready_future(self.channel).result(timeout=self.timeout)
        self.stub = bfruntime_pb2_grpc.BfRuntimeStub(self.channel)
        if self.read_only:
            return
        with self.state_lock:
            self.generation += 1
            generation, requests, subscribed = self.generation, self.requests, self.subscribed
        self.stream = self.stub.StreamChannel(self._request_stream(requests))
        self.thread = Thread(target=self._receive, args=(self.stream, subscribed, generation),
                             name="unicorn-bfrt-stream", daemon=True)
        self.thread.start()
        request = pb.StreamMessageRequest(client_id=self.client_id)
        request.subscribe.device_id = self.device_id
        request.subscribe.notifications.enable_learn_notifications = True
        requests.put(request)
        if not subscribed.wait(self.timeout):
            raise RuntimeError("BF Runtime subscription timed out")
        if self.stream_error:
            raise self.stream_error

    def _request_stream(self, requests=None):
        requests = self.requests if requests is None else requests
        while True:
            request = requests.get()
            if request is None:
                return
            yield request

    def _receive(self, stream=None, subscribed=None, generation=None):
        stream = self.stream if stream is None else stream
        subscribed = self.subscribed if subscribed is None else subscribed
        generation = self.generation if generation is None else generation

        def report(error, replace=True):
            with self.state_lock:
                if self.closed or generation != self.generation:
                    return
                if replace or self.stream_error is None:
                    self.stream_error = error

        try:
            for response in stream:
                kind = response.WhichOneof("update")
                if kind == "subscribe":
                    if response.subscribe.status.code:
                        report(BfRtError(grpc.StatusCode.PERMISSION_DENIED, response.subscribe.status.message))
                    subscribed.set()
                elif kind == "digest":
                    digest = response.digest
                    with self.event_lock:
                        if generation != self.generation:
                            continue
                        self.sequence += 1
                        size = digest.ByteSize()
                        if len(digest.data) > 256 or size > 256 * 1024:
                            self.dropped += 1
                        else:
                            while self.events and (len(self.events) >= 1000 or self.event_bytes + size > 8 * 1024 * 1024):
                                self.event_bytes -= self.events.popleft()["size"]
                                self.dropped += 1
                            self.events.append({"sequence": self.sequence, "received_at": datetime.now(timezone.utc).isoformat(),
                                                "digest": digest, "size": size})
                            self.event_bytes += size
                    # Official BF-RT acknowledges learn messages in the server
                    # callback. Stream DigestAck is explicitly unimplemented
                    # and would terminate this connection if sent.
        except grpc.RpcError as error:
            report(error)
        finally:
            report(BfRtError(grpc.StatusCode.UNAVAILABLE, "BF Runtime stream ended"), replace=False)
            subscribed.set()

    def close(self):
        # Invalidate the running reader before any reconnect resets state.
        with self.state_lock:
            self.closed = True
            self.generation += 1
        self.requests.put(None)
        if self.stream is not None:
            self.stream.cancel()
        if self.channel is not None:
            self.channel.close()
        thread = getattr(self, "thread", None)
        if thread:
            thread.join(timeout=2)

    def discover(self, program_name=None):
        result = self.stub.GetForwardingPipelineConfig(pb.GetForwardingPipelineConfigRequest(
            device_id=self.device_id, client_id=self.client_id), timeout=self.timeout)
        programs = list(result.config)
        if program_name is not None:
            programs = [program for program in programs if program.p4_name == program_name]
        if len(programs) != 1:
            if not programs:
                raise RuntimeError("No BF Runtime program is loaded" if program_name is None else "BF Runtime program is not loaded: " + program_name)
            raise ValueError("Several BF Runtime programs are loaded; set target_options.program_name")
        program = programs[0]
        metadata = BfRtMetadata(program.bfruntime_info, result.non_p4_config.bfruntime_info)
        if not self.read_only:
            request = pb.SetForwardingPipelineConfigRequest(device_id=self.device_id, client_id=self.client_id,
                                                           action=pb.SetForwardingPipelineConfigRequest.BIND)
            request.config.add(p4_name=program.p4_name)
            self.stub.SetForwardingPipelineConfig(request, timeout=self.timeout)
        self.program_name, self.metadata = program.p4_name, metadata
        self.program_pipes = sorted({pipe for profile in program.profiles for pipe in profile.pipe_scope})
        self.entry_scopes = {}
        scoped_tables = [table for table in metadata.match_tables() if "EntryScope" in table.get("attributes", [])]
        if scoped_tables:
            request = pb.ReadRequest(target=self.target(), client_id=self.client_id, p4_name=self.program_name)
            for table in scoped_tables:
                attr = request.entities.add().table_attribute
                attr.table_id = table["id"]
                attr.entry_scope.SetInParent()
            for response in self.stub.Read(request, timeout=self.timeout):
                check_status(response.status)
                for entity in response.entities:
                    if entity.WhichOneof("entity") == "table_attribute" and entity.table_attribute.HasField("entry_scope"):
                        scope = entity.table_attribute.entry_scope.pipe_scope
                        self.entry_scopes[entity.table_attribute.table_id] = "single" if scope.WhichOneof("scope") == "predef" and scope.predef == pb.Mode.SINGLE else "all" if scope.WhichOneof("scope") == "predef" else "user_defined"
        return metadata

    def target(self):
        return pb.TargetDevice(device_id=self.device_id, pipe_id=self.pipe_id, direction=0xff, prsr_id=0xff)

    def read(self, entries):
        request = pb.ReadRequest(target=self.target(), client_id=self.client_id, p4_name=self.program_name)
        for entry in entries:
            copied = request.entities.add().table_entry
            copied.CopyFrom(entry)
            self._scope_entry(copied, write=False)
        rows = []
        try:
            for response in self.stub.Read(request, timeout=self.timeout):
                check_status(response.status)
                rows.extend(entity.table_entry for entity in response.entities if entity.WhichOneof("entity") == "table_entry")
        except grpc.RpcError as error:
            native_error(error)
        return rows

    def ensure_writable(self):
        if self.read_only:
            raise BfRtError(grpc.StatusCode.PERMISSION_DENIED, "This BF Runtime connection is read only")

    def write(self, entries, operation):
        self.ensure_writable()
        request = pb.WriteRequest(target=self.target(), client_id=self.client_id, p4_name=self.program_name)
        for entry in entries:
            copied = request.updates.add(type=operation).entity.table_entry
            copied.CopyFrom(entry)
            self._scope_entry(copied, write=True)
        try:
            check_status(self.stub.Write(request, timeout=self.timeout).status)
        except grpc.RpcError as error:
            native_error(error)

    def _scope_entry(self, entry, write):
        if self.read_only and not write:
            return
        if self.metadata is None:
            return
        table = self.metadata.table(entry.table_id)
        kind = table.get("table_type", "")
        symmetric = kind in ("Counter", "Meter") or kind.startswith("MatchAction") and self.entry_scopes.get(entry.table_id) != "single"
        if symmetric:
            if self.program_pipes != [self.pipe_id]:
                raise ValueError("Native table is symmetric across pipes " + str(self.program_pipes) +
                                 "; this connection selects pipe " + str(self.pipe_id) + ". Load a single-pipe program or configure the external table scope explicitly")
            # BF-RT requires ALL for symmetric tables. Its effective scope
            # remains exactly the single declared program pipe.
            entry.entry_tgt.CopyFrom(self.target())
            entry.entry_tgt.pipe_id = 0xffff

    def initialize_bundle(self, bundle):
        self.ensure_writable()
        validate_bundle_scope(bundle, self.pipe_id)
        from pathlib import Path
        request = pb.SetForwardingPipelineConfigRequest(device_id=self.device_id, client_id=self.client_id,
            action=pb.SetForwardingPipelineConfigRequest.VERIFY_AND_WARM_INIT_BEGIN_AND_END)
        config = request.config.add(p4_name=bundle["program_name"], bfruntime_info=Path(bundle["bfrt_json"]).read_bytes())
        # Read and validate the complete bundle before changing the target.
        BfRtMetadata(config.bfruntime_info)
        if not bundle.get("profiles"):
            raise ValueError("Tofino program bundle requires at least one pipeline profile")
        for profile in bundle["profiles"]:
            config.profiles.add(profile_name=profile["profile_name"], context=Path(profile["context"]).read_bytes(),
                                binary=Path(profile["binary"]).read_bytes(), pipe_scope=profile["pipe_scope"])
        self.stub.SetForwardingPipelineConfig(request, timeout=max(self.timeout, 60))
        # Replacing a program cancels every stream bound to a removed program
        # in the official BF-RT server. Its RPC may return before that stream
        # reader observes cancellation. Recreate the subscription before BIND.
        self.close()
        with self.state_lock:
            self.requests = Queue()
            self.subscribed = Event()
            self.stream_error = None
            self.closed = False
        with self.event_lock:
            self.events.clear()
            self.event_bytes = 0
        self.connect()
        return self.discover(bundle["program_name"])

    def digest_events(self, digest_id=None, after=0, limit=50):
        if self.read_only:
            raise BfRtError(grpc.StatusCode.UNIMPLEMENTED, "Read-only BF Runtime observers do not subscribe to digest notifications")
        with self.event_lock:
            snapshot = list(self.events)
            latest = self.sequence
        rows = []
        learns = {item["id"]: item for item in self.metadata.learns}
        for item in snapshot:
            digest = item["digest"]
            if item["sequence"] <= after or (digest_id is not None and digest.digest_id != digest_id):
                continue
            learn = learns.get(digest.digest_id)
            if learn is None:
                continue
            samples = []
            for data in digest.data:
                values = decode_fields(learn.get("fields", []), data.fields)
                typed = {}
                for field in learn.get("fields", []):
                    if field["name"] not in values:
                        continue
                    spec = field_type(field)
                    value = values[field["name"]]
                    if spec["kind"] == "bytes" or spec["kind"].startswith(("int", "uint")):
                        typed[field["name"]] = {"kind": "int" if spec["kind"].startswith("int") else "bit",
                                                "decimal": value, "hex": hex(int(value)), "bitwidth": spec.get("bitwidth", 32)}
                    else:
                        typed[field["name"]] = {"kind": spec["kind"], "value": value}
                samples.append({"kind": "struct", "name": learn["name"], "fields": typed})
            rows.append({"sequence": str(item["sequence"]), "digest_id": digest.digest_id,
                         "list_id": str(digest.list_id), "received_at": item["received_at"], "timestamp_ns": None,
                         "scope": {"pipe_id": digest.target.pipe_id, "aggregation": "none"}, "data": samples})
        selected = rows[:limit]
        return {"events": selected, "next_sequence": selected[-1]["sequence"] if len(rows) > limit else str(latest),
                "dropped": self.dropped, "buffer_limit": self.events.maxlen,
                "stream": {"active": not self.closed and self.stream_error is None, "primary": self.program_name is not None,
                           "error": self.stream_error.details() if self.stream_error else None}}

    def clear_digest_events(self, digest_id=None):
        self.ensure_writable()
        with self.event_lock:
            if digest_id is None:
                self.events.clear()
                self.event_bytes = 0
            else:
                self.events = deque((item for item in self.events if item["digest"].digest_id != digest_id), maxlen=1000)
                self.event_bytes = sum(item["size"] for item in self.events)
