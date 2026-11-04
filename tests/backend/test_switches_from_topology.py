import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from api.database import db
from api.database.SwitchConfigs import SwitchConfigs
from api.endpoints.switch_config import normalize_adapter_config


def native_config():
    # Exact shape emitted by topologyService.switchConfigs for native discovery:
    # device_id is the app's logical ID; runtime_device_id stays in options.
    return {'name': 's1', 'target': 'tofino', 'address': '127.0.0.1:51051', 'device_id': 7,
            'proto_dump_file': 's1_proto.log',
            'target_options': {'client_id': 0, 'pipe_id': 0, 'runtime_device_id': 0}}


@pytest.fixture
def connections(monkeypatch, app):
    from api import exampleController
    exampleController.switch_configs[0].bmv2.device_id = 0
    seen = []
    def connect(config):
        seen.append(deepcopy(config))
        manager = SimpleNamespace(db_id=-1, shutdown=Mock())
        manager.as_json = lambda: dict(config, db_id=manager.db_id)
        exampleController.switch_configs[config['device_id']] = manager
    add = Mock(side_effect=connect)
    delete = Mock(wraps=exampleController.deleteSwitchConnection)
    monkeypatch.setattr(exampleController, 'addSwitchConnection', add)
    monkeypatch.setattr(exampleController, 'deleteSwitchConnection', delete)
    return SimpleNamespace(controller=exampleController, add=add, delete=delete, seen=seen)


def test_native_discovery_config_connects_and_persists_only_normalized_settings(client, app, connections):
    config = native_config()
    response = client.post('/switches/from_topology', json={'switch_configs': json.dumps([config]), 'create_switches': True})
    assert response.status_code == 200
    connections.delete.assert_called_once_with(0)
    assert connections.seen == [normalize_adapter_config(config)]
    assert response.json[0]['device_id'] == 7
    assert response.json[0]['target_options']['runtime_device_id'] == 0
    with app.app_context():
        record = SwitchConfigs.query.one()
        assert record.target == 'tofino'
        assert record.target_options == config['target_options']
        assert connections.controller.switch_configs[7].db_id == record.id
        assert record.register_thrift_host is None and record.register_thrift_port is None


@pytest.mark.parametrize('malformed', [
    None, [], {}, {'switch_configs': '{'}, {'switch_configs': '{}'},
    {'switch_configs': json.dumps([native_config()]), 'create_switches': 'true'},
    {'switch_configs': json.dumps([native_config()]), 'unexpected': True},
    {'switch_configs': json.dumps([native_config(), dict(native_config(), runtime_device_id=0)])},
    {'switch_configs': json.dumps([native_config(), dict(native_config(), device_id=8, target_options=[])])},
    {'switch_configs': json.dumps([native_config(), dict(native_config(), device_id=8, proto_dump_file=17)])},
    {'switch_configs': json.dumps([native_config(), native_config()])},
    {'switch_configs': json.dumps([native_config(), None])},
])
def test_entire_topology_payload_is_rejected_before_any_disconnect_or_db_write(client, app, connections, malformed):
    response = client.post('/switches/from_topology', json=malformed)
    assert response.status_code == 400
    assert response.json['error']
    connections.delete.assert_not_called()
    connections.add.assert_not_called()
    assert 0 in connections.controller.switch_configs
    with app.app_context():
        assert SwitchConfigs.query.count() == 0


def test_existing_connection_record_refreshes_target_options_and_adapter_settings(client, app, connections):
    config = native_config()
    with app.app_context():
        old = SwitchConfigs(name=config['name'], address=config['address'], device_id=config['device_id'],
            target='bmv2', target_options={}, proto_dump_file='old.log', register_adapter_enabled=False,
            register_thrift_host='old-thrift', register_thrift_port=9090)
        db.session.add(old)
        db.session.commit()
        identity = old.id
    response = client.post('/switches/from_topology', json={'switch_configs': json.dumps([config]), 'create_switches': True})
    assert response.status_code == 200
    config['target_options'] = {'client_id': 42, 'pipe_id': 1, 'runtime_device_id': 0, 'program_name': 'routing'}
    response = client.post('/switches/from_topology', json={'switch_configs': json.dumps([config]), 'create_switches': True})
    assert response.status_code == 200
    with app.app_context():
        record = SwitchConfigs.query.one()
        assert record.id == identity
        assert record.target == 'tofino'
        assert record.target_options == config['target_options']
        assert record.proto_dump_file == 's1_proto.log'
        assert record.register_thrift_host is None and record.register_thrift_port is None
        assert record.register_adapter_enabled is False
        assert connections.controller.switch_configs[7].db_id == identity


def test_unknown_top_level_native_runtime_id_is_a_validation_error():
    with pytest.raises(ValueError, match='Unknown switch settings: runtime_device_id'):
        normalize_adapter_config(dict(native_config(), runtime_device_id=0))
