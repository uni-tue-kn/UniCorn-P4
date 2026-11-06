"""Native indexed and direct BF-RT resources with explicit single-pipe scope."""
from ..managers.ResourceManager import integer, ResourceManager, METER_FIELDS
from .bfrt_metadata import fields, field_info, encode_fields, decode_fields
from .bfrt_proto import bfruntime_pb2 as pb
from .bfrt_tables import BfRtTableEntry, encode_key, table_key

COUNTER_FIELDS = {"$COUNTER_SPEC_PKTS": "packets", "$COUNTER_SPEC_BYTES": "bytes"}
METER_NAMES = {"cir": ("$METER_SPEC_CIR_PPS", "$METER_SPEC_CIR_KBPS"),
               "pir": ("$METER_SPEC_PIR_PPS", "$METER_SPEC_PIR_KBPS"),
               "cburst": ("$METER_SPEC_CBS_PKTS", "$METER_SPEC_CBS_KBITS"),
               "pburst": ("$METER_SPEC_PBS_PKTS", "$METER_SPEC_PBS_KBITS")}


def counter_values(values):
    return {name: values.get(field, "0") for field, name in COUNTER_FIELDS.items()}


class BfRtResources:
    def __init__(self, switch):
        self.switch = switch

    @property
    def helper(self):
        self.switch.require_initialized()
        return self.switch.p4_helper

    def definition(self, collection, resource_id):
        return self.helper.get(collection, id=integer(resource_id, "resource ID", minimum=1, maximum=(1 << 32) - 1))

    indices = ResourceManager.indices
    validate_rows = ResourceManager.validate_rows

    def indexed_entry(self, table, index):
        keys = table.get("key", [])
        if len(keys) != 1 or keys[0].get("match_type", "Exact") != "Exact":
            raise ValueError("Resource does not expose one exact index key")
        entry = pb.TableEntry(table_id=table["id"])
        entry.key.CopyFrom(encode_key(table, {keys[0]["name"]: index}))
        entry.table_flags.from_hw = True
        return entry

    def read(self, kind, resource_id, index=None, offset=0, limit=128):
        resource = self.definition("registers" if kind == "register" else "meters", resource_id)
        table = self.helper.table(resource_id)
        definitions = fields(table.get("data", []))
        requested = list(self.indices(resource, index, offset, limit))
        rows = []
        if requested:
            for entry in self.switch.client.read([self.indexed_entry(table, index) for index in requested]):
                values = decode_fields(definitions, entry.data.fields)
                actual_index = int.from_bytes(entry.key.fields[0].exact.value, "big")
                row = {"index": actual_index}
                if kind == "register":
                    row["value"] = next(iter(values.values())) if len(definitions) == 1 and len(values) == 1 else values
                else:
                    row["config"] = self.decode_meter(values)
                rows.append(row)
        return {kind + "_id": resource_id, "total": resource.size, "entries": sorted(rows, key=lambda row: row["index"]),
                "fields": [field_info(field) for field in definitions], "scope": self.switch.scope}

    def write(self, kind, resource_id, rows):
        self.switch.ensure_writable()
        resource = self.definition("registers" if kind == "register" else "meters", resource_id)
        table = self.helper.table(resource_id)
        definitions = fields(table.get("data", []))
        entries, seen = [], set()
        for row in self.validate_rows(rows):
            index = integer(row.get("index"), "index", maximum=resource.size - 1)
            if index in seen:
                raise ValueError("Duplicate index in write batch")
            seen.add(index)
            entry = self.indexed_entry(table, index)
            if kind == "register":
                value = row.get("value")
                if len(definitions) == 1 and not isinstance(value, dict):
                    value = {definitions[0]["name"]: value}
                writable = {field["name"] for field in definitions if not field.get("read_only")}
                allowed = {field["name"] for field in definitions}
                if not writable:
                    raise ValueError("Register fields are read only")
                if not isinstance(value, dict) or set(value) - allowed or writable - set(value):
                    raise ValueError("Register value must provide every writable typed field")
                values = {name: item for name, item in value.items() if name in writable}
            else:
                if "config" not in row:
                    raise ValueError("config is required")
                values = self.encode_meter(table, row["config"])
            entry.data.fields.extend(encode_fields(definitions, values))
            entries.append(entry)
        self.switch.client.write(entries, pb.Update.MODIFY)

    @staticmethod
    def meter_fields(table):
        available = {field["name"] for field in fields(table.get("data", []))}
        result = {name: next((candidate for candidate in candidates if candidate in available), None)
                  for name, candidates in METER_NAMES.items()}
        if not all(result.values()):
            raise ValueError("Meter does not expose the standard BF-RT rate fields")
        return result

    def encode_meter(self, table, config):
        if config is None:
            raise ValueError("BF-RT meter reset requires explicit rate and burst values")
        if not isinstance(config, dict) or set(config) != set(METER_FIELDS):
            raise ValueError("Meter config must contain cir, cburst, pir and pburst")
        values = {key: integer(value, key) for key, value in config.items()}
        if values["cir"] > values["pir"]:
            raise ValueError("Committed rate must not exceed peak rate")
        return {native: values[name] for name, native in self.meter_fields(table).items()}

    @staticmethod
    def decode_meter(values):
        return {name: next((values[field] for field in candidates if field in values), "0") for name, candidates in METER_NAMES.items()}

    def counters(self, counter_id, index=None):
        resource = self.definition("counters", counter_id)
        table = self.helper.table(counter_id)
        indices = [integer(index, "index", maximum=resource.size - 1)] if index is not None else range(resource.size)
        rows = []
        for offset in range(0, len(indices), 256):
            for entry in self.switch.client.read([self.indexed_entry(table, i) for i in indices[offset:offset + 256]]):
                rows.append({"index": int.from_bytes(entry.key.fields[0].exact.value, "big"),
                             **counter_values(decode_fields(fields(table.get("data", [])), entry.data.fields))})
        return {"counterID": counter_id, "entries": sorted(rows, key=lambda row: row["index"]), "scope": self.switch.scope}

    def reset(self, counter_id, index=None):
        self.switch.ensure_writable()
        resource = self.definition("counters", counter_id)
        table = self.helper.table(counter_id)
        indices = [integer(index, "index", maximum=resource.size - 1)] if index is not None else range(resource.size)
        definitions = fields(table.get("data", []))
        for offset in range(0, len(indices), 256):
            entries = []
            for i in indices[offset:offset + 256]:
                entry = self.indexed_entry(table, i)
                entry.data.fields.extend(encode_fields(definitions, {field["name"]: "0" for field in definitions if field["name"] in COUNTER_FIELDS}))
                entries.append(entry)
            self.switch.client.write(entries, pb.Update.MODIFY)
        return len(indices)

    def direct_entries(self, resource_id, prefix):
        table = self.helper.table(resource_id)
        if not table.get("table_type", "").startswith("MatchAction"):
            raise ValueError("Select a match-action table for a direct resource")
        if not any(field["name"].startswith(prefix) for field in fields(table.get("data", []))):
            raise ValueError("Table has no requested direct resource")
        selector = pb.TableEntry(table_id=resource_id)
        selector.table_flags.from_hw = True
        entries = self.switch.client.read([selector])
        default = pb.TableEntry(table_id=resource_id, is_default_entry=True)
        default.table_flags.from_hw = True
        import grpc
        if not any(entry.is_default_entry for entry in entries):
            try:
                entries.extend(self.switch.client.read([default]))
            except grpc.RpcError as error:
                if error.code() != grpc.StatusCode.NOT_FOUND:
                    raise
        return table, entries

    def direct_counters(self, table_id):
        table, entries = self.direct_entries(table_id, "$COUNTER_SPEC_")
        return {"table_id": table_id, "entries": [{"key": table_key(entry),
                **counter_values(decode_fields(fields(table.get("data", [])),
                    [field for field in entry.data.fields if field.field_id in {item["id"] for item in fields(table.get("data", []))}]))}
                for entry in entries], "scope": self.switch.scope}

    def reset_direct(self, table_id, table_entry=None):
        self.switch.ensure_writable()
        table, entries = self.direct_entries(table_id, "$COUNTER_SPEC_")
        if table_entry is not None:
            if not isinstance(table_entry, dict) or table_entry.get("table_name") != table["name"]:
                raise ValueError("table_entry must reference the selected table")
            selector = BfRtTableEntry(self.helper, table_entry).entry
            if selector.is_default_entry:
                from .tofino import unsupported
                unsupported("Native default-entry direct-counter reset is unavailable because the model driver cannot apply it safely")
            entries = [entry for entry in entries if table_key(entry) == table_key(selector)]
        else:
            # The advertised reset_scope explicitly excludes default entries.
            entries = [entry for entry in entries if not entry.is_default_entry]
        definitions = fields(table.get("data", []))
        updates = []
        for entry in entries:
            update = pb.TableEntry(table_id=table_id, is_default_entry=entry.is_default_entry)
            update.key.CopyFrom(entry.key)
            if entry.is_default_entry:
                # BF-RT default-entry set requires its actual action, even
                # when only a direct resource changes.
                update.data.CopyFrom(entry.data)
                counter_ids = {field["id"] for field in definitions if field["name"] in COUNTER_FIELDS}
                preserved = [field for field in update.data.fields if field.field_id not in counter_ids]
                del update.data.fields[:]
                update.data.fields.extend(preserved)
            update.data.fields.extend(encode_fields(definitions, {field["name"]: "0" for field in definitions if field["name"] in COUNTER_FIELDS}))
            updates.append(update)
        if updates:
            self.switch.client.write(updates, pb.Update.MODIFY)
        return len(updates)

    def read_direct(self, meter_id):
        table, entries = self.direct_entries(meter_id, "$METER_SPEC_")
        ids = {field["id"] for field in fields(table.get("data", []))}
        return {"meter_id": meter_id, "entries": [{"table_entry": BfRtTableEntry.from_native(self.helper, entry).as_json(),
                "config": self.decode_meter(decode_fields(fields(table.get("data", [])), [field for field in entry.data.fields if field.field_id in ids]))}
                for entry in entries], "scope": self.switch.scope}

    def write_direct(self, meter_id, rows):
        self.switch.ensure_writable()
        table = self.helper.table(meter_id)
        entries = []
        for row in self.validate_rows(rows):
            value = row.get("table_entry")
            if not isinstance(value, dict) or value.get("table_name") != table["name"]:
                raise ValueError("Direct meter must reference its associated table")
            entry = pb.TableEntry(table_id=meter_id, is_default_entry=value.get("is_default_action", False))
            entry.key.CopyFrom(encode_key(table, value.get("match_fields", {}), value.get("priority"), entry.is_default_entry))
            encoded = encode_fields(fields(table.get("data", [])), self.encode_meter(table, row.get("config")))
            if entry.is_default_entry:
                current = self.switch.client.read([entry])
                if not current:
                    raise ValueError("Native default entry is unavailable")
                entry.data.CopyFrom(current[0].data)
                changed = {field.field_id for field in encoded}
                counter_ids = {field["id"] for field in fields(table.get("data", [])) if field["name"].startswith("$COUNTER_SPEC_")}
                preserved = [field for field in entry.data.fields if field.field_id not in changed | counter_ids]
                del entry.data.fields[:]
                entry.data.fields.extend(preserved)
            entry.data.fields.extend(encoded)
            entries.append(entry)
        self.switch.client.write(entries, pb.Update.MODIFY)
