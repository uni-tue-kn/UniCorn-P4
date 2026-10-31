"""P4Runtime register and meter operations with lossless JSON values."""
import re

from ..p4.v1 import p4runtime_pb2, p4data_pb2
from .TableEntry import TableEntry


def lossless_match_values(value):
    """Keep wide match keys exact for JSON clients using IEEE-754 numbers."""
    if isinstance(value, dict):
        return {key: lossless_match_values(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [lossless_match_values(item) for item in value]
    if isinstance(value, int) and abs(value) > (1 << 53) - 1:
        return str(value)
    return value


def integer(value, label="value", minimum=0, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{label} must be a decimal integer")
    if isinstance(value, str) and not re.fullmatch(r"-?[0-9]+", value):
        raise ValueError(f"{label} must be a decimal integer")
    result = int(value)
    if result < minimum or (maximum is not None and result > maximum):
        raise ValueError(f"{label} is outside the supported range")
    return result


def register_type(register, p4info):
    spec = register.type_spec
    seen = set()
    while spec.WhichOneof("type_spec") == "new_type":
        name = spec.new_type.name
        if name in seen or name not in p4info.type_info.new_types:
            return {"kind": "unsupported", "description": "Unresolved register type"}
        seen.add(name)
        new_type = p4info.type_info.new_types[name]
        if not new_type.HasField("original_type"):
            return {"kind": "unsupported", "description": "Translated register types are unsupported"}
        spec = new_type.original_type
    if spec.WhichOneof("type_spec") != "bitstring":
        return {"kind": "unsupported", "description": "Only bit<W> and int<W> registers are supported"}
    kind = spec.bitstring.WhichOneof("type_spec")
    if kind not in ("bit", "int"):
        return {"kind": "unsupported", "description": "Variable-width registers are unsupported"}
    return {"kind": kind, "bitwidth": getattr(spec.bitstring, kind).bitwidth}


def encode_register(value, type_info):
    kind, width = type_info["kind"], type_info.get("bitwidth", 0)
    if kind not in ("bit", "int") or width <= 0:
        raise ValueError("Unsupported register type")
    signed = kind == "int"
    low = -(1 << (width - 1)) if signed else 0
    high = (1 << (width - int(signed))) - 1
    number = integer(value, minimum=low, maximum=high)
    # P4Runtime accepts the shortest sign-/zero-extended byte string.
    bits = ((~number).bit_length() if number < 0 else number.bit_length()) + int(signed)
    size = max(1, (bits + 7) // 8)
    return p4data_pb2.P4Data(bitstring=number.to_bytes(size, "big", signed=signed))


def decode_register(data, type_info):
    if data.WhichOneof("data") != "bitstring":
        raise ValueError("Target returned an unsupported register value")
    return str(int.from_bytes(data.bitstring, "big", signed=type_info["kind"] == "int"))


METER_FIELDS = ("cir", "cburst", "pir", "pburst")


def encode_meter(config):
    if config is None:
        return None
    if not isinstance(config, dict) or set(config) != set(METER_FIELDS):
        raise ValueError("Meter config must contain cir, cburst, pir and pburst")
    values = {key: integer(config[key], key, maximum=(1 << 63) - 1) for key in METER_FIELDS}
    if values["cir"] > values["pir"]:
        raise ValueError("Committed rate must not exceed peak rate")
    return p4runtime_pb2.MeterConfig(**values)


def decode_meter(entry):
    if not entry.HasField("config"):
        return None
    return {key: str(getattr(entry.config, key)) for key in METER_FIELDS}


class ResourceManager:
    def __init__(self, switch):
        self.switch = switch

    @property
    def helper(self):
        if not self.switch.connected or self.switch.p4_helper is None:
            raise RuntimeError("Switch is not connected and initialized")
        return self.switch.p4_helper

    def definition(self, collection, resource_id):
        try:
            return self.helper.get(collection, id=integer(resource_id, "resource ID", minimum=1, maximum=(1 << 32) - 1))
        except AttributeError as error:
            raise ValueError("Unknown resource ID") from error

    def indices(self, resource, index=None, offset=0, limit=128):
        if index is not None:
            return [integer(index, "index", maximum=resource.size - 1)]
        start = integer(offset, "offset", maximum=resource.size)
        count = integer(limit, "limit", minimum=1, maximum=256)
        return range(start, min(resource.size, start + count))

    def read(self, kind, resource_id, index=None, offset=0, limit=128):
        collection = "registers" if kind == "register" else "meters"
        resource = self.definition(collection, resource_id)
        type_info = register_type(resource, self.helper.p4info) if kind == "register" else None
        if type_info and type_info["kind"] == "unsupported":
            raise ValueError(type_info["description"])
        entities = []
        for item in self.indices(resource, index, offset, limit):
            entity = p4runtime_pb2.Entity()
            entry = getattr(entity, kind + "_entry")
            setattr(entry, kind + "_id", resource.preamble.id)
            entry.index.index = item
            entities.append(entity)
        entries = []
        if entities:
            for response in self.switch.bmv2.ReadEntities(entities):
                for entity in response.entities:
                    if entity.WhichOneof("entity") != kind + "_entry":
                        continue
                    entry = getattr(entity, kind + "_entry")
                    row = {"index": entry.index.index}
                    row.update({"value": decode_register(entry.data, type_info)} if kind == "register" else {"config": decode_meter(entry)})
                    entries.append(row)
        entries.sort(key=lambda item: item["index"])
        return {kind + "_id": resource.preamble.id, "total": resource.size, "entries": entries}

    def write(self, kind, resource_id, rows):
        resource = self.definition("registers" if kind == "register" else "meters", resource_id)
        entities = []
        seen = set()
        for row in self.validate_rows(rows):
            index = integer(row.get("index"), "index", maximum=resource.size - 1)
            if index in seen:
                raise ValueError("Duplicate index in write batch")
            seen.add(index)
            entity = p4runtime_pb2.Entity()
            entry = getattr(entity, kind + "_entry")
            setattr(entry, kind + "_id", resource.preamble.id)
            entry.index.index = index
            if kind == "register":
                entry.data.CopyFrom(encode_register(row.get("value"), register_type(resource, self.helper.p4info)))
            else:
                if "config" not in row:
                    raise ValueError("config is required; use null to reset the meter")
                config = encode_meter(row.get("config"))
                if config is not None:
                    entry.config.CopyFrom(config)
            entities.append(entity)
        # Validate the whole batch before making any changes. P4Runtime's
        # default CONTINUE_ON_ERROR is explicit: failures may be partial.
        self.switch.bmv2.ModifyEntities(entities)

    def validate_rows(self, rows):
        if not isinstance(rows, list) or not 1 <= len(rows) <= 256 or not all(isinstance(row, dict) for row in rows):
            raise ValueError("entries must contain 1 to 256 objects")
        return rows

    def read_direct(self, meter_id):
        resource = self.definition("direct_meters", meter_id)
        entity = p4runtime_pb2.Entity()
        entity.direct_meter_entry.table_entry.table_id = resource.direct_table_id
        rows = []
        name = self.helper.get_tables_name(resource.direct_table_id)
        for response in self.switch.bmv2.ReadEntities([entity]):
            for entity in response.entities:
                if entity.WhichOneof("entity") != "direct_meter_entry":
                    continue
                raw = entity.direct_meter_entry
                parsed = TableEntry(self.helper)
                parsed.table_name = name
                parsed.entry = raw.table_entry
                parsed.match_fields = {}
                parsed.parse_match_fields()
                rows.append({"table_entry": {"table_name": name, "match_fields": lossless_match_values(parsed.match_fields),
                             "priority": raw.table_entry.priority or None, "action_name": None, "action_params": {},
                             "is_default_action": raw.table_entry.is_default_action}, "config": decode_meter(raw)})
        return {"meter_id": resource.preamble.id, "entries": rows}

    def write_direct(self, meter_id, rows):
        resource = self.definition("direct_meters", meter_id)
        entities = []
        for row in self.validate_rows(rows):
            table = row.get("table_entry")
            if not isinstance(table, dict) or self.helper.get_tables_id(table.get("table_name")) != resource.direct_table_id:
                raise ValueError("Direct meter must reference its associated table")
            key = self.helper.buildTableEntry(table["table_name"], match_fields=table.get("match_fields"),
                    priority=table.get("priority"), default_action=table.get("is_default_action", False))
            entity = p4runtime_pb2.Entity()
            entry = entity.direct_meter_entry
            entry.table_entry.CopyFrom(key)
            if "config" not in row:
                raise ValueError("config is required; use null to reset the meter")
            config = encode_meter(row.get("config"))
            if config is not None:
                entry.config.CopyFrom(config)
            entities.append(entity)
        self.switch.bmv2.ModifyEntities(entities)
