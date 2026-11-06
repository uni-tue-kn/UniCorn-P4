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


def test_switch_addresses_follow_natural_order_not_json_key_order(runner, monkeypatch):
    from netsim.api.netsim import netsim
    runner.hosts = []
    runner.switches = {'s10': {}, 's2': {}, 's1': {}}
    runner.links = []
    monkeypatch.setattr(netsim, 'Mininet', Mock())
    monkeypatch.setattr(netsim, 'configureP4Switch', lambda **options: options)
    topology = Mock()
    monkeypatch.setattr(netsim, 'ParsedTopo', topology)
    runner.create_network()
    classes = topology.call_args.kwargs['switch_classes']
    assert {name: value['grpc_port'] for name, value in classes.items()} == {'s1': 50051, 's2': 50052, 's10': 50053}
    assert {name: value['device_id'] for name, value in classes.items()} == {'s1': 0, 's2': 1, 's10': 2}


def test_system_exit_during_network_creation_runs_cleanup(runner):
    runner.destroy_topology = Mock()
    runner.create_network = Mock(side_effect=SystemExit('port busy'))
    candidate = {'hosts': [], 'switches': {}, 'links': [], 'ext_intfs': [], 'layout': {}}
    with pytest.raises(SystemExit):
        runner.run(candidate=candidate)
    assert runner.destroy_topology.call_count == 2
    assert runner.deployment['status'] == 'failed'


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
    assert runner.populate_switch_mappings() == [{'name': 's1', 'dev_id': 0, 'grpc_port': 50051, 'thrift_port': 9107, 'target': 'bmv2', 'address': '127.0.0.1:50051', 'status': 'ready'}]


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


def test_mixed_targets_keep_link_properties_and_per_node_classes(runner, tmp_path, monkeypatch):
    from netsim.api.netsim.utils.tofino_switch import TofinoSwitch
    from netsim.api.netsim.utils.p4runtime_switch import P4RuntimeSwitch
    runner.hosts = []
    runner.switches = {'s1': {}, 's2': {'target': 'tofino', 'program': 'saved-build'}}
    runner.links = runner.parse_links([['s1', 's2', '4ms', 25]])
    monkeypatch.setattr('netsim.api.netsim.netsim.Mininet', Mock())
    runner.create_network()
    assert issubclass(runner.topo.nodeInfo('s1')['cls'], P4RuntimeSwitch)
    assert issubclass(runner.topo.nodeInfo('s2')['cls'], TofinoSwitch)
    assert runner.topo.linkInfo('s1', 's2')['delay'] == '4ms'
    assert runner.topo.linkInfo('s1', 's2')['bw'] == 25
    assert runner.switches['s2']['program'] == 'saved-build'


def test_mixed_bmv2_and_both_tofino_generations_get_isolated_runtime_options(runner, monkeypatch):
    from netsim.api.netsim import netsim
    runner.hosts = []
    runner.switches = {
        's1': {'target': 'tofino', 'architecture': 'tofino'},
        's10': {'target': 'tofino', 'architecture': 'tofino2'},
        's2': {},
    }
    runner.links = runner.parse_links([['s10', 's2'], ['s2', 's1']])
    monkeypatch.setattr(netsim, 'Mininet', Mock())
    monkeypatch.setattr(netsim, 'configured_switch',
                        lambda base, options: {'kind': 'tofino', 'base': base, **options})
    monkeypatch.setattr(netsim, 'configureP4Switch',
                        lambda **options: {'kind': 'bmv2', **options})
    topology = Mock()
    monkeypatch.setattr(netsim, 'ParsedTopo', topology)

    runner.create_network()

    classes = topology.call_args.kwargs['switch_classes']
    assert classes['s1']['kind'] == classes['s10']['kind'] == 'tofino'
    assert classes['s1']['architecture'] == 'tofino'
    assert classes['s10']['architecture'] == 'tofino2'
    assert (classes['s1']['device_id'], classes['s1']['grpc_port'],
            classes['s1']['model_port_base'], classes['s1']['status_port']) == (0, 51051, 18000, 17000)
    assert (classes['s2']['kind'], classes['s2']['device_id'], classes['s2']['grpc_port'],
            classes['s2']['thrift_port']) == ('bmv2', 1, 50052, 9091)
    assert (classes['s10']['device_id'], classes['s10']['grpc_port'],
            classes['s10']['model_port_base'], classes['s10']['status_port']) == (2, 51053, 18032, 17002)


def test_mixed_switch_discovery_publishes_dynamic_tofino_endpoints(runner):
    runner.net = SimpleNamespace(switches=[
        SimpleNamespace(name='s1', target='tofino', device_id=0, grpc_port=44679,
                        thrift_port=None, architecture='tofino',
                        target_options={'client_id': 0, 'pipe_id': 0, 'architecture': 'tofino'}),
        SimpleNamespace(name='s2', target='tofino', device_id=1, grpc_port=33491,
                        thrift_port=None, architecture='tofino2',
                        target_options={'client_id': 0, 'pipe_id': 0, 'architecture': 'tofino2'}),
        SimpleNamespace(name='s3', target='bmv2', device_id=2, grpc_port=50053, thrift_port=9092),
    ])

    mappings = runner.populate_switch_mappings()

    assert [(item['name'], item['target'], item['address']) for item in mappings] == [
        ('s1', 'tofino', '127.0.0.1:44679'),
        ('s2', 'tofino', '127.0.0.1:33491'),
        ('s3', 'bmv2', '127.0.0.1:50053'),
    ]
    assert mappings[0]['architecture'] == 'tofino'
    assert mappings[1]['architecture'] == 'tofino2'
    assert len({item['grpc_port'] for item in mappings}) == 3


def test_mixed_topology_preflights_each_tofino_generation_once(runner, tmp_path, monkeypatch):
    available = Mock()
    monkeypatch.setattr('runtime.tofino.supervisor.check_available', available)
    path = tmp_path / 'mixed-generations.json'
    path.write_text(json.dumps({
        'hosts': [],
        'switches': {
            's1': {'target': 'tofino', 'architecture': 'tofino'},
            's2': {'target': 'tofino', 'architecture': 'tofino2'},
            's3': {},
        },
        'links': [['s1', 's2'], ['s2', 's3']],
    }))

    runner.read_topology_file(path)

    assert [item.kwargs for item in available.call_args_list] == [
        {'architecture': 'tofino'}, {'architecture': 'tofino2'}]


def test_failed_tofino2_start_rolls_back_partial_mixed_topology(runner):
    candidate = {
        'hosts': [],
        'switches': {
            's1': {'target': 'tofino', 'architecture': 'tofino'},
            's2': {'target': 'tofino', 'architecture': 'tofino2'},
            's3': {},
        },
        'links': runner.parse_links([['s1', 's2'], ['s2', 's3']], hosts=[], switches={
            's1': {'target': 'tofino'}, 's2': {'target': 'tofino'}, 's3': {}}),
        'ext_intfs': [],
        'layout': {},
    }
    runner.destroy_topology = Mock()

    def create_network():
        runner.net = Mock()
        def fail_during_start():
            runner.switch_progress('s1', 'ready')
            runner.switch_progress('s2', 'failed')
            raise RuntimeError('Tofino switch s2 failed')
        runner.net.start.side_effect = fail_during_start
    runner.create_network = create_network

    with pytest.raises(RuntimeError, match='s2 failed'):
        runner.run(candidate=candidate)

    assert runner.destroy_topology.call_count == 2
    assert runner.deployment == {
        'status': 'failed',
        'error': 'Tofino switch s2 failed',
        'switches': {'s1': 'ready', 's2': 'failed', 's3': 'pending'},
    }


def test_repeated_mixed_redeploy_rolls_back_failure_then_reuses_only_released_endpoint(runner):
    candidate = {
        'hosts': [],
        'switches': {
            's1': {'target': 'tofino', 'architecture': 'tofino'},
            's2': {'target': 'tofino', 'architecture': 'tofino2'},
            's3': {},
        },
        'links': runner.parse_links([['s1', 's2'], ['s2', 's3']], hosts=[], switches={
            's1': {'target': 'tofino'}, 's2': {'target': 'tofino'}, 's3': {}}),
        'ext_intfs': [],
        'layout': {},
    }

    def native(name, architecture, device_id, port):
        return SimpleNamespace(name=name, target='tofino', architecture=architecture,
            device_id=device_id, grpc_port=port, thrift_port=None,
            target_options={'client_id': 0, 'pipe_id': 0, 'architecture': architecture})

    first = SimpleNamespace(start=Mock(), stop=Mock(), switches=[
        native('s1', 'tofino', 0, 42001), native('s2', 'tofino2', 1, 42002),
        SimpleNamespace(name='s3', target='bmv2', device_id=2, grpc_port=50053, thrift_port=9092),
    ])
    failed = SimpleNamespace(start=Mock(), stop=Mock(), switches=[])
    def fail_start():
        runner.switch_progress('s1', 'ready')
        runner.switch_progress('s2', 'failed')
        raise RuntimeError('second deployment failed')
    failed.start.side_effect = fail_start
    retried = SimpleNamespace(start=Mock(), stop=Mock(), switches=[
        # Reusing 42001 is safe only because the first relay was stopped.
        native('s1', 'tofino', 0, 42001), native('s2', 'tofino2', 1, 42003),
        SimpleNamespace(name='s3', target='bmv2', device_id=2, grpc_port=50053, thrift_port=9092),
    ])
    networks = iter((first, failed, retried))

    def create_network():
        runner.net = next(networks)

    def destroy_topology():
        if runner.net is not None:
            runner.net.stop()
        runner.net = None
        runner.switch_mappings = []
        runner.interface_mapping = {}

    runner.create_network = create_network
    runner.destroy_topology = destroy_topology
    runner.program_hosts = Mock()
    runner.build_interface_mapping = Mock(return_value={})

    runner.run(candidate=candidate)
    assert [item['grpc_port'] for item in runner.switch_mappings] == [42001, 42002, 50053]
    assert len({item['grpc_port'] for item in runner.switch_mappings}) == 3

    with pytest.raises(RuntimeError, match='second deployment failed'):
        runner.run(candidate=candidate)
    assert first.stop.call_count == failed.stop.call_count == 1
    assert runner.net is None and runner.switch_mappings == []
    assert runner.deployment['status'] == 'failed'

    runner.run(candidate=candidate)
    assert [item['grpc_port'] for item in runner.switch_mappings] == [42001, 42003, 50053]
    assert len({item['grpc_port'] for item in runner.switch_mappings}) == 3
    assert runner.deployment['status'] == 'ready'
    runner.destroy_topology()
    assert retried.stop.call_count == 1


def test_mixed_interface_mapping_uses_each_generation_device_port_base(runner):
    def model(name, architecture):
        interface = Mock()
        interface.name, interface.IP.return_value = f'{name}-eth1', ''
        interface.link = None
        loopback = Mock()
        loopback.IP.return_value = '127.0.0.1'
        return SimpleNamespace(name=name, target='tofino', architecture=architecture,
            intfs={0: loopback, 1: interface},
            device_port=lambda port, base=8 if architecture == 'tofino2' else 0: base + port - 1)

    runner.net = SimpleNamespace(switches=[model('s1', 'tofino'), model('s2', 'tofino2')])
    mapping = runner.build_interface_mapping()
    assert mapping['s1'][0]['device_port'] == 0
    assert mapping['s2'][0]['device_port'] == 8


@pytest.mark.parametrize('target', ['other', None, 1, []])
def test_unknown_target_rejected_before_teardown(runner, tmp_path, target):
    path = tmp_path / 'target.json'
    path.write_text(json.dumps({'hosts': [], 'switches': {'s1': {'target': target}}, 'links': []}))
    runner.topo_file = path
    runner.destroy_topology = Mock()
    with pytest.raises(ValueError, match='Switch target'):
        runner.run()
    runner.destroy_topology.assert_not_called()


def test_model_port_limit_is_checked_before_teardown(runner, tmp_path):
    path = tmp_path / 'too-many-ports.json'
    path.write_text(json.dumps({'hosts': [], 'switches': {'s1': {'target': 'tofino'}, 's2': {}},
                                'links': [['s1', 's2']] * 65}))
    with pytest.raises(ValueError, match='at most 64 ports'):
        runner.read_topology_file(path)


def test_model_discovery_reports_logical_and_native_identity(runner):
    runner.net = SimpleNamespace(switches=[SimpleNamespace(name='s2', target='tofino', device_id=7,
        grpc_port=51052, thrift_port=None, target_options={'client_id': 0, 'pipe_id': 0})])
    assert runner.populate_switch_mappings() == [{'name': 's2', 'target': 'tofino', 'dev_id': 7,
        'runtime_device_id': 0, 'grpc_port': 51052, 'thrift_port': None, 'address': '127.0.0.1:51052',
        'architecture': 'tofino', 'target_options': {'client_id': 0, 'pipe_id': 0}, 'status': 'ready'}]


def test_physical_interface_returns_to_original_namespace_before_switch_teardown(runner):
    node = Mock()
    node.target = 'tofino'
    node.popen.return_value.wait.return_value = 0
    interface = SimpleNamespace(name='eth9', node=node)
    runner.external_intf_objects = [interface]
    runner.detach_external_interfaces()
    command = node.popen.call_args.args[0]
    assert command[:6] == ['ip', 'link', 'set', 'dev', 'eth9', 'netns']
    node.delIntf.assert_called_once_with(interface)
    assert interface.node is None


def test_preflight_accepts_external_interface_owned_by_current_switch_namespace(runner, monkeypatch):
    runner.external_intf_objects = [SimpleNamespace(name='eth9')]
    monkeypatch.setattr('netsim.api.netsim.netsim.os.path.exists', lambda _: False)
    assert runner.parse_ext_intfs([['s1', 'eth9']]) == [{'switch': 's1', 'interface': 'eth9'}]


def test_disconnected_model_rejected_before_teardown_but_external_interface_counts(runner, tmp_path, monkeypatch):
    monkeypatch.setattr('runtime.tofino.supervisor.check_available', Mock())
    path = tmp_path / 'disconnected-model.json'
    topology = {'hosts': [], 'switches': {'s1': {'target': 'tofino'}}, 'links': []}
    path.write_text(json.dumps(topology))
    runner.topo_file = path
    runner.destroy_topology = Mock()
    with pytest.raises(ValueError, match='requires at least one interface'):
        runner.run()
    runner.destroy_topology.assert_not_called()
    monkeypatch.setattr('netsim.api.netsim.netsim.os.path.exists', lambda _: True)
    topology['ext_intfs'] = [['s1', 'physical1']]
    path.write_text(json.dumps(topology))
    assert runner.read_topology_file(path)['ext_intfs'] == [{'switch': 's1', 'interface': 'physical1'}]
