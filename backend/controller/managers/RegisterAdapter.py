"""Explicit connection-scoped P4Runtime compatibility server for external BMv2.

The caller must supply the native Thrift endpoint. No remote ports or register
contents are probed during construction; ordinary RPCs still go to P4Runtime.
"""
from concurrent import futures

import grpc

from runtime.register_proxy import RegisterProxy
from ..p4.v1 import p4runtime_pb2_grpc as rpc


class RegisterAdapter:
    def __init__(self, upstream, thrift_host, thrift_port, device_id, max_bitwidth=63):
        if not isinstance(thrift_host, str) or not thrift_host.strip():
            raise ValueError('Explicit BMv2 Thrift host is required for the register adapter')
        if isinstance(thrift_port, bool) or not isinstance(thrift_port, int) or not 1 <= thrift_port <= 65535:
            raise ValueError('BMv2 Thrift port must be an integer between 1 and 65535')
        if max_bitwidth != 63:
            raise ValueError('External register adapters support at most 63 bits')
        self.proxy = RegisterProxy(upstream, thrift_port, device_id,
                                   thrift_host=thrift_host.strip(), max_bitwidth=63)
        self.server = grpc.server(futures.ThreadPoolExecutor(max_workers=32), options=[
            ('grpc.max_receive_message_length', 64 * 1024 * 1024),
            ('grpc.max_send_message_length', 64 * 1024 * 1024)])
        rpc.add_P4RuntimeServicer_to_server(self.proxy, self.server)
        try:
            port = self.server.add_insecure_port('127.0.0.1:0')
        except Exception:
            self.proxy.channel.close()
            raise
        if not port:
            self.proxy.channel.close()
            raise RuntimeError('Cannot bind the local register adapter endpoint')
        self.address = '127.0.0.1:' + str(port)
        self.capabilities = {'source': 'adapter', 'available': True, 'read': True,
                             'write': True, 'max_bitwidth': 63, 'types': ['bit', 'int'],
                             'default_role_only': True}
        self._closed = False
        try:
            self.server.start()
        except Exception:
            self.close()
            raise

    def close(self):
        if not self._closed:
            self._closed = True
            self.server.stop(grace=0).wait(timeout=5)
            self.proxy.channel.close()
