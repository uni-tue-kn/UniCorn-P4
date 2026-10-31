import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from netsim.api.netsim.netsim import MininetRunner, ParsedTopo, extract_id


@pytest.fixture
def runner(tmp_path):
    instance = MininetRunner(None, str(tmp_path / 'logs'), str(tmp_path / 'pcaps'), quiet=True)
    instance.hosts = ['h1', 'zhost2']
    instance.switches = {'s1': {}, 's2': {}}
    return instance


def test_parse_links_hosts_first_and_optional_properties(runner):
    assert runner.parse_links([['s1', 'zhost2', 4, 100]]) == [
        {'node1': 'zhost2', 'node2': 's1', 'latency': '4ms', 'bandwidth': 100}]
    assert runner.parse_links([['s2', 's1', '2us']])[0]['node1'] == 's1'


@pytest.mark.parametrize('latency,expected', [('2 ms', '2ms'), ('2\tms', '2ms'),
    ('0.25 \tus', '0.25us'), ('1\ns', '1s'), ('0ms', '0ms'), ('2.5s', '2.5s'),
    (0, '0ms'), (2.5, '2.5ms')])
def test_latency_is_one_canonical_tc_argument_through_json_load(runner, tmp_path, latency, expected):
    path = tmp_path / 'latency.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}},
                                'links': [['s1', 'h1', latency, 100]]}))
    candidate = runner.read_topology_file(path)
    assert candidate['links'][0] == {'node1': 'h1', 'node2': 's1', 'latency': expected, 'bandwidth': 100}
    graph = ParsedTopo(candidate['hosts'], candidate['switches'], candidate['links'], str(tmp_path))
    assert graph.linkInfo('h1', 's1')['delay'] == expected


@pytest.mark.parametrize('latency', [True, -1, float('nan'), float('inf'), '2 hours', '2ms ', ' 2ms', '2 ms;echo invalid'])
def test_native_latency_validation_rejects_invalid_delay_before_deployment(runner, tmp_path, latency):
    path = tmp_path / 'invalid-latency.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}}, 'links': [['h1', 's1', latency]]}))
    previous = runner.topology_state()
    with pytest.raises(ValueError, match='Latency'):
        runner.read_topology_file(path)
    assert runner.topology_state() == previous


@pytest.mark.parametrize('links', [None, {}, [['h1']], [['h1', 'missing']],
    [['h1', 'h1']], [['h1', 'zhost2']], [['h1', 's1', 1, 2, 3]], [[1, 's1']]])
def test_invalid_links_rejected(runner, links):
    with pytest.raises(ValueError):
        runner.parse_links(links)


def test_actual_mininet_graph_port_order_is_stable(runner, tmp_path):
    links = runner.parse_links([['s2', 's1'], ['s1', 'zhost2'], ['h1', 's1']])
    graph = ParsedTopo(runner.hosts, runner.switches, links, str(tmp_path))
    assert graph.hosts() == ['h1', 'zhost2']
    assert graph.switches() == ['s1', 's2']
    assert graph.sw_port_mapping['s1'] == [(1, 'h1'), (2, 'zhost2'), (3, 's2')]
    assert graph.port('h1', 's1') == (0, 1)


@pytest.mark.parametrize('attachments', [123, [['s1']], [['missing', 'eth0']],
    [['s1', 'lo']], [['s1', 'eth0'], ['s2', 'eth0']], [['s1', '']], [[1, 'eth0']]])
def test_invalid_external_interfaces(runner, attachments, monkeypatch):
    monkeypatch.setattr('netsim.api.netsim.netsim.os.path.exists', lambda _: True)
    with pytest.raises(ValueError):
        runner.parse_ext_intfs(attachments)


def test_external_interfaces_normalized_and_exist(runner, monkeypatch):
    monkeypatch.setattr('netsim.api.netsim.netsim.os.path.exists', lambda _: True)
    assert runner.parse_ext_intfs([[' s1 ', ' eth0 ']]) == [{'switch': 's1', 'interface': 'eth0'}]
    monkeypatch.setattr('netsim.api.netsim.netsim.os.path.exists', lambda _: False)
    with pytest.raises(ValueError, match='does not exist'):
        runner.parse_ext_intfs([['s1', 'eth0']])


def test_invalid_candidate_does_not_mutate_running_state(runner, tmp_path):
    path = tmp_path / 'bad.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}}, 'links': [['h1', 'unknown']]}))
    previous = runner.topology_state()
    with pytest.raises(ValueError):
        runner.read_topology_file(str(path))
    assert runner.topology_state() == previous


def test_unknown_host_name_and_duplicate_nodes_rejected(runner, tmp_path):
    path = tmp_path / 'bad.json'
    for hosts in (['bad;name1'], ['h1', 'h1'], ['s1'], ['h999']):
        path.write_text(json.dumps({'hosts': hosts, 'switches': {'s1': {}}, 'links': []}))
        with pytest.raises(ValueError):
            runner.read_topology_file(str(path))


def test_saved_layout_survives_load_and_state(runner, tmp_path):
    path = tmp_path / 'layout.json'
    layout = {'h1': {'x': 12, 'y': 34}, 's1': {'x': 100.5, 'y': 50}}
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}}, 'links': [['h1', 's1']], 'layout': layout}))
    runner.topo_file = str(path)
    runner.parse_topology_file()
    assert runner.topology_state()['layout'] == layout


@pytest.mark.parametrize('layout', [[], {'missing1': {'x': 1, 'y': 2}}, {'h1': {'x': True, 'y': 2}},
                                    {'h1': {'x': -1, 'y': 2}}, {'h1': {'x': float('nan'), 'y': 2}}])
def test_invalid_layout_preserves_running_topology(runner, tmp_path, layout):
    path = tmp_path / 'invalid-layout.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}}, 'links': [], 'layout': layout}))
    previous = runner.topology_state()
    with pytest.raises(ValueError, match='Layout'):
        runner.read_topology_file(str(path))
    assert runner.topology_state() == previous


def test_port_mapping_distinguishes_external_and_virtual(runner):
    peer = SimpleNamespace(name='h1')
    local = Mock(name='local')
    local.name, local.IP.return_value = 's1-eth1', ''
    remote = SimpleNamespace(name='h1-eth0', node=peer)
    local.link = SimpleNamespace(intf1=remote, intf2=local)
    external = Mock(name='external')
    external.name, external.IP.return_value = 'eth0', ''
    loopback = Mock(name='loopback')
    loopback.IP.return_value = '127.0.0.1'
    runner.ext_intfs = [{'switch': 's1', 'interface': 'eth0'}]
    runner.net = SimpleNamespace(switches=[SimpleNamespace(name='s1', intfs={1: local, 2: external, 0: loopback})])
    rows = runner.build_interface_mapping()['s1']
    assert rows[0]['peer_node'] == 'h1'
    assert rows[0]['port'] == 1
    assert rows[1]['type'] == 'external'
    assert rows[1]['peer_node'] is None


def test_detach_external_interfaces_never_deletes_them(runner):
    node = Mock()
    interface = SimpleNamespace(name='eth0', node=node)
    runner.external_intf_objects = [interface]
    runner.detach_external_interfaces()
    node.delIntf.assert_called_once_with(interface)
    assert interface.node is None
    assert runner.external_intf_objects == []


def test_extract_numeric_node_ids():
    assert extract_id('switch12') == 12
    with pytest.raises(ValueError):
        extract_id('switch')


def test_switch_discovery_reports_actual_native_endpoint_port(runner):
    runner.net = SimpleNamespace(switches=[SimpleNamespace(name='s1', device_id=0, grpc_port=50051, thrift_port=9107)])
    assert runner.populate_switch_mappings() == [{'name': 's1', 'dev_id': 0, 'grpc_port': 50051, 'thrift_port': 9107}]


@pytest.mark.parametrize('links,count', [([], 0), ([['h1', 's1'], ['h1', 's2']], 2),
                                        ([['s1', 'h1'], ['h1', 's1']], 2)])
def test_invalid_host_attachment_never_tears_down_running_network(runner, tmp_path, links, count):
    path = tmp_path / 'invalid-host.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}, 's2': {}}, 'links': links}))
    runner.topo_file = str(path)
    runner.destroy_topology = Mock()
    previous = runner.topology_state()
    with pytest.raises(ValueError, match=fr'Host h1.*exactly one switch link.*found {count}'):
        runner.run()
    runner.destroy_topology.assert_not_called()
    assert runner.topology_state() == previous


def test_load_uses_validated_candidate_without_reopening_file(runner, tmp_path):
    path = tmp_path / 'candidate.json'
    path.write_text(json.dumps({'hosts': ['h1'], 'switches': {'s1': {}}, 'links': [['h1', 's1']]}))
    candidate = runner.read_topology_file(path)
    path.write_text('{}')
    runner.parse_topology_file(candidate)
    assert runner.hosts == ['h1']
    assert runner.links[0]['node1'] == 'h1'


@pytest.mark.parametrize('name,ports,allowed', [('switchabc1', 1, True), ('switchname1', 1, False),
                                             ('switchab1', 10, True), ('switchabc1', 10, False)])
def test_generated_interface_name_limits_preflight_preserves_running_network(runner, tmp_path, name, ports, allowed):
    path = tmp_path / 'interface-length.json'
    path.write_text(json.dumps({'hosts': [], 'switches': {name: {}, 's2': {}},
                                'links': [[name, 's2']] * ports}))
    runner.topo_file = str(path)
    previous = runner.topology_state()
    runner.destroy_topology = Mock()
    if allowed:
        candidate = runner.read_topology_file(path)
        graph = ParsedTopo(candidate['hosts'], candidate['switches'], candidate['links'], str(tmp_path))
        assert len(graph.sw_port_mapping[name]) == ports
        assert all(len(f'{name}-eth{port}') <= 15 for port, _peer in graph.sw_port_mapping[name])
    else:
        with pytest.raises(ValueError, match='interface'):
            runner.run()
        runner.destroy_topology.assert_not_called()
    assert runner.topology_state() == previous
