import hashlib
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import Mock
import zipfile

import pytest

from api.topology_schema import validate_topology

path = Path(__file__).resolve().parents[2] / 'scripts/create-sample-networks.py'
spec = importlib.util.spec_from_file_location('sample_networks', path)
samples = importlib.util.module_from_spec(spec)
spec.loader.exec_module(samples)


@pytest.mark.parametrize('definition', samples.SCENARIOS, ids=lambda item: item['name'])
def test_public_scenarios_are_valid_and_do_not_reflect_multicast_to_ingress(definition):
    validate_topology(definition['topology'])
    for row in definition['tables']['s1']:
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
