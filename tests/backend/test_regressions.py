from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from controller.controller import Controller, UpdateError
from controller.managers.TableEntry import TableEntry
from controller.managers.SwitchManager import SwitchManager, table_entry_key
from controller.p4.v1 import p4runtime_pb2 as pb
from controller.p4.tmp import p4config_pb2
from controller.utils.bmv2 import Bmv2SwitchConnection, buildDeviceConfig
from controller.utils.convert import encode
from controller.utils.switch import SwitchConnection


def parse(switch, value):
    entry = TableEntry(switch.p4_helper)
    entry.from_dict(value)
    return entry


def test_counter_streams_and_empty_results(switch):
    responses = []
    for index in (0, 1):
        response = pb.ReadResponse()
        entry = response.entities.add().counter_entry
        entry.counter_id = 0x12000001
        entry.index.index = index
        entry.data.packet_count = (1 << 53) + index
        responses.append(response)
    switch.bmv2.ReadCounters.return_value = iter(responses)
    assert switch.get_counter_values(0x12000001)["entries"] == [
        {"index": 0, "packets": "9007199254740992", "bytes": "0"},
        {"index": 1, "packets": "9007199254740993", "bytes": "0"}]
    switch.bmv2.ReadCounters.return_value = iter([])
    assert switch.get_counter_values(0x12000001)["entries"] == []


def test_counter_endpoint_passes_zero_index(client, switch):
    switch.bmv2.ReadCounters.return_value = iter([])
    result = client.get('/counters?switch_id=0&counter_id=301989889&index=0')
    assert result.status_code == 200
    switch.bmv2.ReadCounters.assert_called_once_with(counter_id=0x12000001, index=0)
    assert client.get('/counters?switch_id=0&counter_id=301989889&index=8').status_code == 400


def test_device_zero_disconnect_does_not_disconnect_other_switches(client, switch):
    from api import exampleController
    other = Mock()
    exampleController.switch_configs[1] = other
    assert client.delete('/switches/active', json={"device_id": 0}).status_code == 200
    assert set(exampleController.switch_configs) == {1}
    other.shutdown.assert_not_called()


def test_existing_pipeline_is_adopted(switch):
    adopted = SwitchManager(2, {})
    adopted.connected = True
    adopted.bmv2 = Mock()
    adopted.bmv2.GetForwardingPipelineConfig.return_value = switch.p4_helper.p4info
    adopted.bmv2.ReadTableEntries.return_value = iter([])
    adopted.bmv2.ReadEntities.return_value = iter([])
    assert adopted.get_loaded_config()["registers"]
    assert adopted.get_table_entries("Ingress.table") == {"Ingress.table": []}


def test_bulk_delete_is_forwarded_and_executed(switch, entry):
    controller = Controller()
    controller.switch_configs[0] = switch
    old = [{"id": 1, "switch_entry": entry}]
    new = [{"id": 1, "switch_entry": deepcopy(entry), "deleted": True}]
    controller.updateTableEntries(0, old, new)
    switch.bmv2.DeleteTableEntry.assert_called_once()
    switch.bmv2.ModifyTableEntry.assert_not_called()


def test_failed_match_replacement_restores_only_original_row(switch, entry):
    original = parse(switch, entry)
    changed = parse(switch, dict(entry, match_fields={"key": 2}))
    switch.bmv2.WriteTableEntry.side_effect = [ValueError("insertion failed"), None]
    with pytest.raises(ValueError, match="insertion failed"):
        switch.update_table_entry(original, changed)
    assert switch.bmv2.WriteTableEntry.call_count == 2
    assert switch.bmv2.WriteTableEntry.call_args.args[0] == original.entry
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_failed_action_modify_does_not_delete_or_reset_pipeline(switch, entry):
    switch.bmv2.ModifyTableEntry.side_effect = ValueError("target failure")
    with pytest.raises(ValueError):
        switch.update_table_entry(parse(switch, entry), parse(switch, dict(entry, action_params={"port": 3})))
    switch.bmv2.DeleteTableEntry.assert_not_called()
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_failed_bulk_edit_compensates_preceding_changes(switch, entry):
    controller = Controller()
    controller.switch_configs[0] = switch
    old = [{"id": i, "switch_entry": dict(entry, match_fields={"key": i})} for i in (1, 2)]
    new = [{"id": row["id"], "switch_entry": dict(row["switch_entry"], action_params={"port": 3})} for row in old]
    switch.bmv2.ModifyTableEntry.side_effect = [None, ValueError("second row failed"), None]
    with pytest.raises(UpdateError):
        controller.updateTableEntries(0, old, new)
    assert switch.bmv2.ModifyTableEntry.call_count == 3
    last = switch.bmv2.ModifyTableEntry.call_args.args[0]
    assert last.action.action.params[0].value == b'\x00\x02'
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_direct_meter_survives_action_edit(switch, entry):
    response = pb.ReadResponse()
    direct = response.entities.add().direct_meter_entry
    direct.config.CopyFrom(pb.MeterConfig(cir=3, cburst=4, pir=5, pburst=6))
    switch.bmv2.ReadEntities.return_value = iter([response])
    switch.update_table_entry(parse(switch, entry), parse(switch, dict(entry, action_params={"port": 3})))
    assert switch.bmv2.ModifyTableEntry.call_args.args[0].meter_config == direct.config


def test_deleted_row_compensation_restores_direct_meter_and_counter(switch, entry):
    counter = switch.p4_helper.p4info.direct_counters.add(direct_table_id=0x02000001)
    counter.preamble.id = 0x13000001
    meter_response, counter_response = pb.ReadResponse(), pb.ReadResponse()
    meter = meter_response.entities.add().direct_meter_entry
    meter.config.CopyFrom(pb.MeterConfig(cir=1, cburst=2, pir=3, pburst=4))
    direct_counter = counter_response.entities.add().direct_counter_entry
    direct_counter.data.packet_count = 9007199254740993
    direct_counter.data.byte_count = 1234
    switch.bmv2.ReadEntities.side_effect = [iter([meter_response]), iter([counter_response]), iter([])]
    switch.bmv2.ModifyTableEntry.side_effect = ValueError("second edit failed")
    controller = Controller()
    controller.switch_configs[0] = switch
    old = [{"id": i, "switch_entry": dict(entry, match_fields={"key": i})} for i in (1, 2)]
    new = [{"id": 1, "deleted": True, "switch_entry": old[0]["switch_entry"]},
           {"id": 2, "switch_entry": dict(old[1]["switch_entry"], action_params={"port": 3})}]
    with pytest.raises(UpdateError):
        controller.updateTableEntries(0, old, new)
    restored = switch.bmv2.WriteTableEntry.call_args.args[0]
    assert restored.meter_config == meter.config
    assert restored.counter_data == direct_counter.data
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_table_patch_failure_never_reinitializes(client, switch, entry):
    switch.bmv2.ModifyTableEntry.side_effect = ValueError("invalid")
    import json
    result = client.patch('/tables', json={"switch_id": 0, "old": json.dumps(entry),
        "new": json.dumps(dict(entry, action_params={"port": 3}))})
    assert result.status_code == 500
    switch.bmv2.SetForwardingPipelineConfig.assert_not_called()


def test_table_key_is_match_order_independent():
    one = pb.TableEntry(table_id=1, priority=1)
    one.match.add(field_id=2).exact.value = b'\x01'
    one.match.add(field_id=1).exact.value = b'\x02'
    two = pb.TableEntry(table_id=1, priority=1)
    two.match.extend(reversed(one.match))
    assert table_entry_key(one) == table_entry_key(two)
    two.priority = 2
    assert table_entry_key(one) != table_entry_key(two)


def test_direct_counters_join_by_table_key_not_stream_order(client, switch, entry):
    counter = switch.p4_helper.p4info.direct_counters.add(direct_table_id=0x02000001)
    counter.preamble.id, counter.preamble.name = 0x13000001, "Ingress.direct_counter"
    tables = pb.ReadResponse()
    counters = pb.ReadResponse()
    for key in (1, 2):
        raw = switch.p4_helper.buildTableEntry("Ingress.table", match_fields={"key": key},
                action_name="Ingress.send", action_params={"port": 2})
        tables.entities.add().table_entry.CopyFrom(raw)
    for index, packets in ((1, 200), (0, 100)):
        direct = counters.entities.add().direct_counter_entry
        direct.table_entry.CopyFrom(tables.entities[index].table_entry)
        direct.table_entry.match[0].exact.value = bytes([index + 1])
        direct.data.packet_count = packets
    switch.bmv2.ReadTableEntries.return_value = iter([tables])
    switch.bmv2.ReadDirectCounters.return_value = iter([counters])
    response = client.get('/tables?switch_id=0&table_name=Ingress.table')
    assert response.status_code == 200
    assert [(row["switch_entry"]["match_fields"]["key"], row["counters"]["packets"])
            for row in response.json] == [(1, "100"), (2, "200")]


def test_keep_entries_identical_pipeline_is_noop(tmp_path, switch):
    path = tmp_path / 'pipeline.json'
    path.write_text('{}')
    connection = Bmv2SwitchConnection.__new__(Bmv2SwitchConnection)
    connection.device_id = 0
    connection.client_stub = Mock()
    response = pb.GetForwardingPipelineConfigResponse()
    response.config.p4info.CopyFrom(switch.p4_helper.p4info)
    response.config.p4_device_config = buildDeviceConfig(str(path)).SerializeToString()
    connection.client_stub.GetForwardingPipelineConfig.return_value = response
    connection.SetForwardingPipelineConfig(switch.p4_helper.p4info, keep_entries=True, bmv2_json_file_path=str(path))
    connection.client_stub.SetForwardingPipelineConfig.assert_not_called()
    path.write_text('{"different": true}')
    with pytest.raises(ValueError, match="cannot safely preserve"):
        connection.SetForwardingPipelineConfig(switch.p4_helper.p4info, keep_entries=True, bmv2_json_file_path=str(path))
    connection.client_stub.SetForwardingPipelineConfig.assert_not_called()


def test_standard_rpc_modify_and_zero_index_presence():
    connection = SwitchConnection.__new__(SwitchConnection)
    connection.device_id = 0
    connection.client_stub = Mock()
    entity = pb.Entity()
    entity.register_entry.register_id = 0x16000001
    entity.register_entry.index.index = 0
    connection.ModifyEntities([entity])
    request = connection.client_stub.Write.call_args.args[0]
    assert request.election_id.low == 1
    assert request.updates[0].type == pb.Update.MODIFY
    assert request.updates[0].entity.register_entry.HasField("index")


@pytest.mark.parametrize("value", ['123456789012', '281474976710655'])
def test_decimal_strings_are_not_confused_with_hex_mac(value):
    assert int.from_bytes(encode(value, 48), 'big') == int(value)


@pytest.mark.parametrize("value", [-1, 1.2, True])
def test_invalid_unsigned_table_values_rejected(value):
    with pytest.raises(ValueError):
        encode(value, 16)
