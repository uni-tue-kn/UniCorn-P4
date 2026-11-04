"""Drive the unmodified workshop through UniCorn APIs and real Mininet packets.

Run after compiling and initializing the workshop on s1 in mixed-topology.json.
This helper can also supply traffic for Playwright's native resource tests.
"""
import argparse
import json
import socket
import subprocess
import time
from urllib import parse, request


def run(base_url, container, count=3, receiver='h2', egress_port=1):
    def api(method, path, body=None, **query):
        url = base_url.rstrip('/') + '/api' + path
        if query:
            url += '?' + parse.urlencode(query)
        call = request.Request(url, method=method, headers={'Content-Type': 'application/json'},
                               data=None if body is None else json.dumps(body).encode())
        with request.urlopen(call, timeout=90) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    metadata = api('GET', '/init', switch_id=0)
    assert metadata['target'] == 'tofino' and metadata['program_name'] == 'tofino_workshop', metadata
    tables = metadata['table_info']
    destination = str(int.from_bytes(socket.inet_aton('10.0.1.2'), 'big'))
    match = {'hdr.ipv4.dst_addr': [destination, 32]}

    def table(suffix):
        return next(value for name, value in tables.items() if name.endswith(suffix))

    def put(definition, fields, action_suffix, params):
        name = definition['table_name']
        action = next(name for name in definition['actions'] if name.endswith(action_suffix))
        entry = {'table_name': name, 'match_fields': fields, 'action_name': action,
                 'action_params': params, 'priority': None, 'is_default_action': False}
        rows = api('GET', '/tables', switch_id=0, table_name=name)
        existing = next((row['switch_entry'] for row in rows
                         if not row['switch_entry'].get('is_default_action')
                         and row['switch_entry']['match_fields'] == fields), None)
        if existing:
            api('PATCH', '/tables', {'switch_id': 0, 'old': json.dumps(existing), 'new': json.dumps(entry)})
        else:
            api('POST', '/tables', {'switch_id': 0, 'entry': json.dumps(entry)})
        return entry

    put(table('.ip_c.ip_forward'), match, '.ipv4_forward', {'port': str(egress_port)})
    counter = table('.counter_c.mat_flow_counter')
    put(counter, match, '.count', {})
    meter = table('.meter_c.flow_meter_instance')
    meter_entry = put(meter, match, '.set_color_direct', {})
    meter_id = next(value['id'] for value in metadata['direct_meters'].values()
                    if value['table_id'] == meter['table_id'])
    api('PATCH', '/direct-meters', {'switch_id': 0, 'meter_id': meter_id,
        'entries': [{'table_entry': meter_entry,
                     'config': {'cir': '1000000', 'pir': '2000000', 'cburst': '10000', 'pburst': '20000'}}]})
    random = table('.random_c.load_balance')
    for value in range(4):
        put(random, {'ig_md.random': str(value)}, '.set_egress_port_balanced', {'port': str(egress_port)})

    # This test subprocess stays in the isolated netsim container. It joins
    # only its Mininet hosts and sends a real Ethernet frame through s1.
    dataplane = r'''
import json, pathlib, socket, struct, subprocess, sys
count = int(sys.argv[1])
receiver_host = sys.argv[2]
def host(name):
    for path in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
        try:
            if ('mininet:' + name).encode() in path.read_bytes().split(b'\0'):
                return str(path.parent.name)
        except OSError:
            pass
    raise RuntimeError('Mininet host not found: ' + name)
h1, receiving = host('h1'), host(receiver_host)
def command(pid, source, *args):
    return ['mnexec', '-a', pid, 'python3', '-c', source, *args]
receiver = subprocess.Popen(command(receiving, """
import socket, sys
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3)); s.bind((sys.argv[1],0)); s.settimeout(10)
print('ready',flush=True)
while True:
    packet=s.recv(65536)
    if b'UniCorn workshop API' in packet and packet[22]==63:
        print(len(packet),flush=True); break
""", receiver_host + '-eth0'), stdout=subprocess.PIPE, text=True)
try:
    assert receiver.stdout.readline().strip() == 'ready'
    result = subprocess.run(command(h1, """
import socket, struct, sys, time
def checksum(data):
    value=sum(struct.unpack('!10H',data))
    while value>>16: value=(value&65535)+(value>>16)
    return (~value)&65535
payload=b'UniCorn workshop API'.ljust(40,b'!')
header=struct.pack('!BBHHHBBHII',69,0,60,777,0,64,1,0,0x0a000101,0x0a000102)
header=header[:10]+struct.pack('!H',checksum(header))+header[12:]
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW);s.bind(('h1-eth0',0))
for _ in range(int(sys.argv[1])):
    s.send(bytes.fromhex('0200000000020200000000010800')+header+payload);time.sleep(.1)
""", str(count)), check=True)
    output=receiver.communicate(timeout=12)[0].strip()
    assert receiver.returncode == 0 and int(output) >= 60, output
    print(json.dumps({'forwarded_bytes':int(output)}))
finally:
    if receiver.poll() is None: receiver.kill(); receiver.wait()
'''
    packet_result = subprocess.run(['docker', 'exec', container, 'python3', '-c', dataplane, str(count), receiver],
                                   text=True, capture_output=True, check=True, timeout=30)
    rows = api('GET', '/tables', switch_id=0, table_name=counter['table_name'])
    row = next(row for row in rows if row['switch_entry']['match_fields'] == match)
    assert int(row['counters']['packets']) >= count, row
    events = None
    for _ in range(30):
        events = api('GET', '/digest-events', switch_id=0)
        if events.get('events'):
            break
        time.sleep(.1)
    assert events.get('events'), events
    result = {**json.loads(packet_result.stdout), 'packets': row['counters']['packets'],
              'digest_events': len(events['events']), 'result': 'PASS'}
    print(json.dumps(result))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:3002')
    parser.add_argument('--container', default='unicorn-tofino-integration-netsim-1')
    parser.add_argument('--count', type=int, default=3)
    parser.add_argument('--receiver', choices=('h2', 'h3'), default='h2')
    parser.add_argument('--egress-port', type=int, default=1)
    args = parser.parse_args()
    run(args.base_url, args.container, args.count, args.receiver, args.egress_port)
