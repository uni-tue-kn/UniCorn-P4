"""Fixed-function BF-RT mappings, enabled only by matching native metadata."""
from threading import RLock

import grpc

from ..managers.ResourceManager import integer
from .bfrt_client import BfRtError
from .bfrt_metadata import fields, encode_fields, decode_fields
from .bfrt_proto import bfruntime_pb2 as pb
from .bfrt_tables import encode_key, decode_key

# Existing HTTP update codes are stable independently of either wire protocol.
OPERATIONS = {1: pb.Update.INSERT, 2: pb.Update.MODIFY, 3: pb.Update.DELETE}


def unavailable(message):
    raise BfRtError(grpc.StatusCode.UNIMPLEMENTED, message)


class FixedTable:
    def __init__(self, switch, name):
        self.switch, self.table = switch, switch.p4_helper.table(name)
        self.definitions = fields(self.table.get("data", []))

    def entry(self, key=None, values=None, action=None):
        entry = pb.TableEntry(table_id=self.table["id"])
        if key is not None:
            entry.key.CopyFrom(encode_key(self.table, key))
        if values is not None:
            entry.data.fields.extend(encode_fields(self.definitions, values))
        if action:
            item = next((item for item in self.table.get("action_specs", []) if item["name"] == action), None)
            if item is None:
                unavailable("Required native action is absent: " + action)
            entry.data.action_id = item["id"]
        return entry

    def read(self, key=None):
        entry = self.entry(key)
        entry.table_flags.from_hw = True
        try:
            native = self.switch.client.read([entry])
        except grpc.RpcError as error:
            if key is not None and error.code() == grpc.StatusCode.NOT_FOUND:
                return []
            raise
        return [(decode_key(self.table, entry.key)[0], decode_fields(self.definitions, entry.data.fields), entry) for entry in native]

    def write(self, key, values, operation, action=None):
        self.switch.ensure_writable()
        self.switch.client.write([self.entry(key, values, action)], operation)


def has_fields(helper, name, required):
    table = helper.by_name.get(name) if helper else None
    return bool(table and set(required) <= {field["name"] for field in fields(table.get("data", []))})


class BfRtMirrors:
    def __init__(self, switch): self.native = FixedTable(switch, "$mirror.cfg")
    def read(self, session_id=None):
        rows = self.native.read({"$sid": integer(session_id, "session_id", minimum=1, maximum=65535)} if session_id is not None else None)
        result = []
        for key, values, entry in rows:
            normal = next((action["id"] for action in self.native.table.get("action_specs", []) if action["name"] == "$normal"), None)
            compatible = entry.data.action_id == normal and not values.get("$mcast_grp_a_valid") and not values.get("$mcast_grp_b_valid")
            result.append({"session_id": int(key["$sid"]),
                           "replicas": [{"egress_port": values["$ucast_egress_port"], "instance": 0}] if values.get("$ucast_egress_port_valid") else [],
                           "class_of_service": int(values.get("$ingress_cos", "0")),
                           "packet_length_bytes": int(values.get("$max_pkt_len", "0")),
                           "enabled": values.get("$session_enable", False), "direction": values.get("$direction"),
                           "editable": compatible, "native_fields": values})
        return {"entries": sorted(result, key=lambda row: row["session_id"])}

    def write(self, data, update_type):
        self.native.switch.ensure_writable()
        session_id = integer(data.get("session_id"), "session_id", minimum=1, maximum=min(self.native.table.get("size", 65536) - 1, 65535))
        operation = OPERATIONS[update_type]
        if operation == pb.Update.DELETE:
            self.native.write({"$sid": session_id}, None, operation)
            return
        replicas = data.get("replicas")
        if not isinstance(replicas, list) or len(replicas) != 1 or not isinstance(replicas[0], dict):
            raise ValueError("Tofino unicast mirror requires exactly one replica")
        replica = replicas[0]
        if integer(replica.get("instance", 0), "instance", maximum=65535) != 0:
            raise ValueError("Tofino unicast mirror supports instance zero")
        port = integer(replica.get("egress_port"), "egress_port", maximum=(1 << 32) - 1)
        direction = data.get("direction", "INGRESS")
        if direction not in ("INGRESS", "EGRESS", "BOTH"):
            raise ValueError("direction must be INGRESS, EGRESS or BOTH")
        if operation == pb.Update.MODIFY:
            existing = self.read(session_id)["entries"]
            if existing and not existing[0]["editable"]:
                raise ValueError("Existing native mirror uses multicast/coalescing fields; edit through its native control plane")
        enabled = data.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        values = {"$session_enable": enabled, "$direction": direction,
                  "$ucast_egress_port": port, "$ucast_egress_port_valid": True,
                  "$ingress_cos": integer(data.get("class_of_service", 0), "class_of_service", maximum=7),
                  "$max_pkt_len": integer(data.get("packet_length_bytes", 0) or 65535, "packet_length_bytes", maximum=65535)}
        self.native.write({"$sid": session_id}, values, operation, "$normal")


class BfRtMulticast:
    """Manage nodes created by this connection; never delete external nodes."""
    def __init__(self, switch):
        self.switch = switch
        self.groups, self.nodes = FixedTable(switch, "$pre.mgid"), FixedTable(switch, "$pre.node")
        self.owned_nodes = set()
        self.lock = RLock()

    def read(self, group_id=None):
        groups = self.groups.read({"$MGID": integer(group_id, "multicast_group_id", minimum=1, maximum=65535)} if group_id is not None else None)
        nodes = {int(key["$MULTICAST_NODE_ID"]): data for key, data, _ in self.nodes.read()}
        entries = []
        for key, data, _ in groups:
            replicas = []
            supported = not data.get("$MULTICAST_ECMP_ID") and not any(data.get("$MULTICAST_NODE_L1_XID_VALID", []))
            for node_id in data.get("$MULTICAST_NODE_ID", []):
                node = nodes.get(int(node_id))
                if node is None:
                    supported = False
                    continue
                if node.get("$MULTICAST_LAG_ID"):
                    supported = False
                replicas.extend({"egress_port": str(port), "instance": int(node["$MULTICAST_RID"])} for port in node.get("$DEV_PORT", []))
            entries.append({"multicast_group_id": int(key["$MGID"]), "replicas": sorted(replicas, key=lambda row: (int(row["egress_port"]), row["instance"])),
                            "editable": supported, "native_fields": data})
        return {"entries": sorted(entries, key=lambda row: row["multicast_group_id"])}

    def _cleanup(self, candidates):
        # Both group and ECMP references protect nodes, including references
        # created by another controller after our last write.
        referenced = {int(node) for _, data, _ in self.groups.read() for node in data.get("$MULTICAST_NODE_ID", [])}
        if "$pre.ecmp" in self.switch.p4_helper.by_name:
            referenced.update(int(node) for _, data, _ in FixedTable(self.switch, "$pre.ecmp").read() for node in data.get("$MULTICAST_NODE_ID", []))
        for node_id in set(candidates) & self.owned_nodes - referenced:
            self.nodes.write({"$MULTICAST_NODE_ID": node_id}, None, pb.Update.DELETE)
            self.owned_nodes.discard(node_id)

    def write(self, data, update_type):
        self.switch.ensure_writable()
        group_id = integer(data.get("multicast_group_id"), "multicast_group_id", minimum=1, maximum=65535)
        operation = OPERATIONS[update_type]
        replicas = data.get("replicas")
        if operation != pb.Update.DELETE:
            if not isinstance(replicas, list) or len(replicas) > 256:
                raise ValueError("replicas must contain 0 to 256 port/instance objects")
            normalized = []
            for replica in replicas:
                if not isinstance(replica, dict):
                    raise ValueError("Each replica must contain egress_port and instance")
                normalized.append((integer(replica.get("egress_port"), "egress_port", maximum=(1 << 32) - 1),
                                   integer(replica.get("instance", 0), "instance", maximum=65535)))
            if len(normalized) != len(set(normalized)):
                raise ValueError("Duplicate port/instance replica")
        with self.lock:
            old = self.groups.read({"$MGID": group_id})
            if operation == pb.Update.INSERT and old:
                raise BfRtError(grpc.StatusCode.ALREADY_EXISTS, "Multicast group already exists")
            if operation in (pb.Update.MODIFY, pb.Update.DELETE) and not old:
                raise BfRtError(grpc.StatusCode.NOT_FOUND, "Multicast group does not exist")
            old_nodes = {int(value) for _, values, _ in old for value in values.get("$MULTICAST_NODE_ID", [])}
            if operation == pb.Update.DELETE:
                self.groups.write({"$MGID": group_id}, None, operation)
                self._cleanup(old_nodes)
                return
            # Replacing ECMP/LAG/exclusion state with simple replicas loses
            # semantics. Require native management for those existing groups.
            existing = self.read(group_id)["entries"] if old else []
            if existing and not existing[0]["editable"]:
                raise ValueError("Existing multicast group has ECMP/LAG/exclusion state")
            occupied = {int(key["$MULTICAST_NODE_ID"]) for key, _, _ in self.nodes.read()}
            new_nodes = []
            candidate = min(self.nodes.table.get("size", 1 << 24) - 1, (1 << 32) - 1)
            try:
                for port, rid in normalized:
                    while candidate in occupied and candidate > 0:
                        candidate -= 1
                    if candidate <= 0:
                        raise RuntimeError("No free native multicast node IDs")
                    node_id = candidate
                    self.nodes.write({"$MULTICAST_NODE_ID": node_id}, {"$MULTICAST_RID": rid,
                        "$MULTICAST_LAG_ID": [], "$DEV_PORT": [port]}, pb.Update.INSERT)
                    self.owned_nodes.add(node_id)
                    occupied.add(node_id)
                    new_nodes.append(node_id)
                    candidate -= 1
                self.groups.write({"$MGID": group_id}, {"$MULTICAST_NODE_ID": new_nodes,
                    "$MULTICAST_NODE_L1_XID_VALID": [False] * len(new_nodes), "$MULTICAST_NODE_L1_XID": [0] * len(new_nodes),
                    "$MULTICAST_ECMP_ID": [], "$MULTICAST_ECMP_L1_XID_VALID": [], "$MULTICAST_ECMP_L1_XID": []}, operation)
            except Exception as error:
                try:
                    # On an uncertain write, only undo a group whose current
                    # node set still matches this attempted operation.
                    current = self.groups.read({"$MGID": group_id})
                    if current and {int(n) for n in current[0][1].get("$MULTICAST_NODE_ID", [])} == set(new_nodes):
                        if old:
                            self.switch.client.write([old[0][2]], pb.Update.MODIFY)
                        else:
                            self.groups.write({"$MGID": group_id}, None, pb.Update.DELETE)
                    self._cleanup(new_nodes)
                except Exception as restore_error:
                    raise RuntimeError(f"{error}; restoring multicast state failed: {restore_error}") from error
                raise
            self._cleanup(old_nodes)


class BfRtPortQueues:
    """Expose native port packet shaping; packet queue depth is unavailable."""
    def __init__(self, switch):
        self.switch = switch
        shaping = next(table["name"] for table in switch.p4_helper.tables if table["name"].endswith(".tm.port.sched_shaping"))
        config = next(table["name"] for table in switch.p4_helper.tables if table["name"].endswith(".tm.port.sched_cfg"))
        self.shaping, self.config = FixedTable(switch, shaping), FixedTable(switch, config)
        self.lock = RLock()

    @staticmethod
    def selector(data):
        value = data.get("port")
        return integer(value, "port", maximum=(1 << 32) - 1) if value is not None else None

    def snapshot(self, port=None, discover=True):
        selected = {"dev_port": port} if port is not None else None
        shaping = self.shaping.read(selected)
        configs = {int(key["dev_port"]): values for key, values, _ in self.config.read(selected)}
        ports = []
        for key, values, _ in shaping:
            number = int(key["dev_port"])
            enabled = configs.get(number, {}).get("max_rate_enable")
            ports.append({"port": number, "interface": None, "is_up": None, "discovered": True,
                          "depth_packets": None,
                          "rate_pps": values.get("max_rate") if values.get("unit") == "PPS" and enabled else "0" if enabled is False else None,
                          "burst_packets": values.get("max_burst_size") if values.get("unit") == "PPS" else None,
                          "rate_enabled": enabled, "native_fields": values,
                          "sources": {"depth_packets": "unsupported", "rate_pps": "switch_readback"}})
        return {"configured": True, "write_available": not self.switch.read_only, "readback_available": True,
                "priority_selection_available": False, "state": "switch_readback", "last_applied": [],
                "scope": "port", "configuration": {"source": "bfrt", "defaults": {}, "ports": ports},
                "port_discovery": {"status": "available", "error": None},
                "limits": {"max_rate_pps": str((1 << 32) - 1), "max_burst_packets": str((1 << 32) - 1)},
                "fields": {"rate_pps": {"read": True, "write": not self.switch.read_only, "scope": "port", "unit": "packets_per_second"},
                           "burst_packets": {"read": True, "write": not self.switch.read_only, "unit": "packets"},
                           "depth_packets": {"read": False, "write": False}},
                "message": "Native port packet shaping. Hardware may quantize rates; values shown come from switch readback. Queue packet depth is unavailable."}

    def write(self, data):
        self.switch.ensure_writable()
        port = self.selector(data)
        if port is None:
            raise ValueError("Tofino port shaping requires an explicit port")
        if "depth_packets" in data:
            unavailable("Tofino queue limits use cells; packet depth cannot be mapped exactly")
        rate = integer(data.get("rate_pps"), "rate_pps", maximum=(1 << 32) - 1)
        burst = integer(data["burst_packets"], "burst_packets", minimum=1, maximum=(1 << 32) - 1) if "burst_packets" in data else None
        with self.lock:
            key = {"dev_port": port}
            old_shape, old_config = self.shaping.read(key), self.config.read(key)
            if not old_shape or not old_config:
                raise ValueError("Unknown native traffic-manager port")
            current = old_shape[0][1]
            if rate and burst is None:
                if current.get("unit") != "PPS":
                    raise ValueError("burst_packets is required when switching a port from bit to packet shaping")
                burst = integer(current.get("max_burst_size"), "burst_packets", minimum=1, maximum=(1 << 32) - 1)
            try:
                if rate:
                    self.shaping.write(key, {"unit": "PPS", "max_rate": rate, "max_burst_size": burst}, pb.Update.MODIFY)
                self.config.write(key, {"max_rate_enable": bool(rate)}, pb.Update.MODIFY)
            except Exception as error:
                try:
                    self.switch.client.write([old_shape[0][2]], pb.Update.MODIFY)
                    self.switch.client.write([old_config[0][2]], pb.Update.MODIFY)
                except Exception as restore_error:
                    raise RuntimeError(f"{error}; restoring port shaping failed: {restore_error}") from error
                raise
        return [{"port": port, "rate_pps": str(rate), "burst_packets": str(burst) if burst is not None else None}]
