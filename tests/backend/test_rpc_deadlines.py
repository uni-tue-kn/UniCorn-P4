from unittest.mock import Mock

import grpc
import pytest

from controller.p4.config.v1 import p4info_pb2
from controller.p4.v1 import p4runtime_pb2 as pb
from controller.utils.bmv2 import Bmv2SwitchConnection


@pytest.fixture
def connection():
    connection = Bmv2SwitchConnection.__new__(Bmv2SwitchConnection)
    connection.device_id = 7
    connection.client_stub = Mock()
    connection.client_stub.Read.return_value = iter([])
    return connection


@pytest.mark.parametrize('method', ['WriteTableEntry', 'ModifyTableEntry', 'DeleteTableEntry'])
def test_existing_table_write_paths_have_deadlines(connection, method):
    getattr(connection, method)(pb.TableEntry(table_id=0x02000001))
    call = connection.client_stub.Write.call_args
    assert call.kwargs['timeout'] == 15
    assert call.args[0].device_id == 7
    assert call.args[0].election_id.low == 1


@pytest.mark.parametrize('method,args', [('ReadTableEntries', {'table_id': 0x02000001}),
    ('ReadCounters', {'counter_id': 0x12000001, 'index': 0}),
    ('ReadDirectCounters', {'table_id': 0x02000001})])
def test_existing_read_streams_have_bounded_total_duration(connection, method, args):
    assert list(getattr(connection, method)(**args)) == []
    call = connection.client_stub.Read.call_args
    assert call.kwargs['timeout'] == 15
    assert call.args[0].device_id == 7
    if method == 'ReadCounters':
        assert call.args[0].entities[0].counter_entry.HasField('index')


def test_pipeline_operations_have_longer_but_finite_deadlines(connection, tmp_path):
    path = tmp_path / 'program.json'
    path.write_text('{}')
    connection.SetForwardingPipelineConfig(p4info_pb2.P4Info(), bmv2_json_file_path=str(path))
    assert connection.client_stub.SetForwardingPipelineConfig.call_args.kwargs['timeout'] == 30
    connection.client_stub.GetForwardingPipelineConfig.return_value = pb.GetForwardingPipelineConfigResponse()
    assert connection.GetForwardingPipelineConfig() is None
    assert connection.client_stub.GetForwardingPipelineConfig.call_args.kwargs['timeout'] == 30


def test_multicast_write_uses_deadline(connection):
    entry = pb.PacketReplicationEngineEntry()
    entry.multicast_group_entry.multicast_group_id = 7
    connection.WritePREEntry(entry)
    assert connection.client_stub.Write.call_args.kwargs['timeout'] == 15


def test_pipeline_timeout_is_not_misreported_as_no_program(connection):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.DEADLINE_EXCEEDED
    connection.client_stub.GetForwardingPipelineConfig.side_effect = error
    with pytest.raises(grpc.RpcError):
        connection.GetForwardingPipelineConfig()
