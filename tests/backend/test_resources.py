import pytest

from controller.managers.ResourceManager import encode_register, decode_register, encode_meter
from controller.p4.v1 import p4runtime_pb2 as pb


@pytest.mark.parametrize("kind,width,value", [
    ("bit", 1, 0), ("bit", 1, 1), ("bit", 9, 511),
    ("bit", 64, (1 << 64) - 1), ("bit", 128, (1 << 128) - 1),
    ("int", 9, -256), ("int", 9, 255), ("int", 64, -(1 << 63)),
    ("int", 64, (1 << 63) - 1), ("int", 9, -1),
])
def test_register_round_trip(kind, width, value):
    type_info = {"kind": kind, "bitwidth": width}
    encoded = encode_register(str(value), type_info)
    assert len(encoded.bitstring) <= (width + 7) // 8
    assert decode_register(encoded, type_info) == str(value)


@pytest.mark.parametrize("value", [-1, 256, 1.1, True, "1.0", "0xff", ""])
def test_invalid_register_values(value):
    with pytest.raises(ValueError):
        encode_register(value, {"kind": "bit", "bitwidth": 8})


def test_read_register_zero_and_multiple_stream_chunks(switch):
    first, second = pb.ReadResponse(), pb.ReadResponse()
    for response, index, value in ((first, 0, 0), (second, 1, (1 << 64) - 1)):
        entry = response.entities.add().register_entry
        entry.register_id = 0x16000001
        entry.index.index = index
        entry.data.CopyFrom(encode_register(str(value), {"kind": "bit", "bitwidth": 64}))
    switch.bmv2.ReadEntities.return_value = iter([first, second])
    result = switch.resources.read("register", 0x16000001, limit=2)
    requests = switch.bmv2.ReadEntities.call_args.args[0]
    assert len(requests) == 2
    assert requests[0].register_entry.HasField("index")
    assert result["entries"] == [{"index": 0, "value": "0"}, {"index": 1, "value": "18446744073709551615"}]


def test_register_batch_validated_before_any_write(switch):
    with pytest.raises(ValueError):
        switch.resources.write("register", 0x16000001, [{"index": 0, "value": "1"}, {"index": 8, "value": "2"}])
    switch.bmv2.ModifyEntities.assert_not_called()


def test_register_batch_rejects_duplicate_indices(switch):
    with pytest.raises(ValueError, match="Duplicate"):
        switch.resources.write("register", 0x16000001, [{"index": 0, "value": "1"}, {"index": 0, "value": "2"}])
    switch.bmv2.ModifyEntities.assert_not_called()


def test_pagination_bounds(switch):
    result = switch.resources.read("register", 0x16000001, offset=8)
    assert result["entries"] == []
    switch.bmv2.ReadEntities.assert_not_called()
    with pytest.raises(ValueError):
        switch.resources.read("register", 0x16000001, limit=100000)


def test_meter_write_and_reset(switch):
    config = dict(cir="100", cburst="10", pir="200", pburst="20")
    switch.resources.write("meter", 0x14000001, [{"index": 0, "config": config}, {"index": 1, "config": None}])
    entities = switch.bmv2.ModifyEntities.call_args.args[0]
    assert entities[0].meter_entry.config.cir == 100
    assert entities[0].meter_entry.HasField("index")
    assert not entities[1].meter_entry.HasField("config")


@pytest.mark.parametrize("config", [{}, {"cir": "-1", "cburst": "1", "pir": "2", "pburst": "1"},
    {"cir": "3", "cburst": "1", "pir": "2", "pburst": "1"},
    {"cir": "1", "cburst": "1", "pir": str(1 << 63), "pburst": "1"}])
def test_invalid_meter_config(config):
    with pytest.raises(ValueError):
        encode_meter(config)


def test_direct_meter_read_key_and_write(switch, entry):
    response = pb.ReadResponse()
    raw = response.entities.add().direct_meter_entry
    raw.table_entry.CopyFrom(switch.p4_helper.buildTableEntry("Ingress.table", match_fields={"key": 1}))
    raw.config.CopyFrom(encode_meter(dict(cir="1", cburst="2", pir="3", pburst="4")))
    switch.bmv2.ReadEntities.return_value = iter([response])
    rows = switch.resources.read_direct(0x15000001)["entries"]
    assert rows[0]["table_entry"]["match_fields"] == {"key": 1}
    switch.resources.write_direct(0x15000001, rows)
    request = switch.bmv2.ModifyEntities.call_args.args[0][0].direct_meter_entry
    assert request.table_entry == raw.table_entry
    assert request.config == raw.config


@pytest.mark.parametrize('kind,value,expected,priority', [
    ('EXACT', '9007199254740993', '9007199254740993', None),
    ('LPM', ['9007199254740993', 64], ['9007199254740993', 64], None),
    ('TERNARY', ['9007199254740993', '18446744073709551615'], ['9007199254740993', '18446744073709551615'], 1),
    ('RANGE', ['9007199254740993', '9007199254740995'], ['9007199254740993', '9007199254740995'], 1),
])
def test_direct_meter_wide_keys_survive_json_read_and_write(client, switch, kind, value, expected, priority):
    from controller.p4.config.v1 import p4info_pb2
    field = switch.p4_helper.p4info.tables[0].match_fields[0]
    field.bitwidth = 64
    field.match_type = getattr(p4info_pb2.MatchField, kind)
    response = pb.ReadResponse()
    raw = response.entities.add().direct_meter_entry
    raw.table_entry.CopyFrom(switch.p4_helper.buildTableEntry('Ingress.table', match_fields={'key': value}, priority=priority))
    raw.config.CopyFrom(encode_meter(dict(cir='1', cburst='2', pir='3', pburst='4')))
    switch.bmv2.ReadEntities.return_value = iter([response])
    read = client.get('/direct-meters?switch_id=0&meter_id=352321537')
    assert read.status_code == 200
    assert read.json['entries'][0]['table_entry']['match_fields'] == {'key': expected}
    # A normal browser JSON parser must receive quoted wide integers.
    assert b'"9007199254740993"' in read.data
    write = client.patch('/direct-meters', json={'switch_id': 0, 'meter_id': 0x15000001, 'entries': read.json['entries']})
    assert write.status_code == 200
    actual = switch.bmv2.ModifyEntities.call_args.args[0][0].direct_meter_entry
    assert actual.table_entry == raw.table_entry
    assert actual.config == raw.config


def test_resource_json_and_metadata(client, switch):
    response = client.get('/init?switch_id=0')
    assert response.status_code == 200
    assert response.json["registers"]["Ingress.reg"]["type"] == {"kind": "bit", "bitwidth": 64}
    assert response.json["meters"]["Ingress.meter"]["id"] == 0x14000001
    response = client.patch('/registers', json={"switch_id": 0, "register_id": 0x16000001,
        "entries": [{"index": 0, "value": "18446744073709551615"}]})
    assert response.status_code == 200
    entities = switch.bmv2.ModifyEntities.call_args.args[0]
    assert entities[0].register_entry.data.bitstring == bytes.fromhex("ffffffffffffffff")


@pytest.mark.parametrize("url", ['/registers', '/meters', '/direct-meters'])
def test_invalid_resource_request(client, url):
    assert client.get(url).status_code == 400
    assert client.patch(url, json={"switch_id": 0}).status_code == 400
    assert client.patch(url, json={"switch_id": 5, "register_id": 1}).status_code == 404


def test_target_unsupported_register_returns_capability_error(client, switch):
    import grpc
    class Unsupported(grpc.RpcError):
        def code(self):
            return grpc.StatusCode.UNIMPLEMENTED
        def details(self):
            return "Target has no RegisterEntry implementation"
    switch.bmv2.ReadEntities.side_effect = Unsupported()
    response = client.get('/registers?switch_id=0&register_id=369098753')
    assert response.status_code == 501
    assert response.json["code"] == "UNIMPLEMENTED"
    assert response.json["partial_write_possible"] is False


def test_register_batch_unimplemented_rich_status_maps_to_501(client, switch):
    import grpc
    from google.rpc import status_pb2
    status = status_pb2.Status(code=2)
    status.details.add().Pack(pb.Error(canonical_code=12, message='Native width unsupported'))
    class Unsupported(grpc.RpcError):
        def code(self):
            return grpc.StatusCode.UNKNOWN
        def details(self):
            return 'One or more P4Runtime updates failed'
        def trailing_metadata(self):
            return (('grpc-status-details-bin', status.SerializeToString()),)
    switch.bmv2.ModifyEntities.side_effect = Unsupported()
    response = client.patch('/registers', json={"switch_id": 0, "register_id": 0x16000001,
        "entries": [{"index": 0, "value": "1"}]})
    assert response.status_code == 501
    assert response.json['code'] == 'UNIMPLEMENTED'
    assert 'Native width unsupported' in response.json['error']
    assert response.json['partial_write_possible'] is False
