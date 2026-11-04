"""Target-neutral table rows backed directly by native BF-RT entities."""
import json
from copy import deepcopy

from ..managers.ResourceManager import integer
from .bfrt_metadata import fields, encode_fields, decode_fields, encode_bytes, decode_bytes, field_type
from .bfrt_proto import bfruntime_pb2 as pb


def encode_key(table, values, priority=None, default=False):
    if not isinstance(values, dict):
        raise ValueError("match_fields must contain a JSON object")
    definitions = {field["name"]: field for field in table.get("key", [])}
    if set(values) - set(definitions):
        raise ValueError("Unknown match fields")
    if default and values:
        raise ValueError("A default entry cannot have match fields")
    result = pb.TableKey()
    for name, field in definitions.items():
        if name == "$MATCH_PRIORITY":
            if priority is not None:
                result.fields.add(field_id=field["id"]).exact.value = encode_bytes(priority, field)
            continue
        if name not in values:
            if not default and field.get("match_type") == "Exact":
                raise ValueError("Missing exact match field: " + name)
            continue
        value = values[name]
        key = result.fields.add(field_id=field["id"])
        kind = field.get("match_type", "Exact").lower()
        if kind == "exact":
            key.exact.value = encode_bytes(value, field)
        elif kind == "optional":
            key.optional.value = encode_bytes(value, field)
            key.optional.is_valid = True
        elif kind in ("lpm", "ternary", "range"):
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise ValueError(name + " requires a pair of values")
            if kind == "lpm":
                width = field_type(field).get("bitwidth", 32)
                prefix = integer(value[1], "prefix length", maximum=width)
                numeric = int.from_bytes(encode_bytes(value[0], field), "big") & (((1 << prefix) - 1) << (width - prefix))
                key.lpm.value, key.lpm.prefix_len = encode_bytes(numeric, field), prefix
            elif kind == "ternary":
                mask = encode_bytes(value[1], field)
                numeric = int.from_bytes(encode_bytes(value[0], field), "big") & int.from_bytes(mask, "big")
                key.ternary.value, key.ternary.mask = encode_bytes(numeric, field), mask
            else:
                key.range.low, key.range.high = encode_bytes(value[0], field), encode_bytes(value[1], field)
                if key.range.low > key.range.high:
                    raise ValueError("Range lower bound exceeds upper bound")
        else:
            raise ValueError("Unsupported BF-RT match type: " + kind)
    return result


def decode_key(table, key):
    definitions = {field["id"]: field for field in table.get("key", [])}
    values, priority = {}, None
    for item in key.fields:
        field = definitions[item.field_id]
        kind = item.WhichOneof("match_type")
        body = getattr(item, kind)
        if field["name"] == "$MATCH_PRIORITY":
            priority = int.from_bytes(body.value, "big")
            continue
        if kind in ("exact", "optional"):
            if kind == "optional" and not body.is_valid:
                continue
            value = decode_bytes(body.value, field)
        elif kind == "lpm":
            value = [decode_bytes(body.value, field), body.prefix_len]
        elif kind == "ternary":
            value = [decode_bytes(body.value, field), decode_bytes(body.mask, field)]
        elif kind == "range":
            value = [decode_bytes(body.low, field), decode_bytes(body.high, field)]
        else:
            raise ValueError("Unsupported BF-RT response match type")
        values[field["name"]] = value
    return values, priority


def table_key(entry):
    return (entry.table_id, entry.is_default_entry,
            tuple(sorted((field.field_id, field.SerializeToString(deterministic=True)) for field in entry.key.fields)))


class BfRtTableEntry:
    def __init__(self, helper, value, is_json=False):
        self.helper = helper
        value = json.loads(value) if is_json else value
        if not isinstance(value, dict):
            raise ValueError("Table entry must contain a JSON object")
        self.deleted = value.get("deleted", False)
        table = helper.table(value["table_name"])
        self.table = table
        self.entry = pb.TableEntry(table_id=table["id"], is_default_entry=value.get("is_default_action", False))
        self.entry.key.CopyFrom(encode_key(table, value.get("match_fields", {}), value.get("priority"), self.entry.is_default_entry))
        action_name = value.get("action_name")
        params = value.get("action_params") or {}
        if action_name:
            action = next((item for item in table.get("action_specs", []) if item["name"] == action_name), None)
            if action is None:
                raise ValueError("Unknown action for table: " + action_name)
            if action.get("action_scope") == "DefaultOnly" and not self.entry.is_default_entry:
                raise ValueError("Action is only valid for the default entry")
            self.entry.data.action_id = action["id"]
            definitions = fields(action.get("data", []))
            missing = {field["name"] for field in definitions if field.get("mandatory")} - set(params)
            if missing:
                raise ValueError("Missing action parameters: " + ", ".join(sorted(missing)))
            self.entry.data.fields.extend(encode_fields(definitions, params))
        elif params:
            raise ValueError("action_name is required for action_params")
        native_data = value.get("data_fields", {})
        if self.entry.is_default_entry and any(name.startswith("$COUNTER_SPEC_") for name in native_data):
            raise ValueError("Native default-entry counter values must not be written with table actions")
        self.entry.data.fields.extend(encode_fields(fields(table.get("data", [])), native_data))

    @classmethod
    def from_native(cls, helper, native):
        obj = cls.__new__(cls)
        obj.helper, obj.entry, obj.table = helper, native, helper.table(native.table_id)
        obj.deleted = False
        return obj

    def get_entry_obj(self): return self.entry

    def as_json(self):
        match, priority = decode_key(self.table, self.entry.key)
        action = next((item for item in self.table.get("action_specs", []) if item["id"] == self.entry.data.action_id), None)
        definitions = fields(self.table.get("data", [])) + fields(action.get("data", []) if action else [])
        values = decode_fields(definitions, self.entry.data.fields)
        action_names = {field["name"] for field in fields(action.get("data", []))} if action else set()
        data = {"table_name": self.table["name"], "match_fields": match, "priority": priority,
                "is_default_action": self.entry.is_default_entry, "action_name": action["name"] if action else None,
                "action_params": {name: value for name, value in values.items() if name in action_names}}
        direct = {name: value for name, value in values.items() if name not in action_names
                  and not name.startswith(("$COUNTER_SPEC_", "$METER_SPEC_"))}
        if direct:
            data["data_fields"] = direct
        return data
