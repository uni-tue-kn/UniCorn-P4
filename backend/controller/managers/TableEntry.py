import json
from ..utils import convert

class TableEntry:

    def __init__(self,p4_helper):
        self.p4_helper = p4_helper
    
    def from_json(self,raw_json): 
        entry_dict = json.loads(raw_json)
        self.from_dict(entry_dict)

    # TODO: error handling
    def from_dict(self,entry_dict):
        self.table_name = entry_dict["table_name"]
        self.match_fields = entry_dict["match_fields"]
        self.action_name = entry_dict["action_name"]
        self.action_params = entry_dict["action_params"]
        self.priority = entry_dict["priority"]
        self.is_default_action = entry_dict.get("is_default_action", False)

        # Only set this if key is set
        if "deleted" in entry_dict:
            self.deleted = entry_dict["deleted"]

        self.entry = self.p4_helper.buildTableEntry(
            table_name=self.table_name,
            match_fields=self.match_fields,
            action_name=self.action_name,
            action_params=self.action_params,
            priority=self.priority,
            default_action=self.is_default_action
        )
        if entry_dict.get("meter_config") is not None:
            from .ResourceManager import encode_meter
            self.entry.meter_config.CopyFrom(encode_meter(entry_dict["meter_config"]))
        if entry_dict.get("counter_data") is not None:
            from .ResourceManager import integer
            for name in ("packet_count", "byte_count"):
                setattr(self.entry.counter_data, name, integer(entry_dict["counter_data"].get(name, 0), name, maximum=(1 << 63) - 1))

    def from_entity(self,table_name,entity):
        self.table_name = table_name
        self.entry = entity.table_entry
        self.match_fields = {}
        self.action_name = ""
        self.action_params = {}

        self.priority = self.entry.priority if self.entry.priority else None
        self.is_default_action = self.entry.is_default_action

        self.parse_match_fields()
        self.parse_action()

    def get_entry_obj(self):
        return self.entry

    def parse_match_fields(self):
        # Iterate over match fields
        for match in self.entry.match:
            parsed = self.parse_match(match)
            # Add parsed match field with key and value to dict
            self.match_fields.update(parsed)

    def parse_match(self, match):
        # Data structure for result
        parsed = {}

        # Get name of the field from table name and field id
        match_field_name = self.p4_helper.get_match_field_name(
            self.table_name, match.field_id)

        # Get match field type and value
        match_type = match.WhichOneof("field_match_type")
        match_field_value = self.p4_helper.get_match_field_value(match)

        # Convert value to readable format from numeric representation depending on type
        if match_type == "valid":
            # Valid can be read directly
            parsed[match_field_name] = match_field_value
        elif match_type == "exact" or match_type == "optional":
            # Exact or optional has to be decoded from numberical presentation
            parsed[match_field_name] = convert.decodeNum(
                match_field_value)
        elif match_type == "lpm":
            # Decode IP from muneric, length parameter doies not have to be decoded
            parsed[match_field_name] = [
                convert.decodeNum(match_field_value[0]),
                match_field_value[1]
            ]
        else:
            # For all other cases, decode both fields from numeric
            parsed[match_field_name] = [
                convert.decodeNum(match_field_value[0]),
                convert.decodeNum(match_field_value[1])
            ]

        return parsed

    def parse_action(self):
        # Read action data from entries
        action = self.entry.action.action
        self.action_name = self.p4_helper.get_actions_name(action.action_id)
        # Iterate over parameters and convert from numeric representation
        for param in action.params:
            param_name = self.p4_helper.get_action_param_name(
                self.action_name, param.param_id)
            self.action_params[param_name] = convert.decodeNum(param.value)

    def as_json(self):
        data = {
            "table_name": self.table_name,
            "match_fields": self.match_fields,
            "action_name": self.action_name,
            "action_params": self.action_params,
            "priority": self.priority,
            "is_default_action": self.is_default_action
        }
        if self.entry.HasField("meter_config"):
            from .ResourceManager import METER_FIELDS
            data["meter_config"] = {key: str(getattr(self.entry.meter_config, key)) for key in METER_FIELDS}
        if self.entry.HasField("counter_data"):
            data["counter_data"] = {key: str(getattr(self.entry.counter_data, key)) for key in ("packet_count", "byte_count")}
        return data
