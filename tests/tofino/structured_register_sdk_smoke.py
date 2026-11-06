"""Structured-register native CI using the official SDK client environment."""
import json
import bfrt_grpc.client as gc

interface = gc.ClientInterface(grpc_addr='127.0.0.1:50052', client_id=94, device_id=0)
try:
    interface.bind_pipeline_config('unicorn_structured')
    info = interface.bfrt_info_get('unicorn_structured')
    table = info.table_get('Ingress.packet_register')
    target = gc.Target(device_id=0, pipe_id=0xffff)
    fields = table.info.data_field_name_list_get()
    left = next(name for name in fields if name.endswith('.left'))
    right = next(name for name in fields if name.endswith('.right'))
    def write(index, values):
        table.entry_mod(target, [table.make_key([gc.KeyTuple('$REGISTER_INDEX', index)])],
                        [table.make_data([gc.DataTuple(name, value) for name, value in values.items()])])
    def read(index):
        result = list(table.entry_get(target, [table.make_key([gc.KeyTuple('$REGISTER_INDEX', index)])],
                                      {'from_hw': True}))[0][0].to_dict()
        return {name: result[name][0] for name in fields}
    first = {left: 4294967295, right: 305419896}
    neighbor = {left: 2147483648, right: 4294967295}
    write(7, first)
    write(8, neighbor)
    assert read(7) == first
    changed = dict(first, **{left: 123})
    write(7, changed)
    assert read(7) == changed and read(8) == neighbor
    print(json.dumps({'result': 'PASS', 'client': 'official SDK', 'cell7': read(7), 'cell8': read(8)}, indent=2))
finally:
    interface.tear_down_stream()
