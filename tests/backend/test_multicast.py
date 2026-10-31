import grpc
import pytest

from controller.p4.v1 import p4runtime_pb2 as pb


def group(**overrides):
    return dict({'switch_id': 0, 'multicast_group_id': 23,
                 'replicas': [{'egress_port': '4294967295', 'instance': 65535}]}, **overrides)


@pytest.mark.parametrize('verb,kind', [('post', pb.Update.INSERT), ('patch', pb.Update.MODIFY), ('delete', pb.Update.DELETE)])
def test_multicast_crud_writes_standard_pre_entity(client, switch, verb, kind):
    assert getattr(client, verb)('/multicast-groups', json=group()).status_code == 200
    entity, update_type = switch.bmv2.WriteEntity.call_args.args
    assert update_type == kind
    assert entity.WhichOneof('entity') == 'packet_replication_engine_entry'
    assert entity.packet_replication_engine_entry.WhichOneof('type') == 'multicast_group_entry'
    entry = entity.packet_replication_engine_entry.multicast_group_entry
    assert entry.multicast_group_id == 23
    if verb == 'delete':
        assert not entry.replicas
    else:
        assert entry.replicas[0].egress_port == 4294967295
        assert entry.replicas[0].instance == 65535


def test_multicast_get_collects_chunks_and_accepts_new_port_bytes(client, switch):
    responses = []
    for id_ in (10, 1):
        response = pb.ReadResponse()
        entry = response.entities.add().packet_replication_engine_entry.multicast_group_entry
        entry.multicast_group_id = id_
        entry.replicas.add(egress_port=3, instance=1)
        entry.replicas.add(port=b'\x02', instance=0)
        response.entities.add().packet_replication_engine_entry.clone_session_entry.session_id = 5
        responses.append(response)
    switch.bmv2.ReadEntities.return_value = iter(responses)
    result = client.get('/multicast-groups?switch_id=0')
    assert result.status_code == 200
    assert [row['multicast_group_id'] for row in result.json['entries']] == [1, 10]
    assert result.json['entries'][0]['replicas'] == [{'egress_port': '2', 'instance': 0}, {'egress_port': '3', 'instance': 1}]
    selector = switch.bmv2.ReadEntities.call_args.args[0][0]
    assert selector.packet_replication_engine_entry.WhichOneof('type') == 'multicast_group_entry'
    assert selector.packet_replication_engine_entry.multicast_group_entry.multicast_group_id == 0


@pytest.mark.parametrize('overrides', [
    {'multicast_group_id': 0}, {'multicast_group_id': 65536}, {'multicast_group_id': True},
    {'replicas': None}, {'replicas': [{'egress_port': '0'}]}, {'replicas': [{'egress_port': '4294967296'}]},
    {'replicas': [{'egress_port': '2', 'instance': -1}]}, {'replicas': [{'egress_port': '2', 'instance': 65536}]},
    {'replicas': [{'egress_port': '2'}, {'egress_port': 2, 'instance': 0}]}, {'replicas': ['invalid']},
])
def test_invalid_multicast_is_rejected_before_write(client, switch, overrides):
    response = client.post('/multicast-groups', json=group(**overrides))
    assert response.status_code == 400
    switch.bmv2.WriteEntity.assert_not_called()


def test_multicast_read_specific_group_and_not_connected(client, switch):
    assert client.get('/multicast-groups?switch_id=0&multicast_group_id=65535').json == {'entries': []}
    entity = switch.bmv2.ReadEntities.call_args.args[0][0]
    assert entity.packet_replication_engine_entry.multicast_group_entry.multicast_group_id == 65535
    assert client.get('/multicast-groups?switch_id=123').status_code == 404
    assert client.post('/multicast-groups', json=[]).status_code == 400


def test_multicast_unsupported_target_message_is_exposed(client, switch):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.UNIMPLEMENTED
    error.details = lambda: 'Multicast is not supported'
    switch.bmv2.WriteEntity.side_effect = error
    response = client.post('/multicast-groups', json=group())
    assert response.status_code == 501
    assert 'not supported' in response.json['error']


def test_multicast_empty_group_is_a_valid_configured_set_of_zero_copies(client, switch):
    assert client.post('/multicast-groups', json=group(replicas=[])).status_code == 200
    entity = switch.bmv2.WriteEntity.call_args.args[0]
    assert entity.packet_replication_engine_entry.multicast_group_entry.multicast_group_id == 23
    assert not entity.packet_replication_engine_entry.multicast_group_entry.replicas
