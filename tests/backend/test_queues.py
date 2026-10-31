from unittest.mock import Mock
from types import SimpleNamespace

import pytest
from thrift.Thrift import TApplicationException
from thrift.transport.TTransport import TTransportException

from controller.managers.QueueManager import QueueManager


@pytest.fixture
def native(switch, monkeypatch):
    switch.config.update(register_adapter_enabled=False, register_thrift_host='configured-switch', register_thrift_port=9097)
    transport, client = Mock(), Mock()
    for method in ('set_egress_queue_depth', 'set_all_egress_queue_depths', 'set_egress_queue_rate', 'set_all_egress_queue_rates'):
        getattr(client, method).return_value = 0
    connect = Mock(return_value=(transport, client))
    monkeypatch.setattr(QueueManager, '_client', connect)
    port_client = Mock()
    port_client.bm_dev_mgr_show_ports.return_value = [SimpleNamespace(port_num=number, iface_name=f's1-eth{number}', is_up=True) for number in (1, 2)]
    monkeypatch.setattr(QueueManager, '_ports_client', Mock(return_value=(Mock(), port_client)))
    return connect, transport, client


def test_get_reports_unknown_state_without_contacting_native(client, native):
    connect, _, _ = native
    response = client.get('/queues?switch_id=0')
    assert response.status_code == 200
    assert response.json['configured'] is True
    assert response.json['readback_available'] is False
    assert response.json['state'] == 'unknown'
    assert response.json['last_applied'] == []
    connect.assert_not_called()


def test_all_port_setters_acknowledge_and_record_exact_values(client, native):
    connect, transport, target = native
    response = client.patch('/queues', json={'switch_id': 0, 'depth_packets': 256, 'rate_pps': '9223372036854775807'})
    assert response.status_code == 200
    target.set_all_egress_queue_depths.assert_called_once_with(256)
    target.set_all_egress_queue_rates.assert_called_once_with((1 << 63) - 1)
    assert response.json['applied'][0]['depth_packets'] == 256
    assert response.json['applied'][1]['rate_pps'] == '9223372036854775807'
    assert response.json['applied'][0]['port'] is None
    assert client.get('/queues?switch_id=0').json['last_applied'] == response.json['applied']
    transport.close.assert_called_once()


def test_per_port_and_zero_unlimited_rate(client, native):
    _, _, target = native
    response = client.patch('/queues', json={'switch_id': 0, 'port': 2, 'rate_pps': '0'})
    assert response.status_code == 200
    target.set_egress_queue_rate.assert_called_once_with(2, 0)
    target.set_all_egress_queue_rates.assert_not_called()
    assert response.json['applied'][0]['rate_pps'] == '0'


@pytest.mark.parametrize('changes', [
    {}, {'depth_packets': 0}, {'depth_packets': -1}, {'depth_packets': 2147483648},
    {'depth_packets': True}, {'rate_pps': -1}, {'rate_pps': '9223372036854775808'},
    {'rate_pps': '1.2'}, {'rate_pps': False}, {'port': 511, 'depth_packets': 32},
    {'port': -1, 'depth_packets': 32}, {'priority': 1, 'depth_packets': 32},
    {'priority': 0, 'depth_packets': 32}, {'depth_packets': 32, 'rate_pps': 'bad'},
])
def test_invalid_settings_rejected_before_any_native_operation(client, native, changes):
    response = client.patch('/queues', json={'switch_id': 0, **changes})
    assert response.status_code == 400
    native[0].assert_not_called()


def test_partial_failure_preserves_acknowledged_first_change(client, native):
    _, transport, target = native
    target.set_egress_queue_rate.return_value = -7
    response = client.patch('/queues', json={'switch_id': 0, 'port': 1, 'depth_packets': 77, 'rate_pps': '100'})
    assert response.status_code == 503
    assert response.json['failed_setting'] == 'rate_pps'
    assert response.json['uncertain'] is False
    assert response.json['applied'][0]['depth_packets'] == 77
    assert client.get('/queues?switch_id=0').json['last_applied'] == response.json['applied']
    transport.close.assert_called_once()


def test_transport_failure_marks_current_outcome_unknown(client, native):
    _, _, target = native
    target.set_all_egress_queue_rates.side_effect = TTransportException(message='Connection reset')
    response = client.patch('/queues', json={'switch_id': 0, 'depth_packets': 12, 'rate_pps': '100'})
    assert response.status_code == 503
    assert response.json['uncertain'] is True
    assert response.json['applied'][0]['depth_packets'] == 12


def test_unsupported_target_method_is_explicit(client, native):
    native[2].set_all_egress_queue_depths.side_effect = TApplicationException(TApplicationException.UNKNOWN_METHOD, 'Unknown queue RPC')
    response = client.patch('/queues', json={'switch_id': 0, 'depth_packets': 16})
    assert response.status_code == 501
    assert response.json['code'] == 'UNIMPLEMENTED'
    assert response.json['applied'] == []


def test_missing_explicit_endpoint_is_graceful(client, switch):
    response = client.get('/queues?switch_id=0')
    assert response.json['configured'] is False
    assert response.json['write_available'] is False
    assert client.patch('/queues', json={'switch_id': 0, 'depth_packets': 64}).status_code == 409


def test_history_is_connection_scoped_and_port_filter_includes_global_changes(client, switch, native):
    client.patch('/queues', json={'switch_id': 0, 'depth_packets': 64})
    client.patch('/queues', json={'switch_id': 0, 'port': 1, 'depth_packets': 32})
    client.patch('/queues', json={'switch_id': 0, 'port': 2, 'depth_packets': 16})
    assert len(client.get('/queues?switch_id=0&port=1').json['last_applied']) == 2
    switch.bmv2 = Mock()
    assert client.get('/queues?switch_id=0').json['last_applied'] == []


def test_unknown_switch_and_malformed_requests(client):
    assert client.get('/queues').status_code == 400
    assert client.get('/queues?switch_id=99').status_code == 404
    assert client.patch('/queues', json=[]).status_code == 400


def test_official_native_queue_client_is_bundled():
    from runtime.thrift.sswitch_runtime import SimpleSwitch
    assert callable(SimpleSwitch.Client.set_all_egress_queue_depths)
    assert callable(SimpleSwitch.Client.set_egress_queue_rate)


def test_topology_connection_records_preserve_and_refresh_explicit_native_endpoint(app):
    from api.database import db
    from api.endpoints.switchesfromtopology import SwitchesFromTopology
    with app.app_context():
        endpoint = SwitchesFromTopology(db, Mock())
        config = {'name': 's1', 'address': '127.0.0.1:50051', 'device_id': 0,
                  'register_adapter_enabled': False, 'register_thrift_host': '127.0.0.1', 'register_thrift_port': 9107}
        key = endpoint._switch_key(config)
        first = endpoint._get_or_create_switch_records([config])[key]
        identity = first.id
        assert first.register_adapter_enabled is False
        assert first.register_thrift_port == 9107
        config['register_thrift_port'] = 9111
        updated = endpoint._get_or_create_switch_records([config])[key]
        assert updated.id == identity
        assert updated.register_thrift_host == '127.0.0.1'
        assert updated.register_thrift_port == 9111


def test_configuration_merges_all_port_defaults_and_per_port_fields(client, native):
    client.patch('/queues', json={'switch_id': 0, 'port': 1, 'depth_packets': 32, 'rate_pps': '10'})
    client.patch('/queues', json={'switch_id': 0, 'port': 2, 'depth_packets': 16, 'rate_pps': '20'})
    response = client.patch('/queues', json={'switch_id': 0, 'depth_packets': 64}).json
    config = response['configuration']
    assert config['defaults'] == {'depth_packets': 64, 'rate_pps': None}
    ports = {row['port']: row for row in config['ports']}
    assert ports[1]['depth_packets'] == 64 and ports[1]['rate_pps'] == '10'
    assert ports[2]['depth_packets'] == 64 and ports[2]['rate_pps'] == '20'
    assert ports[1]['sources'] == {'depth_packets': 'all_ports', 'rate_pps': 'port'}
    config = client.patch('/queues', json={'switch_id': 0, 'rate_pps': '0'}).json['configuration']
    assert all(row['rate_pps'] == '0' and row['sources']['rate_pps'] == 'all_ports' for row in config['ports'])
    config = client.patch('/queues', json={'switch_id': 0, 'port': 2, 'depth_packets': 128}).json['configuration']
    assert config['defaults']['depth_packets'] == 64
    assert next(row for row in config['ports'] if row['port'] == 2)['depth_packets'] == 128


def test_discovered_ports_start_unknown_and_preserve_real_interface_names(client, native):
    response = client.get('/queues?switch_id=0').json
    assert response['port_discovery']['status'] == 'available'
    assert response['configuration']['defaults'] == {'depth_packets': None, 'rate_pps': None}
    assert response['configuration']['ports'][0] == {'port': 1, 'interface': 's1-eth1', 'is_up': True,
        'discovered': True, 'depth_packets': None, 'rate_pps': None,
        'sources': {'depth_packets': 'unknown', 'rate_pps': 'unknown'}}


def test_history_eviction_does_not_erase_configuration(client, switch, native):
    manager = QueueManager.for_switch(switch)
    manager.write({'depth_packets': 64})
    manager.write({'port': 2, 'rate_pps': '250'})
    for value in range(1, 121):
        manager.write({'port': 1, 'depth_packets': value})
    response = client.get('/queues?switch_id=0').json
    assert len(response['last_applied']) == 100
    assert response['configuration']['defaults']['depth_packets'] == 64
    assert next(row for row in response['configuration']['ports'] if row['port'] == 2)['rate_pps'] == '250'


def test_failed_setting_preserves_previously_acknowledged_field(client, native):
    client.patch('/queues', json={'switch_id': 0, 'port': 1, 'depth_packets': 32, 'rate_pps': '50'})
    native[2].set_egress_queue_rate.return_value = -1
    response = client.patch('/queues', json={'switch_id': 0, 'port': 1, 'depth_packets': 77, 'rate_pps': '100'})
    assert response.status_code == 503
    port = next(row for row in response.json['configuration']['ports'] if row['port'] == 1)
    assert port['depth_packets'] == 77 and port['rate_pps'] == '50'


def test_port_discovery_failure_retains_acknowledged_configuration(client, switch, native):
    client.patch('/queues', json={'switch_id': 0, 'port': 7, 'depth_packets': 77})
    manager = QueueManager.for_switch(switch)
    manager._ports_client = Mock(side_effect=OSError('Port discovery unavailable'))
    response = client.get('/queues?switch_id=0')
    assert response.status_code == 200
    assert response.json['port_discovery'] == {'status': 'unavailable', 'error': 'Port discovery unavailable'}
    assert response.json['configuration']['ports'][0]['port'] == 7
    assert response.json['configuration']['ports'][0]['depth_packets'] == 77
    assert response.json['configuration']['ports'][0]['discovered'] is False
