"""Tofino target adapter. Native BF-RT protocol and metadata stay behind this API."""
from copy import deepcopy

import grpc

from ..managers.ResourceManager import integer
from .bfrt_client import BfRtClient, BfRtError, validate_bundle_scope
from .bfrt_proto import bfruntime_pb2 as pb
from .bfrt_resources import BfRtResources
from .bfrt_tables import BfRtTableEntry, table_key


def unsupported(message):
    raise BfRtError(grpc.StatusCode.UNIMPLEMENTED, message)


class TofinoTarget:
    target = "tofino"

    def __init__(self, id, config):
        self.id, self.config, self.db_id = id, config, -1
        self.connected = False
        self.state_id = None
        self.p4_helper = None
        self.tables = None
        self.program_manifest = None
        self.bundle = None
        self._managers = {}
        options = config.get("target_options") or {}
        self.read_only = options.get("read_only", False)
        self.client = BfRtClient(config["address"], device_id=options.get("runtime_device_id", 0),
                                client_id=options.get("client_id", 0), pipe_id=options.get("pipe_id", 0), read_only=self.read_only)
        self.resources = BfRtResources(self)
        self.p4runtime_api_version = None
        self.register_access = {"mode": "native", "source": "bfrt", "status": "supported", "available": True,
                                "read": True, "write": not self.read_only, "max_bitwidth": None, "structured": True}

    @property
    def scope(self):
        return {"pipe_id": self.client.pipe_id, "aggregation": "none", "runtime_device_id": self.client.device_id, "program_pipe_ids": list(self.client.program_pipes), "read_only": self.read_only}

    def connect(self):
        try:
            self.client.connect()
            self.connected = True
            try:
                self.p4_helper = self.client.discover((self.config.get("target_options") or {}).get("program_name"))
                self.tables = self
            except RuntimeError as error:
                if "No BF Runtime program is loaded" not in str(error):
                    raise
        except Exception:
            self.shutdown()
            raise

    def shutdown(self):
        try:
            self.client.close()
        finally:
            self.connected = False

    def require_initialized(self):
        if not self.connected or self.p4_helper is None:
            raise RuntimeError("Switch is not connected and initialized")
        if not self.read_only and self.client.stream_error:
            raise RuntimeError("BF Runtime stream disconnected: " + str(self.client.stream_error))

    def ensure_writable(self):
        if self.read_only:
            raise BfRtError(grpc.StatusCode.PERMISSION_DENIED, "This BF Runtime connection is read only")

    def initialize_bundle(self, bundle, keep_entries=False):
        self.ensure_writable()
        if not self.connected:
            raise RuntimeError("Switch is not connected")
        if keep_entries:
            raise ValueError("Keeping entries across a Tofino pipeline replacement is not supported")
        if bundle.get("target") != self.target:
            raise ValueError("Program bundle target does not match switch target")
        validate_bundle_scope(bundle, self.client.pipe_id)
        # A failed warm reload may already have replaced the target program;
        # never continue presenting the previous program's metadata as active.
        self.p4_helper, self.tables = None, None
        self.bundle, self.program_manifest = None, None
        self.p4_helper = self.client.initialize_bundle(bundle)
        self.program_manifest = bundle.get("manifest_path") or bundle.get("program_manifest")
        self.tables, self.bundle = self, deepcopy(bundle)
        self._managers = {}
        self.config.setdefault("target_options", {})["program_name"] = bundle["program_name"]

    def initialize(self, *_args, **_kwargs):
        self.ensure_writable()
        raise ValueError("Tofino initialization requires a native program bundle")

    def capabilities(self):
        from .bfrt_fixed import has_fields
        supported = {name: {"read": True, "write": True, "source": "bfrt"}
                     for name in ("tables", "registers", "counters", "direct_counters", "meters", "direct_meters")}
        supported["direct_counters"].update(default_reset=False, reset_scope="non_default_entries", reason="The native model driver does not safely support default-entry counter resets")
        supported["pipeline"] = {"read": True, "write": True, "keep_entries": False}
        supported["meters"]["reset"] = False
        supported["direct_meters"]["reset"] = False
        supported.update({"digests": {"read": True, "write": False, "events": True, "listen": True, "ack": True, "ack_source": "server", "client_ack": False, "configure": False,
                          "reason": "BF Runtime learn notifications have no P4Runtime timeout configuration"},
                          "mirrors": {"read": False, "write": False, "reason": "Mirror mapping requires supported fixed-function metadata"},
                          "multicast": {"read": False, "write": False, "reason": "BF Runtime PRE nodes and groups require native resource management"},
                          "queues": {"read": False, "write": False, "reason": "Tofino traffic-manager queue units differ from BMv2 queue controls"}})
        if has_fields(self.p4_helper, "$mirror.cfg", {"$session_enable", "$direction", "$ucast_egress_port", "$ucast_egress_port_valid", "$ingress_cos", "$max_pkt_len"}):
            supported["mirrors"] = {"read": True, "write": True, "source": "bfrt", "max_replicas": 1,
                                    "instance": 0, "directions": ["INGRESS", "EGRESS", "BOTH"]}
        if (has_fields(self.p4_helper, "$pre.mgid", {"$MULTICAST_NODE_ID", "$MULTICAST_NODE_L1_XID_VALID", "$MULTICAST_NODE_L1_XID", "$MULTICAST_ECMP_ID", "$MULTICAST_ECMP_L1_XID_VALID", "$MULTICAST_ECMP_L1_XID"})
                and has_fields(self.p4_helper, "$pre.node", {"$MULTICAST_RID", "$MULTICAST_LAG_ID", "$DEV_PORT"})):
            supported["multicast"] = {"read": True, "write": True, "source": "bfrt", "node_ownership": "connection", "max_replicas": 256}
        if self.p4_helper:
            shape = next((table["name"] for table in self.p4_helper.tables if table["name"].endswith(".tm.port.sched_shaping")), None)
            config = next((table["name"] for table in self.p4_helper.tables if table["name"].endswith(".tm.port.sched_cfg")), None)
            if (has_fields(self.p4_helper, shape, {"unit", "max_rate", "max_burst_size"})
                    and has_fields(self.p4_helper, config, {"max_rate_enable"})):
                supported["queues"] = {"read": True, "write": True, "source": "bfrt", "scope": "port",
                                       "rate_pps": True, "burst_packets": True, "depth_packets": False,
                                       "all_ports": False, "rate_readback": "hardware_quantized"}
        if self.read_only:
            for capability in supported.values():
                capability["write"] = False
            supported["digests"].update(events=False, listen=False, ack=False, ack_source=None,
                                        reason="Read-only observers do not subscribe to digest notifications")
        return supported

    def get_loaded_config(self):
        helper = self.p4_helper
        result = {"target": self.target, "read_only": self.read_only, "target_options": self.config.get("target_options", {}),
                  "state_id": self.state_id, "p4_info_file": None, "bmv2_file": None,
                  "p4_info_helper": helper, "table_info": helper.get_table_info() if helper else None,
                  "program_bundle": self.bundle, "program_manifest": self.program_manifest, "program_name": self.client.program_name,
                  "scope": self.scope, "capabilities": self.capabilities(),
                  "register_access": dict(self.register_access), "p4runtime_api_version": None}
        for name in ("registers", "counters", "direct_counters", "meters", "direct_meters", "digests"):
            result[name] = getattr(helper, "get_" + name)() if helper else None
            if result[name]:
                for resource in result[name].values():
                    resource["scope"] = self.scope
        return result

    def as_json(self):
        return {"name": self.config["name"], "address": self.config["address"], "device_id": self.id,
                "proto_dump_file": self.config.get("proto_dump_file"), "db_id": self.db_id,
                "target": self.target, "read_only": self.read_only, "target_options": self.config.get("target_options", {}),
                "scope": self.scope, "capabilities": self.capabilities(),
                "register_access": dict(self.register_access), "p4runtime_api_version": None,
                "register_adapter_enabled": False, "register_thrift_host": None, "register_thrift_port": None}

    def create_table_entry(self, value, is_json=True):
        self.require_initialized()
        return BfRtTableEntry(self.p4_helper, value, is_json)

    def get_table_entries(self, name=None):
        self.require_initialized()
        tables = [self.p4_helper.table(name)] if name is not None else self.p4_helper.match_tables()
        result = {table["name"]: [] for table in tables}
        for table in tables:
            selector = pb.TableEntry(table_id=table["id"])
            selector.table_flags.from_hw = True
            selectors = [selector]
            # BF-RT's wildcard read omits the default entry. Request it
            # explicitly so default actions and their direct resources survive
            # editing and state snapshots.
            default = pb.TableEntry(table_id=table["id"], is_default_entry=True)
            default.table_flags.from_hw = True
            natives = self.client.read(selectors)
            if not any(entry.is_default_entry for entry in natives):
                try:
                    natives.extend(self.client.read([default]))
                except grpc.RpcError as error:
                    if error.code() != grpc.StatusCode.NOT_FOUND:
                        raise
            for native in natives:
                entry = BfRtTableEntry.from_native(self.p4_helper, native)
                result[table["name"]].append({"id": len(result[table["name"]]) + 1, "switch_entry": entry.as_json()})
        return result

    def write_table_entry(self, entry):
        self.ensure_writable()
        if not entry.entry.data.action_id and entry.table.get("action_specs"):
            raise ValueError("action_name is required")
        self.client.write([entry.entry], pb.Update.MODIFY if entry.entry.is_default_entry else pb.Update.INSERT)

    def delete_table_entry(self, entry):
        self.ensure_writable()
        native = pb.TableEntry(table_id=entry.entry.table_id, is_default_entry=entry.entry.is_default_entry)
        native.key.CopyFrom(entry.entry.key)
        self.client.write([native], pb.Update.DELETE)

    def update_table_entry(self, old, new):
        self.ensure_writable()
        selector = pb.TableEntry(table_id=old.entry.table_id, is_default_entry=old.entry.is_default_entry)
        selector.key.CopyFrom(old.entry.key)
        originals = self.client.read([selector])
        # Preserve the current meter configuration when a table action/key
        # changes. Counter values remain untouched for action-only MODIFY.
        if originals:
            from .bfrt_metadata import fields
            meter_ids = {field["id"] for field in fields(old.table.get("data", [])) if field["name"].startswith("$METER_SPEC_")}
            changed = {field.field_id for field in new.entry.data.fields}
            new.entry.data.fields.extend(field for field in originals[0].data.fields if field.field_id in meter_ids - changed)
        if getattr(new, "deleted", False):
            self.delete_table_entry(old)
        elif old.entry == new.entry:
            return
        elif table_key(old.entry) == table_key(new.entry):
            self.client.write([new.entry], pb.Update.MODIFY)
        else:
            self.delete_table_entry(old)
            try:
                self.write_table_entry(new)
            except Exception as error:
                try:
                    self.client.write(originals or [old.entry], pb.Update.INSERT)
                except Exception as restore_error:
                    raise RuntimeError(f"{error}; restoring original entry also failed: {restore_error}") from error
                raise

    table_entry_key = staticmethod(table_key)
    def get_counter_values(self, counter_id=None, index=None): return self.resources.counters(counter_id, index)
    def get_direct_counter_values(self, table_id=None): return self.resources.direct_counters(table_id)
    def reset_counter(self, counter_id, index=None): return self.resources.reset(counter_id, index)
    def reset_direct_counter(self, table_id, table_entry=None): return self.resources.reset_direct(table_id, table_entry)

    def manager(self, kind):
        self.require_initialized()
        if kind not in self._managers:
            from .bfrt_fixed import BfRtMirrors, BfRtMulticast, BfRtPortQueues
            capability = self.capabilities().get(kind, {})
            if kind == "digests":
                manager = BfRtDigests(self)
            elif kind == "queues":
                manager = BfRtPortQueues(self) if capability.get("read") else BfRtQueues(self)
            elif not capability.get("read"):
                unsupported(capability.get("reason", "Resource is unavailable on this target"))
            elif kind == "mirrors":
                manager = BfRtMirrors(self)
            elif kind == "multicast":
                manager = BfRtMulticast(self)
            else:
                raise ValueError("Unknown resource manager: " + kind)
            self._managers[kind] = manager
        return self._managers[kind]


class BfRtDigests:
    def __init__(self, switch): self.switch = switch
    def identifier(self, value):
        value = integer(value, "digest_id", minimum=1, maximum=(1 << 32) - 1)
        if not any(learn["id"] == value for learn in self.switch.p4_helper.learns):
            raise ValueError("Unknown digest ID")
        return value
    def read(self, digest_id=None):
        self.switch.require_initialized()
        values = self.switch.p4_helper.get_digests().values()
        if digest_id is not None:
            wanted = self.identifier(digest_id)
            values = [value for value in values if value["id"] == wanted]
        return {"entries": [{"digest_id": value["id"], "config": None, "enabled": None if self.switch.read_only else True} for value in values],
                "configuration_available": False, "read_only": self.switch.read_only, "scope": self.switch.scope}
    def write(self, data, update_type):
        self.switch.ensure_writable()
        unsupported(self.switch.capabilities()["digests"]["reason"])
    def events(self, digest_id=None, after=0, limit=50):
        self.switch.require_initialized()
        if self.switch.read_only:
            unsupported("Read-only BF Runtime observers do not subscribe to digest notifications")
        return self.switch.client.digest_events(self.identifier(digest_id) if digest_id is not None else None,
                integer(after, "after"), integer(limit, "limit", minimum=1, maximum=256))
    def clear(self, digest_id=None):
        self.switch.ensure_writable()
        self.switch.client.clear_digest_events(digest_id)


class BfRtQueues:
    def __init__(self, switch): self.switch = switch
    def selector(self, data): return data.get("port")
    def snapshot(self, port=None, discover=True):
        return {"configured": False, "write_available": False, "readback_available": False,
                "priority_selection_available": False, "state": "unsupported", "last_applied": [],
                "configuration": {"source": "bfrt", "defaults": {}, "ports": []},
                "port_discovery": {"status": "unsupported", "error": None}, "limits": {},
                "message": self.switch.capabilities()["queues"]["reason"]}
    def write(self, data):
        self.switch.ensure_writable()
        unsupported(self.switch.capabilities()["queues"]["reason"])
