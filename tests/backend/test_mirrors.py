from unittest.mock import Mock

import grpc
from google.rpc import status_pb2
import pytest

from controller.managers.MirrorManager import MirrorManager
from controller.p4.v1 import p4runtime_pb2 as pb
from controller.utils.switch import SwitchConnection


def payload(**overrides):
    return dict({"switch_id": 0, "session_id": 7,
                 "replicas": [{"egress_port": "2", "instance": 0}]}, **overrides)


@pytest.mark.parametrize('verb,update_type', [('post', pb.Update.INSERT), ('patch', pb.Update.MODIFY), ('delete', pb.Update.DELETE)])
def test_mirror_crud_generates_standard_pre_entities(client, switch, verb, update_type):
    response = getattr(client, verb)('/mirrors', json=payload())
    assert response.status_code == 200
    entity, actual_type = switch.bmv2.WriteEntity.call_args.args
    assert actual_type == update_type
    assert entity.WhichOneof('entity') == 'packet_replication_engine_entry'
    session = entity.packet_replication_engine_entry.clone_session_entry
    assert session.session_id == 7
    if verb == 'delete':
        assert not session.replicas
    else:
        assert session.replicas[0].egress_port == 2
        assert session.replicas[0].instance == 0


def test_mirror_get_aggregates_streams_and_distinguishes_multicast(client, switch):
    responses = []
    for id_ in (9, 2):
        response = pb.ReadResponse()
        session = response.entities.add().packet_replication_engine_entry.clone_session_entry
        session.session_id = id_
        session.replicas.add(egress_port=4294967293, instance=65535)
        session.replicas.add(port=b'\x02', instance=0)
        response.entities.add().packet_replication_engine_entry.multicast_group_entry.multicast_group_id = 1
        responses.append(response)
    switch.bmv2.ReadEntities.return_value = iter(responses)
    response = client.get('/mirrors?switch_id=0')
    assert response.status_code == 200
    assert [item['session_id'] for item in response.json['entries']] == [2, 9]
    assert response.json['entries'][0]['replicas'] == [
        {'egress_port': '2', 'instance': 0}, {'egress_port': '4294967293', 'instance': 65535}]
    selector = switch.bmv2.ReadEntities.call_args.args[0][0].packet_replication_engine_entry
    assert selector.WhichOneof('type') == 'clone_session_entry'
    assert selector.clone_session_entry.session_id == 0


def test_read_single_session_uses_key_and_empty_stream_is_valid(client, switch):
    assert client.get('/mirrors?switch_id=0&session_id=7').json == {'entries': []}
    selector = switch.bmv2.ReadEntities.call_args.args[0][0]
    assert selector.packet_replication_engine_entry.clone_session_entry.session_id == 7


@pytest.mark.parametrize('overrides', [
    {'session_id': 0}, {'session_id': 32768}, {'session_id': -1}, {'session_id': True},
    {'replicas': []}, {'replicas': [{'egress_port': '0', 'instance': 0}]},
    {'replicas': [{'egress_port': '4294967296', 'instance': 0}]},
    {'replicas': [{'egress_port': '2', 'instance': 65536}]},
    {'replicas': [{'egress_port': '2', 'instance': -1}]},
    {'replicas': [{'egress_port': '2', 'instance': 0}, {'egress_port': 2, 'instance': 0}]},
    {'replicas': ['invalid']}, {'class_of_service': 256}, {'class_of_service': -1},
    {'packet_length_bytes': -1}, {'packet_length_bytes': 65536}])
def test_mirror_validation_completes_before_any_target_write(client, switch, overrides):
    result = client.post('/mirrors', json=payload(**overrides))
    assert result.status_code == 400
    assert result.json['error']
    switch.bmv2.WriteEntity.assert_not_called()


def test_distinct_instances_of_same_port_are_valid_and_large_ports_are_lossless(client, switch):
    result = client.post('/mirrors', json=payload(replicas=[
        {'egress_port': '4294967293', 'instance': 0}, {'egress_port': '4294967293', 'instance': 1}]))
    assert result.status_code == 200
    entry = switch.bmv2.WriteEntity.call_args.args[0].packet_replication_engine_entry.clone_session_entry
    assert [(replica.egress_port, replica.instance) for replica in entry.replicas] == [(4294967293, 0), (4294967293, 1)]


def test_mirror_optional_settings_and_defaults(client, switch):
    result = client.patch('/mirrors', json=payload(class_of_service=3, packet_length_bytes=128))
    assert result.status_code == 200
    session = switch.bmv2.WriteEntity.call_args.args[0].packet_replication_engine_entry.clone_session_entry
    assert session.class_of_service == 3
    assert session.packet_length_bytes == 128


@pytest.mark.parametrize('code,status,message', [(12, 501, 'COS for clone sessions not supported yet'),
    (6, 409, 'Clone session already exists'), (5, 404, 'Clone session does not exist'),
    (2, 503, 'Error when creating clone session in target')])
def test_mirror_native_errors_are_actionable(client, switch, code, status, message):
    details = status_pb2.Status(code=2)
    details.details.add().Pack(pb.Error(canonical_code=code, message=message))
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.UNKNOWN
    error.details = lambda: ''
    error.trailing_metadata = lambda: (('grpc-status-details-bin', details.SerializeToString()),)
    switch.bmv2.WriteEntity.side_effect = error
    response = client.post('/mirrors', json=payload())
    assert response.status_code == status
    assert message in response.json['error']


def test_unknown_switch_and_malformed_json_are_rejected(client):
    assert client.get('/mirrors').status_code == 400
    assert client.get('/mirrors?switch_id=9').status_code == 404
    assert client.post('/mirrors', json=[]).status_code == 400
    assert client.delete('/mirrors', json={'switch_id': 0}).status_code == 400


def test_pre_write_passes_election_device_type_and_deadline():
    switch = SwitchConnection.__new__(SwitchConnection)
    switch.device_id, switch.client_stub = 3, Mock()
    entity = pb.Entity()
    entity.packet_replication_engine_entry.clone_session_entry.session_id = 5
    switch.WriteEntity(entity, pb.Update.DELETE)
    request = switch.client_stub.Write.call_args.args[0]
    assert request.device_id == 3
    assert request.election_id.low == 1
    assert request.updates[0].type == pb.Update.DELETE
    assert request.updates[0].entity == entity
    assert switch.client_stub.Write.call_args.kwargs['timeout'] == 15
