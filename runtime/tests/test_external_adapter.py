from unittest.mock import Mock, patch

import grpc
import pytest
from google.protobuf.struct_pb2 import Struct

from controller.managers.RegisterAdapter import RegisterAdapter
from controller.p4.v1 import p4runtime_pb2 as pb
from runtime.register_proxy import RegisterError, RegisterProxy
from runtime.tests.test_register_proxy import configure, update


@pytest.mark.parametrize('host,port', [('', 9090), (None, 9090), ('host', 0),
                                      ('host', 65536), ('host', True), ('host', '9090')])
def test_adapter_requires_explicit_valid_endpoint(host, port):
    with pytest.raises(ValueError):
        RegisterAdapter('127.0.0.1:1', host, port, 0)


def test_adapter_lifecycle_does_not_contact_thrift():
    with patch.object(RegisterProxy, '_client') as native, patch('grpc.server') as grpc_server:
        grpc_server.return_value.add_insecure_port.return_value = 12345
        adapter = RegisterAdapter('127.0.0.1:1', 'external-switch', 9090, 7)
        try:
            assert adapter.address.startswith('127.0.0.1:')
            assert adapter.proxy.thrift_host == 'external-switch'
            assert adapter.proxy.device_id == 7
            assert adapter.capabilities['max_bitwidth'] == 63
            native.assert_not_called()
        finally:
            adapter.close()
            adapter.close()
        grpc_server.return_value.stop.assert_called_once_with(grace=0)


def test_external_adapter_rejects64_before_native_memory_access():
    proxy = RegisterProxy('127.0.0.1:1', 9090, 0, 'remote', max_bitwidth=63)
    transport, client = Mock(), Mock()
    proxy._client = Mock(return_value=(transport, client))
    try:
        configure(proxy, client, 64)
        with pytest.raises(RegisterError) as error:
            proxy._write_register(update(b'\xff' * 8))
        assert error.value.code == 12
        client.bm_register_write.assert_not_called()
        configure(proxy, client, 63)
        proxy._write_register(update(b'\x7f' + b'\xff' * 7))
        client.bm_register_write.assert_called_once_with(0, 'Ingress.r', 0, (1 << 63) - 1)
    finally:
        proxy.channel.close()


def test_proxy_advertises_explicit_register_capabilities():
    proxy = RegisterProxy('127.0.0.1:1', 9090, 0, max_bitwidth=63)
    try:
        proxy._call = Mock(return_value=pb.CapabilitiesResponse(p4runtime_api_version='1.3.0'))
        result = proxy.Capabilities(pb.CapabilitiesRequest(), Mock())
        extension = Struct()
        assert result.experimental.Unpack(extension)
        assert extension['source'] == 'unicorn-register-extension'
        assert extension['max_bitwidth'] == 63
        assert extension['read'] is True and extension['write'] is True
        assert result.p4runtime_api_version == '1.3.0'
    finally:
        proxy.channel.close()


def test_official_vendored_thrift_client_imports_without_native_install():
    from runtime.thrift.bm_runtime.standard import Standard
    assert callable(Standard.Client.bm_register_read)
    assert callable(Standard.Client.bm_register_write)
