#!/usr/bin/env python3
"""Generate public feature-demo archives on a disposable local UniCorn stack.

The target must expose the frontend's /api and /netsim proxies, disable update
checks, and contain the known public P4 source under /p4/samples/runtime-lab/.
The script replaces that isolated network four times. No traffic commands or
external switch addresses are executed.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import zipfile

SOURCE = '/p4/samples/runtime-lab/runtime-lab.p4'
PROGRAM = '/p4/samples/runtime-lab/runtime-lab.json'
TABLE = 'LabIngress.forward'
COUNTER = 'LabIngress.port_counter'
REGISTERS = ('LabIngress.packet_count', 'LabIngress.wide_packet_count')
METER = 'LabIngress.port_meter'
DIRECT_METER = 'LabIngress.flow_meter'
DIGEST = 'packet_digest_t'
MAX_ARCHIVE = 64 * 1024 * 1024


def entry(ingress, action='send', **parameters):
    return {'table_name': TABLE, 'match_fields': {'standard_metadata.ingress_port': str(ingress)},
            'action_name': 'LabIngress.' + action, 'action_params': {key: str(value) for key, value in parameters.items()},
            'priority': None}


def pair_topology(observer=False):
    return {'hosts': ['h1', 'h2'], 'switches': {'s1': {}, **({'s2': {}} if observer else {})},
            'links': [['h1', 's1'], ['h2', 's1'], *([['s1', 's2']] if observer else [])],
            'layout': {'h1': {'x': 120, 'y': 90}, 'h2': {'x': 120, 'y': 300}, 's1': {'x': 380, 'y': 190},
                       **({'s2': {'x': 650, 'y': 190}} if observer else {})}}


RATE = {'cir': '5', 'cburst': '2', 'pir': '10', 'pburst': '4'}
SCENARIOS = (
    {'name': 'two-host-forwarding', 'topology': pair_topology(),
     'tables': {'s1': [entry(1, port=2), entry(2, port=1)]}, 'digest': True},
    {'name': 'multicast-hub',
     'topology': {'hosts': ['h1', 'h2', 'h3'], 'switches': {'s1': {}},
                  'links': [['h1', 's1'], ['h2', 's1'], ['h3', 's1']],
                  'layout': {'h1': {'x': 120, 'y': 80}, 'h2': {'x': 120, 'y': 310},
                             'h3': {'x': 650, 'y': 190}, 's1': {'x': 380, 'y': 190}}},
     'tables': {'s1': [entry(port, 'multicast', group=100 + port) for port in (1, 2, 3)]},
     'multicast': {101: (2, 3), 102: (1, 3), 103: (1, 2)}},
    {'name': 'mirror-observer', 'topology': pair_topology(observer=True),
     'tables': {'s1': [entry(1, 'send_and_mirror', port=2), entry(2, port=1)], 's2': []}, 'mirror': True},
    {'name': 'metering-queues', 'topology': pair_topology(),
     'tables': {'s1': [entry(1, 'metered_send', port=2), entry(2, port=1)]}, 'metering': True},
)


class APIError(RuntimeError):
    pass


class API:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip('/')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, data=None, params=None, binary=False, timeout=120):
        url = self.base_url + '/' + path.lstrip('/')
        if params:
            url += '?' + urllib.parse.urlencode(params)
        headers = {'Accept': 'application/zip' if binary else 'application/json'}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, data=json.dumps(data, allow_nan=False).encode() if data is not None else None,
                                         headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                payload = response.read(MAX_ARCHIVE + 1 if binary else 16 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            payload = error.read(4096).decode('utf-8', errors='replace')
            try:
                payload = json.loads(payload).get('error', payload)
            except (ValueError, AttributeError):
                pass
            raise APIError(f'{method} {path}: HTTP {error.code}: {payload}') from error
        except urllib.error.URLError as error:
            raise APIError(f'Cannot reach {url}: {error.reason}') from error
        if binary:
            if len(payload) > MAX_ARCHIVE:
                raise APIError('Export exceeds the supported 64 MiB archive size')
            return payload
        try:
            return json.loads(payload) if payload else None
        except ValueError as error:
            raise APIError(f'{method} {path}: response is not JSON') from error


def check_isolated(api):
    try:
        location = urllib.parse.urlsplit(api.base_url)
        port = location.port
    except ValueError as error:
        raise APIError('The disposable frontend URL has an invalid port') from error
    if (location.scheme not in ('http', 'https') or location.hostname not in ('127.0.0.1', 'localhost', '::1')
            or location.username or location.password or location.query or location.fragment
            or not location.path.endswith('/api') or port in (None, 80, 443, 3000, 5000, 5001)):
        raise APIError('Use a disposable loopback frontend on a separate port, such as http://127.0.0.1:3001/api')
    version = api.call('GET', '/version')
    if not isinstance(version, dict) or version.get('component') != 'backend' or version.get('update', {}).get('status') != 'disabled':
        raise APIError('The disposable backend must have UPDATE_CHECK_ENABLED=false')
    if SOURCE not in api.call('GET', '/p4src').get('p4src', []):
        raise APIError(f'Copy the public examples/p4/runtime-lab directory to {SOURCE.rsplit("/", 1)[0]} in the isolated backend first')
    return API(api.base_url[:-4] + '/netsim')


def discovered_configs(topology):
    names = set(topology['switches'])
    online = [item for item in topology.get('switches_online', []) if item.get('name') in names]
    if {item['name'] for item in online} != names or len(online) != len(names):
        raise APIError('The emulator did not discover exactly the expected switches')
    for item in online:
        for field in ('grpc_port', 'thrift_port'):
            if not isinstance(item.get(field), int) or isinstance(item[field], bool) or not 1 <= item[field] <= 65535:
                raise APIError(f'Invalid discovered {field} for {item["name"]}')
        if not isinstance(item.get('dev_id'), int) or isinstance(item['dev_id'], bool) or item['dev_id'] < 0:
            raise APIError('Invalid discovered device ID')
    return [{'name': item['name'], 'device_id': item['dev_id'], 'address': f'127.0.0.1:{item["grpc_port"]}',
             'proto_dump_file': None, 'register_adapter_enabled': False,
             'register_thrift_host': '127.0.0.1', 'register_thrift_port': item['thrift_port']} for item in online]


def metadata_checks(metadata):
    required = [('tables', TABLE), ('counters', COUNTER), ('meters', METER), ('direct_meters', DIRECT_METER), ('digests', DIGEST)]
    # Table definitions live under table_info in the initialization endpoint.
    for collection, name in required:
        collection = 'table_info' if collection == 'tables' else collection
        if name not in (metadata.get(collection) or {}):
            raise APIError(f'The compiled public program is missing {name}')
    for name, width in zip(REGISTERS, (32, 64)):
        resource = metadata.get('registers', {}).get(name)
        if not resource or resource.get('size') != 16 or resource.get('type') != {'kind': 'bit', 'bitwidth': width}:
            raise APIError(f'The compiled public program has an unexpected register definition for {name}')


def install_scenario(api, netsim, definition, program):
    name = definition['name']
    saved = api.call('POST', '/topologies', {'name': f'sample-{name}.json', 'topology': definition['topology'], 'overwrite': True})
    api.call('DELETE', '/switches/active', {})
    loaded = netsim.call('POST', '/topology/load', {'topology_file': saved['name']}, timeout=90)
    configs = discovered_configs(loaded)
    api.call('POST', '/switches/from_topology', {'switch_configs': json.dumps(configs), 'create_switches': True})
    switches, metadata = {}, {}
    for config in configs:
        switch_id = config['device_id']
        switches[config['name']] = switch_id
        api.call('POST', '/init', {'switch_id': switch_id, 'p4_info_file': program['p4_info'], 'bmv2_file': program['bmv2'], 'keep_entries': False})
        info = api.call('GET', '/init', params={'switch_id': switch_id})
        metadata_checks(info)
        metadata[config['name']] = info
        for row in definition['tables'].get(config['name'], []):
            api.call('POST', '/tables', {'switch_id': switch_id, 'entry': json.dumps(row)})
    switch_id, info = switches['s1'], metadata['s1']
    for group, ports in definition.get('multicast', {}).items():
        api.call('POST', '/multicast-groups', {'switch_id': switch_id, 'multicast_group_id': group,
                 'replicas': [{'egress_port': str(port), 'instance': 0} for port in ports]})
    if definition.get('mirror'):
        api.call('POST', '/mirrors', {'switch_id': switch_id, 'session_id': 20, 'replicas': [{'egress_port': '3', 'instance': 0}],
                                     'class_of_service': 0, 'packet_length_bytes': 0})
    if definition.get('digest'):
        api.call('POST', '/digests', {'switch_id': switch_id, 'digest_id': info['digests'][DIGEST]['id'],
            'config': {'max_timeout_ns': '100000000', 'max_list_size': '1', 'ack_timeout_ns': '1000000000'}})
    if definition.get('metering'):
        api.call('PATCH', '/direct-meters', {'switch_id': switch_id, 'meter_id': info['direct_meters'][DIRECT_METER]['id'],
                 'entries': [{'table_entry': definition['tables']['s1'][0], 'config': RATE}]})
        api.call('PATCH', '/meters', {'switch_id': switch_id, 'meter_id': info['meters'][METER]['id'],
                 'entries': [{'index': 1, 'config': RATE}]})
        api.call('PATCH', '/queues', {'switch_id': switch_id, 'port': 2, 'depth_packets': 8, 'rate_pps': '10'})
    verify_scenario(api, definition, switches, metadata)
    return switches


def verify_scenario(api, definition, switches, metadata):
    for name, switch_id in switches.items():
        rows = api.call('GET', '/tables', params={'switch_id': switch_id, 'table_name': TABLE})
        expected = definition['tables'].get(name, [])
        actual = {str(row['switch_entry']['match_fields']['standard_metadata.ingress_port']): row['switch_entry'] for row in rows}
        if len(actual) != len(expected):
            raise APIError(f'{name}: table readback does not match the sample')
        for row in expected:
            read = actual.get(row['match_fields']['standard_metadata.ingress_port'], {})
            if read.get('action_name') != row['action_name'] or {key: str(value) for key, value in read.get('action_params', {}).items()} != row['action_params']:
                raise APIError(f'{name}: action readback does not match the sample')
        info = metadata[name]
        counters = api.call('GET', '/counters', params={'switch_id': switch_id, 'counter_id': info['counters'][COUNTER]['id']})
        if len(counters['entries']) != 16:
            raise APIError(f'{name}: expected 16 readable counter cells')
        for register in REGISTERS:
            identifier = info['registers'][register]['id']
            api.call('PATCH', '/registers', {'switch_id': switch_id, 'register_id': identifier, 'entries': [{'index': 0, 'value': '0'}]})
            read = api.call('GET', '/registers', params={'switch_id': switch_id, 'register_id': identifier, 'index': 0})
            if read['entries'] != [{'index': 0, 'value': '0'}]:
                raise APIError(f'{name}: register read/write did not round-trip')
    switch_id, info = switches['s1'], metadata['s1']
    if definition.get('multicast'):
        groups = api.call('GET', '/multicast-groups', params={'switch_id': switch_id})['entries']
        actual = {row['multicast_group_id']: sorted(int(replica['egress_port']) for replica in row['replicas']) for row in groups}
        if actual != {group: sorted(ports) for group, ports in definition['multicast'].items()}:
            raise APIError('Multicast readback differs from the sample')
    if definition.get('mirror'):
        mirrors = api.call('GET', '/mirrors', params={'switch_id': switch_id})['entries']
        if not any(row['session_id'] == 20 and row['replicas'] == [{'egress_port': '3', 'instance': 0}] for row in mirrors):
            raise APIError('Mirror session readback differs from the sample')
    if definition.get('digest'):
        entries = api.call('GET', '/digests', params={'switch_id': switch_id, 'digest_id': info['digests'][DIGEST]['id']})['entries']
        if len(entries) != 1:
            raise APIError('The sample digest is not enabled')
    if definition.get('metering'):
        meters = api.call('GET', '/meters', params={'switch_id': switch_id, 'meter_id': info['meters'][METER]['id'], 'index': 1})
        direct = api.call('GET', '/direct-meters', params={'switch_id': switch_id, 'meter_id': info['direct_meters'][DIRECT_METER]['id']})
        row = next((row for row in direct['entries'] if str(row['table_entry']['match_fields']['standard_metadata.ingress_port']) == '1'), None)
        if meters['entries'][0]['config'] != RATE or not row or row['config'] != RATE:
            raise APIError('Meter readback differs from the sample')
        queues = api.call('GET', '/queues', params={'switch_id': switch_id, 'port': 2})
        if not any(row['port'] == 2 and row['depth_packets'] == 8 and row['rate_pps'] == '10' for row in queues['configuration']['ports']):
            raise APIError('Acknowledged queue settings differ from the sample')


def validate_export(payload, definition, source_bytes):
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            if manifest.get('format') != 'unicorn-p4-network' or manifest.get('format_version') != 1:
                raise APIError('The backend returned an unsupported archive format')
            if {item['name'] for item in manifest['switches']} != set(definition['topology']['switches']):
                raise APIError('The exported archive contains unexpected switches')
            topology = json.loads(archive.read(manifest['topology']))
            if set(topology['hosts']) != set(definition['topology']['hosts']) or set(topology['switches']) != set(definition['topology']['switches']):
                raise APIError('The exported archive contains an unexpected topology')
            for path, digest in manifest['files'].items():
                if hashlib.sha256(archive.read(path)).hexdigest() != digest:
                    raise APIError(f'Archive checksum mismatch: {path}')
            sources = [item['pipeline']['source'] for item in manifest['switches'] if item.get('pipeline') and item['pipeline'].get('source')]
            if len(sources) != len(manifest['switches']) or any(archive.read(path) != source_bytes for path in sources):
                raise APIError('The archive must include only the matching public runtime-lab P4 source')
            if {path for path in archive.namelist() if path.lower().endswith('.p4')} != set(sources):
                raise APIError('The archive contains an unexpected P4 source file')
            for item in manifest['switches']:
                categories = (item.get('runtime') or {}).get('categories', {})
                required = ('tables', 'registers', 'counters', 'meters', 'direct_meters', 'multicast_groups', 'mirrors', 'digests')
                if any(categories.get(category, {}).get('status') != 'ok' for category in required):
                    raise APIError(f'{item["name"]}: a required runtime resource could not be captured: {categories}')
            return manifest
    except (zipfile.BadZipFile, KeyError, ValueError) as error:
        raise APIError(f'Invalid exported network archive: {error}') from error


def generate(base_url, output_dir):
    api = API(base_url)
    netsim = check_isolated(api)
    source = Path(__file__).resolve().parents[1] / 'examples/p4/runtime-lab/runtime-lab.p4'
    source_bytes = source.read_bytes()
    print(f'WARNING: replacing only the disposable network at {base_url}; each scenario recreates it.', flush=True)
    api.call('POST', '/compile', {'file': SOURCE}, timeout=180)
    programs = api.call('GET', '/p4files').get('programs', [])
    program = next((item for item in programs if item['bmv2'] == PROGRAM and item.get('source') == SOURCE), None)
    if program is None:
        raise APIError('The backend did not produce the known public program pair')
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    for definition in SCENARIOS:
        print(f'Installing and checking {definition["name"]}…', flush=True)
        install_scenario(api, netsim, definition, program)
        payload = api.call('GET', '/network/export', binary=True, timeout=180)
        manifest = validate_export(payload, definition, source_bytes)
        target = output / (definition['name'] + '.zip')
        temporary = target.with_suffix('.zip.tmp')
        temporary.write_bytes(payload)
        temporary.replace(target)
        warnings = len(manifest.get('warnings', [])) + sum(len(item.get('warnings', [])) for item in manifest['switches'])
        print(f'Wrote {target} ({len(payload)} bytes; {warnings} capture notes)', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:3001/api', help='Disposable frontend API proxy; production/default ports are rejected')
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'examples/networks')
    args = parser.parse_args()
    try:
        generate(args.base_url, args.output_dir)
    except (APIError, OSError) as error:
        parser.exit(1, f'Sample generation failed: {error}\n')


if __name__ == '__main__':
    main()
