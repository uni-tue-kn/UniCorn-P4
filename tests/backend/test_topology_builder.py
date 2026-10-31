import copy
import json

import pytest

from api.topology_schema import validate_topology


@pytest.fixture
def topology():
    return {'hosts': ['h1'], 'switches': {'s1': {}, 's2': {}},
            'links': [['h1', 's1', '0ms', 100], ['s1', 's2', '2ms'], ['s1', 's2']],
            'layout': {'h1': {'x': 100, 'y': 250}, 's1': {'x': 100, 'y': 100}}}


def test_save_reload_layout_and_external_interfaces(client, tmp_path, monkeypatch, topology):
    monkeypatch.setenv('TOPO_DIR', str(tmp_path))
    topology['ext_intfs'] = [['s1', 'eth0']]
    response = client.post('/topologies', json={'name': 'created', 'topology': topology})
    assert response.status_code == 200
    path = str(tmp_path / 'created.json')
    assert json.loads((tmp_path / 'created.json').read_text()) == topology
    assert client.get('/topologies').json == {'topologies': [path]}
    assert client.get('/topologies', query_string={'name': path}).json[path] == topology
    assert list(tmp_path.glob('.topology-*')) == []


def test_save_requires_explicit_overwrite(client, tmp_path, monkeypatch, topology):
    monkeypatch.setenv('TOPO_DIR', str(tmp_path))
    original = copy.deepcopy(topology)
    body = {'name': 'created.json', 'topology': topology}
    assert client.post('/topologies', json=body).status_code == 200
    body['topology']['links'] = []
    assert client.post('/topologies', json=body).status_code == 409
    assert json.loads((tmp_path / 'created.json').read_text()) == original
    body['overwrite'] = True
    assert client.post('/topologies', json=body).status_code == 200
    assert json.loads((tmp_path / 'created.json').read_text())['links'] == []


@pytest.mark.parametrize('name', ['../escape', '/tmp/escape', 'a/b', 'a\\b', '.hidden', '', None])
def test_save_rejects_unsafe_filename(client, tmp_path, monkeypatch, topology, name):
    monkeypatch.setenv('TOPO_DIR', str(tmp_path))
    assert client.post('/topologies', json={'name': name, 'topology': topology}).status_code == 400
    assert not list(tmp_path.glob('*.json'))


def test_save_rejects_symlink_destination(client, tmp_path, monkeypatch, topology):
    folder = tmp_path / 'topologies'
    folder.mkdir()
    original = tmp_path / 'outside.json'
    original.write_text('original')
    (folder / 'linked.json').symlink_to(original)
    monkeypatch.setenv('TOPO_DIR', str(folder))
    assert client.post('/topologies', json={'name': 'linked.json', 'topology': topology, 'overwrite': True}).status_code == 400
    assert original.read_text() == 'original'
    assert client.get('/topologies').json == {'topologies': []}


@pytest.mark.parametrize('change', [
    {'hosts': ['bad']}, {'hosts': ['h999']}, {'hosts': ['h1', 'h1']}, {'hosts': ['h1', 'host1']},
    {'switches': {'s1': []}}, {'links': [['h1', 'missing']]}, {'links': [['h1', 'h1']]},
    {'links': [['h1', 's1', '-2ms']]}, {'links': [['h1', 's1', 0, 0]]},
    {'links': [['h1', 's1', True]]}, {'links': [['h1', 's1', '3hours']]},
    {'layout': {'missing': {'x': 1, 'y': 2}}}, {'layout': {'h1': {'x': -1, 'y': 2}}},
    {'ext_intfs': [['s1', 'lo']]}, {'ext_intfs': [['s1', 'eth0'], ['s2', 'eth0']]},
])
def test_invalid_drafts_rejected(topology, change):
    topology.update(change)
    with pytest.raises((ValueError, TypeError)):
        validate_topology(topology)


def test_host_to_host_link_rejected(topology):
    topology['hosts'].append('h2')
    topology['links'] = [['h1', 'h2']]
    with pytest.raises(ValueError, match='include a switch'):
        validate_topology(topology)


def test_malformed_request_and_unknown_get_are_graceful(client, tmp_path, monkeypatch):
    monkeypatch.setenv('TOPO_DIR', str(tmp_path))
    assert client.post('/topologies', json=[]).status_code == 400
    assert client.post('/topologies', json={'name': 'draft', 'topology': {}, 'overwrite': 'yes'}).status_code == 400
    assert client.get('/topologies', query_string={'name': '../outside.json'}).status_code == 404
