import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import grpc
import pytest
from flask import Flask, request
from flask_restful import Api

from api import network_archive as archive
from api.endpoints.network import NetworkImport
from controller.targets.bfrt_client import BfRtClient
from controller.targets.bfrt_metadata import fields, encode_fields
from controller.targets.bfrt_tables import encode_key
from controller.targets.bfrt_proto import bfruntime_pb2 as pb
from test_native_archive import rewrite, snapshot, native
from test_bfrt_targets import MemoryBfRt



def test_control_native_archive_roundtrip(snapshot):
    archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())


def test_native_export_keeps_the_exact_source_when_basenames_collide(snapshot):
    root = Path(snapshot.switch.program_manifest).parent
    metadata = json.loads((root / 'manifest.json').read_text())
    metadata['source'] = str(snapshot.root / 'nested' / 'example.p4')
    (root / 'manifest.json').write_text(json.dumps(metadata))
    (root / 'source' / 'nested').mkdir()
    (root / 'source' / 'nested' / 'example.p4').write_text('#include "../example.p4"\n#include <tna.p4>\n')
    validated = archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())
    assert validated['manifest']['switches'][0]['pipeline']['source'].endswith('/source/nested/example.p4')


def test_replay_accepts_an_identical_entry_already_created_by_the_pipeline(snapshot):
    entry = next(row for row in snapshot.switch.client.entries.values()
                 if row.table_id == snapshot.switch.p4_helper.table('pipe.Ingress.forwarding')['id'])
    assert archive._restore_entity(snapshot.switch, entry, 'tables', snapshot.switch.p4_helper) is False


def test_native_import_polling_recovers_transient_failures(monkeypatch):
    from urllib.error import HTTPError
    topology = {'switches': {'s1': {'target': 'tofino'}}}
    loaded = {'file_name': '/topologies/sample.json'}
    request = Mock(side_effect=[{'deployment_id': 'job1'}, OSError('connection lost'),
                               HTTPError('http://emulator', 502, 'gateway', {}, None),
                               {'status': 'ready', 'topology': loaded}])
    monkeypatch.setattr(archive, 'netsim_request', request)
    monkeypatch.setattr(archive.time, 'sleep', lambda _: None)
    assert archive._load_import_topology('sample.json', topology, {'deployment': {}}) == loaded
    assert request.call_count == 4


def test_native_import_polling_does_not_retry_a_missing_job(monkeypatch):
    from urllib.error import HTTPError
    request = Mock(side_effect=[{'deployment_id': 'job1'}, HTTPError('http://emulator', 404, 'missing', {}, None)])
    monkeypatch.setattr(archive, 'netsim_request', request)
    with pytest.raises(HTTPError):
        archive._load_import_topology('sample.json', {'switches': {'s1': {'target': 'tofino'}}}, {'deployment': {}})
    assert request.call_count == 2


def test_pre_rpc_validation_failure_preserves_active_program(native, tmp_path):
    previous = native.p4_helper
    metadata = tmp_path / 'bfrt.json'
    metadata.write_text('{"tables":[{"id":1}]}')
    native.client = BfRtClient('unused.invalid')
    native.client.stub = Mock()
    with pytest.raises(ValueError):
        native.initialize_bundle({'target':'tofino', 'program_name':'bad', 'bfrt_json':str(metadata),
                                  'profiles':[{'profile_name':'pipe','pipe_scope':[0], 'context':'unused','binary':'unused'}]})
    native.client.stub.SetForwardingPipelineConfig.assert_not_called()
    assert native.p4_helper is previous


def test_reconnect_timeout_does_not_leave_closed_stub(monkeypatch):
    client = BfRtClient('unused.invalid')
    client.channel = Mock()
    old = client.stub = Mock()
    client.close()
    monkeypatch.setattr('controller.targets.bfrt_client.grpc.insecure_channel', Mock(return_value=Mock()))
    monkeypatch.setattr('controller.targets.bfrt_client.grpc.channel_ready_future', Mock(return_value=Mock(
        result=Mock(side_effect=grpc.FutureTimeoutError()))))
    with pytest.raises(grpc.FutureTimeoutError):
        client.connect()
    assert client.stub is not old


def test_subscription_timeout_reaps_its_reader_and_allows_retry(monkeypatch):
    from threading import Event, enumerate as threads
    from controller.targets import bfrt_client as transport

    class Stream:
        def __init__(self, subscribe):
            self.subscribe = subscribe
            self.cancelled = Event()

        def __iter__(self):
            if self.subscribe:
                response = pb.StreamMessageResponse()
                response.subscribe.status.code = 0
                yield response
            self.cancelled.wait(5)

        def cancel(self):
            self.cancelled.set()

    failed, healthy = Stream(False), Stream(True)
    stub = Mock(StreamChannel=Mock(side_effect=[failed, healthy]))
    channel = Mock()
    monkeypatch.setattr(transport.grpc, 'insecure_channel', Mock(return_value=channel))
    monkeypatch.setattr(transport.grpc, 'channel_ready_future', Mock(return_value=Mock()))
    monkeypatch.setattr(transport.bfruntime_pb2_grpc, 'BfRuntimeStub', Mock(return_value=stub))
    client = BfRtClient('unused.invalid', timeout=.05)
    previous_readers = {thread.ident for thread in threads() if thread.name == 'unicorn-bfrt-stream'}
    with pytest.raises(RuntimeError, match='subscription timed out'):
        client.connect()
    assert failed.cancelled.is_set()
    assert client.channel is client.stub is client.stream is client.thread is None
    assert {thread.ident for thread in threads() if thread.name == 'unicorn-bfrt-stream'} == previous_readers
    try:
        client.connect()
        assert client.subscribed.is_set()
        assert client.stub is stub
        assert client.stream_error is None
    finally:
        client.close()
    assert healthy.cancelled.is_set()


def test_explicit_program_filter_allows_an_empty_device_but_rejects_a_different_program():
    from controller.targets.bfrt_client import NoProgramLoaded
    client = BfRtClient('unused.invalid')
    response = pb.GetForwardingPipelineConfigResponse()
    client.stub = Mock(GetForwardingPipelineConfig=Mock(return_value=response))
    with pytest.raises(NoProgramLoaded):
        client.discover('desired')
    response.config.add(p4_name='other')
    with pytest.raises(RuntimeError, match='program is not loaded: desired'):
        client.discover('desired')


@pytest.mark.parametrize('payload', ['json', 'form', 'query'])
def test_native_requests_finish_before_the_connection_is_removed(native, payload):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from threading import Event
    from api.endpoints.Endpoint import SwitchEndpoint
    from controller.controller import Controller

    entered, finish, deleting = Event(), Event(), Event()
    controller = Controller()
    controller.switch_configs[17] = native

    class Operation(SwitchEndpoint):
        def post(self):
            entered.set()
            assert finish.wait(5)
            assert controller.switch_configs[17] is native
            assert native.connected
            return {'complete': True}

    app = Flask(__name__)
    Api(app).add_resource(Operation, '/operation', resource_class_kwargs={'controller': controller, 'db': None})

    def call():
        with app.test_client() as client:
            arguments = {'query_string' if payload == 'query' else 'data' if payload == 'form' else 'json': {'switch_id': 17}}
            return client.post('/operation', **arguments)

    def remove():
        deleting.set()
        controller.deleteSwitchConnection(17)

    with ThreadPoolExecutor(max_workers=2) as workers:
        operation = workers.submit(call)
        try:
            assert entered.wait(5)
            removal = workers.submit(remove)
            assert deleting.wait(5)
            with pytest.raises(TimeoutError):
                removal.result(timeout=.05)
        finally:
            finish.set()
        assert operation.result(timeout=5).status_code == 200
        removal.result(timeout=5)
    assert 17 not in controller.switch_configs
    assert not native.connected


@pytest.mark.parametrize('problem', ['protobuf', 'fixed_json', 'queues', 'nonobject'])
def test_malformed_native_upload_is_a_client_error(snapshot, problem):
    original = archive.build_archive(snapshot.controller).getvalue()
    def edit(files, manifest):
        record = manifest['switches'][0]
        state_path = record['runtime']['path']
        state = json.loads(files[state_path])
        if problem == 'protobuf':
            state['entities']['tables'] = [{'not_a_protobuf_field':1}]
        elif problem == 'queues':
            state['queues'].pop('configuration')
        elif problem == 'nonobject':
            state['entities']['mirrors'] = [42]
        else:
            path = record['pipeline']['manifest']
            metadata = json.loads(files[path]); metadata.pop('fixed_json')
            files[path] = archive.json_bytes(metadata)
        files[state_path] = archive.json_bytes(state)
    raw = rewrite(original, edit)
    app = Flask(__name__)
    Api(app).add_resource(NetworkImport, '/import', resource_class_kwargs={'controller':snapshot.controller, 'db':None})
    response = app.test_client().post('/import', data={'file':(io.BytesIO(raw),'network.zip')})
    assert response.status_code == 400, response.data


def test_indirect_native_table_export_can_be_reimported(snapshot):
    switch = snapshot.switch
    table = switch.p4_helper.table('pipe.Ingress.forwarding')
    table['table_type'] = 'MatchAction_Indirect'
    table['action_specs'] = []
    table['data'].append({'singleton':{'id':777,'name':'$ACTION_MEMBER_ID','type':{'type':'uint32'}}})
    path = Path(switch.bundle['manifest_path']).parent / 'bf-rt.json'
    path.write_text(json.dumps(switch.p4_helper.raw))
    row = pb.TableEntry(table_id=table['id'])
    row.key.CopyFrom(encode_key(table, {'intrinsic.ingress_port':'0'}))
    row.data.fields.extend(encode_fields(fields(table['data']), {'$ACTION_MEMBER_ID':'7'}))
    switch.client = MemoryBfRt()
    switch.client.write([row], pb.Update.INSERT)
    raw = archive.build_archive(snapshot.controller).getvalue()
    validated = archive.validate_archive(raw)
    status = validated['manifest']['switches'][0]['runtime']['categories']['tables']
    assert status['status'] == 'unavailable'
    assert 'Action-profile/selector' in ' '.join(status['errors'])


def test_direct_counter_reset_rejects_an_indexed_counter_id(native):
    table = native.p4_helper.table('pipe.Ingress.packet_counter')
    native.client = MemoryBfRt()
    for index in (0, 1):
        row = native.resources.indexed_entry(table, index)
        row.data.fields.extend(encode_fields(fields(table['data']), {'$COUNTER_SPEC_PKTS':'10','$COUNTER_SPEC_BYTES':'600'}))
        native.client.write([row], pb.Update.INSERT)
    with pytest.raises(ValueError):
        native.reset_direct_counter(table['id'])


@pytest.mark.parametrize('kind', ['mirrors','multicast','queues','digests'])
def test_uninitialized_resource_page_returns_conflict(native, kind):
    from api.endpoints.mirrors import Mirrors
    from api.endpoints.multicast import MulticastGroups
    from api.endpoints.queues import Queues
    from api.endpoints.digests import Digests
    native.p4_helper = None
    app = Flask(__name__)
    resource = {'mirrors':Mirrors,'multicast':MulticastGroups,'queues':Queues,'digests':Digests}[kind]
    Api(app).add_resource(resource, '/resource', resource_class_kwargs={'controller':SimpleNamespace(switch_configs={17:native}),'db':None})
    response = app.test_client().get('/resource?switch_id=17')
    assert response.status_code == 409, response.data


def test_read_only_digest_events_return_supported_api_error(native):
    from api.endpoints.digests import DigestEvents
    native.read_only = True
    native.client = BfRtClient('unused.invalid', read_only=True)
    app = Flask(__name__)
    Api(app).add_resource(DigestEvents, '/events', resource_class_kwargs={'controller':SimpleNamespace(switch_configs={17:native}),'db':None})
    response = app.test_client().get('/events?switch_id=17')
    assert response.status_code == 501, response.data


def test_external_only_model_import_is_rejected_before_disconnecting(snapshot, monkeypatch):
    import tempfile
    from api.topology_schema import validate_deployable_topology
    topology = {'hosts':[],'switches':{'s1':{'target':'tofino'}},'links':[], 'ext_intfs':[['s1','eth9']]}
    validate_deployable_topology(topology)
    stage = {'directory':tempfile.TemporaryDirectory(), 'manifest':{'files':{}}, 'files':{},
             'topology':topology, 'switches':[], 'deployment':{}}
    controller = Mock()
    def load(path, filtered_topology, current_stage):
        validate_deployable_topology(filtered_topology)
        return {'file_name':path, 'switches_online':[]}
    monkeypatch.setattr(archive, '_load_import_topology', load)
    assert archive._DEPLOY_LOCK.acquire(blocking=False)
    result = archive._deploy_reserved(controller, None, {'import_token':'audit-ext-only'}, stage, [])
    assert 'at least one interface' in result['error']
    controller.deleteAllSwitchConnections.assert_not_called()


def test_coalescing_mirror_does_not_break_the_session_list(native):
    table = native.p4_helper.table('$mirror.cfg')
    action = next(item for item in table['action_specs'] if item['name'] == '$coalescing')
    row = pb.TableEntry(table_id=table['id'])
    row.key.CopyFrom(encode_key(table, {'$sid':'7'}))
    row.data.action_id = action['id']
    row.data.fields.extend(encode_fields(fields(action['data']), {'$timeout_usec':'10'}))
    native.client = MemoryBfRt()
    native.client.write([row], pb.Update.INSERT)
    assert native.manager('mirrors').read()['entries'][0]['editable'] is False


def test_failed_key_edit_rollback_omits_read_only_fields(native):
    from copy import deepcopy
    value = {'table_name':'pipe.Ingress.forwarding','match_fields':{'intrinsic.ingress_port':'0'},
             'action_name':'Ingress.forward','action_params':{'port':'1','index':'0'}}
    old = native.create_table_entry(value, False)
    changed = deepcopy(value); changed['match_fields']['intrinsic.ingress_port'] = '1'
    new = native.create_table_entry(changed, False)
    original = deepcopy(old.entry)
    original.data.fields.add(field_id=999, stream=b'\x01')
    old.table['data'].append({'singleton':{'id':999,'name':'$ENTRY_HIT_STATE','read_only':True,'type':{'type':'uint32'}}})
    native.client.read.return_value = [original]
    def write(entries, operation):
        if operation == pb.Update.INSERT and entries[0].key == new.entry.key:
            raise RuntimeError('injected INSERT failure')
    native.client.write.side_effect = write
    with pytest.raises(RuntimeError, match='injected INSERT failure'):
        native.update_table_entry(old, new)
    restored = native.client.write.call_args.args[0][0]
    assert all(field.field_id != 999 for field in restored.data.fields)


def test_dated_build_is_kept_when_database_references_fail(tmp_path, monkeypatch):
    from api.program_builds import BuildJobs
    from test_program_builds import make_bundle
    monkeypatch.setenv('P4_DIR', str(tmp_path))
    source = tmp_path / 'main.p4'; source.write_text('#include <tna.p4>\n')
    old = tmp_path / '.unicorn-builds' / 'old'
    metadata = make_bundle(old)
    metadata.update(source=str(source), created_at='2026-11-04T10:00:00+00:00')
    (old/'manifest.json').write_text(json.dumps(metadata))
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', lambda request, timeout: io.BytesIO(json.dumps({
        'manifest':make_bundle(Path(json.loads(request.data)['output']))}).encode()))
    jobs = BuildJobs(); jobs.referenced = Mock(side_effect=RuntimeError('Database unavailable'))
    jobs.jobs['fresh'] = {'status':'pending'}
    jobs._compile('fresh',source,'http://compiler:8080')
    assert jobs.get('fresh')['status'] == 'complete' and old.is_dir()


@pytest.mark.parametrize('replace', [False, True])
def test_waiting_native_request_does_not_block_other_connections(native, replace):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, RLock
    from api.endpoints.Endpoint import SwitchEndpoint, Endpoint
    from controller.controller import Controller

    waiting, underlying = Event(), RLock()
    class ObservedLock:
        def acquire(self):
            waiting.set()
            return underlying.acquire()
        def release(self):
            underlying.release()
        def __enter__(self):
            self.acquire()
        def __exit__(self, *_args):
            self.release()

    native.operation_lock = ObservedLock()
    controller = Controller()
    other = SimpleNamespace(target='bmv2', as_json=lambda: {'device_id': 18})
    controller.switch_configs = {17: native, 18: other}
    dispatched = Mock()

    class Operation(SwitchEndpoint):
        def get(self):
            dispatched(int(request.args['switch_id']))
            return {'complete': True}

    class Connections(Endpoint):
        def get(self):
            return {'connections': self.controller.getSwitchConnections()}

    app = Flask(__name__)
    api = Api(app)
    for resource, path in ((Operation, '/operation'), (Connections, '/connections')):
        api.add_resource(resource, path, resource_class_kwargs={'controller': controller, 'db': None})

    def get(path):
        with app.test_client() as client:
            return client.get(path)

    with ThreadPoolExecutor(max_workers=2) as workers:
        underlying.acquire()  # Simulate an in-progress native pipeline load.
        queued = workers.submit(get, '/operation?switch_id=17')
        try:
            assert waiting.wait(5)
            assert workers.submit(get, '/connections').result(timeout=2).status_code == 200
            assert workers.submit(get, '/operation?switch_id=18').result(timeout=2).status_code == 200
            if replace:
                with controller.connections_lock:
                    controller.switch_configs[17] = other
        finally:
            underlying.release()
        assert queued.result(timeout=5).status_code == (409 if replace else 200)
    assert [call.args[0] for call in dispatched.call_args_list] == ([18] if replace else [18, 17])


@pytest.mark.parametrize('priority', [1, 2, 16777216])
def test_table_priority_uses_the_same_larger_first_order_as_p4runtime(priority):
    from controller.targets.bfrt_tables import decode_key
    table = {'key': [{'id': 1, 'name': '$MATCH_PRIORITY', 'match_type': 'Exact', 'type': {'type': 'uint32'}}]}
    key = encode_key(table, {}, priority=priority)
    assert int.from_bytes(key.fields[0].exact.value, 'big') == 16777216 - priority
    assert decode_key(table, key) == ({}, priority)
    assert not encode_key(table, {}, priority=priority, default=True).fields


@pytest.mark.parametrize('priority', [0, -1, 16777217])
def test_table_priority_rejects_values_outside_its_positive_range(priority):
    table = {'key': [{'id': 1, 'name': '$MATCH_PRIORITY', 'match_type': 'Exact', 'type': {'type': 'uint32'}}]}
    with pytest.raises(ValueError, match='priority'):
        encode_key(table, {}, priority=priority)


def test_eight_two_digit_ipv6_groups_are_not_misread_as_eight_bytes():
    import ipaddress
    from controller.targets.bfrt_metadata import encode_bytes
    field = {'id': 1, 'name': 'address', 'type': {'type': 'bytes', 'width': 128}}
    address = '11:22:33:44:55:66:77:88'
    assert encode_bytes(address, field) == ipaddress.IPv6Address(address).packed
    field['type']['width'] = 48
    assert encode_bytes('aa:bb:cc:dd:ee:ff', field) == bytes.fromhex('aabbccddeeff')


def test_signed_range_order_is_compared_numerically():
    from controller.targets.bfrt_tables import decode_key
    table = {'key': [{'id': 1, 'name': 'delta', 'match_type': 'Range', 'type': {'type': 'int16'}}]}
    for low, high in ((-128, 127), (-2, -1), (0, 127)):
        key = encode_key(table, {'delta': [str(low), str(high)]})
        assert decode_key(table, key) == ({'delta': [str(low), str(high)]}, None)
    for low, high in ((127, -128), (-1, -2)):
        with pytest.raises(ValueError, match='lower bound'):
            encode_key(table, {'delta': [str(low), str(high)]})


def test_external_priority_groups_survive_table_edit_roundtrips(native):
    from controller.targets.bfrt_tables import BfRtTableEntry
    table = native.p4_helper.table('pipe.Ingress.forwarding')
    table['key'].append({'id': 777, 'name': '$MATCH_PRIORITY', 'match_type': 'Exact', 'type': {'type': 'uint32'}})
    row = pb.TableEntry(table_id=table['id'])
    row.key.CopyFrom(encode_key(table, {'intrinsic.ingress_port': '0'}, priority=10, priority_group=7))
    row.data.action_id = table['action_specs'][0]['id']
    row.data.fields.extend(encode_fields(fields(table['action_specs'][0]['data']), {'port': '1', 'index': '0'}))
    value = BfRtTableEntry.from_native(native.p4_helper, row).as_json()
    assert value['priority'] == 10
    assert value['_priority_group'] == 7
    assert BfRtTableEntry(native.p4_helper, value).entry.key == row.key
