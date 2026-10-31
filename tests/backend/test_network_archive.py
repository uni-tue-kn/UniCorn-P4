import hashlib
import io
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import Mock
import zipfile

import grpc
from google.protobuf import json_format, text_format
import pytest

from api import network_archive as bundle
from controller.managers.QueueManager import QueueManager
from controller.p4.tmp import p4config_pb2
from controller.p4.v1 import p4runtime_pb2 as pb
from controller.utils.helper import P4InfoHelper


def rpc_error(code, message='target read unavailable'):
    error = grpc.RpcError()
    error.code, error.details = lambda: code, lambda: message
    return error


@pytest.fixture(autouse=True)
def isolated_staging():
    for stage in bundle._STAGES.values():
        stage['directory'].cleanup()
    bundle._STAGES.clear()
    bundle._RESULTS.clear()
    yield
    for stage in bundle._STAGES.values():
        stage['directory'].cleanup()
    bundle._STAGES.clear()
    bundle._RESULTS.clear()


@pytest.fixture
def snapshot(switch, tmp_path, monkeypatch):
    root = tmp_path / 'p4'
    source = root / 'lesson/basic.p4'
    source.parent.mkdir(parents=True)
    source.write_text('#include <core.p4>\n#include "../common/types.h"\n// main source\n')
    (root / 'common').mkdir()
    (root / 'common/types.h').write_text('// private include required by active source\n')
    (root / 'unrelated-secret.env').write_text('NEVER_EXPORT=secret')
    (root / 'private.pcap').write_bytes(b'private')
    program = {'parsers': [], 'deparsers': [], 'actions': [], 'pipelines': []}
    compiled = source.with_suffix('.json')
    compiled.write_text(json.dumps(program))
    monkeypatch.setenv('P4_DIR', str(root))
    monkeypatch.setenv('TOPO_DIR', str(tmp_path / 'topologies'))
    switch.config = {'name': 's1', 'address': '127.0.0.1:50051', 'device_id': 0,
        'proto_dump_file': '/private/logs.txt', 'register_adapter_enabled': False,
        'register_thrift_host': '127.0.0.1', 'register_thrift_port': 9090}
    switch.bmv2_file = str(compiled)
    switch.p4_file = str(source.with_name('basic.p4info.txt'))
    info = switch.p4_helper.p4info
    direct_counter = info.direct_counters.add(direct_table_id=0x02000001)
    direct_counter.preamble.id, direct_counter.preamble.name = 0x13000001, 'Ingress.directCounter'
    digest = info.digests.add()
    digest.preamble.id, digest.preamble.name = 0x17000001, 'learn'
    digest.type_spec.bitstring.bit.bitwidth = 48
    Path(switch.p4_file).write_text(text_format.MessageToString(info))
    response = pb.GetForwardingPipelineConfigResponse()
    response.config.p4info.CopyFrom(info)
    response.config.p4_device_config = p4config_pb2.P4DeviceConfig(device_data=compiled.read_bytes()).SerializeToString()
    switch.bmv2.client_stub.GetForwardingPipelineConfig.return_value = response
    table = pb.Entity()
    table.table_entry.CopyFrom(switch.p4_helper.buildTableEntry('Ingress.table', {'key': 1}, action_name='Ingress.send', action_params={'port': 2}))
    default = pb.Entity()
    default.table_entry.CopyFrom(switch.p4_helper.buildTableEntry('Ingress.table', default_action=True, action_name='Ingress.send', action_params={'port': 2}))
    def read(selectors):
        result = pb.ReadResponse()
        for selector in selectors:
            kind = selector.WhichOneof('entity')
            actual = pb.Entity.FromString(selector.SerializeToString())
            if kind == 'table_entry':
                result.entities.add().CopyFrom(default if selector.table_entry.is_default_action else table)
                continue
            if kind in ('direct_meter_entry', 'direct_counter_entry'):
                for row in (table, default):
                    entry = getattr(result.entities.add(), kind)
                    entry.table_entry.CopyFrom(row.table_entry)
                    entry.table_entry.ClearField('action')
                    if kind == 'direct_meter_entry':
                        entry.config.CopyFrom(pb.MeterConfig(cir=10, cburst=2, pir=20, pburst=4))
                    else:
                        entry.data.packet_count = 9007199254740993
                continue
            if kind == 'register_entry':
                actual.register_entry.data.bitstring = b'\xff' * 8 if actual.register_entry.register_id == 0x16000001 else b'\xff'
            elif kind == 'counter_entry':
                actual.counter_entry.data.packet_count = 9007199254740993
            elif kind == 'meter_entry':
                actual.meter_entry.config.CopyFrom(pb.MeterConfig(cir=100, cburst=10, pir=200, pburst=20))
            elif kind == 'digest_entry':
                actual.digest_entry.config.max_list_size = 1
            elif kind == 'packet_replication_engine_entry':
                pre = actual.packet_replication_engine_entry
                if pre.WhichOneof('type') == 'multicast_group_entry':
                    pre.multicast_group_entry.multicast_group_id = 17
                    pre.multicast_group_entry.replicas.add(egress_port=2)
                else:
                    pre.clone_session_entry.session_id = 7
                    pre.clone_session_entry.replicas.add(egress_port=3)
            result.entities.add().CopyFrom(actual)
        return iter([result])
    switch.bmv2.ReadEntities.side_effect = read
    queues = QueueManager.for_switch(switch)
    queues.history = [{'port': 2, 'rate_pps': '200', 'applied_at': '2026-10-31T00:00:00Z'}]
    queues.defaults = {'depth_packets': 8, 'rate_pps': '100'}
    queues.known_ports = {2}
    queues.overrides = {2: {'rate_pps': '200'}}
    running = {'file_name': '/topologies/current.json', 'hosts': ['h1'], 'switches': {'s1': {}},
        'links': [{'node1': 'h1', 'node2': 's1', 'latency': '2ms', 'bandwidth': 100}],
        'ext_intfs': [], 'layout': {'h1': {'x': 10, 'y': 20}, 's1': {'x': 100, 'y': 200}}}
    mappings = [{'name': 's1', 'dev_id': 0, 'grpc_port': 50051, 'thrift_port': 9090}]
    def netsim(route, body=None, timeout=5):
        assert body is None
        return running if route == '/topology/get' else {'switches_online': mappings}
    monkeypatch.setattr(bundle, 'netsim_request', netsim)
    controller = SimpleNamespace(switch_configs={0: switch})
    return SimpleNamespace(switch=switch, controller=controller, root=root, program=program, running=running,
                           mappings=mappings, read=read)


def archive_files(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def rewrite(raw, modify):
    files = archive_files(raw)
    manifest = json.loads(files['manifest.json'])
    modify(files, manifest)
    manifest['files'] = {name: hashlib.sha256(content).hexdigest() for name, content in files.items() if name != 'manifest.json'}
    files['manifest.json'] = bundle.json_bytes(manifest)
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return result.getvalue()


def test_export_is_self_contained_and_only_includes_active_source_closure(snapshot):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    files = archive_files(raw)
    assert set(files) == {'manifest.json', 'topology.json', 'programs/switch-0/lesson/basic.p4',
        'programs/switch-0/lesson/basic.json', 'programs/switch-0/lesson/basic.p4info.txt',
        'programs/switch-0/common/types.h', 'state/switch-0.json'}
    assert b'NEVER_EXPORT' not in raw
    manifest = json.loads(files['manifest.json'])
    assert manifest['format_version'] == 1
    assert manifest['switches'][0]['kind'] == 'emulated'
    assert manifest['switches'][0]['config']['proto_dump_file'] is None
    topology = json.loads(files['topology.json'])
    assert topology['links'] == [['h1', 's1', '2ms', 100]]
    assert topology['layout']['s1'] == {'x': 100, 'y': 200}
    state = json.loads(files['state/switch-0.json'])
    assert state['entities']['registers'][0]['register_entry']['data']['bitstring'] == '//////////8='
    assert state['entities']['counters'][0]['counter_entry']['data']['packet_count'] == '9007199254740993'
    assert state['queues']['readback_available'] is False
    assert state['queues']['last_applied'][0]['rate_pps'] == '200'
    validated = bundle.validate_archive(raw)
    assert len(validated['switches'][0]['entities']['tables']) == 2


def test_export_marks_unavailable_categories_without_fabricating_values(snapshot):
    def read(selectors):
        if selectors[0].WhichOneof('entity') == 'register_entry':
            raise rpc_error(grpc.StatusCode.UNIMPLEMENTED, 'Registers unsupported on external target')
        if selectors[0].WhichOneof('entity') == 'digest_entry':
            raise rpc_error(grpc.StatusCode.NOT_FOUND, 'Digest not configured')
        return snapshot.read(selectors)
    snapshot.switch.bmv2.ReadEntities.side_effect = read
    raw = bundle.build_archive(snapshot.controller).getvalue()
    validated = bundle.validate_archive(raw)
    record = validated['switches'][0]['record']
    assert record['runtime']['categories']['registers']['status'] == 'unavailable'
    assert record['runtime']['categories']['registers']['count'] == 0
    assert record['runtime']['categories']['digests'] == {'status': 'ok', 'count': 0, 'errors': []}
    assert validated['switches'][0]['entities']['registers'] == []


def test_adopted_external_pipeline_exports_compiled_files_without_claiming_source(snapshot):
    snapshot.switch.bmv2_file = None
    snapshot.switch.p4_file = None
    snapshot.switch.config['address'] = 'external.example:9559'
    record = bundle.validate_archive(bundle.build_archive(snapshot.controller).getvalue())['switches'][0]['record']
    assert record['kind'] == 'external'
    assert record['pipeline']['source'] is None
    assert record['pipeline']['bmv2'] == 'programs/switch-0/program.json'
    assert any('source is unknown' in message for message in record['warnings'])


@pytest.mark.parametrize('name', ['../escape.p4', '/absolute.p4', 'programs/../escape.p4', 'programs\\escape.p4', 'C:/escape.p4'])
def test_zip_path_traversal_is_rejected_without_staging(snapshot, name):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    altered = rewrite(raw, lambda files, manifest: files.update({name: b'attack'}))
    with pytest.raises(ValueError, match='path|Archive|Unexpected'):
        bundle.stage_import(altered)
    assert bundle._STAGES == {}


def test_archive_rejects_symlinks_duplicates_checksum_mismatch_and_decompression_limits(snapshot, monkeypatch):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    files = archive_files(raw)
    for mode in ('symlink', 'duplicate', 'checksum'):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name, content in files.items():
                info = zipfile.ZipInfo(name)
                if mode == 'symlink' and name.endswith('types.h'):
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, content + b'x' if mode == 'checksum' and name.endswith('types.h') else content)
            if mode == 'duplicate':
                with pytest.warns(UserWarning):
                    archive.writestr('manifest.json', files['manifest.json'])
        with pytest.raises(ValueError):
            bundle.validate_archive(output.getvalue())
    monkeypatch.setattr(bundle, 'MAX_TOTAL', 100)
    with pytest.raises(ValueError, match='uncompressed-size'):
        bundle.validate_archive(raw)


def test_preflight_validates_pipeline_and_runtime_dependencies_before_mutation(snapshot):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    def missing_table(files, manifest):
        state = json.loads(files['state/switch-0.json'])
        state['entities']['tables'][0]['table_entry']['table_id'] = 999
        files['state/switch-0.json'] = bundle.json_bytes(state)
    with pytest.raises(ValueError, match='unknown tables'):
        bundle.stage_import(rewrite(raw, missing_table))
    def missing_parent(files, manifest):
        state = json.loads(files['state/switch-0.json'])
        state['entities']['tables'] = []
        manifest['switches'][0]['runtime']['categories']['tables']['count'] = 0
        files['state/switch-0.json'] = bundle.json_bytes(state)
    with pytest.raises(ValueError, match='Direct resource references'):
        bundle.stage_import(rewrite(raw, missing_parent))
    assert bundle._STAGES == {}


def test_stage_preview_is_read_only_and_expires_with_bounded_capacity(snapshot, monkeypatch):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    monkeypatch.setattr(bundle, 'MAX_STAGED', 1)
    result = bundle.stage_import(raw)
    assert result['preview']['switches'][0]['runtime']['tables']['count'] == 2
    assert result['preview']['switches'][0]['pipeline'] is True
    assert result['preview']['topology']['layout']['s1']['x'] == 100
    with pytest.raises(ValueError, match='Too many staged'):
        bundle.stage_import(raw)
    stage = bundle._STAGES[result['import_token']]
    directory = Path(stage['directory'].name)
    stage['expires'] = 0
    bundle._cleanup_stages()
    assert not directory.exists()
    with pytest.raises(KeyError, match='unknown or expired'):
        bundle.deploy_import(Mock(), None, {'import_token': result['import_token']})


class Destination:
    def __init__(self):
        self.switch_configs, self.calls = {}, []

    def deleteAllSwitchConnections(self):
        self.calls.append(('disconnect',))
        self.switch_configs.clear()

    def addSwitchConnection(self, config):
        self.calls.append(('connect', config))
        owner = self
        class Manager:
            def __init__(self):
                self.id, self.config, self.db_id = config['device_id'], config, -1
                self.bmv2 = Mock()
                self.bmv2.WriteEntity.side_effect = lambda entity, kind: owner.calls.append(('write', entity, kind))

            def initialize(self, p4info, bmv2, keep_entries=False):
                owner.calls.append(('pipeline', p4info, bmv2, keep_entries))
                self.p4_file, self.bmv2_file = p4info, bmv2
                self.p4_helper = P4InfoHelper(p4_info_filepath=p4info)
                assert json.loads(Path(bmv2).read_text())['pipelines'] == []
        self.switch_configs[config['device_id']] = Manager()

    def getInitialDecoding(self, device_id, p4info):
        return self.switch_configs[device_id].p4_helper.get_table_decoding()


def test_deploy_discovers_actual_ids_restores_in_order_and_token_retry_is_idempotent(snapshot, monkeypatch):
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    destination = Destination()
    requests = []
    def netsim(route, body=None, timeout=5):
        requests.append((route, body))
        assert route == '/topology/load'
        return dict(snapshot.running, file_name=body['topology_file'], switches_online=[
            {'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}])
    monkeypatch.setattr(bundle, 'netsim_request', netsim)
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token']})
    assert result['status'] == 'complete'
    assert destination.calls[0] == ('disconnect',)
    config = destination.calls[1][1]
    assert config['device_id'] == 42
    assert config['address'] == '127.0.0.1:55099'
    assert config['register_thrift_port'] == 9191
    assert config['register_adapter_enabled'] is False
    writes = [(entry.WhichOneof('entity'), kind) for action, *rest in destination.calls if action == 'write' for entry, kind in [rest]]
    assert writes[0] == ('table_entry', pb.Update.INSERT)
    assert writes[1] == ('table_entry', pb.Update.MODIFY)
    assert writes[-1] == ('digest_entry', pb.Update.INSERT)
    counter = next(entity.counter_entry for action, *rest in destination.calls if action == 'write' for entity, _ in [rest] if entity.WhichOneof('entity') == 'counter_entry')
    assert counter.data.packet_count == 9007199254740993
    count = len(destination.calls)
    assert bundle.deploy_import(destination, None, {'import_token': staged['import_token']}) == result
    assert len(destination.calls) == count
    assert len(requests) == 1
    assert Path(result['topology_file']).is_file()
    assert Path(result['imported_project']).is_relative_to(snapshot.root)
    assert result['switches'][0]['categories']['queues']['status'] == 'skipped'


def test_external_targets_are_never_contacted_from_archive_without_explicit_mapping(snapshot, monkeypatch):
    snapshot.switch.config['address'] = 'archive-host.example:50051'
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    destination = Destination()
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 1, 'grpc_port': 50052, 'thrift_port': 9091}]))
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token']})
    assert all(call[0] != 'connect' for call in destination.calls)
    assert result['switches'][0]['status'] == 'skipped'
    assert any('addresses were not contacted' in message for message in result['warnings'])


def test_deploy_partial_failures_are_reported_and_do_not_repeat_on_retry(snapshot, monkeypatch):
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    destination = Destination()
    monkeypatch.setattr(bundle, 'netsim_request', Mock(side_effect=OSError('Emulator unavailable')))
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token']})
    assert result['status'] == 'partial'
    assert 'Emulator unavailable' in result['error']
    assert bundle.deploy_import(destination, None, {'import_token': staged['import_token']}) == result
    assert destination.calls == [('disconnect',)]


def test_import_export_http_contract_uses_download_and_staged_multipart_preview(client, snapshot):
    response = client.get('/network/export')
    assert response.status_code == 200
    assert response.mimetype == 'application/zip'
    assert 'attachment' in response.headers['Content-Disposition']
    imported = client.post('/network/import', data={'file': (io.BytesIO(response.data), 'network.zip')})
    assert imported.status_code == 200
    assert imported.json['preview']['switches'][0]['name'] == 's1'
    assert imported.json['import_token']
    assert client.post('/network/import/deploy', json={'import_token': 'unknown'}).status_code == 404
    assert client.post('/network/import', data={}).status_code == 400


def test_queue_replay_uses_complete_known_summary_defaults_then_ports_not_rolling_history(snapshot, monkeypatch):
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    destination, applied = Destination(), []
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}]))
    monkeypatch.setattr(QueueManager, 'write', lambda manager, settings: applied.append(settings))
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token'], 'restore_queues': True})
    assert applied == [{'port': None, 'depth_packets': 8, 'rate_pps': '100'},
                       {'port': 2, 'depth_packets': 8, 'rate_pps': '200'}]
    assert result['switches'][0]['categories']['queues']['restored'] == 2
    assert result['switches'][0]['categories']['queues']['readback_available'] is False
    assert staged['preview']['switches'][0]['runtime']['queues']['count'] == 2


@pytest.mark.parametrize('attach', [False, True])
def test_physical_interface_attachments_require_explicit_deployment_option(snapshot, monkeypatch, attach):
    snapshot.running['ext_intfs'] = [{'switch': 's1', 'interface': 'eth9'}]
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 1, 'grpc_port': 50051, 'thrift_port': 9090}]))
    result = bundle.deploy_import(Destination(), None, {'import_token': staged['import_token'], 'attach_external_interfaces': attach})
    topology = json.loads(Path(result['topology_file']).read_text())
    assert topology['ext_intfs'] == ([['s1', 'eth9']] if attach else [])


def test_external_restore_requires_explicit_mapping_and_uses_only_supplied_destination(snapshot, monkeypatch):
    snapshot.switch.config['address'] = 'untrusted-archive.example:9559'
    raw = bundle.build_archive(snapshot.controller).getvalue()
    def remove_topology(files, manifest):
        manifest['topology'] = None
        files.pop('topology.json')
    staged = bundle.stage_import(rewrite(raw, remove_topology))
    destination = Destination()
    network = Mock()
    monkeypatch.setattr(bundle, 'netsim_request', network)
    with pytest.raises(ValueError, match='restore_external'):
        bundle.deploy_import(destination, None, {'import_token': staged['import_token'],
            'external_targets': {'switch-0': {'address': 'explicit.example:50052', 'device_id': 7}}})
    with pytest.raises(ValueError, match='protocol-log'):
        bundle.deploy_import(destination, None, {'import_token': staged['import_token'], 'restore_external': True,
            'external_targets': {'switch-0': {'address': 'explicit.example:50052', 'device_id': 7, 'proto_dump_file': '/private/log'}}})
    assert destination.calls == []
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token'], 'restore_external': True,
        'external_targets': {'switch-0': {'address': 'explicit.example:50052', 'device_id': 7, 'proto_dump_file': None}}})
    network.assert_not_called()
    connection = next(call[1] for call in destination.calls if call[0] == 'connect')
    assert connection['address'] == 'explicit.example:50052'
    assert connection['device_id'] == 7
    assert connection['register_thrift_host'] is None
    assert not connection['register_adapter_enabled']
    assert result['switches'][0]['name'] == 's1'


def test_modified_stage_is_rejected_before_project_write_or_network_mutation(snapshot):
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    directory = Path(bundle._STAGES[staged['import_token']]['directory'].name)
    (directory / 'programs/switch-0/lesson/basic.json').write_text('tampered')
    controller = Destination()
    result = bundle.deploy_import(controller, None, {'import_token': staged['import_token']})
    assert result['status'] == 'partial'
    assert 'changed after validation' in result['error']
    assert result['imported_project'] is None
    assert controller.calls == []


def test_register_read_limit_produces_explicit_partial_valid_archive(snapshot, monkeypatch):
    # The cap applies across categories and leaves a valid importable snapshot.
    monkeypatch.setattr(bundle, 'MAX_ENTITIES', 20)
    raw = bundle.build_archive(snapshot.controller).getvalue()
    validated = bundle.validate_archive(raw)
    record = validated['switches'][0]['record']
    assert sum(len(rows) for rows in validated['switches'][0]['entities'].values()) == 20
    assert any(status['status'] != 'ok' for status in record['runtime']['categories'].values())


def test_source_outside_closure_is_reported_without_exporting_or_requiring_private_file(snapshot, tmp_path):
    private = tmp_path / 'private.h'
    private.write_text('DO_NOT_INCLUDE')
    source = snapshot.root / 'lesson/basic.p4'
    source.write_text('#include "../../private.h"\n')
    raw = bundle.build_archive(snapshot.controller).getvalue()
    validated = bundle.validate_archive(raw)
    record = validated['switches'][0]['record']
    assert record['pipeline']['source'] is None
    assert not any(name.endswith('.p4') for name in validated['files'])
    assert any('outside' in warning or 'not portable' in warning for warning in record['warnings'])


def test_unavailable_parent_tables_omit_dependent_direct_resources_with_explicit_notes(snapshot):
    def read(selectors):
        if selectors[0].WhichOneof('entity') == 'table_entry':
            raise rpc_error(grpc.StatusCode.UNIMPLEMENTED, 'Table read is unsupported')
        return snapshot.read(selectors)
    snapshot.switch.bmv2.ReadEntities.side_effect = read
    validated = bundle.validate_archive(bundle.build_archive(snapshot.controller).getvalue())
    record, entities = validated['switches'][0]['record'], validated['switches'][0]['entities']
    assert entities['tables'] == []
    assert entities['direct_meters'] == []
    assert entities['direct_counters'] == []
    assert record['runtime']['categories']['direct_meters']['status'] == 'partial'
    assert 'parent table entry' in record['runtime']['categories']['direct_meters']['errors'][0]


def test_deploy_persists_new_connection_and_local_history_without_copying_original_database(app, snapshot, monkeypatch):
    from api.database import db
    from api.database.SwitchConfigs import SwitchConfigs
    from api.database.TableStates import TableStates
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    destination = Destination()
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}]))
    with app.app_context():
        result = bundle.deploy_import(destination, db, {'import_token': staged['import_token']})
        assert result['status'] == 'complete'
        assert SwitchConfigs.query.count() == 1
        row = SwitchConfigs.query.one()
        assert row.device_id == 42 and row.address == '127.0.0.1:55099'
        history = TableStates.query.one()
        assert history.name == 'Imported network'
        assert history.switch_config_id == row.id
        assert len(history.table_entries['Ingress.table']) == 1
        assert history.table_entries['Ingress.table'][0]['switch_entry']['match_fields'] == {'key': 1}
        assert destination.switch_configs[42].state_id == history.id


def test_padded_direct_resource_keys_match_shorter_table_keys_without_guessing(snapshot):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    def pad(files, manifest):
        state = json.loads(files['state/switch-0.json'])
        entity = json_format.ParseDict(state['entities']['direct_meters'][0], pb.Entity())
        entity.direct_meter_entry.table_entry.match[0].exact.value = b'\x00\x00\x01'
        state['entities']['direct_meters'][0] = json_format.MessageToDict(entity, preserving_proto_field_name=True)
        files['state/switch-0.json'] = bundle.json_bytes(state)
    validated = bundle.validate_archive(rewrite(raw, pad))
    entities = validated['switches'][0]['entities']
    assert bundle.table_key(entities['tables'][0].table_entry) == bundle.table_key(entities['direct_meters'][0].direct_meter_entry.table_entry)


def test_action_profile_dependencies_are_exported_and_restored_before_indirect_tables(snapshot, monkeypatch):
    info = snapshot.switch.p4_helper.p4info
    profile = info.action_profiles.add(size=8, with_selector=True, max_group_size=8)
    profile.preamble.id, profile.preamble.name = 0x11000001, 'Ingress.selector'
    profile.table_ids.append(0x02000001)
    info.tables[0].implementation_id = profile.preamble.id
    snapshot.switch.bmv2.client_stub.GetForwardingPipelineConfig.return_value.config.p4info.CopyFrom(info)
    member = pb.Entity()
    member.action_profile_member.action_profile_id = profile.preamble.id
    member.action_profile_member.member_id = 1
    member.action_profile_member.action.action_id = 0x01000001
    member.action_profile_member.action.params.add(param_id=1, value=b'\x02')
    group = pb.Entity()
    group.action_profile_group.action_profile_id, group.action_profile_group.group_id = profile.preamble.id, 2
    group.action_profile_group.members.add(member_id=1, weight=1)
    def read(selectors):
        kind = selectors[0].WhichOneof('entity')
        if kind in ('action_profile_member', 'action_profile_group'):
            response = pb.ReadResponse()
            response.entities.add().CopyFrom(member if kind == 'action_profile_member' else group)
            return iter([response])
        responses = list(snapshot.read(selectors))
        if kind == 'table_entry' and not selectors[0].table_entry.is_default_action:
            responses[0].entities[0].table_entry.action.Clear()
            responses[0].entities[0].table_entry.action.action_profile_group_id = 2
        return iter(responses)
    snapshot.switch.bmv2.ReadEntities.side_effect = read
    raw = bundle.build_archive(snapshot.controller).getvalue()
    staged = bundle.stage_import(raw)
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}]))
    destination = Destination()
    result = bundle.deploy_import(destination, None, {'import_token': staged['import_token']})
    assert result['status'] == 'complete'
    kinds = [rest[0].WhichOneof('entity') for action, *rest in destination.calls if action == 'write']
    assert kinds[:3] == ['action_profile_member', 'action_profile_group', 'table_entry']
    def missing_member(files, manifest):
        state = json.loads(files['state/switch-0.json'])
        state['entities']['action_profile_members'] = []
        manifest['switches'][0]['runtime']['categories']['action_profile_members']['count'] = 0
        files['state/switch-0.json'] = bundle.json_bytes(state)
    with pytest.raises(ValueError, match='missing member'):
        bundle.validate_archive(rewrite(raw, missing_member))


def test_preflight_rejects_register_type_value_mismatch_before_any_stage(snapshot):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    def invalid_value(files, manifest):
        state = json.loads(files['state/switch-0.json'])
        row = state['entities']['registers'][0]['register_entry']
        row['data'] = {'bitstring': 'AQAAAAAAAAAAAA=='}  # wider than bit<64>
        files['state/switch-0.json'] = bundle.json_bytes(state)
    with pytest.raises(ValueError, match='Register value is outside'):
        bundle.stage_import(rewrite(raw, invalid_value))
    assert bundle._STAGES == {}


def test_http_upload_limit_is_applied_before_multipart_spooling(client):
    response = client.post('/network/import', data={}, environ_overrides={'CONTENT_LENGTH': str(bundle.MAX_ARCHIVE + 2 * 1024 * 1024),
                                                                       'CONTENT_TYPE': 'multipart/form-data; boundary=large'})
    assert response.status_code == 413
    assert 'request limit' in response.json['error']
    assert bundle._STAGES == {}


def test_completed_imports_free_staging_payload_capacity_and_keep_only_bounded_retry_results(snapshot, monkeypatch):
    raw = bundle.build_archive(snapshot.controller).getvalue()
    destination = Destination()
    monkeypatch.setattr(bundle, 'MAX_STAGED', 1)
    monkeypatch.setattr(bundle, 'MAX_COMPLETED', 4)
    service = Mock(return_value=dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}]))
    monkeypatch.setattr(bundle, 'netsim_request', service)
    tokens, results = [], []
    for _ in range(5):
        staged = bundle.stage_import(raw)
        token = staged['import_token']
        stage = bundle._STAGES[token]
        temporary = Path(stage['directory'].name)
        tokens.append(token)
        results.append(bundle.deploy_import(destination, None, {'import_token': token}))
        assert not temporary.exists()
        assert not bundle._STAGES
        assert stage == {}  # No file bytes, entity objects, or tempdir retained.
        assert len(bundle._RESULTS) <= 4
    assert service.call_count == 5
    assert tokens[0] not in bundle._RESULTS
    assert bundle.deploy_import(destination, None, {'import_token': tokens[-1]}) == results[-1]
    assert service.call_count == 5
    bundle._RESULTS[tokens[-1]]['expires'] = 0
    bundle._cleanup_stages()
    with pytest.raises(KeyError, match='unknown or expired'):
        bundle.deploy_import(destination, None, {'import_token': tokens[-1]})


def test_partial_restore_reports_total_failures_with_bounded_diagnostic_payload(snapshot, monkeypatch):
    staged = bundle.stage_import(bundle.build_archive(snapshot.controller).getvalue())
    monkeypatch.setattr(bundle, 'MAX_REPORT_ERRORS', 2)
    monkeypatch.setattr(bundle, 'netsim_request', lambda *args, **kwargs: dict(snapshot.running,
        switches_online=[{'name': 's1', 'dev_id': 42, 'grpc_port': 55099, 'thrift_port': 9191}]))
    original = bundle._restore_entity
    def restore(manager, entity, category, info):
        if category == 'registers':
            raise RuntimeError('Target rejected register write')
        return original(manager, entity, category, info)
    monkeypatch.setattr(bundle, '_restore_entity', restore)
    result = bundle.deploy_import(Destination(), None, {'import_token': staged['import_token']})
    status = result['switches'][0]['categories']['registers']
    assert result['status'] == 'partial'
    assert status['failed'] == 16 and status['restored'] == 0
    assert len(status['errors']) == 2
    assert result['switches'][0]['categories']['meters']['restored'] == 8
    assert bundle._STAGES == {}
