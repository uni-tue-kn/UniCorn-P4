"""Run only against a disposable official model with an exclusive BF-RT client.

Example: PYTHONPATH=backend:. python tests/tofino/adapter_smoke.py \
    --address 127.0.0.1:50052 --program tofino_workshop --suite workshop \
    --interface uttest0
"""
import argparse
import json
import socket
import struct
import time

import grpc

from controller.targets.tofino import TofinoTarget


def upsert(switch, value):
    entry = switch.create_table_entry(value, False)
    try:
        switch.write_table_entry(entry)
    except grpc.RpcError as error:
        if error.code() != grpc.StatusCode.ALREADY_EXISTS:
            raise
        from controller.targets.bfrt_proto import bfruntime_pb2 as pb
        switch.client.write([entry.entry], pb.Update.MODIFY)


def packet(interface):
    payload = b'UniCorn native BFRT adapter proof'
    header = struct.pack('!BBHHHBBHII', 0x45, 0, len(payload) + 20, 999, 0, 64, 1, 0, 0x0a000001, 0x0a000002)
    checksum = sum(struct.unpack('!10H', header))
    while checksum >> 16:
        checksum = (checksum & 65535) + (checksum >> 16)
    header = header[:10] + struct.pack('!H', (~checksum) & 65535) + header[12:]
    raw = (bytes.fromhex('0200000000020200000000010800') + header + payload).ljust(60, b'\0')
    with socket.socket(socket.AF_PACKET, socket.SOCK_RAW) as sender:
        sender.bind((interface, 0))
        sender.send(raw)


def workshop(switch, interface):
    metadata = switch.get_loaded_config()
    for name, action, params in (
        ('pipe.ingress.ip_c.ip_forward', 'ingress.ip_c.ipv4_forward', {'port': '0'}),
        ('pipe.ingress.counter_c.mat_flow_counter', 'ingress.counter_c.count', {}),
        ('pipe.ingress.meter_c.flow_meter_instance', 'ingress.meter_c.set_color_direct', {}),
    ):
        upsert(switch, {'table_name': name, 'match_fields': {'hdr.ipv4.dst_addr': ['167772162', 32]},
                        'action_name': action, 'action_params': params, 'priority': None})
    widths = []
    for resource in metadata['registers'].values():
        width = resource['type']['bitwidth']
        widths.append(width)
        index = resource['size'] - 1
        old = switch.resources.read('register', resource['id'], index=index)['entries']
        expected = str((1 << width) - 1)
        try:
            switch.resources.write('register', resource['id'], [{'index': index, 'value': expected}])
            assert switch.resources.read('register', resource['id'], index=index)['entries'][0]['value'] == expected
        finally:
            switch.resources.write('register', resource['id'], old)
    for resource in metadata['direct_counters'].values():
        rows = switch.get_table_entries(resource['name'])[resource['name']]
        default = next(row['switch_entry'] for row in rows if row['switch_entry']['is_default_action'])
        normal = next(row['switch_entry'] for row in rows if not row['switch_entry']['is_default_action'])
        assert switch.reset_direct_counter(resource['id'], normal) == 1
        try:
            switch.reset_direct_counter(resource['id'], default)
            raise AssertionError('Unsafe default-entry counter reset was accepted')
        except grpc.RpcError as error:
            assert error.code() == grpc.StatusCode.UNIMPLEMENTED
    for resource in metadata['direct_meters'].values():
        assert resource['rate_unit'] == 'kilobits_per_second'
        row = next(row for row in switch.resources.read_direct(resource['id'])['entries'] if not row['table_entry']['is_default_action'])
        switch.resources.write_direct(resource['id'], [dict(row, config={'cir': '100000000', 'pir': '100000000', 'cburst': '1000000', 'pburst': '1000000'})])
        actual = next(row for row in switch.resources.read_direct(resource['id'])['entries'] if not row['table_entry']['is_default_action'])
        assert int(actual['config']['cir']) > 0
    digest_count = 0
    if interface:
        packet(interface)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            events = switch.manager('digests').events()['events']
            if events:
                values = events[-1]['data'][0]['fields']
                assert values['dst_addr']['decimal'] == '167772162'
                assert values['ingress_mac_timestamp']['bitwidth'] == 48
                assert int(values['ingress_mac_timestamp']['decimal']) > 0
                assert switch.manager('digests').events()['stream']['active'] is True
                digest_count = len(events)
                break
            time.sleep(.1)
        assert digest_count
    return {'register_widths': widths, 'direct_counter_tables': len(metadata['direct_counters']),
            'direct_meters': len(metadata['direct_meters']), 'digest_events': digest_count}


def resources(switch):
    metadata = switch.get_loaded_config()
    register = next(iter(metadata['registers'].values()))
    old = switch.resources.read('register', register['id'], index=8)['entries']
    try:
        switch.resources.write('register', register['id'], [{'index': 8, 'value': '123'}])
        assert switch.resources.read('register', register['id'], index=8)['entries'][0]['value'] == '123'
    finally:
        switch.resources.write('register', register['id'], old)
    meter = next(iter(metadata['meters'].values()))
    switch.resources.write('meter', meter['id'], [{'index': 8, 'config': {'cir': '1000000', 'pir': '2000000', 'cburst': '10000', 'pburst': '20000'}}])
    assert int(switch.resources.read('meter', meter['id'], index=8)['entries'][0]['config']['cir']) > 0
    counter = next(iter(metadata['counters'].values()))
    switch.get_counter_values(counter['id'], 8)
    assert switch.reset_counter(counter['id'], 8) == 1
    mirror = switch.manager('mirrors')
    mirror_id = next(value for value in range(1, 1000) if value not in {row['session_id'] for row in mirror.read()['entries']})
    try:
        mirror.write({'session_id': mirror_id, 'replicas': [{'egress_port': '1', 'instance': 0}]}, 1)
        assert mirror.read(mirror_id)['entries'][0]['replicas'] == [{'egress_port': '1', 'instance': 0}]
    finally:
        mirror.write({'session_id': mirror_id}, 3)
    multicast = switch.manager('multicast')
    group_id = next(value for value in range(1, 1000) if value not in {row['multicast_group_id'] for row in multicast.read()['entries']})
    try:
        multicast.write({'multicast_group_id': group_id, 'replicas': [{'egress_port': '1', 'instance': 7}]}, 1)
        assert multicast.read(group_id)['entries'][0]['replicas'] == [{'egress_port': '1', 'instance': 7}]
        multicast.write({'multicast_group_id': group_id, 'replicas': [{'egress_port': '1', 'instance': 8}]}, 2)
        assert multicast.read(group_id)['entries'][0]['replicas'][0]['instance'] == 8
    finally:
        multicast.write({'multicast_group_id': group_id}, 3)
    assert not multicast.owned_nodes
    queues = switch.manager('queues')
    queues.write({'port': 0, 'rate_pps': '1000000', 'burst_packets': '10000'})
    assert queues.snapshot(0)['configuration']['ports'][0]['rate_pps'] == '1000000'
    queues.write({'port': 0, 'rate_pps': '0'})
    return {'register': True, 'counter': True, 'meter': True, 'mirror': True, 'multicast': True, 'port_pps_shaper': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--address', default='127.0.0.1:50052')
    parser.add_argument('--program', required=True)
    parser.add_argument('--suite', choices=('resources', 'workshop'), required=True)
    parser.add_argument('--client-id', type=int, default=89)
    parser.add_argument('--interface')
    args = parser.parse_args()
    switch = TofinoTarget(17, {'name': 'adapter-proof', 'address': args.address, 'device_id': 17,
        'target': 'tofino', 'target_options': {'runtime_device_id': 0, 'client_id': args.client_id, 'pipe_id': 0, 'program_name': args.program}})
    try:
        switch.connect()
        result = workshop(switch, args.interface) if args.suite == 'workshop' else resources(switch)
        print(json.dumps({'result': 'PASS', 'scope': switch.scope, **result}, indent=2))
    finally:
        switch.shutdown()


if __name__ == '__main__':
    main()
