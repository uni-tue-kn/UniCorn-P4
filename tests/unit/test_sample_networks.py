import hashlib
import copy
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock
import zipfile

import pytest

from api.topology_schema import validate_deployable_topology

path = Path(__file__).resolve().parents[2] / 'scripts/create-sample-networks.py'
spec = importlib.util.spec_from_file_location('sample_networks', path)
samples = importlib.util.module_from_spec(spec)
spec.loader.exec_module(samples)


@pytest.mark.parametrize('definition', samples.SCENARIOS, ids=lambda item: item['name'])
def test_public_scenarios_are_valid_and_do_not_reflect_multicast_to_ingress(definition):
    validate_deployable_topology(definition['topology'])
    multicast_switch = definition.get('multicast_switch', 's1')
    for row in definition['tables'][multicast_switch]:
        if row['action_name'] == 'LabIngress.multicast':
            ingress = int(row['match_fields']['standard_metadata.ingress_port'])
            replicas = definition['multicast'][int(row['action_params']['group'])]
            assert ingress not in replicas


@pytest.mark.parametrize('url', ['http://127.0.0.1:3000/api', 'http://localhost:5000/api',
                                'http://example.com:3001/api', 'http://127.0.0.1:3001',
                                'http://user:pass@127.0.0.1:3001/api'])
def test_generator_refuses_production_or_untrusted_targets_before_network_calls(url):
    api = Mock(base_url=url)
    with pytest.raises(samples.APIError):
        samples.check_isolated(api)
    api.call.assert_not_called()


def test_generator_requires_disabled_updates_and_the_known_public_source():
    api = Mock(base_url='http://127.0.0.1:3001/api')
    api.call.return_value = {'component': 'backend', 'update': {'status': 'checked'}}
    with pytest.raises(samples.APIError, match='UPDATE_CHECK_ENABLED'):
        samples.check_isolated(api)
    api.call.assert_called_once_with('GET', '/version')
    api.call.reset_mock()
    api.call.side_effect = [{'component': 'backend', 'update': {'status': 'disabled'}}, {'p4src': []}]
    with pytest.raises(samples.APIError, match='Copy the public'):
        samples.check_isolated(api)
    assert all(call.args[0] == 'GET' for call in api.call.call_args_list)


def test_generator_derives_the_sibling_proxy_and_uses_discovered_endpoint_values():
    api = Mock(base_url='http://127.0.0.1:3001/api')
    api.call.side_effect = [{'component': 'backend', 'update': {'status': 'disabled'}}, {'p4src': [samples.SOURCE]}]
    assert samples.check_isolated(api).base_url == 'http://127.0.0.1:3001/netsim'
    config = samples.discovered_configs({'switches': {'s1': {}}, 'switches_online': [
        {'name': 's1', 'dev_id': 7, 'grpc_port': 52007, 'thrift_port': 9307}]})[0]
    assert config['device_id'] == 7 and config['address'] == '127.0.0.1:52007'
    assert config['register_thrift_port'] == 9307 and config['register_adapter_enabled'] is False
    with pytest.raises(samples.APIError, match='expected switches'):
        samples.discovered_configs({'switches': {'s1': {}}, 'switches_online': []})


def archive_bytes(source=b'public source', source_hash=None):
    definition = samples.SCENARIOS[0]
    files = {'topology.json': json.dumps(definition['topology']).encode(), 'programs/runtime-lab.p4': source}
    categories = {name: {'status': 'ok'} for name in ('tables', 'registers', 'counters', 'meters', 'direct_meters', 'multicast_groups', 'mirrors', 'digests')}
    manifest = {'format': 'unicorn-p4-network', 'format_version': 1, 'topology': 'topology.json',
                'switches': [{'name': 's1', 'pipeline': {'source': 'programs/runtime-lab.p4'}, 'runtime': {'categories': categories}}],
                'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
    if source_hash:
        manifest['files']['programs/runtime-lab.p4'] = source_hash
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr('manifest.json', json.dumps(manifest))
        for name, value in files.items():
            archive.writestr(name, value)
    return output.getvalue()


def test_archive_validation_requires_matching_public_source_and_consistent_hashes():
    assert samples.validate_export(archive_bytes(), samples.SCENARIOS[0], b'public source')['format_version'] == 1
    with pytest.raises(samples.APIError, match='matching public'):
        samples.validate_export(archive_bytes(b'unrelated private source'), samples.SCENARIOS[0], b'public source')
    with pytest.raises(samples.APIError, match='checksum mismatch'):
        samples.validate_export(archive_bytes(source_hash='0' * 64), samples.SCENARIOS[0], b'public source')


def test_campus_ring_ports_and_branch_features_match_the_public_network():
    assert [item['name'] for item in samples.SCENARIOS] == ['two-host-forwarding', 'multicast-hub', 'mirror-observer', 'metering-queues', 'campus-telemetry']
    campus = samples.SCENARIOS[-1]
    topology = campus['topology']
    assert len(topology['hosts']) == 6 and len(topology['switches']) == 4 and len(topology['links']) == 10
    assert set(topology['layout']) == set(topology['hosts']) | set(topology['switches'])
    peers = {'s1': {1: 'h1', 2: 'h2', 3: 's2', 4: 's3'}, 's2': {1: 'h3', 2: 's1', 3: 's4'},
             's3': {1: 'h4', 2: 's1', 3: 's4'}, 's4': {1: 'h5', 2: 'h6', 3: 's2', 4: 's3'}}
    for switch, ports in peers.items():
        assert {frozenset((switch, peer)) for peer in ports.values()} <= {frozenset(link[:2]) for link in topology['links']}
    def trace(host):
        previous, switch, result = host, 's1', []
        for _ in range(8):
            result.append(switch)
            ingress = next(port for port, peer in peers[switch].items() if peer == previous)
            row = next(row for row in campus['tables'][switch] if row['match_fields']['standard_metadata.ingress_port'] == str(ingress))
            outgoing = peers[switch][int(row['action_params']['port'])]
            if outgoing.startswith('h'):
                return result, outgoing
            previous, switch = switch, outgoing
        pytest.fail('Campus forwarding loop did not terminate')
    assert trace('h1') == (['s1', 's2', 's4', 's3', 's1'], 'h2')
    assert trace('h2') == (['s1', 's3', 's4', 's2', 's1'], 'h1')
    assert campus['mirror_port'] == 4 and campus['tables']['s1'][0]['action_name'] == 'LabIngress.send_and_mirror'
    assert campus['tables']['s4'][-1] == samples.entry(1, 'multicast', group=102)
    assert samples.multicast_replicas(campus, 102, campus['multicast'][102]) == [{'egress_port': '2', 'instance': 0}, {'egress_port': '4', 'instance': 1}]
    assert samples.entry(2, port=1) in campus['tables']['s4']  # h6 replies to h5.


class ScenarioAPI:
    """Stateful response fixture: install must verify what the fake target stored."""
    def __init__(self):
        self.calls, self.tables, self.resources, self.registers = [], {}, {}, {}
        self.info = {'table_info': {samples.TABLE: {}}, 'counters': {samples.COUNTER: {'id': 1}},
                     'meters': {samples.METER: {'id': 2}}, 'direct_meters': {samples.DIRECT_METER: {'id': 3}},
                     'digests': {samples.DIGEST: {'id': 4}},
                     'registers': {name: {'id': index, 'size': 16, 'type': {'kind': 'bit', 'bitwidth': width}}
                                   for index, (name, width) in enumerate(zip(samples.REGISTERS, (32, 64)), 5)}}

    def call(self, method, path, data=None, params=None, **kwargs):
        self.calls.append((method, path, copy.deepcopy(data), copy.deepcopy(params)))
        if path == '/topologies':
            return {'name': '/topologies/' + data['name']}
        if path == '/init' and method == 'GET':
            return copy.deepcopy(self.info)
        request = data if data is not None else params or {}
        switch = request.get('switch_id')
        if path == '/tables':
            if method == 'POST':
                self.tables.setdefault(switch, []).append(json.loads(data['entry']))
                return {}
            return [{'switch_entry': copy.deepcopy(row)} for row in self.tables.get(switch, [])]
        if path == '/registers':
            key = switch, request['register_id']
            if method == 'PATCH':
                self.registers[key] = copy.deepcopy(data['entries'])
            return {'entries': copy.deepcopy(self.registers[key])}
        if path == '/counters':
            return {'entries': [{'index': index, 'data': {}} for index in range(16)]}
        if path in ('/meters', '/direct-meters', '/digests', '/mirrors', '/multicast-groups', '/queues'):
            key = path, switch
            if method != 'GET':
                self.resources[key] = copy.deepcopy(data)
                return {}
            stored = self.resources[key]
            if path == '/queues':
                return {'configuration': {'defaults': {key: stored[key] for key in ('depth_packets', 'rate_pps')}, 'ports': []}}
            if path in ('/meters', '/direct-meters'):
                return {'entries': stored['entries']}
            return {'entries': [{key: value for key, value in stored.items() if key != 'switch_id'}]}
        return {}


def installed_campus():
    definition = samples.SCENARIOS[-1]
    loaded = {**definition['topology'], 'switches_online': [{'name': name, 'dev_id': 40 + index,
              'grpc_port': 52040 + index, 'thrift_port': 9340 + index} for index, name in enumerate(definition['topology']['switches'])]}
    api, netsim = ScenarioAPI(), Mock()
    netsim.call.return_value = loaded
    switches = samples.install_scenario(api, netsim, definition, {'p4_info': '/public/info.txt', 'bmv2': '/public/program.json'})
    return api, switches


def test_campus_installs_and_reads_back_all_feature_branches_using_discovered_ids():
    api, switches = installed_campus()
    assert switches == {'s1': 40, 's2': 41, 's3': 42, 's4': 43}
    assert api.resources['/mirrors', 40]['replicas'] == [{'egress_port': '4', 'instance': 0}]
    assert api.resources['/multicast-groups', 43]['replicas'] == [{'egress_port': '2', 'instance': 0}, {'egress_port': '4', 'instance': 1}]
    for path in ('/meters', '/direct-meters'):
        assert api.resources[path, 40]['entries'][0]['config'] == samples.CAMPUS_RATE
    assert api.resources['/digests', 40]['config']['max_list_size'] == '16'
    for identifier in switches.values():
        assert api.resources['/queues', identifier] == {'switch_id': identifier, 'depth_packets': 256, 'rate_pps': '0'}
        assert any(method == 'GET' and path == '/queues' and params == {'switch_id': identifier} for method, path, data, params in api.calls)
    assert api.registers[40, 6] == [{'index': 0, 'value': '9007199254740993'}]


@pytest.mark.parametrize('path', ['/mirrors', '/multicast-groups', '/digests', '/meters', '/direct-meters', '/queues'])
def test_campus_verification_rejects_incorrect_feature_readback(path):
    api, switches = installed_campus()
    switch = switches['s4'] if path == '/multicast-groups' else switches['s1']
    stored = api.resources[path, switch]
    if path in ('/mirrors', '/multicast-groups'):
        stored['replicas'][0]['egress_port'] = '99'
    elif path == '/digests':
        stored['config']['max_list_size'] = '1'
    elif path == '/queues':
        stored['depth_packets'] = 1
    else:
        stored['entries'][0]['config'] = samples.RATE
    with pytest.raises(samples.APIError):
        samples.verify_scenario(api, samples.SCENARIOS[-1], switches, {name: api.info for name in switches})
