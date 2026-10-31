import grpc
import pytest

from controller.p4.v1 import p4runtime_pb2 as pb


def test_index_zero_reset_uses_standard_counter_modify_without_pipeline_change(client, switch):
    result = client.patch('/counters', json={'switch_id': 0, 'counter_id': 0x12000001, 'index': 0, 'reset': True})
    assert result.status_code == 200
    assert result.json == {'success': True, 'counter_id': 0x12000001, 'reset_count': 1}
    entities = switch.bmv2.ModifyEntities.call_args.args[0]
    assert len(entities) == 1
    counter = entities[0].counter_entry
    assert counter.counter_id == 0x12000001 and counter.HasField('index') and counter.index.index == 0
    assert counter.HasField('data') and counter.data.packet_count == counter.data.byte_count == 0
    switch.bmv2.ModifyTableEntry.assert_not_called()
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_all_reset_is_scoped_and_bounded_in_write_batches(client, switch):
    switch.p4_helper.p4info.counters[0].size = 513
    result = client.patch('/counters', json={'switch_id': 0, 'counter_id': 0x12000001, 'reset': True})
    assert result.status_code == 200 and result.json['reset_count'] == 513
    batches = [call.args[0] for call in switch.bmv2.ModifyEntities.call_args_list]
    assert [len(batch) for batch in batches] == [256, 256, 1]
    assert [entity.counter_entry.index.index for batch in batches for entity in batch] == list(range(513))
    assert all(entity.counter_entry.counter_id == 0x12000001 for batch in batches for entity in batch)


@pytest.mark.parametrize('change', [
    {'index': -1}, {'index': 8}, {'index': True}, {'counter_id': 0x16000001},
    {'reset': False}, {'reset': 'true'}, {'reset': None}, {'counter_id': 0},
])
def test_invalid_resets_do_not_write(client, switch, change):
    data = {'switch_id': 0, 'counter_id': 0x12000001, 'reset': True, **change}
    assert client.patch('/counters', json=data).status_code == 400
    switch.bmv2.ModifyEntities.assert_not_called()


def add_direct_counter(switch):
    counter = switch.p4_helper.p4info.direct_counters.add(direct_table_id=0x02000001)
    counter.preamble.id, counter.preamble.name = 0x13000001, 'Ingress.direct_counter'


def test_direct_reset_preserves_table_key_without_action_or_meter_writes(client, switch, entry):
    add_direct_counter(switch)
    result = client.patch('/direct-counters', json={'switch_id': 0, 'table_id': 0x02000001, 'table_entry': entry, 'reset': True})
    assert result.status_code == 200 and result.json['reset_count'] == 1
    direct = switch.bmv2.ModifyEntities.call_args.args[0][0].direct_counter_entry
    assert direct.table_entry.table_id == 0x02000001
    assert int.from_bytes(direct.table_entry.match[0].exact.value, 'big') == 1
    assert direct.HasField('data') and direct.data.packet_count == direct.data.byte_count == 0
    assert not direct.table_entry.HasField('action')
    assert not direct.table_entry.HasField('meter_config')
    switch.bmv2.ModifyTableEntry.assert_not_called()
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_reset_all_direct_counters_only_writes_returned_existing_keys(client, switch):
    add_direct_counter(switch)
    response = pb.ReadResponse()
    for value in (1, 2):
        direct = response.entities.add().direct_counter_entry
        direct.table_entry.CopyFrom(switch.p4_helper.buildTableEntry('Ingress.table', {'key': value}, action_name='Ingress.send', action_params={'port': 2}))
        direct.data.packet_count = 9007199254740993
    switch.bmv2.ReadDirectCounters.return_value = iter([response])
    result = client.patch('/direct-counters', json={'switch_id': 0, 'table_id': 0x02000001, 'reset': True})
    assert result.status_code == 200 and result.json['reset_count'] == 2
    assert len(switch.bmv2.ModifyEntities.call_args.args[0]) == 2
    assert all(not entity.direct_counter_entry.table_entry.HasField('action') for entity in switch.bmv2.ModifyEntities.call_args.args[0])


@pytest.mark.parametrize('entry', [{'table_name': 'Other.table'}, {'table_name': 'Ingress.table', 'match_fields': {}},
                                  {'table_name': 'Ingress.table', 'match_fields': {'invalid': 1}},
                                  {'table_name': 'Ingress.table', 'is_default_action': 'true'}])
def test_invalid_direct_counter_keys_do_not_write(client, switch, entry):
    add_direct_counter(switch)
    assert client.patch('/direct-counters', json={'switch_id': 0, 'table_id': 0x02000001, 'table_entry': entry, 'reset': True}).status_code == 400
    switch.bmv2.ModifyEntities.assert_not_called()


def test_direct_reset_requires_associated_counter(client, switch):
    assert client.patch('/direct-counters', json={'switch_id': 0, 'table_id': 0x02000001, 'reset': True}).status_code == 400
    switch.bmv2.ModifyEntities.assert_not_called()


def test_reset_unavailable_reports_possible_partial_write(client, switch):
    class Unavailable(grpc.RpcError):
        def code(self): return grpc.StatusCode.UNAVAILABLE
        def details(self): return 'Target disconnected'
    switch.bmv2.ModifyEntities.side_effect = Unavailable()
    result = client.patch('/counters', json={'switch_id': 0, 'counter_id': 0x12000001, 'reset': True})
    assert result.status_code == 503 and result.json['partial_write_possible'] is True


def test_reset_unknown_switch_is_not_a_server_error(client):
    assert client.patch('/counters', json={'switch_id': 99, 'counter_id': 0x12000001, 'reset': True}).status_code == 404
