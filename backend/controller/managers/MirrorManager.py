"""Mirror sessions use standard P4Runtime PRE CloneSessionEntry entities."""
from ..p4.v1 import p4runtime_pb2 as pb
from .ResourceManager import integer


class MirrorManager:
    def __init__(self, bmv2):
        self.bmv2 = bmv2

    @staticmethod
    def session_id(value):
        # simple_switch reserves session zero and uses a 15-bit mirror ID.
        return integer(value, "session_id", minimum=1, maximum=32767)

    def read(self, session_id=None):
        selector = pb.Entity()
        wanted = selector.packet_replication_engine_entry.clone_session_entry
        wanted.session_id = self.session_id(session_id) if session_id is not None else 0
        sessions = []
        for response in self.bmv2.ReadEntities([selector]):
            for entity in response.entities:
                if entity.WhichOneof("entity") != "packet_replication_engine_entry":
                    continue
                pre = entity.packet_replication_engine_entry
                if pre.WhichOneof("type") != "clone_session_entry":
                    continue
                session = pre.clone_session_entry
                replicas = [{"egress_port": str(int.from_bytes(replica.port, 'big') if replica.WhichOneof("port_kind") == "port"
                                               else replica.egress_port), "instance": replica.instance}
                            for replica in session.replicas]
                replicas.sort(key=lambda item: (int(item["egress_port"]), item["instance"]))
                sessions.append({"session_id": session.session_id, "replicas": replicas,
                    "class_of_service": session.class_of_service, "packet_length_bytes": session.packet_length_bytes})
        return {"entries": sorted(sessions, key=lambda item: item["session_id"])}

    def write(self, data, update_type):
        entity = pb.Entity()
        session = entity.packet_replication_engine_entry.clone_session_entry
        session.session_id = self.session_id(data.get("session_id"))
        if update_type != pb.Update.DELETE:
            replicas = data.get("replicas")
            if not isinstance(replicas, list) or not 1 <= len(replicas) <= 256:
                raise ValueError("replicas must contain 1 to 256 port/instance objects")
            seen = set()
            for replica in replicas:
                if not isinstance(replica, dict):
                    raise ValueError("Each replica must contain egress_port and instance")
                port = integer(replica.get("egress_port"), "egress_port", minimum=1, maximum=(1 << 32) - 1)
                instance = integer(replica.get("instance", 0), "instance", maximum=65535)
                if (port, instance) in seen:
                    raise ValueError("Duplicate port/instance replica")
                seen.add((port, instance))
                # PI/BMv2 advertises P4Runtime 1.3 and requires this established
                # uint32 field; newer port bytes are accepted on read as well.
                session.replicas.add(egress_port=port, instance=instance)
            session.class_of_service = integer(data.get("class_of_service", 0), "class_of_service", maximum=255)
            session.packet_length_bytes = integer(data.get("packet_length_bytes", 0), "packet_length_bytes", maximum=65535)
        self.bmv2.WriteEntity(entity, update_type)
