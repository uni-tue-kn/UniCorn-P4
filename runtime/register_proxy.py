"""Explicit server-side BMv2 RegisterEntry extension for the P4Runtime API.

Upstream PI does not implement registers. This process exposes standard
P4Runtime, forwarding other entities to PI and accessing BMv2 register memory
through its native Thrift service. See runtime/README.md for limitations.
"""
import argparse
from concurrent import futures
import json
import threading

import grpc
from google.rpc import status_pb2
from google.protobuf.message import DecodeError
from google.protobuf.struct_pb2 import Struct
from thrift.protocol import TBinaryProtocol, TMultiplexedProtocol
from thrift.transport import TSocket, TTransport

from controller.p4.v1 import p4runtime_pb2 as pb
from controller.p4.v1 import p4runtime_pb2_grpc as rpc


class RegisterError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class RegisterProxy(rpc.P4RuntimeServicer):
    def __init__(self, upstream, thrift_port, device_id, thrift_host='127.0.0.1', max_bitwidth=64):
        self.channel = grpc.insecure_channel(upstream)
        self.upstream = rpc.P4RuntimeStub(self.channel)
        self.thrift_port = thrift_port
        self.thrift_host = thrift_host
        self.max_bitwidth = max_bitwidth
        self.device_id = device_id
        self.lock = threading.RLock()

    def _call(self, method, request, context):
        try:
            result, call = method.with_call(
                request, timeout=_timeout(context), metadata=context.invocation_metadata())
            context.set_trailing_metadata(call.trailing_metadata())
            return result
        except grpc.RpcError as exc:
            context.set_trailing_metadata(exc.trailing_metadata() or ())
            context.abort(exc.code(), exc.details())

    def Capabilities(self, request, context):
        response = self._call(self.upstream.Capabilities, request, context)
        extension = Struct()
        extension.update({'source': 'unicorn-register-extension',
                          'max_bitwidth': self.max_bitwidth, 'read': True, 'write': True,
                          'default_role_only': True})
        response.experimental.Pack(extension)
        return response

    def SetForwardingPipelineConfig(self, request, context):
        with self.lock:
            return self._call(self.upstream.SetForwardingPipelineConfig, request, context)

    def GetForwardingPipelineConfig(self, request, context):
        return self._call(self.upstream.GetForwardingPipelineConfig, request, context)

    def StreamChannel(self, request_iterator, context):
        stream = self.upstream.StreamChannel(
            request_iterator, metadata=context.invocation_metadata())
        context.add_callback(stream.cancel)
        try:
            yield from stream
        except grpc.RpcError as exc:
            context.set_trailing_metadata(exc.trailing_metadata() or ())
            if context.is_active():
                context.abort(exc.code(), exc.details())

    def _client(self):
        from runtime.thrift.bm_runtime.standard import Standard
        sock = TSocket.TSocket(self.thrift_host, self.thrift_port)
        sock.setTimeout(5000)
        transport = TTransport.TBufferedTransport(sock)
        protocol = TMultiplexedProtocol.TMultiplexedProtocol(
            TBinaryProtocol.TBinaryProtocol(transport), 'standard')
        transport.open()
        return transport, Standard.Client(protocol)

    def _registers(self, client):
        request = pb.GetForwardingPipelineConfigRequest(
            device_id=self.device_id,
            response_type=pb.GetForwardingPipelineConfigRequest.P4INFO_AND_COOKIE)
        info = self.upstream.GetForwardingPipelineConfig(request, timeout=5).config.p4info
        arrays = {r['name']: r for r in json.loads(client.bm_get_config())['register_arrays']}
        result = {}
        for register in info.registers:
            spec = register.type_spec
            visited = set()
            while spec.WhichOneof('type_spec') == 'new_type':
                name = spec.new_type.name
                if name in visited or name not in info.type_info.new_types:
                    spec = None
                    break
                visited.add(name)
                definition = info.type_info.new_types[name]
                if not definition.HasField('original_type'):
                    spec = None
                    break
                spec = definition.original_type
            if spec is None:
                result[register.preamble.id] = (register, None)
                continue
            if spec.WhichOneof('type_spec') != 'bitstring':
                result[register.preamble.id] = (register, None)
                continue
            kind = spec.bitstring.WhichOneof('type_spec')
            if kind not in ('bit', 'int'):
                result[register.preamble.id] = (register, None)
                continue
            width = getattr(spec.bitstring, kind).bitwidth
            target = arrays.get(register.preamble.name)
            if target is None or target['bitwidth'] != width or not 1 <= width <= self.max_bitwidth:
                result[register.preamble.id] = (register, None)
            else:
                result[register.preamble.id] = (register, (width, kind == 'int'))
        return result

    def _select(self, entry, registers, write=False):
        if entry.register_id == 0:
            if write:
                raise RegisterError(3, 'Register writes require a register_id')
            selected = list(registers.values())
        elif entry.register_id not in registers:
            raise RegisterError(5, 'Unknown register_id')
        else:
            selected = [registers[entry.register_id]]
        for register, shape in selected:
            if shape is None:
                raise RegisterError(12, 'BMv2 register extension supports bit<W>/int<W> with 1 <= W <= ' + str(self.max_bitwidth))
            width, signed = shape
            if entry.HasField('index'):
                index = entry.index.index
                if index < 0:
                    raise RegisterError(3, 'Register index must be nonnegative')
                if index >= register.size:
                    raise RegisterError(11, 'Register index exceeds array size')
                indices = [index]
            else:
                indices = range(register.size)
            yield register, width, signed, indices

    def _read_register(self, entry, context=None):
        _ensure_active(context)
        transport, client = self._client()
        try:
            registers = self._registers(client)
            for register, width, signed, indices in self._select(entry, registers):
                for index in indices:
                    _ensure_active(context)
                    raw = client.bm_register_read(0, register.preamble.name, index)
                    value = raw & ((1 << width) - 1)
                    response = pb.ReadResponse()
                    out = response.entities.add().register_entry
                    out.register_id = register.preamble.id
                    out.index.index = index
                    if signed and value & (1 << (width - 1)):
                        value -= 1 << width
                    length = max(1, (value.bit_length() + (8 if signed else 7)) // 8)
                    out.data.bitstring = value.to_bytes(length, 'big', signed=signed)
                    while signed and len(out.data.bitstring) > 1:
                        data = out.data.bitstring
                        if (data[0] == 0 and data[1] < 128) or (data[0] == 255 and data[1] >= 128):
                            out.data.bitstring = data[1:]
                        else:
                            break
                    yield response
        finally:
            transport.close()

    def Read(self, request, context):
        if not any(e.HasField('register_entry') for e in request.entities):
            yield from self._forward_read(request, context)
            return
        if request.device_id != self.device_id:
            context.abort(grpc.StatusCode.NOT_FOUND, 'Unknown device_id')
        if request.role:
            context.abort(grpc.StatusCode.UNIMPLEMENTED,
                          'The register extension supports the default P4Runtime role only')
        with self.lock:
            for entity in request.entities:
                if entity.HasField('register_entry'):
                    try:
                        yield from self._read_register(entity.register_entry, context)
                    except RegisterError as exc:
                        context.abort(_grpc_code(exc.code), str(exc))
                    except grpc.RpcError as exc:
                        context.set_trailing_metadata(exc.trailing_metadata() or ())
                        context.abort(exc.code(), exc.details())
                    except Exception as exc:
                        context.abort(grpc.StatusCode.INTERNAL, 'BMv2 register access failed: ' + str(exc))
                else:
                    subrequest = pb.ReadRequest()
                    subrequest.CopyFrom(request)
                    del subrequest.entities[:]
                    subrequest.entities.add().CopyFrom(entity)
                    yield from self._forward_read(subrequest, context)

    def _forward_read(self, request, context):
        stream = self.upstream.Read(request, timeout=_timeout(context),
                                    metadata=context.invocation_metadata())
        context.add_callback(stream.cancel)
        try:
            yield from stream
        except grpc.RpcError as exc:
            context.set_trailing_metadata(exc.trailing_metadata() or ())
            context.abort(exc.code(), exc.details())

    def _write_register(self, update, context=None):
        _ensure_active(context)
        if update.type != pb.Update.MODIFY:
            raise RegisterError(3, 'Registers support MODIFY only')
        entry = update.entity.register_entry
        if not entry.HasField('data') or entry.data.WhichOneof('data') != 'bitstring':
            raise RegisterError(3, 'Register write requires P4Data.bitstring')
        if not entry.data.bitstring:
            raise RegisterError(3, 'Register bitstring must be nonempty')
        transport, client = self._client()
        try:
            registers = self._registers(client)
            for register, width, signed, indices in self._select(entry, registers, write=True):
                value = int.from_bytes(entry.data.bitstring, 'big', signed=signed)
                limit = 1 << (width - 1 if signed else width)
                if not (-limit if signed else 0) <= value < limit:
                    raise RegisterError(3, 'Value exceeds register bitwidth')
                value &= (1 << width) - 1
                # Thrift BmRegisterValue is signed i64; BMv2 stores its bit pattern.
                thrift_value = value if value < (1 << 63) else value - (1 << 64)
                for index in indices:
                    _ensure_active(context)
                    client.bm_register_write(0, register.preamble.name, index, thrift_value)
        finally:
            transport.close()

    def Write(self, request, context):
        if not any(u.entity.HasField('register_entry') for u in request.updates):
            return self._call(self.upstream.Write, request, context)
        if request.device_id != self.device_id:
            context.abort(grpc.StatusCode.NOT_FOUND, 'Unknown device_id')
        if request.role or request.role_id:
            context.abort(grpc.StatusCode.UNIMPLEMENTED,
                          'The register extension supports the default P4Runtime role only')
        with self.lock:
            # Let upstream enforce the device, role and current primary election.
            authorization = pb.WriteRequest()
            authorization.CopyFrom(request)
            del authorization.updates[:]
            self._call(self.upstream.Write, authorization, context)
            if request.atomicity != pb.WriteRequest.CONTINUE_ON_ERROR:
                context.abort(grpc.StatusCode.UNIMPLEMENTED,
                              'The register extension supports CONTINUE_ON_ERROR only')
            errors = []
            for update in request.updates:
                try:
                    _ensure_active(context)
                except RegisterError as exc:
                    context.abort(_grpc_code(exc.code), str(exc))
                error = pb.Error()
                try:
                    if update.entity.HasField('register_entry'):
                        self._write_register(update, context)
                    else:
                        subrequest = pb.WriteRequest()
                        subrequest.CopyFrom(authorization)
                        subrequest.updates.add().CopyFrom(update)
                        self.upstream.Write(subrequest, timeout=_timeout(context),
                                            metadata=context.invocation_metadata())
                except RegisterError as exc:
                    if exc.code in (1, 4):
                        context.abort(_grpc_code(exc.code), str(exc))
                    error.canonical_code, error.message = exc.code, str(exc)
                except grpc.RpcError as exc:
                    error.canonical_code, error.message = exc.code().value[0], exc.details()
                    for key, value in exc.trailing_metadata() or ():
                        if key == 'grpc-status-details-bin':
                            try:
                                status = status_pb2.Status.FromString(value)
                                if status.details:
                                    status.details[0].Unpack(error)
                            except (DecodeError, TypeError, ValueError):
                                pass  # Keep the original upstream code/message.
                except Exception as exc:
                    error.canonical_code, error.message = 13, str(exc)
                errors.append(error)
            if any(error.canonical_code for error in errors):
                status = status_pb2.Status(code=2, message='One or more P4Runtime updates failed')
                for error in errors:
                    status.details.add().Pack(error)
                context.set_trailing_metadata((('grpc-status-details-bin', status.SerializeToString()),))
                context.abort(grpc.StatusCode.UNKNOWN, status.message)
            return pb.WriteResponse()


def _grpc_code(code):
    return next(status for status in grpc.StatusCode if status.value[0] == code)


def _ensure_active(context):
    if context is not None and not context.is_active():
        remaining = context.time_remaining()
        expired = remaining is not None and remaining <= 0
        raise RegisterError(4 if expired else 1,
                            'Register operation deadline exceeded' if expired else 'Register operation cancelled')


def _timeout(context):
    remaining = context.time_remaining()
    # gRPC represents an absent deadline using an enormous float. Passing it
    # back as a timeout can overflow the native deadline calculation.
    return remaining if remaining is not None and remaining < 86400 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--listen', required=True)
    parser.add_argument('--upstream', required=True)
    parser.add_argument('--thrift-port', type=int, required=True)
    parser.add_argument('--thrift-host', default='127.0.0.1')
    parser.add_argument('--max-bitwidth', type=int, choices=(63, 64), default=64)
    parser.add_argument('--device-id', type=int, required=True)
    args = parser.parse_args()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=32), options=[
        ('grpc.max_receive_message_length', 64 * 1024 * 1024),
        ('grpc.max_send_message_length', 64 * 1024 * 1024)])
    rpc.add_P4RuntimeServicer_to_server(
        RegisterProxy(args.upstream, args.thrift_port, args.device_id,
                      thrift_host=args.thrift_host, max_bitwidth=args.max_bitwidth), server)
    if not server.add_insecure_port(args.listen):
        raise RuntimeError('Cannot bind register extension endpoint ' + args.listen)
    server.start()
    server.wait_for_termination()


if __name__ == '__main__':
    main()
