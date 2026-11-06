"""Observer mode tests use mocked channels only; no external target is contacted."""
import json
from pathlib import Path
from unittest.mock import Mock, call

import grpc
import pytest

from api.endpoints.switch_config import normalize_adapter_config
from controller.targets.bfrt_client import BfRtClient, BfRtError
from controller.targets.bfrt_proto import bfruntime_pb2 as pb
from controller.targets.tofino import TofinoTarget
from test_bfrt_targets import native, FIXTURES


@pytest.fixture
def observer(native):
    target = TofinoTarget(17, {'name': 'observer', 'address': 'unused.invalid:50052', 'device_id': 17,
        'target': 'tofino', 'target_options': {'read_only': True, 'runtime_device_id': 0, 'pipe_id': 0,
                                            'client_id': 2147483646, 'program_name': 'running'}})
    target.connected = True
    target.p4_helper = native.p4_helper
    target.client = Mock(pipe_id=0, device_id=0, stream_error=None, program_name='running', program_pipes=[0, 1])
    target.client.read.return_value = []
    return target


def transport(monkeypatch, native, read_only):
    module = __import__('controller.targets.bfrt_client', fromlist=['BfRtClient'])
    channel, stub, ready, threads = Mock(), Mock(), Mock(), Mock()
    response = pb.GetForwardingPipelineConfigResponse()
    program = response.config.add(p4_name='running', bfruntime_info=json.dumps(native.p4_helper.raw).encode())
    program.profiles.add(profile_name='pipe', pipe_scope=[0, 1])
    response.non_p4_config.bfruntime_info = (FIXTURES / 'fixed.json').read_bytes()
    stub.GetForwardingPipelineConfig.return_value = response
    stub.Read.return_value = []
    monkeypatch.setattr(module.grpc, 'insecure_channel', Mock(return_value=channel))
    monkeypatch.setattr(module.grpc, 'channel_ready_future', Mock(return_value=ready))
    monkeypatch.setattr(module.bfruntime_pb2_grpc, 'BfRuntimeStub', Mock(return_value=stub))
    monkeypatch.setattr(module, 'Thread', threads)
    client = BfRtClient('unused.invalid:50052', client_id=2147483646, read_only=read_only)
    # Full-control subscription delivery is deterministic without a real thread.
    if not read_only:
        threads.return_value.start.side_effect = lambda: client.subscribed.set()
    return client, channel, stub, threads


def test_observer_connect_and_discovery_never_subscribes_binds_or_writes(monkeypatch, native):
    client, channel, stub, threads = transport(monkeypatch, native, True)
    client.connect()
    metadata = client.discover('running')
    assert metadata.get_registers()
    assert client.program_pipes == [0, 1]
    assert client.stream is None
    threads.assert_not_called()
    stub.StreamChannel.assert_not_called()
    stub.SetForwardingPipelineConfig.assert_not_called()
    stub.Write.assert_not_called()
    stub.GetForwardingPipelineConfig.assert_called_once_with(
        pb.GetForwardingPipelineConfigRequest(device_id=0, client_id=2147483646), timeout=15)
    assert {method[0] for method in stub.mock_calls} == {'GetForwardingPipelineConfig', 'Read'}
    attributes = stub.Read.call_args.args[0]
    assert attributes.target.pipe_id == 0
    assert all(entity.WhichOneof('entity') == 'table_attribute' for entity in attributes.entities)
    client.close()
    channel.close.assert_called_once()
    stub.StreamChannel.assert_not_called()


def test_full_control_still_subscribes_and_binds_by_default(monkeypatch, native):
    client, _channel, stub, threads = transport(monkeypatch, native, False)
    assert BfRtClient('unused.invalid').read_only is False
    client.connect()
    client.discover('running')
    stub.StreamChannel.assert_called_once()
    threads.assert_called_once()
    request = stub.SetForwardingPipelineConfig.call_args.args[0]
    assert request.action == pb.SetForwardingPipelineConfigRequest.BIND
    assert request.config[0].p4_name == 'running'
    subscribe = client.requests.get_nowait()
    assert subscribe.subscribe.notifications.enable_learn_notifications
    client.close()


def test_observer_symmetric_multi_pipe_read_keeps_exact_selected_target(monkeypatch, native):
    client, _channel, stub, _threads = transport(monkeypatch, native, True)
    client.connect()
    client.discover('running')
    stub.Read.reset_mock()
    table = native.p4_helper.table('pipe.Ingress.packet_counter')
    entry = pb.TableEntry(table_id=table['id'])
    client.read([entry])
    request = stub.Read.call_args.args[0]
    assert request.target.pipe_id == 0
    assert request.client_id == 2147483646
    assert request.p4_name == 'running'
    assert not request.entities[0].table_entry.HasField('entry_tgt')
    assert not entry.HasField('entry_tgt')
    client.read_only = False
    with pytest.raises(ValueError, match='symmetric across pipes'):
        client.read([entry])
    client.close()


@pytest.mark.parametrize('value', ['true', 'false', 0, 1, None, [], {}])
def test_observer_setting_requires_a_boolean(value):
    config = {'name': 'observer', 'address': 'unused.invalid:50052', 'device_id': 17,
              'target': 'tofino', 'target_options': {'read_only': value}}
    with pytest.raises(ValueError, match='read_only must be a boolean'):
        normalize_adapter_config(config)
    with pytest.raises(ValueError, match='read_only must be a boolean'):
        BfRtClient('unused.invalid', read_only=value)


def test_read_only_option_round_trips_and_full_control_defaults_remain_unchanged():
    config = {'name': 'observer', 'address': 'unused.invalid:50052', 'device_id': 17, 'target': 'tofino'}
    assert normalize_adapter_config(dict(config, target_options={'read_only': True}))['target_options']['read_only'] is True
    assert normalize_adapter_config(dict(config, target_options={'read_only': False}))['target_options']['read_only'] is False
    assert 'read_only' not in normalize_adapter_config(config)['target_options']


def test_observer_transport_mutators_fail_before_files_or_rpc(monkeypatch):
    client = BfRtClient('unused.invalid', read_only=True)
    client.stub = Mock()
    read = Mock(side_effect=AssertionError('Observer must not read pipeline artifacts'))
    monkeypatch.setattr(Path, 'read_bytes', read)
    for operation in (lambda: client.write([object()], pb.Update.MODIFY),
                      lambda: client.initialize_bundle({}), lambda: client.clear_digest_events()):
        with pytest.raises(BfRtError) as error:
            operation()
        assert error.value.code() == grpc.StatusCode.PERMISSION_DENIED
    client.stub.assert_not_called()
    assert client.stub.mock_calls == []
    read.assert_not_called()


def test_observer_capabilities_and_fixed_resource_reads_are_available(observer):
    observer.require_initialized()
    info = observer.get_loaded_config()
    assert info['read_only'] is True
    assert observer.as_json()['read_only'] is True
    assert info['scope']['read_only'] is True
    assert info['register_access']['write'] is False
    assert info['capabilities']['pipeline'] == {'read': True, 'write': False, 'keep_entries': False}
    assert all(capability['write'] is False for capability in info['capabilities'].values())
    assert all(info['capabilities'][kind]['read'] for kind in ('tables', 'registers', 'counters', 'mirrors', 'multicast', 'queues'))
    assert observer.manager('mirrors').read() == {'entries': []}
    assert observer.manager('multicast').read() == {'entries': []}
    queues = observer.manager('queues').snapshot(0)
    assert queues['readback_available'] is True
    assert queues['write_available'] is False
    assert queues['fields']['rate_pps']['write'] is False
    assert queues['fields']['burst_packets']['write'] is False
    observer.client.stream_error = RuntimeError('There is no observer stream')
    observer.require_initialized()


@pytest.mark.parametrize('operation', [
    lambda switch: switch.initialize_bundle({}), lambda switch: switch.initialize(),
    lambda switch: switch.write_table_entry(None), lambda switch: switch.delete_table_entry(None),
    lambda switch: switch.update_table_entry(None, None),
    lambda switch: switch.resources.write('register', None, None),
    lambda switch: switch.resources.write('meter', None, None),
    lambda switch: switch.resources.write_direct(None, None),
    lambda switch: switch.reset_counter(None), lambda switch: switch.reset_direct_counter(None),
    lambda switch: switch.manager('mirrors').write({}, 2),
    lambda switch: switch.manager('multicast').write({}, 2),
    lambda switch: switch.manager('queues').write({}),
    lambda switch: switch.manager('digests').write({}, 2), lambda switch: switch.manager('digests').clear(),
])
def test_observer_mutators_reject_before_any_target_read_or_write(observer, operation):
    original = observer.p4_helper
    with pytest.raises(BfRtError) as error:
        operation(observer)
    assert error.value.code() == grpc.StatusCode.PERMISSION_DENIED
    assert observer.p4_helper is original
    observer.client.read.assert_not_called()
    observer.client.write.assert_not_called()
    observer.client.initialize_bundle.assert_not_called()


def test_observer_digest_metadata_does_not_claim_notification_capture(observer):
    capability = observer.capabilities()['digests']
    assert capability['read'] is True
    assert all(capability[field] is False for field in ('write', 'events', 'listen', 'ack', 'configure'))
    assert observer.manager('digests').read()['read_only'] is True
    with pytest.raises(BfRtError) as error:
        observer.manager('digests').events()
    assert error.value.code() == grpc.StatusCode.UNIMPLEMENTED
    observer.client.digest_events.assert_not_called()
