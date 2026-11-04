"""Native BF-RT metadata and lossless field encoding (no P4Info conversion)."""
import ipaddress
import json
import math
from types import SimpleNamespace

from ..managers.ResourceManager import integer
from .bfrt_proto import bfruntime_pb2 as pb

MATCH_TYPES = {"Exact": 2, "LPM": 3, "Ternary": 4, "Range": 5, "Optional": 6}
COLLECTIONS = {"registers": "Register", "counters": "Counter", "meters": "Meter"}


def fields(items):
    """Unwrap BF-RT singleton/oneof descriptors without dropping field types."""
    result = []
    for item in items:
        if "singleton" in item:
            result.append(dict(item["singleton"], **{k: v for k, v in item.items() if k != "singleton"}))
        elif "oneof" in item:
            result.extend(fields(item["oneof"]))
        else:
            result.append(item)
    return result


def field_type(field):
    spec = field.get("type", {})
    kind = spec.get("type", "container" if "container" in field else "unknown")
    width = spec.get("width")
    if width is None and kind.startswith(("uint", "int")):
        suffix = kind[4:] if kind.startswith("uint") else kind[3:]
        width = int(suffix) if suffix.isdigit() else None
    result = {"kind": kind, "repeated": bool(field.get("repeated", False))}
    if width is not None:
        result["bitwidth"] = width
    if "container" in field:
        result["fields"] = [field_info(child) for child in fields(field["container"])]
    if "choices" in spec:
        result["choices"] = spec["choices"]
    return result


def field_info(field):
    return {"id": field["id"], "name": field["name"], "type": field_type(field),
            "read_only": field.get("read_only", False), "mandatory": field.get("mandatory", False)}


def text_number(value):
    """Parse hex, IPv4/IPv6 and colon-separated byte strings (MAC style)."""
    if value.startswith("0x"):
        return int(value, 16)
    if "." in value:
        return int(ipaddress.ip_address(value))
    groups = value.split(":")
    # MAC-style byte strings remain valid, but eight groups always mean IPv6,
    # including addresses whose groups happen to contain only two digits.
    if len(groups) != 8 and all(len(group) == 2 for group in groups):
        return int("".join(groups), 16)
    return int(ipaddress.IPv6Address(value))


def number(value, field):
    spec = field_type(field)
    width = spec.get("bitwidth", 32)
    signed = spec["kind"].startswith("int")
    if isinstance(value, str) and (value.startswith("0x") or ":" in value or "." in value):
        try:
            value = text_number(value)
        except ValueError as error:
            raise ValueError("Invalid numeric value for " + field["name"]) from error
    return integer(value, field["name"], minimum=-(1 << (width - 1)) if signed else 0,
                   maximum=(1 << (width - int(signed))) - 1)


def encode_bytes(value, field):
    spec = field_type(field)
    return number(value, field).to_bytes(max(1, (spec.get("bitwidth", 32) + 7) // 8), "big", signed=spec["kind"].startswith("int"))


def decode_bytes(value, field):
    return str(int.from_bytes(value, "big", signed=field_type(field)["kind"].startswith("int")))


def encode_data(field, value):
    if field.get("read_only"):
        raise ValueError(field["name"] + " is read only")
    result = pb.DataField(field_id=field["id"])
    spec = field_type(field)
    kind = spec["kind"]
    if "fields" in spec:
        if not isinstance(value, list):
            raise ValueError(field["name"] + " must be an array of objects")
        for row in value:
            result.container_arr_val.container.add().val.extend(encode_fields(fields(field["container"]), row))
    elif spec["repeated"]:
        if not isinstance(value, list):
            raise ValueError(field["name"] + " must be an array")
        if kind == "bool":
            if not all(isinstance(item, bool) for item in value):
                raise ValueError(field["name"] + " must contain booleans")
            result.bool_arr_val.val.extend(value)
        elif kind == "string":
            if not all(isinstance(item, str) for item in value):
                raise ValueError(field["name"] + " must contain strings")
            result.str_arr_val.val.extend(value)
        else:
            result.int_arr_val.val.extend(integer(number(item, field), field["name"], maximum=(1 << 32) - 1) for item in value)
    elif kind == "bool":
        if not isinstance(value, bool):
            raise ValueError(field["name"] + " must be a boolean")
        result.bool_val = value
    elif kind == "string":
        if not isinstance(value, str) or (spec.get("choices") and value not in spec["choices"]):
            raise ValueError("Invalid string value for " + field["name"])
        result.str_val = value
    elif kind == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(field["name"] + " must be a finite number")
        result.float_val = value
    elif kind == "bytes" or kind.startswith(("int", "uint")):
        result.stream = encode_bytes(value, field)
    else:
        raise ValueError("Unsupported BF-RT field type " + kind)
    return result


def encode_fields(definitions, values):
    if not isinstance(values, dict):
        raise ValueError("Field values must contain a JSON object")
    by_name = {field["name"]: field for field in definitions}
    if set(values) - set(by_name):
        raise ValueError("Unknown fields: " + ", ".join(sorted(set(values) - set(by_name))))
    return [encode_data(by_name[name], value) for name, value in values.items()]


def decode_data(field, value):
    kind = value.WhichOneof("value")
    if kind == "stream":
        return decode_bytes(value.stream, field)
    if kind in ("int_arr_val", "bool_arr_val", "str_arr_val"):
        return [str(item) if kind == "int_arr_val" else item for item in getattr(value, kind).val]
    if kind == "container_arr_val":
        return [decode_fields(fields(field.get("container", [])), row.val) for row in value.container_arr_val.container]
    if kind in ("str_val", "bool_val", "float_val"):
        return getattr(value, kind)
    raise ValueError("BF-RT returned no supported value for " + field["name"])


def decode_fields(definitions, values):
    by_id = {field["id"]: field for field in definitions}
    result = {}
    for value in values:
        if value.field_id not in by_id:
            raise ValueError("BF-RT returned an unknown field ID: " + str(value.field_id))
        field = by_id[value.field_id]
        result[field["name"]] = decode_data(field, value)
    return result


def validate_descriptors(items, depth=0):
    """Reject malformed/unbounded native widths before encoding archive data."""
    if depth > 16 or not isinstance(items, list):
        raise ValueError("Invalid BF-RT field descriptors")
    seen_ids, seen_names = set(), set()
    for field in fields(items):
        if not isinstance(field, dict):
            raise ValueError("Invalid BF-RT field descriptor")
        identifier, name = field.get("id"), field.get("name")
        if (isinstance(identifier, bool) or not isinstance(identifier, int) or not 0 <= identifier < (1 << 32)
                or not isinstance(name, str) or not name or identifier in seen_ids or name in seen_names):
            raise ValueError("Invalid or duplicate BF-RT field identifier: " + str(identifier) + " " + str(name))
        seen_ids.add(identifier)
        seen_names.add(name)
        spec = field_type(field)
        width = spec.get("bitwidth")
        if width is not None and (isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 4096):
            raise ValueError("BF-RT field width must be between 1 and 4096 bits")
        if "container" in field:
            validate_descriptors(field["container"], depth + 1)


class BfRtMetadata:
    def __init__(self, program, fixed=None):
        self.raw = json.loads(program) if isinstance(program, (str, bytes)) else program
        self.tables = list(self.raw.get("tables", []))
        if fixed:
            fixed = json.loads(fixed) if isinstance(fixed, (str, bytes)) else fixed
            self.tables.extend(fixed.get("tables", []))
        self.learns = self.raw.get("learn_filters", [])
        seen_ids, seen_names = set(), set()
        for table in self.tables:
            if not isinstance(table, dict):
                raise ValueError("Invalid BF-RT table descriptor")
            identifier, name = table.get("id"), table.get("name")
            if (isinstance(identifier, bool) or not isinstance(identifier, int) or not 0 < identifier < (1 << 32)
                    or not isinstance(name, str) or not name or identifier in seen_ids or name in seen_names):
                raise ValueError("Invalid or duplicate BF-RT table identifier")
            seen_ids.add(identifier)
            seen_names.add(name)
            validate_descriptors(table.get("key", []))
            validate_descriptors(table.get("data", []))
            for action in table.get("action_specs", []):
                validate_descriptors(action.get("data", []))
        for learn in self.learns:
            validate_descriptors(learn.get("fields", []))
        self.by_id = {table["id"]: table for table in self.tables}
        self.by_name = {table["name"]: table for table in self.tables}

    def table(self, identifier):
        try:
            return self.by_name[identifier] if isinstance(identifier, str) and identifier in self.by_name else self.by_id[int(identifier)]
        except (KeyError, ValueError, TypeError) as error:
            raise ValueError("Unknown BF-RT table: " + str(identifier)) from error

    def get(self, collection, id):
        table = self.table(id)
        if collection == "tables":
            valid = table.get("table_type", "").startswith("MatchAction")
        else:
            valid = table.get("table_type") == COLLECTIONS.get(collection)
        if not valid:
            raise ValueError("Unknown " + collection + " resource ID")
        return SimpleNamespace(preamble=SimpleNamespace(id=table["id"], name=table["name"]), size=table.get("size", 0))

    def match_tables(self):
        return [table for table in self.tables if table.get("table_type", "").startswith("MatchAction")]

    def get_tables_id(self, name):
        return self.table(name)["id"]

    def table_entry_blueprint(self):
        return {table["name"]: [] for table in self.match_tables()}

    def get_table_info(self):
        result = {}
        for table in self.match_tables():
            keys = {key["name"]: {"id": key["id"], "match_key": key["name"],
                    "match_type": MATCH_TYPES.get(key.get("match_type"), 0),
                    "bitwidth": field_type(key).get("bitwidth", 32), "type": field_type(key)}
                    for key in table.get("key", []) if key["name"] != "$MATCH_PRIORITY"}
            actions = {action["name"]: {"id": action["id"], "name": action["name"], "alias": action["name"].split(".")[-1],
                       "params": [dict(field_info(field), bitwidth=field_type(field).get("bitwidth", 32)) for field in fields(action.get("data", []))]}
                       for action in table.get("action_specs", [])}
            result[table["name"]] = {"table_name": table["name"], "table_id": table["id"], "match_fields": keys,
                                     "actions": actions, "data_fields": [field_info(field) for field in fields(table.get("data", []))],
                                     "native_type": table["table_type"]}
        return result

    def get_table_decoding(self):
        return {name: {"match": {key: "numeric" for key in table["match_fields"]},
                       "action": {name: {param["name"]: "numeric" for param in action["params"]} for name, action in table["actions"].items()}}
                for name, table in self.get_table_info().items()}

    def resources(self, kind):
        result = {}
        for table in self.tables:
            if table.get("table_type") != kind:
                continue
            data = fields(table.get("data", []))
            typed = [field_info(field) for field in data]
            row = {"id": table["id"], "name": table["name"], "alias": table["name"].split(".")[-1],
                   "size": table.get("size", 0), "fields": typed, "native_type": kind}
            if kind == "Register":
                row["type"] = typed[0]["type"] if len(typed) == 1 else {"kind": "struct", "fields": typed}
                if len(typed) == 1 and row["type"]["kind"] == "bytes":
                    row["type"] = dict(row["type"], kind="bit")
            if kind in ("Counter", "Meter"):
                names = {field["name"] for field in data}
                row["unit"] = 3 if any("BYTES" in name for name in names) and any("PKTS" in name for name in names) else 1 if any("BYTES" in name for name in names) else 2
            result[table["name"]] = row
        return result

    def get_registers(self): return self.resources("Register")
    def get_counters(self): return self.resources("Counter")
    def get_meters(self):
        result = self.resources("Meter")
        for row in result.values():
            row.update(self.meter_units(self.table(row["id"])))
        return result
    def get_direct_counters(self):
        result = {}
        for table in self.match_tables():
            names = {field["name"] for field in fields(table.get("data", [])) if field["name"].startswith("$COUNTER_SPEC_")}
            if names:
                result[table["name"]] = {"id": table["id"], "name": table["name"], "table_id": table["id"],
                                        "unit": 3 if len(names) == 2 else 1 if "$COUNTER_SPEC_BYTES" in names else 2}
        return result

    @staticmethod
    def meter_units(table):
        names = {field["name"] for field in fields(table.get("data", []))}
        packets = "$METER_SPEC_CIR_PPS" in names
        return {"unit": 2 if packets else 1, "rate_unit": "packets_per_second" if packets else "kilobits_per_second",
                "burst_unit": "packets" if packets else "kilobits", "quantized": True, "reset": False}

    def get_direct_meters(self):
        return {table["name"]: {"id": table["id"], "name": table["name"], "table_id": table["id"], **self.meter_units(table)}
                for table in self.match_tables() if any(field["name"].startswith("$METER_SPEC_") for field in fields(table.get("data", [])))}
    def get_digests(self):
        return {learn["name"]: {"id": learn["id"], "name": learn["name"], "alias": learn["name"].split(".")[-1],
                "type": {"kind": "struct", "fields": [field_info(field) for field in fields(learn.get("fields", []))]}} for learn in self.learns}
