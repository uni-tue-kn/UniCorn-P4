"""Run against a disposable switch endpoint; installs the provided test pipeline.

python -m runtime.tests.live_probe HOST:PORT FILE.p4info.txt FILE.json
"""
import argparse
import grpc
from google.rpc import status_pb2

from controller.p4.v1 import p4runtime_pb2 as pb
from controller.utils.bmv2 import Bmv2SwitchConnection
from controller.utils.helper import P4InfoHelper


def run(endpoint, info_path, json_path):
    helper = P4InfoHelper(info_path)
    switch = Bmv2SwitchConnection(name='register-live-probe', address=endpoint, device_id=0)
    try:
        grpc.channel_ready_future(switch.channel).result(timeout=15)
        request = pb.WriteRequest(device_id=0)
        request.election_id.low = 1
        update = request.updates.add(type=pb.Update.MODIFY)
        update.entity.register_entry.register_id = helper.p4info.registers[0].preamble.id
        update.entity.register_entry.index.index = 0
        update.entity.register_entry.data.bitstring = b'\x01'
        try:
            switch.client_stub.Write(request, timeout=5)
            raise AssertionError('Write succeeded without primary arbitration')
        except grpc.RpcError as error:
            assert error.code() == grpc.StatusCode.PERMISSION_DENIED, error
        assert switch.MasterArbitrationUpdate().arbitration.status.code == 0
        switch.SetForwardingPipelineConfig(helper.p4info, bmv2_json_file_path=json_path)
        for register in helper.p4info.registers:
            spec = register.type_spec.bitstring
            kind = spec.WhichOneof('type_spec')
            width = getattr(spec, kind).bitwidth
            if width > 64:
                continue
            signed = kind == 'int'
            values = ([0, -1, -(1 << (width - 1)), (1 << (width - 1)) - 1]
                      if signed else [0, (1 << width) - 1])
            for value in values:
                data = value.to_bytes(max(1, (width + 7) // 8), 'big', signed=signed)
                entry = update.entity.register_entry
                entry.register_id = register.preamble.id
                entry.data.bitstring = data
                switch.client_stub.Write(request, timeout=5)
                read = pb.ReadRequest(device_id=0)
                wanted = read.entities.add().register_entry
                wanted.register_id = register.preamble.id
                wanted.index.index = 0
                actual = [entity.register_entry for response in switch.client_stub.Read(read, timeout=5)
                          for entity in response.entities]
                assert len(actual) == 1
                assert int.from_bytes(actual[0].data.bitstring, 'big', signed=signed) == value
            print(f'PASS {register.preamble.name}: {kind}<{width}> index0 round trips')
        update.entity.register_entry.index.index = register.size
        try:
            switch.client_stub.Write(request, timeout=5)
            raise AssertionError('Out-of-range write succeeded')
        except grpc.RpcError as error:
            details = dict(error.trailing_metadata())['grpc-status-details-bin']
            status = status_pb2.Status.FromString(details)
            item_error = pb.Error()
            status.details[0].Unpack(item_error)
            assert item_error.canonical_code == 11
        print('PASS primary authorization and structured OUT_OF_RANGE error')
    finally:
        switch.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('endpoint')
    parser.add_argument('p4info')
    parser.add_argument('bmv2_json')
    args = parser.parse_args()
    run(args.endpoint, args.p4info, args.bmv2_json)
