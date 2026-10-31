from unittest.mock import Mock

import grpc
import pytest

from controller.p4.config.v1 import p4info_pb2
from controller.p4.v1 import p4runtime_pb2 as pb
from runtime.register_proxy import RegisterError, RegisterProxy


@pytest.fixture
def proxy():
    proxy = RegisterProxy('127.0.0.1:1', 9090, 0)
    transport, client = Mock(), Mock()
    proxy._client = Mock(return_value=(transport, client))
    return proxy, transport, client


def configure(proxy, client, width=64, signed=False):
    info = p4info_pb2.P4Info()
    reg = info.registers.add(size=8)
    reg.preamble.id = 0x16000001
    reg.preamble.name = 'Ingress.r'
    getattr(reg.type_spec.bitstring, 'int' if signed else 'bit').bitwidth = width
    proxy.upstream = Mock()
    proxy.upstream.GetForwardingPipelineConfig.return_value.config.p4info = info
    client.bm_get_config.return_value = (
        '{"register_arrays":[{"name":"Ingress.r","bitwidth":%d}]}' % width)
    return reg


def update(value, index=0):
    update = pb.Update(type=pb.Update.MODIFY)
    reg = update.entity.register_entry
    reg.register_id = 0x16000001
    reg.index.index = index
    reg.data.bitstring = value
    return update


def test_uint64_full_precision_and_zero_index(proxy):
    server, transport, client = proxy
    configure(server, client)
    server._write_register(update(b'\xff' * 8))
    client.bm_register_write.assert_called_once_with(0, 'Ingress.r', 0, -1)
    client.bm_register_read.return_value = -1
    results = list(server._read_register(update(b'\x00').entity.register_entry))
    assert results[0].entities[0].register_entry.data.bitstring == b'\xff' * 8
    assert results[0].entities[0].register_entry.HasField('index')
    transport.close.assert_called()


@pytest.mark.parametrize('width,data,stored', [(7, b'\xff', 127), (9, b'\xff\x00', 256),
                                             (9, b'\x00\xff', 255), (64, b'\x80' + b'\0'*7, -(1<<63))])
def test_signed_canonical_bytes(proxy, width, data, stored):
    server, _, client = proxy
    configure(server, client, width, True)
    server._write_register(update(data))
    client.bm_register_write.assert_called_once_with(0, 'Ingress.r', 0, stored)
    client.bm_register_read.return_value = stored
    result = list(server._read_register(update(b'\0').entity.register_entry))
    assert result[0].entities[0].register_entry.data.bitstring == data


@pytest.mark.parametrize('index,code', [(-1, 3), (8, 11)])
def test_index_rejection_before_write(proxy, index, code):
    server, _, client = proxy
    configure(server, client)
    with pytest.raises(RegisterError) as exc:
        server._write_register(update(b'\x01', index))
    assert exc.value.code == code
    client.bm_register_write.assert_not_called()


def test_unsupported_width_and_overflow(proxy):
    server, _, client = proxy
    configure(server, client, 128)
    with pytest.raises(RegisterError) as exc:
        server._write_register(update(b'\1'))
    assert exc.value.code == 12
    configure(server, client, 7)
    with pytest.raises(RegisterError) as exc:
        server._write_register(update(b'\x80'))
    assert exc.value.code == 3
    client.bm_register_write.assert_not_called()


def test_wildcard_is_not_index_zero(proxy):
    server, _, client = proxy
    configure(server, client, 32)
    entry = update(b'\x2a').entity.register_entry
    entry.ClearField('index')
    request = pb.Update(type=pb.Update.MODIFY)
    request.entity.register_entry.CopyFrom(entry)
    server._write_register(request)
    assert client.bm_register_write.call_count == 8


def test_insert_and_missing_data_rejected(proxy):
    server, _, client = proxy
    configure(server, client)
    request = update(b'\0')
    request.type = pb.Update.INSERT
    with pytest.raises(RegisterError):
        server._write_register(request)
    request.type = pb.Update.MODIFY
    request.entity.register_entry.ClearField('data')
    with pytest.raises(RegisterError):
        server._write_register(request)
    client.bm_register_write.assert_not_called()


def test_register_write_checks_upstream_primary_before_memory_access(proxy):
    server, _, client = proxy
    context = Mock()
    context.time_remaining.return_value = 5
    context.invocation_metadata.return_value = ()
    error = Mock(spec=grpc.RpcError)
    # RpcError itself is an exception; give it the same accessors as real gRPC.
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.PERMISSION_DENIED
    error.details = lambda: 'Not primary'
    error.trailing_metadata = lambda: ()
    server.upstream = Mock()
    server.upstream.Write.with_call.side_effect = error
    context.abort.side_effect = RuntimeError('aborted')
    request = pb.WriteRequest(device_id=0)
    request.election_id.low = 1
    request.updates.add().CopyFrom(update(b'\x2a'))
    with pytest.raises(RuntimeError, match='aborted'):
        server.Write(request, context)
    context.abort.assert_called_once_with(grpc.StatusCode.PERMISSION_DENIED, 'Not primary')
    server._client.assert_not_called()
    auth_request = server.upstream.Write.with_call.call_args.args[0]
    assert auth_request.election_id.low == 1
    assert len(auth_request.updates) == 0


def test_invalid_write_returns_p4runtime_per_update_details(proxy):
    server, _, client = proxy
    configure(server, client)
    context = Mock()
    context.time_remaining.return_value = 5
    context.invocation_metadata.return_value = ()
    server.upstream.Write.with_call.return_value = (pb.WriteResponse(), Mock())
    context.abort.side_effect = RuntimeError('aborted')
    request = pb.WriteRequest(device_id=0)
    request.election_id.low = 1
    request.updates.add().CopyFrom(update(b'\1', index=8))
    with pytest.raises(RuntimeError, match='aborted'):
        server.Write(request, context)
    from google.rpc import status_pb2
    metadata = context.set_trailing_metadata.call_args.args[0]
    status = status_pb2.Status.FromString(dict(metadata)['grpc-status-details-bin'])
    detail = pb.Error()
    assert status.details[0].Unpack(detail)
    assert detail.canonical_code == 11


class Aborted(RuntimeError):
    pass


def rpc_context():
    context = Mock()
    context.time_remaining.return_value = 5
    context.invocation_metadata.return_value = ()
    context.is_active.return_value = True
    context.abort.side_effect = Aborted('aborted')
    return context


@pytest.mark.parametrize('atomicity', [pb.WriteRequest.ROLLBACK_ON_ERROR, pb.WriteRequest.DATAPLANE_ATOMIC])
def test_atomic_write_is_rejected_before_native_access(proxy, atomicity):
    server, _, _ = proxy
    server.upstream = Mock()
    server.upstream.Write.with_call.return_value = (pb.WriteResponse(), Mock())
    request = pb.WriteRequest(device_id=0, atomicity=atomicity)
    request.updates.add().CopyFrom(update(b'\x01'))
    context = rpc_context()
    with pytest.raises(Aborted):
        server.Write(request, context)
    assert context.abort.call_args.args[0] == grpc.StatusCode.UNIMPLEMENTED
    server._client.assert_not_called()


def test_register_write_wrong_device_does_not_touch_native_memory(proxy):
    server, _, _ = proxy
    request = pb.WriteRequest(device_id=2)
    request.updates.add().CopyFrom(update(b'\x01'))
    context = rpc_context()
    with pytest.raises(Aborted):
        server.Write(request, context)
    assert context.abort.call_args.args[0] == grpc.StatusCode.NOT_FOUND
    server._client.assert_not_called()


@pytest.mark.parametrize('write', [False, True])
def test_custom_roles_cannot_bypass_resource_permissions(proxy, write):
    server, _, _ = proxy
    context = rpc_context()
    with pytest.raises(Aborted):
        if write:
            request = pb.WriteRequest(device_id=0, role='restricted')
            request.updates.add().CopyFrom(update(b'\x01'))
            server.Write(request, context)
        else:
            request = pb.ReadRequest(device_id=0, role='restricted')
            request.entities.add().register_entry.register_id = 0x16000001
            list(server.Read(request, context))
    assert context.abort.call_args.args[0] == grpc.StatusCode.UNIMPLEMENTED
    server._client.assert_not_called()


@pytest.mark.parametrize('expired,code', [(False, 1), (True, 4)])
def test_cancelled_wildcard_write_stops_between_cells(proxy, expired, code):
    server, transport, client = proxy
    configure(server, client, 32)
    context = rpc_context()
    context.time_remaining.return_value = 0 if expired else 5
    client.bm_register_write.side_effect = lambda *_: setattr(context.is_active, 'return_value', False)
    request = update(b'\x01')
    request.entity.register_entry.ClearField('index')
    with pytest.raises(RegisterError) as exc:
        server._write_register(request, context)
    assert exc.value.code == code
    assert client.bm_register_write.call_count == 1
    transport.close.assert_called_once()


def test_cancelled_wildcard_read_closes_transport_and_stops_iteration(proxy):
    server, transport, client = proxy
    configure(server, client, 32)
    client.bm_register_read.return_value = 42
    context = rpc_context()
    entry = update(b'\x00').entity.register_entry
    entry.ClearField('index')
    stream = server._read_register(entry, context)
    assert next(stream).entities[0].register_entry.index.index == 0
    context.is_active.return_value = False
    with pytest.raises(RegisterError) as exc:
        next(stream)
    assert exc.value.code == 1
    assert client.bm_register_read.call_count == 1
    transport.close.assert_called_once()


def test_mixed_batch_reports_success_and_each_failure_in_order(proxy):
    from google.rpc import status_pb2
    server, _, client = proxy
    configure(server, client, 32)
    server.upstream.Write.with_call.return_value = (pb.WriteResponse(), Mock())
    upstream_details = status_pb2.Status(code=2)
    upstream_details.details.add().Pack(pb.Error(canonical_code=3, message='bad table entry'))
    upstream_error = grpc.RpcError()
    upstream_error.code = lambda: grpc.StatusCode.UNKNOWN
    upstream_error.details = lambda: 'batch failed'
    upstream_error.trailing_metadata = lambda: (('grpc-status-details-bin', upstream_details.SerializeToString()),)
    server.upstream.Write.side_effect = upstream_error
    request = pb.WriteRequest(device_id=0)
    request.election_id.low = 7
    request.updates.add().CopyFrom(update(b'\x2a'))
    request.updates.add().CopyFrom(update(b'\x01', index=8))
    request.updates.add(type=pb.Update.INSERT).entity.table_entry.table_id = 0x02000001
    context = rpc_context()
    with pytest.raises(Aborted):
        server.Write(request, context)
    client.bm_register_write.assert_called_once_with(0, 'Ingress.r', 0, 42)
    metadata = dict(context.set_trailing_metadata.call_args.args[0])
    actual = status_pb2.Status.FromString(metadata['grpc-status-details-bin'])
    errors = []
    for detail in actual.details:
        error = pb.Error()
        assert detail.Unpack(error)
        errors.append(error.canonical_code)
    assert errors == [0, 11, 3]
    assert server.upstream.Write.call_args.args[0].election_id.low == 7


def test_cyclic_new_type_is_unsupported_instead_of_hanging(proxy):
    server, _, client = proxy
    register = configure(server, client, 32)
    register.type_spec.Clear()
    register.type_spec.new_type.name = 'Cycle'
    info = server.upstream.GetForwardingPipelineConfig.return_value.config.p4info
    info.type_info.new_types['Cycle'].original_type.new_type.name = 'Cycle'
    with pytest.raises(RegisterError) as error:
        server._write_register(update(b'\x01'))
    assert error.value.code == 12
    client.bm_register_write.assert_not_called()
