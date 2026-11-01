"""Security bounds remain active with BMv2's older generated Python clients."""
import pytest
from thrift.Thrift import TMessageType, TType
from thrift.protocol import TBinaryProtocol, TMultiplexedProtocol
from thrift.protocol.TProtocol import TProtocolException
from thrift.transport.TTransport import TMemoryBuffer, TTransportException

from runtime.thrift.bm_runtime.standard import Standard
from runtime.thrift.sswitch_runtime import SimpleSwitch


def reply(method):
    buffer = TMemoryBuffer()
    protocol = TBinaryProtocol.TBinaryProtocol(buffer)
    protocol.writeMessageBegin(method, TMessageType.REPLY, 0)
    protocol.writeStructBegin(method + '_result')
    return buffer, protocol


def client(client_type, service, payload):
    protocol = TMultiplexedProtocol.TMultiplexedProtocol(
        TBinaryProtocol.TBinaryProtocol(TMemoryBuffer(payload)), service)
    return client_type(protocol)


@pytest.mark.parametrize('client_type,service,method', [
    (Standard.Client, 'standard', 'bm_get_config'),
    (SimpleSwitch.Client, 'simple_switch', 'set_egress_queue_depth'),
])
def test_native_clients_reject_oversized_fields_before_reading_the_body(client_type, service, method):
    buffer, protocol = reply(method)
    # A normal config result and an unknown queue-result field both need limits.
    protocol.writeFieldBegin('success', TType.STRING, 0)
    protocol.writeI32(16_384_001)
    with pytest.raises(TTransportException) as error:
        getattr(client(client_type, service, buffer.getvalue()), 'recv_' + method)()
    assert error.value.type == TTransportException.SIZE_LIMIT


def test_native_client_limits_recursion_when_skipping_unknown_fields():
    buffer, protocol = reply('bm_register_read')
    for _ in range(70):
        protocol.writeFieldBegin('future', TType.STRUCT, 99)
        protocol.writeStructBegin('future')
    for _ in range(70):
        protocol.writeFieldStop()
        protocol.writeStructEnd()
        protocol.writeFieldEnd()
    protocol.writeFieldStop()
    protocol.writeStructEnd()
    protocol.writeMessageEnd()
    with pytest.raises(TProtocolException) as error:
        client(Standard.Client, 'standard', buffer.getvalue()).recv_bm_register_read()
    assert error.value.type == TProtocolException.DEPTH_LIMIT


def test_native_client_rejects_invalid_field_types():
    buffer, protocol = reply('bm_register_read')
    protocol.writeFieldBegin('invalid', 99, 99)
    protocol.writeFieldStop()
    protocol.writeStructEnd()
    protocol.writeMessageEnd()
    with pytest.raises(TProtocolException) as error:
        client(Standard.Client, 'standard', buffer.getvalue()).recv_bm_register_read()
    assert error.value.type == TProtocolException.INVALID_DATA
