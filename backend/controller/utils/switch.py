# Copyright 2019 Belma Turkovic
# TU Delft Embedded and Networked Systems Group.
# NOTICE: THIS FILE IS BASED ON https://github.com/p4lang/tutorials/tree/master/exercises/p4runtime, BUT WAS MODIFIED UNDER COMPLIANCE
# WITH THE APACHE 2.0 LICENCE FROM THE ORIGINAL WORK. THE FOLLOWING IS THE COPYRIGHT OF THE ORIGINAL DOCUMENT:
#
# Copyright 2017-present Open Networking Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
from queue import Queue, Empty, Full
from abc import abstractmethod
from collections import deque
from datetime import datetime, timezone
import logging
import threading
import grpc
from ..p4.v1 import p4runtime_pb2
from ..p4.v1 import p4runtime_pb2_grpc
from ..p4.tmp import p4config_pb2
import time

import ast

MSG_LOG_MAX_LEN = 1024
DIGEST_MAX_EVENTS = 256
DIGEST_MAX_BYTES = 4 * 1024 * 1024
DIGEST_MAX_LIST_BYTES = 256 * 1024
DIGEST_MAX_LIST_ITEMS = 256

# List of all active connections
connections = []


def ShutdownAllSwitchConnections():
    for c in list(connections):
        c.shutdown()


class SwitchConnection(object):
    def __init__(
        self, name=None, address="127.0.0.1:50051", device_id=0, proto_dump_file=None
    ):
        self.name = name
        self.address = address
        self.device_id = device_id
        self.p4info = None
        self.channel = grpc.insecure_channel(self.address)
        if proto_dump_file is not None:
            interceptor = GrpcRequestLogger(proto_dump_file)
            self.channel = grpc.intercept_channel(self.channel, interceptor)
        self.client_stub = p4runtime_pb2_grpc.P4RuntimeStub(self.channel)
        # create requests queue
        self.requests_stream = IterableQueue(maxsize=256)
        self._init_stream_state()
        # get response via requests queue
        self.stream_msg_resp = self.client_stub.StreamChannel(
            iter(self.requests_stream)
        )
        self.proto_dump_file = proto_dump_file
        connections.append(self)
        self._stream_thread = threading.Thread(target=self._consume_stream,
            name=f'p4runtime-stream-{self.device_id}', daemon=True)
        self._stream_thread.start()

    def _init_stream_state(self):
        self._closed = threading.Event()
        self._event_lock = threading.RLock()
        self._arbitration_lock = threading.Lock()
        self._arbitration_updates = Queue(maxsize=16)
        self._digest_events = deque()
        self._digest_event_bytes = 0
        self._digest_sequence = 0
        self._digest_dropped = 0
        self._stream_primary = False
        self._stream_active = True
        self._stream_error = None

    def _send_stream(self, request):
        if self._closed.is_set():
            raise RuntimeError('P4Runtime stream is closed')
        try:
            self.requests_stream.put_nowait(request)
        except Full as error:
            raise RuntimeError('P4Runtime stream request queue is full') from error

    def _consume_stream(self):
        """This is the only response iterator consumer for the connection."""
        try:
            for response in self.stream_msg_resp:
                if self._closed.is_set():
                    break
                kind = response.WhichOneof('update')
                if kind == 'arbitration':
                    if response.arbitration.device_id != self.device_id:
                        continue
                    with self._event_lock:
                        self._stream_primary = response.arbitration.status.code == 0
                        self._stream_error = (None if self._stream_primary else
                            (response.arbitration.status.message or 'Controller is not primary')[:1024])
                    try:
                        self._arbitration_updates.put_nowait(response)
                    except Full:
                        try:
                            self._arbitration_updates.get_nowait()
                        except Empty:
                            pass
                        self._arbitration_updates.put_nowait(response)
                elif kind == 'digest':
                    self._capture_digest(response.digest)
                elif kind == 'error':
                    with self._event_lock:
                        self._stream_error = (response.error.message or
                            f'P4Runtime stream error {response.error.canonical_code}')[:1024]
                        if response.error.canonical_code in (7, 16):
                            self._stream_primary = False
        except Exception as error:
            if not self._closed.is_set():
                with self._event_lock:
                    self._stream_error = str(error)[:1024] or 'P4Runtime stream failed'
                logging.warning('P4Runtime stream %s failed: %s', self.name, error)
        finally:
            with self._event_lock:
                self._stream_active = False
                self._stream_primary = False
                if not self._closed.is_set() and self._stream_error is None:
                    self._stream_error = 'P4Runtime stream closed'

    def _capture_digest(self, digest):
        """Capture the entire bounded list before placing its ACK on the stream."""
        with self._event_lock:
            if self._closed.is_set():
                return
            if not self._stream_primary:
                self._digest_dropped += 1
                self._stream_error = 'Digest received while controller is not primary; not acknowledged'
                return
            size = digest.ByteSize()
            if size > DIGEST_MAX_LIST_BYTES or len(digest.data) > DIGEST_MAX_LIST_ITEMS:
                self._digest_dropped += 1
                self._stream_error = 'Digest list exceeds capture limits; not acknowledged'
                return
            payload = digest.SerializeToString()
            while self._digest_events and (len(self._digest_events) >= DIGEST_MAX_EVENTS or
                    self._digest_event_bytes + len(payload) > DIGEST_MAX_BYTES):
                self._digest_event_bytes -= len(self._digest_events.popleft()['payload'])
                self._digest_dropped += 1
            self._digest_sequence += 1
            self._digest_events.append({'sequence': str(self._digest_sequence),
                'digest_id': digest.digest_id, 'payload': payload,
                'received_at': datetime.now(timezone.utc).isoformat()})
            self._digest_event_bytes += len(payload)
            ack = p4runtime_pb2.StreamMessageRequest()
            ack.digest_ack.digest_id = digest.digest_id
            ack.digest_ack.list_id = digest.list_id
            try:
                self._send_stream(ack)
            except RuntimeError as error:
                self._stream_error = str(error) + '; captured digest was not acknowledged'

    def GetDigestEvents(self, digest_id=None, after=0, limit=50):
        with self._event_lock:
            matches = [event for event in self._digest_events
                       if int(event['sequence']) > after and (digest_id is None or event['digest_id'] == digest_id)]
            events = [dict(event) for event in matches[:limit]]
            # The cursor advances past irrelevant digest IDs, but never skips a
            # matching event omitted by pagination.
            cursor = events[-1]['sequence'] if len(matches) > limit else str(self._digest_sequence)
            return {'events': events, 'next_sequence': cursor, 'dropped': self._digest_dropped,
                    'stream': {'primary': self._stream_primary, 'active': self._stream_active,
                               'error': self._stream_error},
                    'limits': {'events': DIGEST_MAX_EVENTS, 'bytes': DIGEST_MAX_BYTES,
                               'list_bytes': DIGEST_MAX_LIST_BYTES, 'list_items': DIGEST_MAX_LIST_ITEMS}}

    def ClearDigestEvents(self, digest_id=None):
        with self._event_lock:
            self._digest_events = deque(event for event in self._digest_events
                if digest_id is not None and event['digest_id'] != digest_id)
            self._digest_event_bytes = sum(len(event['payload']) for event in self._digest_events)

    @abstractmethod
    def buildDeviceConfig(self, **kwargs):
        return p4config_pb2.P4DeviceConfig()

    def shutdown(self):
        self._closed.set()
        self.requests_stream.close()
        try:
            self.stream_msg_resp.cancel()
        finally:
            self.channel.close()
            thread = getattr(self, '_stream_thread', None)
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=2)
            with self._event_lock:
                self._stream_active = False
                self._stream_primary = False
                self.ClearDigestEvents()
            if self in connections:
                connections.remove(self)

    def MasterArbitrationUpdate(self, dry_run=False, **kwargs):
        request = p4runtime_pb2.StreamMessageRequest()
        request.arbitration.device_id = self.device_id
        request.arbitration.election_id.high = 0
        request.arbitration.election_id.low = 1

        if dry_run:
            print("P4Runtime MasterArbitrationUpdate: ", request)
        else:
            with self._arbitration_lock:
                while True:
                    try:
                        self._arbitration_updates.get_nowait()
                    except Empty:
                        break
                self._send_stream(request)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        return self._arbitration_updates.get(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                    except Empty:
                        if self._closed.is_set() or not self._stream_active:
                            raise RuntimeError(self._stream_error or 'P4Runtime stream closed during arbitration')
                self.stream_msg_resp.cancel()
                raise TimeoutError('Timed out waiting for P4Runtime arbitration')

    def SetForwardingPipelineConfig(self, p4info, dry_run=False, keep_entries=False, **kwargs):
        device_config = self.buildDeviceConfig(**kwargs)
        if keep_entries and not dry_run:
            read = p4runtime_pb2.GetForwardingPipelineConfigRequest(device_id=self.device_id)
            current = self.client_stub.GetForwardingPipelineConfig(read, timeout=30)
            previous_device = p4config_pb2.P4DeviceConfig()
            previous_device.ParseFromString(current.config.p4_device_config)
            if current.config.p4info == p4info and previous_device.device_data == device_config.device_data:
                return  # Identical program is already active; preserve all state.
            raise ValueError("BMv2 cannot safely preserve all state while replacing a different pipeline. "
                             "Disable Keep existing entries to explicitly reset it.")
        request = p4runtime_pb2.SetForwardingPipelineConfigRequest()
        request.election_id.low = 1
        request.device_id = self.device_id
        config = request.config

        config.p4info.CopyFrom(p4info)
        config.p4_device_config = device_config.SerializeToString()
        
        if keep_entries:
            request.action = (
                p4runtime_pb2.SetForwardingPipelineConfigRequest.RECONCILE_AND_COMMIT
            )
        else:
            request.action = (
                p4runtime_pb2.SetForwardingPipelineConfigRequest.VERIFY_AND_COMMIT
            )
        if dry_run:
            print("P4Runtime SetForwardingPipelineConfig:", request)
        else:
            self.client_stub.SetForwardingPipelineConfig(request, timeout=30)
            self.p4info = p4info
            if hasattr(self, '_event_lock'):
                self.ClearDigestEvents()

    def ReadEntities(self, entities):
        request = p4runtime_pb2.ReadRequest(device_id=self.device_id)
        request.entities.extend(entities)
        return self.client_stub.Read(request, timeout=15)

    def ModifyEntities(self, entities):
        request = p4runtime_pb2.WriteRequest(device_id=self.device_id)
        request.election_id.low = 1
        for entity in entities:
            update = request.updates.add(type=p4runtime_pb2.Update.MODIFY)
            update.entity.CopyFrom(entity)
        self.client_stub.Write(request, timeout=15)

    def WriteEntity(self, entity, update_type):
        request = p4runtime_pb2.WriteRequest(device_id=self.device_id)
        request.election_id.low = 1
        request.updates.add(type=update_type).entity.CopyFrom(entity)
        return self.client_stub.Write(request, timeout=15)

    def GetForwardingPipelineConfig(self):
        try:
            request = p4runtime_pb2.GetForwardingPipelineConfigRequest()
            request.device_id = self.device_id
            response = self.client_stub.GetForwardingPipelineConfig(request, timeout=30)
            p4info = response.config.p4info
            device_config = response.config.p4_device_config
            return p4info if p4info.ByteSize() else None
        except grpc.RpcError as error:
            if error.code() in (grpc.StatusCode.NOT_FOUND, grpc.StatusCode.FAILED_PRECONDITION):
                return None
            raise

    def WriteTableEntry(self, table_entry, dry_run=False):
        request = p4runtime_pb2.WriteRequest()
        request.device_id = self.device_id
        request.election_id.low = 1
        update = request.updates.add()
        if table_entry.is_default_action:
            update.type = p4runtime_pb2.Update.MODIFY
        else:
            update.type = p4runtime_pb2.Update.INSERT
        update.entity.table_entry.CopyFrom(table_entry)
        if dry_run:
            print("P4Runtime Write:", request)
        else:
            self.client_stub.Write(request, timeout=15)

    def ModifyTableEntry(self, table_entry, dry_run=False):
        request = p4runtime_pb2.WriteRequest()
        request.device_id = self.device_id
        request.election_id.low = 1
        update = request.updates.add()
        update.type = p4runtime_pb2.Update.MODIFY
        update.entity.table_entry.CopyFrom(table_entry)
        if dry_run:
            print("P4Runtime Write:", request)
        else:
            self.client_stub.Write(request, timeout=15)

    def DeleteTableEntry(self, table_entry, dry_run=False):
        request = p4runtime_pb2.WriteRequest()
        request.device_id = self.device_id
        request.election_id.low = 1
        update = request.updates.add()
        update.type = p4runtime_pb2.Update.DELETE
        update.entity.table_entry.CopyFrom(table_entry)
        if dry_run:
            print("P4Runtime Write:", request)
        else:
            self.client_stub.Write(request, timeout=15)

    def ReadTableEntries(self, table_id=None, read_default = False, dry_run=False):
        request = p4runtime_pb2.ReadRequest()
        request.device_id = self.device_id
        entity = request.entities.add()
        table_entry = entity.table_entry
        if table_id is not None:
            table_entry.table_id = table_id
        else:
            table_entry.table_id = 0
        table_entry.is_default_action = read_default    
        if dry_run:
            print("P4Runtime Read:", request)
        else:
            for response in self.client_stub.Read(request, timeout=15):
                yield response

    def ReadCounters(self, counter_id=None, index=None, dry_run=False):
        request = p4runtime_pb2.ReadRequest()
        request.device_id = self.device_id
        entity = request.entities.add()
        counter_entry = entity.counter_entry
        if counter_id is not None:
            counter_entry.counter_id = counter_id
        else:
            counter_entry.counter_id = 0
        if index is not None:
            counter_entry.index.index = index
        if dry_run:
            print("P4Runtime Read:", request)
        else:
            for response in self.client_stub.Read(request, timeout=15):
                yield response
                
    def ReadDirectCounters(self, table_id=None, dry_run=False):
        request = p4runtime_pb2.ReadRequest()
        request.device_id = self.device_id
        entity = request.entities.add()
        counter_entry = entity.direct_counter_entry
        if table_id is not None:
            counter_entry.table_entry.table_id = table_id
        else:
            counter_entry.table_entry.table_id = 0
        if dry_run:
            print("P4Runtime Read:", request)
        else:
            for response in self.client_stub.Read(request, timeout=15):
                yield response                

    def WritePREEntry(self, pre_entry, dry_run=False):
        request = p4runtime_pb2.WriteRequest()
        request.device_id = self.device_id
        request.election_id.low = 1
        update = request.updates.add()
        update.type = p4runtime_pb2.Update.INSERT
        update.entity.packet_replication_engine_entry.CopyFrom(pre_entry)
        if dry_run:
            print("P4Runtime Write:", request)
        else:
            self.client_stub.Write(request, timeout=15)


class GrpcRequestLogger(
    grpc.UnaryUnaryClientInterceptor, grpc.UnaryStreamClientInterceptor
):
    """Implementation of a gRPC interceptor that logs request to a file"""

    def __init__(self, log_file):
        self.log_file = log_file
        with open(self.log_file, "w") as f:
            # Clear content if it exists.
            f.write("")

    def log_message(self, method_name, body):
        with open(self.log_file, "a") as f:
            ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            msg = str(body)
            f.write("\n[%s] %s\n---\n" % (ts, method_name))
            if len(msg) < MSG_LOG_MAX_LEN:
                f.write(str(body))
            else:
                f.write("Message too long (%d bytes)! Skipping log...\n" % len(msg))
            f.write("---\n")

    def intercept_unary_unary(self, continuation, client_call_details, request):
        self.log_message(client_call_details.method, request)
        return continuation(client_call_details, request)

    def intercept_unary_stream(self, continuation, client_call_details, request):
        self.log_message(client_call_details.method, request)
        return continuation(client_call_details, request)


class IterableQueue(Queue):
    _sentinel = object()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._queue_close_lock = threading.Lock()
        self._queue_closed = False

    def __iter__(self):
        return iter(self.get, self._sentinel)

    def close(self):
        with self._queue_close_lock:
            if self._queue_closed:
                return
            self._queue_closed = True
            while True:
                try:
                    self.put_nowait(self._sentinel)
                    return
                except Full:
                    try:
                        self.get_nowait()
                    except Empty:
                        pass
