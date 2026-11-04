"""Run with the common controller adapter against a real struct-register model."""
import json
from controller.targets.tofino import TofinoTarget

switch = TofinoTarget(19, {'name': 'structured-native', 'address': '127.0.0.1:50052', 'target': 'tofino',
    'target_options': {'runtime_device_id': 0, 'client_id': 93, 'pipe_id': 0, 'program_name': 'unicorn_structured'}})
try:
    switch.connect()
    registers = switch.get_loaded_config()['registers']
    register = next(iter(registers.values()))
    resource_id = register['id']
    before = switch.resources.read('register', resource_id, index=7)
    fields = before['fields']
    assert len(fields) == 2 and all(field['type']['bitwidth'] == 32 for field in fields), fields
    left = next(field['name'] for field in fields if field['name'].endswith('.left'))
    right = next(field['name'] for field in fields if field['name'].endswith('.right'))
    initial = {left: '4294967295', right: '305419896'}
    switch.resources.write('register', resource_id, [{'index': 7, 'value': initial}])
    readback = switch.resources.read('register', resource_id, index=7)['entries'][0]['value']
    assert readback == initial, readback
    # The common API requires the complete typed value: preserve the other field
    # while modifying one component, and preserve neighboring register cells.
    neighbor = {left: '2147483648', right: '4294967295'}
    switch.resources.write('register', resource_id, [{'index': 8, 'value': neighbor}])
    modified = dict(readback, **{left: '123'})
    switch.resources.write('register', resource_id, [{'index': 7, 'value': modified}])
    actual = switch.resources.read('register', resource_id, index=7)['entries'][0]['value']
    assert actual == modified and actual[right] == initial[right], actual
    actual_neighbor = switch.resources.read('register', resource_id, index=8)['entries'][0]['value']
    assert actual_neighbor == neighbor, actual_neighbor
    try:
        switch.resources.write('register', resource_id, [{'index': 7, 'value': {left: '456'}}])
        raise AssertionError('Incomplete structured register value was accepted')
    except ValueError:
        pass
    assert switch.resources.read('register', resource_id, index=7)['entries'][0]['value'] == modified
    print(json.dumps({'result': 'PASS', 'fields': fields, 'cell7': actual, 'cell8': actual_neighbor,
                      'incomplete_write_rejected': True}, indent=2))
finally:
    switch.shutdown()
