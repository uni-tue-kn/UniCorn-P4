import json

import pytest

from threading import Event, Lock, RLock
from types import SimpleNamespace
from unittest.mock import Mock

from flask import Flask
from flask_restful import Api

from netsim.api.endpoints.deploy_topology import DeployTopology, DeploymentStatus
from netsim.api.endpoints.load_topology import LoadTopology


def deployment_api(run):
    runner = SimpleNamespace(operation_lock=Lock(), lifecycle_lock=RLock(), deployment_jobs={},
                             deployment={'switches': {}}, topo_file='previous.json')
    runner.read_topology_file = Mock(return_value={'hosts': [], 'switches': {}, 'links': []})
    runner.run = run
    runner.topology_state = lambda **_: {'file_name': runner.topo_file, 'switches_online': []}
    ws = Mock()
    app = Flask(__name__)
    api = Api(app)
    args = {'netsim': runner, 'ws': ws}
    api.add_resource(DeployTopology, '/topology/deploy', resource_class_kwargs=args)
    api.add_resource(DeploymentStatus, '/topology/deploy/<deployment_id>', resource_class_kwargs=args)
    api.add_resource(LoadTopology, '/topology/load', resource_class_kwargs=args)
    return app.test_client(), runner, ws


def test_async_deployment_exposes_progress_and_rejects_concurrent_mutations():
    entered, release = Event(), Event()

    def run(**_):
        entered.set()
        assert release.wait(5)

    client, runner, ws = deployment_api(run)
    response = client.post('/topology/deploy', json={'topology_file': 'new.json'})
    try:
        assert response.status_code == 202
        assert entered.wait(2)
        runner.deployment = {'switches': {'s1': 'model_starting'}}
        url = '/topology/deploy/' + response.json['deployment_id']
        status = client.get(url)
        assert status.json['status'] == 'running'
        assert status.json['switches'] == {'s1': 'model_starting'}
        assert client.post('/topology/deploy', json={'topology_file': 'other.json'}).status_code == 409
        assert client.post('/topology/load', json={'topology_file': 'other.json'}).status_code == 409
        assert client.delete('/topology/load').status_code == 409
    finally:
        release.set()
    # Acquiring the operation lock waits for publication of the result.
    assert runner.operation_lock.acquire(timeout=2)
    runner.operation_lock.release()
    result = client.get(url).json
    assert result['status'] == 'ready'
    assert result['topology']['file_name'] == 'new.json'
    ws.init_clis.assert_called_once()


def test_bad_async_candidate_never_closes_existing_nodes():
    client, runner, ws = deployment_api(Mock())
    runner.read_topology_file.side_effect = ValueError('invalid target')
    response = client.post('/topology/deploy', json={'topology_file': 'bad.json'})
    assert response.status_code == 400
    assert runner.topo_file == 'previous.json'
    runner.run.assert_not_called()
    ws.close_clis.assert_not_called()
    assert not runner.operation_lock.locked()


def test_failed_job_reports_error_and_releases_operation_lock():
    client, runner, ws = deployment_api(Mock(side_effect=RuntimeError('model failed')))
    response = client.post('/topology/deploy', json={'topology_file': 'bad-model.json'})
    assert runner.operation_lock.acquire(timeout=2)
    runner.operation_lock.release()
    result = client.get('/topology/deploy/' + response.json['deployment_id']).json
    assert result['status'] == 'failed'
    assert result['error'] == 'model failed'
    ws.init_clis.assert_not_called()
    assert client.get('/topology/deploy/missing').status_code == 404


def test_system_exit_marks_async_job_failed_and_releases_operation_lock():
    def abort(**_):
        raise SystemExit('switch port is occupied')
    client, runner, _ = deployment_api(abort)
    response = client.post('/topology/deploy', json={'topology_file': 'bad.json'})
    assert runner.operation_lock.acquire(timeout=2)
    runner.operation_lock.release()
    result = client.get('/topology/deploy/' + response.json['deployment_id']).json
    assert result['status'] == 'failed'
    assert result['error'] == 'switch port is occupied'


def test_terminal_setup_failure_preserves_successful_async_deployment():
    client, runner, ws = deployment_api(Mock())
    ws.init_clis.side_effect = RuntimeError('terminal unavailable')
    response = client.post('/topology/deploy', json={'topology_file': 'new.json'})
    assert runner.operation_lock.acquire(timeout=2)
    runner.operation_lock.release()
    result = client.get('/topology/deploy/' + response.json['deployment_id']).json
    assert result['status'] == 'ready'
    assert result['topology']['file_name'] == runner.topo_file == 'new.json'
    assert result['warnings'] == ['Terminals could not be initialized: terminal unavailable']


def test_terminal_close_failure_preserves_previous_topology_before_replacement():
    client, runner, ws = deployment_api(Mock())
    ws.close_clis.side_effect = RuntimeError('terminal close failed')
    response = client.post('/topology/deploy', json={'topology_file': 'new.json'})
    assert runner.operation_lock.acquire(timeout=2)
    runner.operation_lock.release()
    result = client.get('/topology/deploy/' + response.json['deployment_id']).json
    assert result['status'] == 'failed'
    assert result['error'] == 'terminal close failed'
    assert runner.topo_file == 'previous.json'
    runner.run.assert_not_called()


@pytest.mark.parametrize('endpoint,resource', [('/topology/load', LoadTopology), ('/topology/deploy', DeployTopology)])
@pytest.mark.parametrize('reason', ['Tofino executable is missing: /sdk/bin/tofino-model',
                                  'Tofino default bundle is unavailable: /bundles/empty/manifest.json'])
def test_unavailable_model_keeps_running_topology_and_terminals(tmp_path, monkeypatch, endpoint, resource, reason):
    from netsim.api.netsim.netsim import MininetRunner
    runner = MininetRunner(None, str(tmp_path / 'logs'), str(tmp_path / 'pcaps'), quiet=True)
    runner.topo_file = 'previous.json'
    runner.hosts = ['h7']
    runner.switches = {'s7': {}}
    old_network = runner.net = object()
    runner.destroy_topology = Mock()
    before = runner.topology_state()
    candidate = tmp_path / 'mixed.json'
    candidate.write_text(json.dumps({'hosts': [], 'switches': {'s1': {'target': 'tofino'}, 's2': {}},
                                     'links': [['s1', 's2']]}))
    available = Mock(side_effect=ValueError(reason))
    monkeypatch.setattr('runtime.tofino.supervisor.check_available', available)
    ws = Mock()
    app = Flask(__name__)
    Api(app).add_resource(resource, endpoint, resource_class_kwargs={'netsim': runner, 'ws': ws})
    response = app.test_client().post(endpoint, json={'topology_file': str(candidate)})
    assert response.status_code == 400
    assert reason in response.json['error']
    available.assert_called_once_with()
    ws.close_clis.assert_not_called()
    runner.destroy_topology.assert_not_called()
    assert runner.net is old_network
    assert runner.topology_state() == before
    assert not runner.operation_lock.locked()
    assert runner.deployment_jobs == {}


def test_legacy_candidate_never_requires_optional_model_sdk(tmp_path, monkeypatch):
    from netsim.api.netsim.netsim import MininetRunner
    runner = MininetRunner(None, str(tmp_path / 'logs'), str(tmp_path / 'pcaps'), quiet=True)
    available = Mock(side_effect=ValueError('SDK not installed'))
    monkeypatch.setattr('runtime.tofino.supervisor.check_available', available)
    candidate = tmp_path / 'legacy.json'
    candidate.write_text(json.dumps({'hosts': [], 'switches': {'s1': {}}, 'links': []}))
    assert runner.read_topology_file(candidate)['switches'] == {'s1': {}}
    available.assert_not_called()
