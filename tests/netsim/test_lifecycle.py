import json
from threading import RLock
from types import SimpleNamespace
from unittest.mock import Mock

from flask import Flask
from flask_restful import Api

import netsim.api as module
from netsim.api import NodeCLI, WebsocketManager
from netsim.api.endpoints.load_topology import LoadTopology


class FakeNode:
    def __init__(self, name):
        self.name = name
        self.shell = object()
        self.waiting = False
        self.stop = Mock()
        self.startShell = Mock()
        self.sendInt = Mock()


def manager(monkeypatch):
    monkeypatch.setattr(module, 'P4Host', FakeNode)
    monkeypatch.setattr(module, 'P4Switch', FakeNode)
    runner = SimpleNamespace(net={'h1': FakeNode('h1')}, lifecycle_lock=RLock())
    return WebsocketManager(Mock(), runner), runner


def test_terminal_init_does_not_restart_or_stop_node_shells(monkeypatch):
    ws, runner = manager(monkeypatch)
    ws.init_clis()
    ws.init_clis()
    node = runner.net['h1']
    assert list(ws.clis) == ['h1']
    node.stop.assert_not_called()
    node.startShell.assert_not_called()


def test_terminal_close_interrupts_command_without_stopping_node(monkeypatch):
    ws, runner = manager(monkeypatch)
    ws.init_clis()
    adapter = ws.clis['h1']
    node = runner.net['h1']
    node.waiting = True
    ws.close_clis()
    node.sendInt.assert_called_once()
    node.stop.assert_not_called()
    assert adapter.stop_event.is_set()
    assert ws.clis == {}


def test_new_topology_uses_only_new_nodes_and_empty_topology_is_valid(monkeypatch):
    ws, runner = manager(monkeypatch)
    ws.init_clis()
    runner.net = {'h2': FakeNode('h2')}
    ws.init_clis()
    assert set(ws.clis) == {'h2'}
    runner.net = None
    ws.init_clis()
    assert ws.clis == {}


def test_terminal_command_output_and_interrupt_are_routed(monkeypatch):
    ws, runner = manager(monkeypatch)
    ws.init_clis()
    cli = ws.clis['h1']
    cli.run_cmd = Mock()
    ws.handle_message({'target': 'h1', 'cmd': 'echo example'})
    cli.run_cmd.assert_called_once_with('echo example')
    ws.handle_message({'target': 'h1', 'interrupt': True})
    runner.net['h1'].sendInt.assert_called_once()
    cli.handle_output('example\n')
    assert json.loads(ws.socket.emit.call_args.args[1]) == {'name': 'h1', 'data': 'example\n'}


def test_unknown_terminal_returns_message_instead_of_server_error(monkeypatch):
    ws, _ = manager(monkeypatch)
    ws.handle_message({'target': 'missing', 'cmd': 'echo example'})
    assert 'unavailable' in json.loads(ws.socket.emit.call_args.args[1])['data']
    ws.handle_message(None)


def test_node_cli_rejects_overlapping_commands():
    node, socket = FakeNode('h1'), Mock()
    node.sendCmd = Mock()
    cli = NodeCLI(node, socket)
    cli.command_lock.acquire()
    cli.run_cmd('echo example')
    node.sendCmd.assert_not_called()
    assert 'already running' in json.loads(socket.emit.call_args.args[1])['data']
    cli.command_lock.release()


def test_load_lifecycle_initializes_terminals_before_response_and_clear():
    events = []
    runner = SimpleNamespace(lifecycle_lock=RLock(), topo_file=None)
    candidate = {'hosts': ['h1'], 'switches': {'s1': {}}, 'links': []}
    runner.read_topology_file = Mock(side_effect=lambda _: events.append('validate') or candidate)
    runner.run = Mock(side_effect=lambda **_: events.append('run'))
    runner.destroy_topology = Mock(side_effect=lambda: events.append('destroy'))
    runner.topology_state = lambda **_: {'file_name': runner.topo_file}
    ws = SimpleNamespace(close_clis=lambda: events.append('close'), init_clis=lambda: events.append('init'))
    app = Flask(__name__)
    Api(app).add_resource(LoadTopology, '/topology/load', resource_class_kwargs={'netsim': runner, 'ws': ws})
    client = app.test_client()
    response = client.post('/topology/load', json={'topology_file': 'topology.json'})
    assert response.status_code == 200
    assert events == ['validate', 'close', 'run', 'init']
    runner.run.assert_called_once_with(candidate=candidate)
    runner.read_topology_file.assert_called_once_with('topology.json')
    assert response.json['file_name'] == 'topology.json'
    assert client.delete('/topology/load').status_code == 200
    assert runner.topo_file is None
    assert events[-2:] == ['close', 'destroy']


def test_bad_candidate_preserves_existing_topology():
    runner = SimpleNamespace(lifecycle_lock=RLock(), topo_file='previous.json',
                             read_topology_file=Mock(side_effect=ValueError('bad candidate')))
    ws = Mock()
    app = Flask(__name__)
    Api(app).add_resource(LoadTopology, '/topology/load', resource_class_kwargs={'netsim': runner, 'ws': ws})
    response = app.test_client().post('/topology/load', json={'topology_file': 'broken.json'})
    assert response.status_code == 400
    assert runner.topo_file == 'previous.json'
    ws.close_clis.assert_not_called()
