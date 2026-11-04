"""Native BF-RT contract tests against actual compiler/fixed-function metadata."""
from copy import deepcopy
import json
from pathlib import Path
from unittest.mock import Mock

import grpc
import pytest

from api.endpoints.switch_config import normalize_adapter_config
from controller.targets import create_target
from controller.targets.bfrt_metadata import BfRtMetadata, fields, encode_data, decode_data, encode_fields, decode_fields
from controller.targets.bfrt_client import BfRtClient, BfRtError, check_status
from controller.targets.bfrt_proto import bfruntime_pb2 as pb
from controller.targets.bfrt_tables import BfRtTableEntry, table_key
from controller.targets.tofino import TofinoTarget

FIXTURES = Path(__file__).parents[1] / 'fixtures' / 'tofino'


@pytest.fixture
def native():
    switch = TofinoTarget(17, {'name': 'native', 'address': '127.0.0.1:50052', 'device_id': 17, 'target': 'tofino',
                              'target_options': {'pipe_id': 0, 'runtime_device_id': 0}})
    switch.connected = True
    switch.p4_helper = BfRtMetadata((FIXTURES / 'resources.json').read_bytes(), (FIXTURES / 'fixed.json').read_bytes())
    switch.client = Mock(pipe_id=0, device_id=0, stream_error=None, program_name='unicorn_resources', program_pipes=[0])
    switch.client.read.return_value = []
    return switch


def test_factory_preserves_default_and_distinct_logical_device_id(native):
    from controller.managers.SwitchManager import SwitchManager
    assert isinstance(create_target(0, {}), SwitchManager)
    assert create_target(17, native.config).client.device_id == 0
    assert native.as_json()['device_id'] == 17
    assert native.get_loaded_config()['scope'] == {'pipe_id': 0, 'runtime_device_id': 0, 'aggregation': 'none', 'program_pipe_ids': [0], 'read_only': False}


def test_config_validates_target_settings():
    base = {'name': 'a', 'address': 'localhost:50052', 'device_id': 17}
    assert normalize_adapter_config(base)['target'] == 'bmv2'
    config = normalize_adapter_config(dict(base, target='tofino'))
    assert config['target_options'] == {'client_id': 0, 'runtime_device_id': 0, 'pipe_id': 0}
    for options in ({'pipe_id': 65535}, {'pipe_id': True}, {'runtime_device_id': -1}, {'unknown': 1}):
        with pytest.raises(ValueError): normalize_adapter_config(dict(base, target='tofino', target_options=options))
    with pytest.raises(ValueError): normalize_adapter_config(dict(base, target='tofino', register_adapter_enabled=True, register_thrift_host='x', register_thrift_port=9090))


def test_native_metadata_is_generic_and_preserves_exact_fields(native):
    config = native.get_loaded_config()
    assert config['table_info']['pipe.Ingress.forwarding']['match_fields']['intrinsic.ingress_port']['match_type'] == 2
    assert config['registers']['pipe.Ingress.packet_register']['type']['bitwidth'] == 32
    assert config['capabilities']['mirrors']['max_replicas'] == 1
    assert config['capabilities']['multicast']['node_ownership'] == 'connection'
    assert config['capabilities']['queues']['depth_packets'] is False
    assert config['capabilities']['digests']['listen'] is True
    assert config['capabilities']['digests']['configure'] is False
    assert native.p4_helper.get_table_decoding()['pipe.Ingress.forwarding']['match']['intrinsic.ingress_port'] == 'numeric'


def test_exact_typed_fields_and_nested_container_round_trip():
    definitions = [{'id': 1, 'name': 'wide', 'type': {'type': 'uint64'}},
                   {'id': 2, 'name': 'signed', 'type': {'type': 'int16'}},
                   {'id': 3, 'name': 'ports', 'type': {'type': 'uint32'}, 'repeated': True},
                   {'id': 4, 'name': 'enable', 'type': {'type': 'bool'}},
                   {'id': 5, 'name': 'rows', 'container': [{'id': 6, 'name': 'text', 'type': {'type': 'string'}}]}]
    value = {'wide': '18446744073709551615', 'signed': '-32768', 'ports': ['0', '4294967295'], 'enable': False, 'rows': [{'text': 'hello'}]}
    assert decode_fields(definitions, encode_fields(definitions, value)) == value
    with pytest.raises(ValueError): encode_fields(definitions, dict(value, wide='18446744073709551616'))
    with pytest.raises(ValueError): encode_fields(definitions, dict(value, enable=1))


def test_structured_register_is_never_flattened_or_summed(native):
    table = native.p4_helper.table('pipe.Ingress.packet_register')
    table['data'].append({'singleton': {'id': 2, 'name': 'Ingress.packet_register.f2', 'type': {'type': 'uint64'}}})
    register_id = table['id']
    row = native.resources.indexed_entry(table, 0)
    row.data.fields.extend(encode_fields(fields(table['data']), {'Ingress.packet_register.f1': '7', 'Ingress.packet_register.f2': '18446744073709551615'}))
    native.client.read.return_value = [row]
    read = native.resources.read('register', register_id, index=0)
    assert read['entries'][0]['value'] == {'Ingress.packet_register.f1': '7', 'Ingress.packet_register.f2': '18446744073709551615'}
    assert read['scope']['pipe_id'] == 0
    native.resources.write('register', register_id, read['entries'])
    assert native.client.write.call_args.args[1] == pb.Update.MODIFY
    with pytest.raises(ValueError): native.resources.write('register', register_id, [{'index': 0, 'value': '8'}])


def test_scalar_register_and_full_batch_validation(native):
    table = native.p4_helper.table('pipe.Ingress.packet_register')
    native.resources.write('register', table['id'], [{'index': 0, 'value': '4294967295'}])
    request = native.client.write.call_args.args[0][0]
    assert request.key.fields[0].exact.value == bytes(4)
    native.client.write.reset_mock()
    with pytest.raises(ValueError): native.resources.write('register', table['id'], [{'index': 0, 'value': '1'}, {'index': 1, 'value': '4294967296'}])
    native.client.write.assert_not_called()


def test_native_table_rows_and_direct_fields_roundtrip(native):
    value = {'table_name': 'pipe.Ingress.forwarding', 'match_fields': {'intrinsic.ingress_port': '0'},
             'action_name': 'Ingress.forward', 'action_params': {'port': '1', 'index': '7'}, 'priority': None,
             'is_default_action': False}
    entry = native.create_table_entry(value, False)
    assert entry.as_json() == value
    native.write_table_entry(entry)
    assert native.client.write.call_args.args[1] == pb.Update.INSERT
    native.client.read.return_value = [entry.entry]
    assert native.get_table_entries(value['table_name'])[value['table_name']][0]['switch_entry'] == value
    assert native.table_entry_key(entry.entry) == table_key(entry.entry)
    native.delete_table_entry(entry)
    assert not native.client.write.call_args.args[0][0].HasField('data')


def test_native_counter_zero_index_and_exact_counts(native):
    table = native.p4_helper.table('pipe.Ingress.packet_counter')
    row = native.resources.indexed_entry(table, 0)
    row.data.fields.extend(encode_fields(fields(table['data']), {'$COUNTER_SPEC_PKTS': '18446744073709551615', '$COUNTER_SPEC_BYTES': '12'}))
    native.client.read.return_value = [row]
    assert native.get_counter_values(table['id'], 0)['entries'] == [{'index': 0, 'packets': '18446744073709551615', 'bytes': '12'}]
    assert native.reset_counter(table['id'], 0) == 1


def test_native_meter_mapping_and_units(native):
    table = native.p4_helper.table('pipe.Ingress.packet_meter')
    native.resources.write('meter', table['id'], [{'index': 0, 'config': {'cir': '10', 'pir': '20', 'cburst': '30', 'pburst': '40'}}])
    request = native.client.write.call_args.args[0][0]
    values = decode_fields(fields(table['data']), request.data.fields)
    assert values == {'$METER_SPEC_CIR_PPS': '10', '$METER_SPEC_PIR_PPS': '20', '$METER_SPEC_CBS_PKTS': '30', '$METER_SPEC_PBS_PKTS': '40'}
    with pytest.raises(ValueError): native.resources.write('meter', table['id'], [{'index': 0, 'config': None}])


def test_native_status_errors_are_not_success():
    with pytest.raises(BfRtError) as error:
        check_status([pb.Error(), pb.Error(canonical_code=5, message='missing')])
    assert error.value.code() == grpc.StatusCode.NOT_FOUND
    assert error.value.errors == [{'index': 1, 'code': 5, 'message': 'missing'}]


def test_native_transport_sets_requested_single_pipe_without_global_package_shadow(native):
    client = BfRtClient('localhost:50052', device_id=0, client_id=31, pipe_id=2)
    client.stub = Mock()
    client.program_name = 'sample'
    client.stub.Read.return_value = []
    client.read([pb.TableEntry(table_id=1)])
    request = client.stub.Read.call_args.args[0]
    assert request.target.pipe_id == 2
    assert request.target.device_id == 0
    assert request.client_id == 31
    assert request.p4_name == 'sample'
    assert pb.DESCRIPTOR.package == 'bfrt_proto'


class MemoryBfRt:
    """Entity store that models MODIFY's partial data-field updates."""
    def __init__(self):
        self.pipe_id, self.device_id, self.program_pipes = 0, 0, [0]
        self.stream_error, self.program_name = None, 'sample'
        self.entries = {}
        self.writes = []
        self.fail = None

    def read(self, selectors):
        result = []
        for selector in selectors:
            for entry in self.entries.values():
                if entry.table_id != selector.table_id: continue
                if selector.HasField('key') and table_key(selector) != table_key(entry): continue
                if selector.is_default_entry and not entry.is_default_entry: continue
                result.append(deepcopy(entry))
        return result

    def write(self, entries, operation):
        for entry in entries:
            key = table_key(entry)
            self.writes.append((deepcopy(entry), operation))
            if self.fail and self.fail(entry, operation):
                self.fail = None
                raise BfRtError(grpc.StatusCode.INVALID_ARGUMENT, 'injected failure')
            if operation == pb.Update.INSERT:
                if key in self.entries: raise BfRtError(grpc.StatusCode.ALREADY_EXISTS, 'exists')
                self.entries[key] = deepcopy(entry)
            elif operation == pb.Update.DELETE:
                self.entries.pop(key, None)
            else:
                if key not in self.entries: raise BfRtError(grpc.StatusCode.NOT_FOUND, 'missing')
                actual = self.entries[key]
                changed = {field.field_id for field in entry.data.fields}
                preserved = [deepcopy(field) for field in actual.data.fields if field.field_id not in changed]
                del actual.data.fields[:]
                actual.data.fields.extend(preserved + list(entry.data.fields))
                if entry.data.action_id: actual.data.action_id = entry.data.action_id


@pytest.mark.parametrize('subscribed', [False, True])
def test_native_stream_eof_reports_disconnect_and_invalidates_live_reads(native, subscribed):
    client = BfRtClient('unused.invalid')
    client.metadata = native.p4_helper
    client.program_name = 'sample'
    response = pb.StreamMessageResponse()
    response.subscribe.status.code = 0
    client.stream = iter([response] if subscribed else [])
    client._receive()

    assert client.subscribed.is_set()
    assert isinstance(client.stream_error, BfRtError)
    assert client.stream_error.code() == grpc.StatusCode.UNAVAILABLE
    stream = client.digest_events()['stream']
    assert stream['active'] is False
    assert 'ended' in stream['error']
    native.client = client
    with pytest.raises(RuntimeError, match='stream disconnected'):
        native.require_initialized()


def test_native_stream_shutdown_does_not_report_disconnect():
    client = BfRtClient('unused.invalid')
    client.closed = True
    client.stream = iter([])
    client._receive()
    assert client.stream_error is None


def test_pre_nodes_external_references_and_owned_cleanup(native):
    from controller.targets.bfrt_fixed import FixedTable
    native.client = MemoryBfRt()
    nodes = FixedTable(native, '$pre.node')
    groups = FixedTable(native, '$pre.mgid')
    nodes.write({'$MULTICAST_NODE_ID': 45}, {'$MULTICAST_RID': 3, '$MULTICAST_LAG_ID': [], '$DEV_PORT': [7]}, pb.Update.INSERT)
    groups.write({'$MGID': 9}, {'$MULTICAST_NODE_ID': [45]}, pb.Update.INSERT)
    manager = native.manager('multicast')
    manager.write({'multicast_group_id': 9, 'replicas': [{'egress_port': '1', 'instance': 8}]}, 2)
    assert manager.read(9)['entries'][0]['replicas'] == [{'egress_port': '1', 'instance': 8}]
    assert any(int(key['$MULTICAST_NODE_ID']) == 45 for key, _, _ in nodes.read())
    owned = set(manager.owned_nodes)
    assert len(owned) == 1
    manager.write({'multicast_group_id': 9}, 3)
    assert manager.owned_nodes == set()
    assert [int(key['$MULTICAST_NODE_ID']) for key, _, _ in nodes.read()] == [45]


def test_pre_failed_group_write_rolls_back_only_owned_nodes(native):
    native.client = MemoryBfRt()
    manager = native.manager('multicast')
    group_table_id = native.p4_helper.table('$pre.mgid')['id']
    native.client.fail = lambda entry, op: entry.table_id == group_table_id
    with pytest.raises(BfRtError):
        manager.write({'multicast_group_id': 9, 'replicas': [{'egress_port': '1', 'instance': 8}]}, 1)
    assert manager.owned_nodes == set()
    assert native.client.entries == {}


def test_pre_external_ecmp_reference_protects_our_node(native):
    from controller.targets.bfrt_fixed import FixedTable
    native.client = MemoryBfRt()
    manager = native.manager('multicast')
    manager.write({'multicast_group_id': 9, 'replicas': [{'egress_port': '1', 'instance': 8}]}, 1)
    node_id = next(iter(manager.owned_nodes))
    FixedTable(native, '$pre.ecmp').write({'$MULTICAST_ECMP_ID': 1}, {'$MULTICAST_NODE_ID': [node_id]}, pb.Update.INSERT)
    manager.write({'multicast_group_id': 9}, 3)
    assert node_id in manager.owned_nodes
    assert len(FixedTable(native, '$pre.node').read()) == 1


def test_native_mirror_constraints_and_readback(native):
    native.client = MemoryBfRt()
    manager = native.manager('mirrors')
    manager.write({'session_id': 7, 'replicas': [{'egress_port': '0', 'instance': 0}], 'direction': 'BOTH'}, 1)
    assert manager.read(7)['entries'][0]['replicas'] == [{'egress_port': '0', 'instance': 0}]
    assert manager.read(7)['entries'][0]['direction'] == 'BOTH'
    with pytest.raises(ValueError): manager.write({'session_id': 8, 'replicas': [{'egress_port': 1, 'instance': 1}]}, 1)
    manager.write({'session_id': 7}, 3)
    assert manager.read()['entries'] == []


def test_native_port_pps_requires_exact_burst_units_and_rolls_back(native):
    from controller.targets.bfrt_fixed import FixedTable
    native.client = MemoryBfRt()
    shape = FixedTable(native, 'tf1.tm.port.sched_shaping')
    config = FixedTable(native, 'tf1.tm.port.sched_cfg')
    shape.write({'dev_port': 0}, {'unit': 'BPS', 'max_rate': 100, 'max_burst_size': 9216}, pb.Update.INSERT)
    config.write({'dev_port': 0}, {'max_rate_enable': False}, pb.Update.INSERT)
    manager = native.manager('queues')
    with pytest.raises(ValueError): manager.write({'port': 0, 'rate_pps': '10'})
    native.client.fail = lambda entry, op: entry.table_id == config.table['id']
    with pytest.raises(BfRtError): manager.write({'port': 0, 'rate_pps': '10', 'burst_packets': '100'})
    assert shape.read()[0][1]['unit'] == 'BPS'
    manager.write({'port': 0, 'rate_pps': '10', 'burst_packets': '100'})
    assert manager.snapshot(0)['configuration']['ports'][0]['rate_pps'] == '10'
    with pytest.raises(BfRtError): manager.write({'port': 0, 'depth_packets': 100})


def test_shared_program_scope_never_silently_broadens_or_aggregates(native):
    client = BfRtClient('localhost')
    client.metadata, client.program_pipes = native.p4_helper, [0, 1, 2, 3]
    table = native.p4_helper.table('pipe.Ingress.packet_counter')
    entry = native.resources.indexed_entry(table, 0)
    with pytest.raises(ValueError, match='symmetric across pipes'):
        client._scope_entry(entry, write=False)
    client.program_pipes = [0]
    client._scope_entry(entry, write=True)
    assert entry.entry_tgt.pipe_id == 65535
    register = native.resources.indexed_entry(native.p4_helper.table('pipe.Ingress.packet_register'), 0)
    client._scope_entry(register, write=True)
    assert not register.HasField('entry_tgt')


def test_native_default_counter_reset_is_explicitly_unavailable(native):
    native.client = MemoryBfRt()
    table = native.p4_helper.table('pipe.Ingress.forwarding')
    table['data'] = [{'singleton': {'id': 65554, 'name': '$COUNTER_SPEC_PKTS', 'type': {'type': 'uint64'}}}]
    entry = native.create_table_entry({'table_name': table['name'], 'match_fields': {}, 'is_default_action': True,
                                     'action_name': 'Ingress.forward', 'action_params': {'port': '1', 'index': '0'},
                                     'data_fields': {}}, False)
    entry.entry.data.fields.extend(encode_fields(fields(table['data']), {'$COUNTER_SPEC_PKTS': '9'}))
    native.client.write([entry.entry], pb.Update.INSERT)
    with pytest.raises(BfRtError) as error:
        native.reset_direct_counter(table['id'], entry.as_json())
    assert error.value.code() == grpc.StatusCode.UNIMPLEMENTED
    assert len(native.client.writes) == 1
    assert native.capabilities()['direct_counters']['default_reset'] is False


def test_register_readonly_fields_are_preserved_but_not_written(native):
    table = native.p4_helper.table('pipe.Ingress.packet_register')
    table['data'].append({'singleton': {'id': 2, 'name': 'status', 'type': {'type': 'uint32'}, 'read_only': True}})
    native.resources.write('register', table['id'], [{'index': 0, 'value': {'Ingress.packet_register.f1': '7', 'status': '8'}}])
    entry = native.client.write.call_args.args[0][0]
    assert len(entry.data.fields) == 1
    assert entry.data.fields[0].field_id == 1


def test_pipeline_reload_resubscribes_before_binding_removed_program(tmp_path):
    directory = tmp_path
    (directory / 'bfrt.json').write_text('{"tables":[]}')
    (directory / 'context.json').write_text('{}')
    (directory / 'tofino.bin').write_bytes(b'binary')
    client = BfRtClient('localhost')
    client.stub = Mock()
    order = []
    client.stub.SetForwardingPipelineConfig.side_effect = lambda *_args, **_kwargs: order.append('reload')
    client.close = lambda: order.append('close')
    client.connect = lambda: order.append('subscribe')
    client.discover = lambda name: order.append('bind:' + name) or 'metadata'
    result = client.initialize_bundle({'program_name': 'next', 'bfrt_json': str(directory / 'bfrt.json'),
        'profiles': [{'profile_name': 'pipe', 'context': str(directory / 'context.json'), 'binary': str(directory / 'tofino.bin'), 'pipe_scope': [0]}]})
    assert result == 'metadata'
    assert order == ['reload', 'close', 'subscribe', 'bind:next']


def test_failed_pipeline_reload_invalidates_previous_metadata(native):
    native.client.initialize_bundle.side_effect = RuntimeError('warm reload failed')
    with pytest.raises(RuntimeError): native.initialize_bundle({'target': 'tofino', 'profiles': [{'pipe_scope': [0]}]})
    assert native.p4_helper is None
    assert native.get_loaded_config()['table_info'] is None


def test_default_meter_write_keeps_action_and_avoids_coexisting_counter(native):
    native.client = MemoryBfRt()
    table = native.p4_helper.table('pipe.Ingress.forwarding')
    table['data'] = [{'singleton': {'id': 65554, 'name': '$COUNTER_SPEC_PKTS', 'type': {'type': 'uint64'}}}] + [
        {'singleton': {'id': 100 + index, 'name': name, 'type': {'type': 'uint64'}}}
        for index, name in enumerate(('$METER_SPEC_CIR_PPS', '$METER_SPEC_PIR_PPS', '$METER_SPEC_CBS_PKTS', '$METER_SPEC_PBS_PKTS'))]
    default = native.create_table_entry({'table_name': table['name'], 'match_fields': {}, 'is_default_action': True,
        'action_name': 'Ingress.forward', 'action_params': {'port': '1', 'index': '0'}}, False)
    default.entry.data.fields.extend(encode_fields(fields(table['data']), {'$COUNTER_SPEC_PKTS': '77'}))
    native.client.write([default.entry], pb.Update.INSERT)
    native.resources.write_direct(table['id'], [{'table_entry': default.as_json(),
        'config': {'cir': '10', 'pir': '20', 'cburst': '30', 'pburst': '40'}}])
    written = native.client.writes[-1][0]
    assert written.is_default_entry
    assert written.data.action_id == default.entry.data.action_id
    assert {field.field_id for field in written.data.fields} == {1, 2, 100, 101, 102, 103}
    stored = native.client.read([default.entry])[0]
    assert next(field.stream for field in stored.data.fields if field.field_id == 65554) == (77).to_bytes(8, 'big')


@pytest.mark.parametrize('selected,profiles', [
    (1, [{'pipe_scope': [0]}]), (2, [{'pipe_scope': [0]}]),
    (0, [{'pipe_scope': [0, 1]}]), (0, [{'pipe_scope': [0]}, {'pipe_scope': [1]}]),
    (0, [{'pipe_scope': [False]}]),
])
def test_pipeline_scope_mismatch_preserves_active_metadata_and_never_initializes(native, selected, profiles):
    native.client.pipe_id = selected
    original = native.p4_helper
    with pytest.raises(ValueError, match='selected connection pipe'):
        native.initialize_bundle({'target': 'tofino', 'profiles': profiles})
    native.client.initialize_bundle.assert_not_called()
    assert native.p4_helper is original


def test_transport_rejects_bundle_scope_before_reading_artifacts_or_native_rpc():
    client = BfRtClient('localhost', pipe_id=2)
    client.stub = Mock()
    with pytest.raises(ValueError, match='selected connection pipe \\[2\\]'):
        client.initialize_bundle({'profiles': [{'pipe_scope': [0]}], 'bfrt_json': '/missing/metadata.json'})
    client.stub.SetForwardingPipelineConfig.assert_not_called()
