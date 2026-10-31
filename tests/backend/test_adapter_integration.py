import importlib
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

import grpc
from google.protobuf.struct_pb2 import Struct
from sqlalchemy import inspect, text
import pytest

from controller.managers.SwitchManager import SwitchManager
from controller.p4.v1 import p4runtime_pb2 as pb


def config(**settings):
    return dict({"name": "external", "address": "external.example:9559", "device_id": 7,
                 "proto_dump_file": None}, **settings)


@pytest.fixture
def connection_factory(monkeypatch, switch):
    created = []
    def create(**settings):
        connection = Mock()
        for key, value in settings.items():
            setattr(connection, key, value)
        response = pb.StreamMessageResponse()
        response.arbitration.status.code = 0
        connection.MasterArbitrationUpdate.return_value = response
        connection.client_stub.Capabilities.return_value = pb.CapabilitiesResponse(p4runtime_api_version='1.3.0')
        connection.GetForwardingPipelineConfig.return_value = switch.p4_helper.p4info
        connection.ReadEntities.return_value = iter([])
        created.append(connection)
        return connection
    factory = Mock(side_effect=create)
    monkeypatch.setattr(importlib.import_module('controller.managers.SwitchManager'), 'Bmv2SwitchConnection', factory)
    return factory, created


def test_default_external_connection_never_starts_adapter_or_contacts_thrift(connection_factory, monkeypatch):
    adapter = Mock()
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', adapter)
    manager = SwitchManager(7, config())
    manager.connect()
    assert manager.connected
    adapter.assert_not_called()
    assert manager._register_adapter is None
    assert connection_factory[0].call_args.kwargs['address'] == 'external.example:9559'
    assert manager.as_json()['address'] == 'external.example:9559'
    assert manager.register_access['status'] == 'unknown'
    manager.shutdown()


def test_explicit_adapter_routes_only_runtime_connection_and_keeps_original_address(connection_factory, monkeypatch):
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter', available=True, read=True, write=True, max_bitwidth=63)
    factory = Mock(return_value=adapter)
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', factory)
    original = config(register_adapter_enabled=True, register_thrift_host='external.example', register_thrift_port=9090)
    manager = SwitchManager(7, original)
    manager.connect()
    factory.assert_called_once_with('external.example:9559', 'external.example', 9090, 7)
    assert connection_factory[0].call_args.kwargs['address'] == '127.0.0.1:12345'
    assert not any(name.startswith('register_') for name in connection_factory[0].call_args.kwargs)
    assert original['address'] == manager.config['address'] == manager.as_json()['address'] == 'external.example:9559'
    assert manager.as_json()['register_access']['mode'] == 'adapter'
    manager.shutdown()
    adapter.close.assert_called_once()
    assert not manager.connected


def test_failed_connection_closes_created_adapter(connection_factory, monkeypatch):
    factory, _ = connection_factory
    factory.side_effect = RuntimeError('P4Runtime unavailable')
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter')
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', Mock(return_value=adapter))
    manager = SwitchManager(7, config(register_adapter_enabled=True, register_thrift_host='external.example', register_thrift_port=9090))
    with pytest.raises(Exception, match='P4Runtime unavailable'):
        manager.connect()
    adapter.close.assert_called_once()
    assert not manager.connected


def test_adapter_closes_even_if_runtime_shutdown_fails(connection_factory, monkeypatch):
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter')
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', Mock(return_value=adapter))
    manager = SwitchManager(7, config(register_adapter_enabled=True, register_thrift_host='host', register_thrift_port=9090))
    manager.connect()
    manager.bmv2.shutdown.side_effect = RuntimeError('channel cleanup failed')
    with pytest.raises(RuntimeError):
        manager.shutdown()
    adapter.close.assert_called_once()
    assert not manager.connected


def test_failed_arbitration_still_closes_adapter_if_channel_cleanup_fails(connection_factory, monkeypatch):
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter')
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', Mock(return_value=adapter))
    factory, _ = connection_factory
    create = factory.side_effect
    def rejected(**settings):
        connection = create(**settings)
        connection.MasterArbitrationUpdate.return_value.arbitration.status.code = 7
        connection.shutdown.side_effect = RuntimeError('channel cleanup failed')
        return connection
    factory.side_effect = rejected
    manager = SwitchManager(7, config(register_adapter_enabled=True, register_thrift_host='host', register_thrift_port=9090))
    with pytest.raises(Exception, match='Failed to connect to switch'):
        manager.connect()
    adapter.close.assert_called_once()
    assert not manager.connected


def test_optional_malformed_capabilities_do_not_break_table_connection(connection_factory):
    manager = SwitchManager(7, config())
    factory, _ = connection_factory
    create = factory.side_effect
    def malformed(**settings):
        connection = create(**settings)
        extension = Struct()
        extension.update({'source': 'unicorn-register-extension', 'max_bitwidth': 'invalid'})
        connection.client_stub.Capabilities.return_value.experimental.Pack(extension)
        return connection
    factory.side_effect = malformed
    manager.connect()
    assert manager.connected
    assert manager.register_access['status'] == 'unknown'
    manager.shutdown()


def test_empty_external_read_does_not_falsely_claim_support(switch):
    switch.bmv2.ReadEntities.return_value = iter([])
    switch._probe_register_access()
    assert switch.register_access['status'] == 'unknown'
    assert not switch._register_probe_done


def test_probe_skips_unsupported_register_types_instead_of_disabling_all_registers(switch):
    first = switch.p4_helper.p4info.registers[0]
    first.type_spec.Clear()
    first.type_spec.struct.name = 'ComplexRegister'
    second = switch.p4_helper.p4info.registers[1]
    second.type_spec.Clear()
    second.type_spec.bitstring.bit.bitwidth = 32
    switch.bmv2.ReadEntities.return_value = iter([])
    switch._probe_register_access()
    request = switch.bmv2.ReadEntities.call_args.args[0][0]
    assert request.register_entry.register_id == second.preamble.id
    assert switch.register_access['status'] == 'unknown'


def test_native_read_capability_probe_is_read_only_and_does_not_claim_write(switch):
    response = pb.ReadResponse()
    actual = response.entities.add().register_entry
    actual.register_id = switch.p4_helper.p4info.registers[1].preamble.id
    actual.index.index = 0
    actual.data.bitstring = b'\x00'
    switch.bmv2.ReadEntities.return_value = iter([response])
    switch._probe_register_access()
    assert switch.register_access['read'] is True
    assert switch.register_access['write'] is None
    selector = switch.bmv2.ReadEntities.call_args.args[0][0].register_entry
    assert selector.HasField('index') and selector.index.index == 0
    switch.bmv2.ModifyEntities.assert_not_called()
    switch.bmv2.WriteEntity.assert_not_called()


def test_stock_unimplemented_probe_does_not_break_mat_operations(switch):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.UNIMPLEMENTED
    switch.bmv2.ReadEntities.side_effect = error
    switch.bmv2.ReadTableEntries.return_value = iter([])
    switch._probe_register_access()
    assert switch.register_access['status'] == 'unsupported'
    assert switch.register_access['available'] is False
    assert switch.get_table_entries('Ingress.table') == {'Ingress.table': []}
    switch.bmv2.ModifyEntities.assert_not_called()


def test_transient_external_probe_error_remains_unknown_and_retryable(switch):
    error = grpc.RpcError()
    error.code = lambda: grpc.StatusCode.UNAVAILABLE
    switch.bmv2.ReadEntities.side_effect = error
    switch._probe_register_access()
    assert switch.register_access['status'] == 'unknown'
    assert not switch._register_probe_done


def test_legacy_database_migration_is_additive_idempotent_and_preserves_saved_configs(tmp_path, monkeypatch):
    path = tmp_path / 'legacy.db'
    with sqlite3.connect(path) as connection:
        connection.executescript('''
            CREATE TABLE SwitchConfigs (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL,
                address VARCHAR NOT NULL, device_id INTEGER NOT NULL, proto_dump_file VARCHAR,
                date_created DATETIME, last_connection DATETIME,
                CONSTRAINT uix_1 UNIQUE(name, address, device_id));
            INSERT INTO SwitchConfigs VALUES (42, 'lecture-switch', 'example:9559', 7, NULL,
                '2026-10-31 12:00:00', '2026-10-31 12:00:00');
            CREATE TABLE lecture_notes (message TEXT);
            INSERT INTO lecture_notes VALUES ('preserve this');
        ''')
    monkeypatch.setenv('DB_DIR', str(path))
    monkeypatch.setenv('UPDATE_CHECK_ENABLED', 'false')
    from api import create_app, exampleController
    from api.database import db
    from api.database.migrations import migrate_switch_adapter_fields
    exampleController.switch_configs = {}
    app = create_app()
    with app.app_context():
        migrate_switch_adapter_fields(db.engine)
        assert {'register_adapter_enabled', 'register_thrift_host', 'register_thrift_port'} <= {
            column['name'] for column in inspect(db.engine).get_columns('SwitchConfigs')}
        assert db.session.execute(text('SELECT message FROM lecture_notes')).scalar_one() == 'preserve this'
    rows = app.test_client().get('/switches/known').json
    assert rows[0]['id'] == 42
    assert rows[0]['address'] == 'example:9559'
    assert rows[0]['register_adapter_enabled'] is False
    assert rows[0]['register_thrift_host'] is None
    assert rows[0]['register_thrift_port'] is None


@pytest.mark.parametrize('enabled', [False, True])
def test_saved_adapter_settings_round_trip_active_history_edit_and_reconnect(client, app, connection_factory, monkeypatch, enabled):
    from api import exampleController
    exampleController.switch_configs = {}
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter', available=True, read=True, write=True, max_bitwidth=63)
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', Mock(return_value=adapter))
    original = config(register_adapter_enabled=enabled, register_thrift_host='external.example', register_thrift_port=9090)
    assert client.post('/switches/active', json={'switch_config': json.dumps(original)}).status_code == 200
    assert client.delete('/switches/active', json={'device_id': 7}).status_code == 200
    history = client.get('/switches/known').json
    assert len(history) == 1
    record = history[0]
    assert record['register_thrift_host'] == 'external.example'
    assert record['register_thrift_port'] == 9090
    updated = dict(original, register_thrift_host='another.example', register_thrift_port=9091)
    assert client.patch('/switches/known', json={'db_id': record['id'], 'switch_config': json.dumps(updated)}).status_code == 200
    assert client.post('/switches/known', json={'db_id': record['id']}).status_code == 200
    active = exampleController.switch_configs[7]
    assert active.config['register_thrift_host'] == 'another.example'
    assert active.config['register_thrift_port'] == 9091
    assert active.config['register_adapter_enabled'] is enabled
    assert active.config['address'] == 'external.example:9559'
    active.shutdown()


@pytest.mark.parametrize('settings', [dict(register_adapter_enabled='false'),
    dict(register_adapter_enabled=True), dict(register_adapter_enabled=True, register_thrift_host='host', register_thrift_port='9090')])
def test_invalid_adapter_config_is_rejected_before_connect(client, connection_factory, settings):
    response = client.post('/switches/active', json={'switch_config': json.dumps(config(**settings))})
    assert response.status_code == 400
    connection_factory[0].assert_not_called()


def test_readding_same_switch_updates_persisted_adapter_settings(client, app, connection_factory, monkeypatch):
    from api import exampleController
    from api.database import db
    from api.database.SwitchConfigs import SwitchConfigs
    exampleController.switch_configs = {}
    adapter = Mock(address='127.0.0.1:12345')
    adapter.capabilities = dict(source='adapter')
    monkeypatch.setattr(importlib.import_module('controller.managers.RegisterAdapter'), 'RegisterAdapter', Mock(return_value=adapter))
    original = config(register_adapter_enabled=True, register_thrift_host='host', register_thrift_port=9090)
    assert client.post('/switches/active', json={'switch_config': json.dumps(original)}).status_code == 200
    first_id = exampleController.switch_configs[7].db_id
    client.delete('/switches/active', json={'device_id': 7})
    replacement = config(register_adapter_enabled=False, register_thrift_host=None, register_thrift_port=None,
                         proto_dump_file='new.log')
    assert client.post('/switches/active', json={'switch_config': json.dumps(replacement)}).status_code == 200
    assert exampleController.switch_configs[7].db_id == first_id
    with app.app_context():
        rows = SwitchConfigs.query.all()
        assert len(rows) == 1
        assert rows[0].register_adapter_enabled is False
        assert rows[0].register_thrift_host is None
        assert rows[0].register_thrift_port is None
        assert rows[0].proto_dump_file == 'new.log'
    client.delete('/switches/active', json={'device_id': 7})


def test_persistence_failure_closes_only_the_new_connection(client, connection_factory, monkeypatch):
    from api import exampleController
    from api.database import db
    exampleController.switch_configs = {}
    monkeypatch.setattr(db.session, 'commit', Mock(side_effect=RuntimeError('database write failed')))
    response = client.post('/switches/active', json={'switch_config': json.dumps(config())})
    assert response.status_code == 500
    assert exampleController.switch_configs == {}
    connection_factory[1][0].shutdown.assert_called_once()


def test_duplicate_active_device_does_not_close_existing_connection(client, connection_factory):
    from api import exampleController
    exampleController.switch_configs = {}
    assert client.post('/switches/active', json={'switch_config': json.dumps(config())}).status_code == 200
    original = exampleController.switch_configs[7]
    response = client.post('/switches/active', json={'switch_config': json.dumps(config(name='other'))})
    assert response.status_code == 500
    assert exampleController.switch_configs[7] is original
    original.bmv2.shutdown.assert_not_called()
    client.delete('/switches/active', json={'device_id': 7})


def test_unknown_saved_switch_and_invalid_settings_are_clean_errors(client, app):
    assert client.post('/switches/known', json={'db_id': 999}).status_code == 404
    assert client.patch('/switches/known', json={'db_id': 999, 'switch_config': '{}'}).status_code == 404
    assert client.delete('/switches/known', json={'db_id': 999}).status_code == 404
