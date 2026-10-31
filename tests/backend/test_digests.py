import grpc
from google.protobuf import text_format
import pytest
from unittest.mock import Mock

from controller.managers.DigestManager import DigestManager
from controller.p4.config.v1 import p4info_pb2, p4types_pb2
from controller.p4.v1 import p4data_pb2, p4runtime_pb2 as pb
from controller.utils.bmv2 import Bmv2SwitchConnection
from controller.utils.p4data import decode_p4data
from controller.utils.switch import IterableQueue


@pytest.fixture
def digest_switch(switch):
    info = switch.p4_helper.p4info
    digest = info.digests.add()
    digest.preamble.id, digest.preamble.name, digest.preamble.alias = 0x17000001, 'Ingress.learn', 'learn'
    digest.type_spec.struct.name = 'mac_learn_t'
    struct = info.type_info.structs['mac_learn_t']
    struct.members.add(name='srcAddr').type_spec.bitstring.bit.bitwidth = 48
    struct.members.add(name='ingressPort').type_spec.bitstring.bit.bitwidth = 9
    return switch


def payload(**overrides):
    return dict({'switch_id': 0, 'digest_id': 0x17000001,
                 'config': {'max_timeout_ns': '9007199254740993', 'max_list_size': '1', 'ack_timeout_ns': '0'}}, **overrides)


@pytest.mark.parametrize('verb,update_type', [('post', pb.Update.INSERT), ('patch', pb.Update.MODIFY), ('delete', pb.Update.DELETE)])
def test_digest_configuration_uses_standard_entity_with_lossless_values(client, digest_switch, verb, update_type):
    response = getattr(client, verb)('/digests', json=payload())
    assert response.status_code == 200
    entity, kind = digest_switch.bmv2.WriteEntity.call_args.args
    assert kind == update_type
    assert entity.WhichOneof('entity') == 'digest_entry'
    assert entity.digest_entry.digest_id == 0x17000001
    if verb == 'delete':
        assert not entity.digest_entry.HasField('config')
    else:
        assert entity.digest_entry.config.max_timeout_ns == 9007199254740993
        assert entity.digest_entry.config.max_list_size == 1


def test_digest_read_stream_and_resource_id_alias(client, digest_switch):
    response = pb.ReadResponse()
    response.entities.add().digest_entry.CopyFrom(pb.DigestEntry(digest_id=0x17000001,
        config=pb.DigestEntry.Config(max_timeout_ns=9223372036854775807, max_list_size=2, ack_timeout_ns=10)))
    response.entities.add().counter_entry.counter_id = 1
    digest_switch.bmv2.ReadEntities.return_value = iter([pb.ReadResponse(), response])
    result = client.get('/digests?switch_id=0&resource_id=385875969')
    assert result.status_code == 200
    assert result.json == {'entries': [{'digest_id': 0x17000001, 'config': {
        'max_timeout_ns': '9223372036854775807', 'max_list_size': '2', 'ack_timeout_ns': '10'}}]}
    assert digest_switch.bmv2.ReadEntities.call_args.args[0][0].digest_entry.digest_id == 0x17000001


@pytest.mark.parametrize('config', [None, {}, {'max_timeout_ns': '0', 'max_list_size': '-1', 'ack_timeout_ns': '0'},
    {'max_timeout_ns': '-1', 'max_list_size': '1', 'ack_timeout_ns': '0'},
    {'max_timeout_ns': '0', 'max_list_size': '2147483648', 'ack_timeout_ns': '0'},
    {'max_timeout_ns': '0', 'max_list_size': '1', 'ack_timeout_ns': '9223372036854775808'},
    {'max_timeout_ns': '0', 'max_list_size': True, 'ack_timeout_ns': '0'}])
def test_digest_invalid_config_never_reaches_target(client, digest_switch, config):
    assert client.post('/digests', json=payload(config=config)).status_code == 400
    digest_switch.bmv2.WriteEntity.assert_not_called()


def test_digest_zero_list_size_is_standard_target_chosen_limit(client, digest_switch):
    assert client.post('/digests', json=payload(config={'max_timeout_ns': '0', 'max_list_size': '0', 'ack_timeout_ns': '0'})).status_code == 200
    assert digest_switch.bmv2.WriteEntity.call_args.args[0].digest_entry.config.max_list_size == 0


def test_digest_metadata_and_unknown_ids(client, digest_switch):
    metadata = client.get('/init?switch_id=0').json['digests']
    assert metadata['Ingress.learn'] == {'id': 0x17000001, 'name': 'Ingress.learn', 'alias': 'learn',
                                        'type': {'struct': {'name': 'mac_learn_t'}}}
    assert client.post('/digests', json=payload(digest_id=7)).status_code == 400
    assert client.get('/digests?switch_id=999').status_code == 404
    digest_switch.p4_helper = None
    assert client.get('/digests?switch_id=0').status_code == 409


def test_events_decode_named_members_without_losing_u64_ids_or_values(client, digest_switch):
    digest = pb.DigestList(digest_id=0x17000001, list_id=18446744073709551615, timestamp=9007199254740993)
    value = digest.data.add()
    value.struct.members.add(bitstring=bytes.fromhex('aabbccddeeff'))
    value.struct.members.add(bitstring=b'\x01\xff')
    digest_switch.bmv2.GetDigestEvents.return_value = {'events': [{'sequence': '9007199254740993', 'payload': digest.SerializeToString()}],
        'next_sequence': '9007199254740993', 'dropped': 0, 'stream': {'primary': True, 'active': True, 'error': None}, 'limits': {}}
    response = client.get('/digest-events?switch_id=0&digest_id=385875969&after=9007199254740992&limit=2')
    assert response.status_code == 200
    event = response.json['events'][0]
    assert event['list_id'] == '18446744073709551615'
    assert event['timestamp_ns'] == '9007199254740993'
    assert event['data'][0]['fields']['srcAddr'] == {'kind': 'bit', 'decimal': '187723572702975', 'hex': '0xaabbccddeeff', 'bitwidth': 48}
    assert event['data'][0]['fields']['ingressPort']['decimal'] == '511'
    assert 'payload' not in event
    digest_switch.bmv2.GetDigestEvents.assert_called_once_with(0x17000001, 9007199254740992, 2)


def test_event_clear_does_not_disable_digest_and_query_limits_are_validated(client, digest_switch):
    assert client.delete('/digest-events', json={'switch_id': 0, 'digest_id': 0x17000001}).status_code == 200
    digest_switch.bmv2.ClearDigestEvents.assert_called_once_with(0x17000001)
    digest_switch.bmv2.WriteEntity.assert_not_called()
    for query in ('limit=0', 'limit=101', 'after=-1', 'digest_id=1'):
        assert client.get('/digest-events?switch_id=0&' + query).status_code == 400


def test_digest_target_unsupported_is_actionable(client, digest_switch):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.UNIMPLEMENTED
    error.details = lambda: 'Digests are unsupported'
    digest_switch.bmv2.ReadEntities.side_effect = error
    assert client.get('/digests?switch_id=0').status_code == 501


def test_known_disabled_digest_not_found_is_an_empty_configuration(client, digest_switch):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.NOT_FOUND
    error.details = lambda: 'Digest is not configured'
    digest_switch.bmv2.ReadEntities.side_effect = error
    response = client.get('/digests?switch_id=0&digest_id=385875969')
    assert response.status_code == 200
    assert response.json == {'entries': []}
    assert client.get('/digests?switch_id=0').json == {'entries': []}


def test_digest_listing_avoids_pi_unsupported_wildcard_and_skips_disabled_instances(client, digest_switch):
    second = digest_switch.p4_helper.p4info.digests.add()
    second.preamble.id, second.preamble.name = 0x17000002, 'Ingress.second'
    second.type_spec.bitstring.bit.bitwidth = 8
    requested = []
    def read(entities):
        digest_id = entities[0].digest_entry.digest_id
        requested.append(digest_id)
        if digest_id == 0x17000001:
            error = grpc.RpcError()
            error.code = lambda: grpc.StatusCode.NOT_FOUND
            raise error
        response = pb.ReadResponse()
        response.entities.add().digest_entry.CopyFrom(pb.DigestEntry(digest_id=digest_id,
            config=pb.DigestEntry.Config(max_list_size=1)))
        return iter([response])
    digest_switch.bmv2.ReadEntities.side_effect = read
    response = client.get('/digests?switch_id=0')
    assert response.status_code == 200
    assert requested == [0x17000001, 0x17000002]
    assert response.json == {'entries': [{'digest_id': 0x17000002, 'config': {
        'max_timeout_ns': '0', 'max_list_size': '1', 'ack_timeout_ns': '0'}}]}


def test_p4data_signed_tuple_varbit_bool_and_unknown_types_are_lossless():
    spec = p4types_pb2.P4DataTypeSpec()
    spec.tuple.members.add().bitstring.int.bitwidth = 7
    spec.tuple.members.add().bitstring.varbit.max_bitwidth = 16
    getattr(spec.tuple.members.add(), 'bool').SetInParent()
    data = p4data_pb2.P4Data()
    data.tuple.members.add(bitstring=b'\xff')
    data.tuple.members.add().varbit.CopyFrom(p4data_pb2.P4Varbit(bitstring=b'\x03', bitwidth=2))
    setattr(data.tuple.members.add(), 'bool', True)
    result = decode_p4data(data, spec)
    assert result['members'][0] == {'kind': 'int', 'decimal': '-1', 'hex': '0xff', 'bitwidth': 7}
    assert result['members'][1] == {'kind': 'varbit', 'decimal': '3', 'hex': '0x03', 'bitwidth': 2}
    assert result['members'][2] == {'kind': 'bool', 'value': True}
    assert decode_p4data(p4data_pb2.P4Data()) == {'kind': 'raw', 'protobuf_hex': ''}


def test_cyclic_new_type_is_bounded_and_retains_raw_value(digest_switch):
    info = digest_switch.p4_helper.p4info
    info.type_info.new_types['Cycle'].original_type.new_type.name = 'Cycle'
    spec = p4types_pb2.P4DataTypeSpec()
    spec.new_type.name = 'Cycle'
    data = p4data_pb2.P4Data(bitstring=b'\xff' * 8)
    assert decode_p4data(data, spec, info.type_info) == {'kind': 'raw', 'protobuf_hex': data.SerializeToString().hex()}


def pipeline_connection(switch):
    connection = Bmv2SwitchConnection.__new__(Bmv2SwitchConnection)
    connection.name, connection.device_id = 'pipeline-test', 0
    connection.client_stub = Mock()
    connection.requests_stream = IterableQueue(maxsize=256)
    connection._init_stream_state()
    connection._stream_primary = True
    switch.bmv2 = connection
    return connection


def capture_mac(connection, value=bytes.fromhex('aabbccddeeff')):
    digest = pb.DigestList(digest_id=0x17000001, list_id=1)
    digest.data.add().struct.members.add(bitstring=value)
    digest.data[0].struct.members.add(bitstring=b'\x01')
    connection._capture_digest(digest)


def test_real_pipeline_reset_clears_old_digest_data_before_reusing_id_with_different_type(digest_switch, tmp_path):
    connection = pipeline_connection(digest_switch)
    capture_mac(connection)
    assert DigestManager(digest_switch).events()['events'][0]['data'][0]['fields']['srcAddr']['decimal'] == '187723572702975'
    changed = p4info_pb2.P4Info()
    changed.CopyFrom(digest_switch.p4_helper.p4info)
    member = changed.type_info.structs['mac_learn_t'].members[0]
    member.name = 'newSignedField'
    member.type_spec.bitstring.int.bitwidth = 7
    path, device = tmp_path / 'new.p4info.txt', tmp_path / 'new.json'
    path.write_text(text_format.MessageToString(changed))
    device.write_text('{}')
    digest_switch.initialize(str(path), str(device))
    # An old captured MAC must not be rendered as the new int<7> field.
    assert DigestManager(digest_switch).events()['events'] == []
    assert connection._digest_event_bytes == 0
    capture_mac(connection, b'\xff')
    fields = DigestManager(digest_switch).events()['events'][0]['data'][0]['fields']
    assert 'srcAddr' not in fields
    assert fields['newSignedField']['decimal'] == '-1'


def test_identical_keep_entries_pipeline_preserves_valid_digest_capture(digest_switch, tmp_path):
    connection = pipeline_connection(digest_switch)
    capture_mac(connection)
    path, device = tmp_path / 'same.p4info.txt', tmp_path / 'same.json'
    path.write_text(text_format.MessageToString(digest_switch.p4_helper.p4info))
    device.write_text('{}')
    current = pb.GetForwardingPipelineConfigResponse()
    current.config.p4info.CopyFrom(digest_switch.p4_helper.p4info)
    current.config.p4_device_config = connection.buildDeviceConfig(bmv2_json_file_path=str(device)).SerializeToString()
    connection.client_stub.GetForwardingPipelineConfig.return_value = current
    digest_switch.initialize(str(path), str(device), keep_entries=True)
    connection.client_stub.SetForwardingPipelineConfig.assert_not_called()
    event = DigestManager(digest_switch).events()['events'][0]
    assert event['data'][0]['fields']['srcAddr']['decimal'] == '187723572702975'


def test_failed_pipeline_commit_preserves_original_digest_schema_and_capture(digest_switch, tmp_path):
    connection = pipeline_connection(digest_switch)
    capture_mac(connection)
    original = digest_switch.p4_helper
    path, device = tmp_path / 'different.p4info.txt', tmp_path / 'different.json'
    path.write_text(text_format.MessageToString(p4info_pb2.P4Info()))
    device.write_text('{"different": true}')
    connection.client_stub.SetForwardingPipelineConfig.side_effect = RuntimeError('Target rejected pipeline')
    with pytest.raises(Exception, match='Target rejected pipeline'):
        digest_switch.initialize(str(path), str(device))
    assert digest_switch.p4_helper is original
    assert DigestManager(digest_switch).events()['events'][0]['data'][0]['fields']['srcAddr']['decimal'] == '187723572702975'
