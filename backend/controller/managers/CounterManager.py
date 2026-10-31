"""Reset counter cells through P4Runtime without editing their tables/pipeline."""
from ..p4.v1 import p4runtime_pb2 as pb
from .ResourceManager import integer


class CounterManager:
    def __init__(self, switch):
        self.switch = switch

    def reset(self, counter_id, index=None):
        resource = self.switch.resources.definition('counters', counter_id)
        if resource.size <= 0:
            raise ValueError('Counter has no addressable cells')
        indices = range(resource.size) if index is None else [integer(index, 'index', maximum=resource.size - 1)]
        batch, count = [], 0
        for value in indices:
            entity = pb.Entity()
            entry = entity.counter_entry
            entry.counter_id = resource.preamble.id
            entry.index.index = value  # Index zero must remain explicitly present.
            entry.data.SetInParent()
            batch.append(entity)
            if len(batch) == 256:
                self.switch.bmv2.ModifyEntities(batch)
                count += len(batch)
                batch = []
        if batch:
            self.switch.bmv2.ModifyEntities(batch)
            count += len(batch)
        return count

    def reset_direct(self, table_id, table_entry=None):
        table = self.switch.resources.definition('tables', table_id)
        if not any(counter.direct_table_id == table.preamble.id
                   for counter in self.switch.p4_helper.p4info.direct_counters):
            raise ValueError('This table has no direct counter')
        if table_entry is not None:
            if not isinstance(table_entry, dict) or table_entry.get('table_name') != table.preamble.name:
                raise ValueError('table_entry must reference the selected table')
            matches = table_entry.get('match_fields', {})
            default = table_entry.get('is_default_action', False)
            if not isinstance(matches, dict) or not isinstance(default, bool):
                raise ValueError('Invalid table entry key')
            allowed = {field.name for field in table.match_fields}
            required = {field.name for field in table.match_fields if field.match_type == 2}
            if set(matches) - allowed or (not default and required - set(matches)) or (default and matches):
                raise ValueError('Provide a complete key for the selected table entry')
            priority = table_entry.get('priority')
            if priority is not None:
                priority = integer(priority, 'priority', maximum=(1 << 31) - 1)
            key = self.switch.p4_helper.buildTableEntry(table.preamble.name, match_fields=matches,
                                                       priority=priority, default_action=default)
            keys = [key]
        else:
            # Read existing keys instead of using an ambiguous wildcard write.
            keys = (entity.direct_counter_entry.table_entry
                    for response in self.switch.bmv2.ReadDirectCounters(table.preamble.id)
                    for entity in response.entities
                    if entity.WhichOneof('entity') == 'direct_counter_entry')
        batch, count = [], 0
        for key in keys:
            if key.table_id != table.preamble.id:
                continue
            entity = pb.Entity()
            entry = entity.direct_counter_entry
            entry.table_entry.table_id = key.table_id
            entry.table_entry.match.extend(key.match)
            entry.table_entry.priority = key.priority
            entry.table_entry.is_default_action = key.is_default_action
            entry.data.SetInParent()
            batch.append(entity)
            if len(batch) == 256:
                self.switch.bmv2.ModifyEntities(batch)
                count += len(batch)
                batch = []
        if batch:
            self.switch.bmv2.ModifyEntities(batch)
            count += len(batch)
        return count
