"""Standard P4Runtime PRE multicast groups (BMv2 uses 16-bit group IDs)."""
from ..p4.v1 import p4runtime_pb2 as pb
from .ResourceManager import integer


class MulticastManager:
    def __init__(self, bmv2):
        self.bmv2 = bmv2

    @staticmethod
    def group_id(value):
        return integer(value, 'multicast_group_id', minimum=1, maximum=65535)

    def read(self, group_id=None):
        selector = pb.Entity()
        selector.packet_replication_engine_entry.multicast_group_entry.multicast_group_id = (
            self.group_id(group_id) if group_id is not None else 0)
        groups = []
        for response in self.bmv2.ReadEntities([selector]):
            for entity in response.entities:
                if entity.WhichOneof('entity') != 'packet_replication_engine_entry':
                    continue
                pre = entity.packet_replication_engine_entry
                if pre.WhichOneof('type') != 'multicast_group_entry':
                    continue
                group = pre.multicast_group_entry
                replicas = [{'egress_port': str(int.from_bytes(replica.port, 'big')
                             if replica.WhichOneof('port_kind') == 'port' else replica.egress_port),
                             'instance': replica.instance} for replica in group.replicas]
                replicas.sort(key=lambda row: (int(row['egress_port']), row['instance']))
                groups.append({'multicast_group_id': group.multicast_group_id, 'replicas': replicas})
        return {'entries': sorted(groups, key=lambda row: row['multicast_group_id'])}

    def write(self, data, update_type):
        entity = pb.Entity()
        group = entity.packet_replication_engine_entry.multicast_group_entry
        group.multicast_group_id = self.group_id(data.get('multicast_group_id'))
        if update_type != pb.Update.DELETE:
            replicas = data.get('replicas')
            if not isinstance(replicas, list) or len(replicas) > 256:
                raise ValueError('replicas must contain 0 to 256 port/instance objects')
            seen = set()
            for row in replicas:
                if not isinstance(row, dict):
                    raise ValueError('Each replica must contain egress_port and instance')
                port = integer(row.get('egress_port'), 'egress_port', minimum=1, maximum=(1 << 32) - 1)
                instance = integer(row.get('instance', 0), 'instance', maximum=65535)
                if (port, instance) in seen:
                    raise ValueError('Duplicate port/instance replica')
                seen.add((port, instance))
                group.replicas.add(egress_port=port, instance=instance)
        self.bmv2.WriteEntity(entity, update_type)
