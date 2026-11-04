"""Run inside a live official model container with the resources sample loaded."""
import json
import os
import socket
import time
import bfrt_grpc.client as gc

priority_check = os.environ.get('UNICORN_NATIVE_PRIORITY') == 'true'
program_name = 'unicorn_priority' if priority_check else 'unicorn_resources'
interface = gc.ClientInterface(grpc_addr='127.0.0.1:50052', client_id=77, device_id=0)
interface.bind_pipeline_config(program_name)
info = interface.bfrt_info_get(program_name)
target = gc.Target(device_id=0, pipe_id=0xffff)
print(json.dumps({name: table.info.data_field_name_list_get() for name, table in info.table_dict.items() if 'Ingress.' in name}, indent=2))
forward = info.table_get('Ingress.forwarding')
if priority_check:
    # Only the lower 24 bits control precedence; the upper byte is a TCAM
    # group. Larger UI priorities 1, 2 and 2**24 map to smaller native values.
    for priority, index in ((1, 6), (2, 8), (1 << 24, 7)):
        forward.entry_add(target, [forward.make_key([
            gc.KeyTuple('intrinsic.ingress_port', 0, mask=511),
            gc.KeyTuple('$MATCH_PRIORITY', (1 << 24) - priority)])],
            [forward.make_data([gc.DataTuple('port', 1), gc.DataTuple('index', index)], 'Ingress.forward')])
else:
    forward.entry_add(target, [forward.make_key([gc.KeyTuple('intrinsic.ingress_port', 0)])],
                      [forward.make_data([gc.DataTuple('port', 1), gc.DataTuple('index', 7)], 'Ingress.forward')])
register = info.table_get('Ingress.packet_register')
key = register.make_key([gc.KeyTuple('$REGISTER_INDEX', 7)])
field = register.info.data_field_name_list_get()[0]
register.entry_add(target, [key], [register.make_data([gc.DataTuple(field, 100)])])
read = list(register.entry_get(target, [key], {'from_hw': True}))
assert all(v == 100 for v in read[0][0].to_dict()[field]), read
counter = info.table_get('Ingress.packet_counter')
ckey = counter.make_key([gc.KeyTuple('$COUNTER_INDEX', 7)])
counter.entry_mod(target, [ckey], [counter.make_data([gc.DataTuple('$COUNTER_SPEC_PKTS', 0), gc.DataTuple('$COUNTER_SPEC_BYTES', 0)])])
meter = info.table_get('Ingress.packet_meter')
mkey = meter.make_key([gc.KeyTuple('$METER_INDEX', 7)])
meter.entry_mod(target, [mkey], [meter.make_data([gc.DataTuple('$METER_SPEC_CIR_PPS', 1000000), gc.DataTuple('$METER_SPEC_PIR_PPS', 2000000), gc.DataTuple('$METER_SPEC_CBS_PKTS', 10000), gc.DataTuple('$METER_SPEC_PBS_PKTS', 20000)])])
meter_read = list(meter.entry_get(target, [mkey], {'from_hw': False}))[0][0].to_dict()
assert meter_read['$METER_SPEC_CIR_PPS'] > 0, meter_read
receiver = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
receiver.bind(('uttest1', 0))
receiver.settimeout(5)
sender = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
sender.bind(('uttest0', 0))
packet = bytes.fromhex('02000000000202000000000188b5') + b'UniCorn real Tofino model'.ljust(46, b'!')
sender.send(packet)
while True:
    received = receiver.recv(65536)
    if received == packet:
        break
register.operations_execute(target, 'Sync')
values = list(register.entry_get(target, [key], {'from_hw': True}))[0][0].to_dict()[field]
assert values[0] == 101, values
if priority_check:
    for index in (6, 8):
        unused = register.make_key([gc.KeyTuple('$REGISTER_INDEX', index)])
        assert all(value == 0 for value in list(register.entry_get(target, [unused], {'from_hw': True}))[0][0].to_dict()[field])
counter.operations_execute(target, 'Sync')
counts = list(counter.entry_get(target, [ckey], {'from_hw': True}))[0][0].to_dict()
assert counts['$COUNTER_SPEC_PKTS'] == 1, counts
assert counts['$COUNTER_SPEC_BYTES'] >= len(packet), counts
print(json.dumps({'forwarded_bytes': len(received), 'register_pipe_values': values, 'counter': counts, 'meter': meter_read,
                  'priority_check': priority_check, 'result': 'PASS'}, indent=2))
interface.tear_down_stream()
