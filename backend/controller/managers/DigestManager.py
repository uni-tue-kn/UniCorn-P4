"""Digest configuration and decoding; events are captured by SwitchConnection."""
import grpc

from ..p4.v1 import p4runtime_pb2 as pb
from ..utils.p4data import decode_p4data
from .ResourceManager import integer


DIGEST_FIELDS = ('max_timeout_ns', 'max_list_size', 'ack_timeout_ns')


class DigestManager:
    def __init__(self, switch):
        self.switch = switch

    def identifier(self, value):
        return self.switch.resources.definition('digests', value).preamble.id

    def read(self, digest_id=None):
        # PI/BMv2 rejects digest_id=0 wildcard reads. Enumerate the program's
        # digest IDs through standard indexed P4Runtime reads instead.
        helper = self.switch.resources.helper
        if digest_id is None:
            entries = []
            for digest in helper.p4info.digests:
                entries.extend(self.read(digest.preamble.id)['entries'])
            return {'entries': sorted(entries, key=lambda row: row['digest_id'])}
        selector = pb.Entity()
        selector.digest_entry.digest_id = self.identifier(digest_id)
        entries = []
        try:
            for response in self.switch.bmv2.ReadEntities([selector]):
                for entity in response.entities:
                    if entity.WhichOneof('entity') == 'digest_entry':
                        entry = entity.digest_entry
                        entries.append({'digest_id': entry.digest_id, 'config':
                                        {key: str(getattr(entry.config, key)) for key in DIGEST_FIELDS}})
        except grpc.RpcError as error:
            # BMv2 returns NOT_FOUND for a known but disabled digest when read
            # by ID. Present the same empty configuration as its wildcard read.
            if error.code() != grpc.StatusCode.NOT_FOUND:
                raise
        return {'entries': sorted(entries, key=lambda row: row['digest_id'])}

    def write(self, data, update_type):
        entity = pb.Entity()
        entry = entity.digest_entry
        entry.digest_id = self.identifier(data.get('digest_id', data.get('resource_id')))
        if update_type != pb.Update.DELETE:
            config = data.get('config')
            if not isinstance(config, dict) or set(config) != set(DIGEST_FIELDS):
                raise ValueError('Digest config must contain max_timeout_ns, max_list_size and ack_timeout_ns')
            entry.config.max_timeout_ns = integer(config['max_timeout_ns'], 'max_timeout_ns', maximum=(1 << 63) - 1)
            entry.config.max_list_size = integer(config['max_list_size'], 'max_list_size', maximum=(1 << 31) - 1)
            entry.config.ack_timeout_ns = integer(config['ack_timeout_ns'], 'ack_timeout_ns', maximum=(1 << 63) - 1)
        self.switch.bmv2.WriteEntity(entity, update_type)

    def events(self, digest_id=None, after=0, limit=50):
        identifier = self.identifier(digest_id) if digest_id is not None else None
        after = integer(after, 'after')
        limit = integer(limit, 'limit', minimum=1, maximum=100)
        result = self.switch.bmv2.GetDigestEvents(identifier, after, limit)
        info = self.switch.p4_helper.p4info if self.switch.p4_helper is not None else None
        definitions = {digest.preamble.id: digest for digest in info.digests} if info is not None else {}
        for event in result['events']:
            raw = pb.DigestList.FromString(event.pop('payload'))
            definition = definitions.get(raw.digest_id)
            event.update(digest_id=raw.digest_id, list_id=str(raw.list_id), timestamp_ns=str(raw.timestamp),
                         data=[decode_p4data(value, definition.type_spec if definition is not None else None,
                                            info.type_info if info is not None else None) for value in raw.data])
        return result
