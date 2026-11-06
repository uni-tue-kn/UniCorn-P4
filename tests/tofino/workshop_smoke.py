"""Exercise the user's unmodified workshop P4 on an actual Tofino1 model."""
import json
import select
import socket
import struct
import time
import bfrt_grpc.client as gc

interface = gc.ClientInterface(grpc_addr='127.0.0.1:50052', client_id=88, device_id=0)
interface.bind_pipeline_config('tofino_workshop')
info = interface.bfrt_info_get('tofino_workshop')
target = gc.Target(device_id=0, pipe_id=0xffff)
ip_dst = 0x0a000002
ip_src = 0x0a000001


def prefix(table):
    return table.make_key([gc.KeyTuple('hdr.ipv4.dst_addr', ip_dst, prefix_len=32)])


def put(table, key, data):
    try:
        table.entry_del(target, [key])
    except Exception:
        pass
    table.entry_add(target, [key], [data])


ip = info.table_get('ingress.ip_c.ip_forward')
put(ip, prefix(ip), ip.make_data([gc.DataTuple('port', 0)], 'ingress.ip_c.ipv4_forward'))
count = info.table_get('ingress.counter_c.mat_flow_counter')
put(count, prefix(count), count.make_data([gc.DataTuple('$COUNTER_SPEC_PKTS', 0)], 'ingress.counter_c.count'))
meter = info.table_get('ingress.meter_c.flow_meter_instance')
meter_key = prefix(meter)
meter_data = meter.make_data([
    gc.DataTuple('$METER_SPEC_CIR_KBPS', 1000000), gc.DataTuple('$METER_SPEC_PIR_KBPS', 2000000),
    gc.DataTuple('$METER_SPEC_CBS_KBITS', 10000), gc.DataTuple('$METER_SPEC_PBS_KBITS', 20000)], 'ingress.meter_c.set_color_direct')
put(meter, meter_key, meter_data)
meter_read = list(meter.entry_get(target, [meter_key], {'from_hw': False}))[0][0].to_dict()
random = info.table_get('ingress.random_c.load_balance')
for value in range(4):
    put(random, random.make_key([gc.KeyTuple('ig_md.random', value)]),
        random.make_data([gc.DataTuple('port', value % 2)], 'ingress.random_c.set_egress_port_balanced'))
# Seed both timestamp halves with max values: real packet processing must overwrite.
for name, bits in [('lower_last_ts_series', 32), ('higher_last_ts_series', 16), ('next_time_series_index', 32)]:
    table = info.table_get('ingress.register_c.' + name)
    field = table.info.data_field_name_list_get()[0]
    table.entry_mod(target, [table.make_key([gc.KeyTuple('$REGISTER_INDEX', 0)])],
                    [table.make_data([gc.DataTuple(field, 0 if name == 'next_time_series_index' else (1 << bits) - 1)])])


def checksum(data):
    values = struct.unpack('!' + 'H' * (len(data) // 2), data)
    value = sum(values)
    while value >> 16:
        value = (value & 0xffff) + (value >> 16)
    return (~value) & 0xffff


def packet(identification, udp=False):
    payload = b'Unmodified workshop model test!'
    transport = struct.pack('!HHHH', 1000, 2000, len(payload) + 8, 0) + payload if udp else payload
    header = struct.pack('!BBHHHBBHII', 0x45, 0, len(transport) + 20, identification, 0, 64, 17 if udp else 1, 0, ip_src, ip_dst)
    header = header[:10] + struct.pack('!H', checksum(header)) + header[12:]
    return (bytes.fromhex('0200000000020200000000010800') + header + transport).ljust(60, b'\0')


receivers = []
for name in ['uttest0', 'uttest1']:
    receiver = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
    receiver.bind((name, 0))
    receiver.setblocking(False)
    receivers.append(receiver)
sender = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
sender.bind(('uttest0', 0))


def send_receive(identity, udp=False, expect=True):
    sender.send(packet(identity, udp))
    deadline = time.monotonic() + (4 if expect else 0.6)
    while time.monotonic() < deadline:
        ready, _, _ = select.select(receivers, [], [], min(0.1, deadline - time.monotonic()))
        for receiver in ready:
            received = receiver.recv(65536)
            if len(received) < 34 or received[12:14] != b'\x08\x00':
                continue
            if struct.unpack('!H', received[18:20])[0] == identity and received[22] == 63:
                assert checksum(received[14:34]) == 0, 'IPv4 checksum not updated'
                assert expect, 'Red meter packet was unexpectedly forwarded'
                return receivers.index(receiver)
    assert not expect, f'No forwarded IPv4 packet {identity}'


random_ports = [send_receive(100 + n) for n in range(16)]
assert set(random_ports) == {0, 1}, random_ports
# Native hash compute gives the exact configured CRC output for the same tuple.
hash_compute = info.table_get('ingress.hash_c.c_hash.compute')
hash_key = hash_compute.make_key([gc.KeyTuple('hdr.ipv4.dst_addr', ip_dst), gc.KeyTuple('hdr.ipv4.src_addr', ip_src),
                                  gc.KeyTuple('hdr.udp.src_port', 1000), gc.KeyTuple('hdr.udp.dst_port', 2000)])
hash_value = list(hash_compute.entry_get(target, [hash_key]))[0][0].to_dict()['hash_value']
hash_table = info.table_get('ingress.hash_c.load_balance_hash')
put(hash_table, hash_table.make_key([gc.KeyTuple('ig_md.hash', hash_value)]),
    hash_table.make_data([gc.DataTuple('port', 1)], 'ingress.hash_c.set_egress_port_balanced'))
assert send_receive(200, udp=True) == 1
learn = info.learn_get('SwitchIngressDeparser.control_plane_digest')
digest = interface.digest_get(timeout=10)
digest_values = [data.to_dict() for data in learn.make_data_list(digest)]
assert any(int(value['dst_addr']) == ip_dst and int(value['ingress_mac_timestamp']) > 0 for value in digest_values), digest_values
registers = {}
for name in ['lower_last_ts_series', 'higher_last_ts_series', 'next_time_series_index']:
    table = info.table_get('ingress.register_c.' + name)
    table.operations_execute(target, 'Sync')
    field = table.info.data_field_name_list_get()[0]
    registers[name] = list(table.entry_get(target, [table.make_key([gc.KeyTuple('$REGISTER_INDEX', 0)])], {'from_hw': True}))[0][0].to_dict()[field]
assert registers['lower_last_ts_series'][0] not in [0, 0xffffffff], registers
assert registers['higher_last_ts_series'][0] != 0xffff, registers
assert registers['next_time_series_index'][0] == 17, registers
count.operations_execute(target, 'SyncCounters')
count_data = list(count.entry_get(target, [prefix(count)], {'from_hw': True}))[0][0].to_dict()
assert count_data['$COUNTER_SPEC_PKTS'] == 17, count_data
# Zero bursts/rates force red: test the original meter-controlled drop path.
meter.entry_mod(target, [meter_key], [meter.make_data([
    gc.DataTuple('$METER_SPEC_CIR_KBPS', 0), gc.DataTuple('$METER_SPEC_PIR_KBPS', 0),
    gc.DataTuple('$METER_SPEC_CBS_KBITS', 0), gc.DataTuple('$METER_SPEC_PBS_KBITS', 0)], 'ingress.meter_c.set_color_direct')])
send_receive(300, expect=False)
print(json.dumps({'result': 'PASS', 'random_forward_ports': random_ports, 'hash_value': hash_value,
                  'registers': registers, 'direct_counter': count_data, 'direct_meter': meter_read,
                  'digests': digest_values, 'red_meter_drop': True}, indent=2))
interface.tear_down_stream()
