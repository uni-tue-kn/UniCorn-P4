"""Native target additions preserve the existing bounded archive workflow."""
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import zipfile

from google.protobuf import json_format
import pytest

from api import network_archive as archive
from api.program_builds import validate_bundle
from controller.controller import Controller
from controller.targets.bfrt_metadata import fields, encode_fields
from controller.targets.bfrt_proto import bfruntime_pb2 as pb
from controller.targets.tofino import TofinoTarget
from test_bfrt_targets import MemoryBfRt, native


@pytest.fixture
def snapshot(native, tmp_path, monkeypatch):
    root = tmp_path / 'p4'
    directory = root / '.unicorn-builds' / 'example'
    directory.mkdir(parents=True)
    (directory / 'bf-rt.json').write_text(json.dumps(native.p4_helper.raw))
    (directory / 'context.json').write_text('{}')
    (directory / 'tofino.bin').write_bytes(b'native-compiled-binary')
    (directory / 'source').mkdir()
    (directory / 'source' / 'example.p4').write_text('#include <tna.p4>\n// source snapshot\n')
    manifest = {'target': 'tofino', 'program_name': 'sample', 'source': str(root / 'example.p4'),
                'bfrt_json': 'bf-rt.json', 'profiles': [{'profile_name': 'pipe', 'context': 'context.json', 'binary': 'tofino.bin', 'pipe_scope': [0]}]}
    path = directory / 'manifest.json'
    path.write_text(json.dumps(manifest))
    native.program_manifest = str(path)
    native.bundle = dict(manifest, manifest_path=str(path))
    native.client = MemoryBfRt()
    entry = native.create_table_entry({'table_name': 'pipe.Ingress.forwarding', 'match_fields': {'intrinsic.ingress_port': '0'},
                                      'action_name': 'Ingress.forward', 'action_params': {'port': '1', 'index': '0'}, 'priority': None}, False)
    native.client.write([entry.entry], pb.Update.INSERT)
    table = native.p4_helper.table('pipe.Ingress.packet_register')
    register = native.resources.indexed_entry(table, 0)
    register.data.fields.extend(encode_fields(fields(table['data']), {'Ingress.packet_register.f1': '4294967295'}))
    native.client.write([register], pb.Update.INSERT)
    monkeypatch.setenv('P4_DIR', str(root))
    monkeypatch.setenv('TOPO_DIR', str(tmp_path / 'topologies'))
    monkeypatch.setattr(archive, 'netsim_request', Mock(side_effect=OSError('No emulator topology')))
    yield SimpleNamespace(switch=native, root=root, controller=SimpleNamespace(switch_configs={17: native}))
    for stage in archive._STAGES.values(): stage['directory'].cleanup()
    archive._STAGES.clear()
    archive._RESULTS.clear()


def rewrite(raw, edit):
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        files = {name: zipped.read(name) for name in zipped.namelist()}
    manifest = json.loads(files.pop('manifest.json'))
    edit(files, manifest)
    manifest['files'] = {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr('manifest.json', archive.json_bytes(manifest))
        for name, value in files.items(): zipped.writestr(name, value)
    return result.getvalue()


def test_native_archive_contains_portable_build_and_exact_typed_state(snapshot):
    raw = archive.build_archive(snapshot.controller).getvalue()
    validated = archive.validate_archive(raw)
    record = validated['manifest']['switches'][0]
    assert record['config']['target'] == 'tofino'
    assert record['pipeline'] == {'target': 'tofino', 'manifest': 'programs/switch-17/manifest.json', 'source': 'programs/switch-17/source/example.p4'}
    assert validated['files']['programs/switch-17/profile-0/tofino.bin'] == b'native-compiled-binary'
    state = validated['switches'][0]['state']
    assert state['scope']['aggregation'] == 'none'
    register = validated['switches'][0]['entities']['registers'][0]
    assert int.from_bytes(register.data.fields[0].stream, 'big') == 4294967295
    assert not register.HasField('entry_tgt')
    assert record['runtime']['categories']['digests']['status'] == 'unavailable'
    assert record['runtime']['categories']['queues']['readback_available'] is True
    assert 'bmv2' not in record['pipeline']
    assert b'native-compiled-binary' not in raw  # ZIP compression is in use.


def test_tofino2_archive_preserves_generation_and_binary_name(snapshot):
    directory = Path(snapshot.switch.program_manifest).parent
    (directory / 'tofino.bin').rename(directory / 'tofino2.bin')
    manifest = json.loads((directory / 'manifest.json').read_text())
    manifest['architecture'] = 'tofino2'
    manifest['profiles'][0]['binary'] = 'tofino2.bin'
    (directory / 'manifest.json').write_text(json.dumps(manifest))
    snapshot.switch.bundle = dict(manifest, manifest_path=snapshot.switch.program_manifest)
    snapshot.switch.config.setdefault('target_options', {})['architecture'] = 'tofino2'

    validated = archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())
    record = validated['manifest']['switches'][0]
    portable = json.loads(validated['files'][record['pipeline']['manifest']])
    assert portable['architecture'] == 'tofino2'
    assert portable['profiles'][0]['binary'] == 'profile-0/tofino2.bin'
    assert validated['files']['programs/switch-17/profile-0/tofino2.bin'] == b'native-compiled-binary'

    staged = archive.stage_import(archive.build_archive(snapshot.controller).getvalue())
    assert staged['preview']['switches'][0]['target_options']['architecture'] == 'tofino2'


@pytest.mark.parametrize('mismatch', ['connection', 'pipeline'])
def test_native_archive_rejects_generation_mismatch_before_staging(snapshot, mismatch):
    raw = archive.build_archive(snapshot.controller).getvalue()
    def edit(files, manifest):
        if mismatch == 'connection':
            manifest['switches'][0]['config']['target_options']['architecture'] = 'tofino2'
        else:
            portable = json.loads(files['programs/switch-17/manifest.json'])
            portable['architecture'] = 'tofino2'
            files['programs/switch-17/manifest.json'] = archive.json_bytes(portable)
    with pytest.raises(ValueError, match='generation does not match'):
        archive.stage_import(rewrite(raw, edit))
    assert not archive._STAGES


@pytest.mark.parametrize('all_readonly', [False, True])
def test_native_archive_omits_readonly_register_fields_from_replay(snapshot, all_readonly):
    table = snapshot.switch.p4_helper.table('pipe.Ingress.packet_register')
    table['data'].append({'singleton': {'id': 2, 'name': 'status', 'read_only': True,
                                       'type': {'type': 'uint32'}}})
    if all_readonly:
        table['data'][0]['read_only'] = True
    metadata = Path(snapshot.switch.program_manifest).parent / 'bf-rt.json'
    metadata.write_text(json.dumps(snapshot.switch.p4_helper.raw))
    for entry in snapshot.switch.client.entries.values():
        if entry.table_id == table['id']:
            entry.data.fields.add(field_id=2, stream=(8).to_bytes(4, 'big'))
    validated = archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())
    registers = validated['switches'][0]['entities']['registers']
    if all_readonly:
        assert registers == []
    else:
        assert [field.field_id for field in registers[0].data.fields] == [1]
    status = validated['manifest']['switches'][0]['runtime']['categories']['registers']
    assert status['status'] == ('unavailable' if all_readonly else 'partial')
    assert status['count'] == len(registers)
    assert any('read only' in error for error in status['errors'])


def test_native_archive_preserves_source_with_quoted_sdk_headers(snapshot):
    source = Path(snapshot.switch.program_manifest).parent / 'source/example.p4'
    source.write_text('#include "core.p4"\n#include "tna.p4"\n')
    validated = archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())
    archived_source = validated['manifest']['switches'][0]['pipeline']['source']
    assert archived_source is not None
    assert validated['files'][archived_source] == source.read_bytes()


def test_native_external_mapping_requires_same_target_before_any_mutation(snapshot):
    staged = archive.stage_import(archive.build_archive(snapshot.controller).getvalue())
    destination = Mock()
    with pytest.raises(ValueError, match='match the archived switch target'):
        archive.deploy_import(destination, None, {'import_token': staged['import_token'], 'restore_external': True,
            'external_targets': {'switch-17': {'address': '127.0.0.1:50051', 'device_id': 5}}})
    destination.deleteAllSwitchConnections.assert_not_called()
    destination.addSwitchConnection.assert_not_called()
    assert not list(snapshot.root.glob('imported-network-*'))


@pytest.mark.parametrize('corrupt', ['path', 'index', 'width', 'scope', 'category'])
def test_native_validation_rejects_bad_artifacts_and_values_before_staging(snapshot, corrupt):
    raw = archive.build_archive(snapshot.controller).getvalue()
    def edit(files, manifest):
        if corrupt == 'path':
            value = json.loads(files['programs/switch-17/manifest.json'])
            value['profiles'][0]['binary'] = '/etc/passwd'
            files['programs/switch-17/manifest.json'] = archive.json_bytes(value)
        elif corrupt == 'width':
            state = json.loads(files['state/switch-17.json'])
            state['entities']['registers'][0]['data']['fields'][0]['stream'] = 'Af////8='
            files['state/switch-17.json'] = archive.json_bytes(state)
        else:
            state = json.loads(files['state/switch-17.json'])
            if corrupt == 'scope': state['scope']['aggregation'] = 'sum'
            elif corrupt == 'index': state['entities']['registers'][0]['key']['fields'][0]['exact']['value'] = 'AAABAA=='
            else: state['entities']['counters'] = state['entities']['registers']
            files['state/switch-17.json'] = archive.json_bytes(state)
    with pytest.raises(ValueError): archive.stage_import(rewrite(raw, edit))
    assert not archive._STAGES


def test_native_restore_uses_native_bundle_and_existing_staged_deploy_flow(snapshot, monkeypatch):
    staged = archive.stage_import(archive.build_archive(snapshot.controller).getvalue())
    destination = Controller()
    restored = []
    def connect(self):
        self.connected = True
        self.p4_helper = deepcopy(snapshot.switch.p4_helper)
        self.client = MemoryBfRt()
        for entry in snapshot.switch.client.entries.values():
            if self.p4_helper.table(entry.table_id).get('table_type') == 'Register':
                self.client.write([deepcopy(entry)], pb.Update.INSERT)
    def initialize(self, bundle, keep_entries=False):
        assert bundle['target'] == 'tofino'
        assert Path(bundle['profiles'][0]['binary']).read_bytes() == b'native-compiled-binary'
        self.program_manifest = bundle['manifest_path']
        restored.append(bundle)
    monkeypatch.setattr(TofinoTarget, 'connect', connect)
    monkeypatch.setattr(TofinoTarget, 'initialize_bundle', initialize)
    result = archive.deploy_import(destination, None, {'import_token': staged['import_token'], 'restore_external': True,
        'external_targets': {'switch-17': {'target': 'tofino', 'address': '127.0.0.1:50052', 'device_id': 22}}})
    assert result['switches'][0]['categories']['tables']['restored'] == 1
    assert result['switches'][0]['categories']['registers']['restored'] == 1
    assert restored[0]['manifest_path'].startswith(result['imported_project'])
    assert validate_bundle(restored[0]['manifest_path'])['program_name'] == 'sample'
    assert destination.switch_configs[22].client.device_id == 0
    second = archive.deploy_import(destination, None, {'import_token': staged['import_token']})
    assert second == result
    assert len(restored) == 1


def test_native_import_preview_preserves_destination_target_options(snapshot):
    preview = archive.stage_import(archive.build_archive(snapshot.controller).getvalue())['preview']['switches'][0]
    assert preview['kind'] == 'external'
    assert preview['target'] == 'tofino'
    assert preview['target_options'] == dict(snapshot.switch.config['target_options'], client_id=0)


def test_native_capture_requests_hardware_for_wildcard_table_and_direct_reads(snapshot):
    original = snapshot.switch.client.read
    selectors = []
    def read(entries):
        selectors.extend(deepcopy(entries))
        return original(entries)
    snapshot.switch.client.read = read
    archive.build_archive(snapshot.controller)
    match_ids = {table['id'] for table in snapshot.switch.p4_helper.match_tables()}
    wildcard = [entry for entry in selectors if entry.table_id in match_ids and not entry.HasField('key')]
    assert wildcard
    assert all(entry.table_flags.from_hw for entry in wildcard)


def test_native_archive_preserves_default_action_and_direct_meter(snapshot):
    switch = snapshot.switch
    table = switch.p4_helper.table('pipe.Ingress.forwarding')
    meter = {'$METER_SPEC_CIR_PPS': '10', '$METER_SPEC_PIR_PPS': '20',
             '$METER_SPEC_CBS_PKTS': '100', '$METER_SPEC_PBS_PKTS': '200'}
    table['data'] = [{'singleton': {'id': 65540 + index, 'name': name, 'type': {'type': 'uint64'}}}
                     for index, name in enumerate(meter)]
    for entry in switch.client.entries.values():
        if entry.table_id == table['id']:
            entry.data.fields.extend(encode_fields(fields(table['data']), meter))
    metadata = Path(switch.program_manifest).parent / 'bf-rt.json'
    metadata.write_text(json.dumps(switch.p4_helper.raw))
    default = switch.create_table_entry({'table_name': table['name'], 'is_default_action': True,
        'action_name': 'Ingress.forward', 'action_params': {'port': '7', 'index': '3'}}, False)
    default.entry.data.fields.extend(encode_fields(fields(table['data']), meter))
    switch.client.write([default.entry], pb.Update.INSERT)
    original = switch.client.read
    def read(selectors):
        # The real BF-RT wildcard omits defaults; they require an explicit read.
        return [entry for selector in selectors for entry in original([selector])
                if entry.is_default_entry == selector.is_default_entry]
    switch.client.read = read

    validated = archive.validate_archive(archive.build_archive(snapshot.controller).getvalue())
    entities = validated['switches'][0]['entities']
    defaults = [entry for entry in entities['tables'] if entry.is_default_entry]
    assert len(defaults) == 1
    assert defaults[0].data.action_id == default.entry.data.action_id
    assert list(defaults[0].data.fields) == list(default.entry.data.fields[:2])
    meters = [entry for entry in entities['direct_meters'] if entry.is_default_entry]
    assert len(meters) == 1
    assert meters[0].data == default.entry.data


def test_native_archive_history_persists_compiled_program_name(snapshot, app):
    from api.database import db
    from api.database.SwitchConfigs import SwitchConfigs
    from api.database.TableStates import TableStates
    with app.app_context():
        record = SwitchConfigs(**snapshot.switch.config)
        db.session.add(record)
        db.session.commit()
        snapshot.switch.db_id = record.id
        tables = [entry for entry in snapshot.switch.client.entries.values()
                  if snapshot.switch.p4_helper.table(entry.table_id).get('table_type', '').startswith('MatchAction')]
        archive._persist_pipeline(snapshot.switch, snapshot.controller, db, tables)
        state = db.session.get(TableStates, snapshot.switch.state_id)
        assert state.program_name == snapshot.switch.client.program_name == 'sample'
        assert state.target == 'tofino'
        assert state.p4_info_file == '' and state.bmv2_file == ''


def restore_indexed(native, tmp_path, monkeypatch, counts, write):
    import api.program_builds as builds
    entities = {category: [] for category in archive.CATEGORIES}
    names = {'registers': 'pipe.Ingress.packet_register', 'counters': 'pipe.Ingress.packet_counter',
             'meters': 'pipe.Ingress.packet_meter'}
    for category, count in counts.items():
        table = native.p4_helper.table(names[category])
        table['size'] = max(table.get('size', 0), count)
        for index in range(count):
            entry = native.resources.indexed_entry(table, index)
            entry.ClearField('table_flags')
            entry.data.fields.extend(encode_fields(fields(table['data']), {field['name']: '7' for field in fields(table['data'])}))
            entities[category].append(entry)
    native.client.write = write
    native.initialize_bundle = Mock()
    config = native.config
    controller = SimpleNamespace(addSwitchConnection=Mock(), switch_configs={config['device_id']: native})
    monkeypatch.setattr(builds, 'validate_bundle', Mock(return_value={'target': 'tofino', 'profiles': [{'pipe_scope': [0]}]}))
    item = {'record': {'key': 'switch-17', 'config': config, 'pipeline': {'manifest': 'manifest.json'},
                       'runtime': {'categories': {category: {'status': 'ok'} for category in archive.CATEGORIES}}},
            'info': native.p4_helper, 'entities': entities,
            'state': {'queues': {'configuration': {'source': 'bfrt', 'defaults': {}, 'ports': []}}}}
    return archive.restore_switch(controller, config, item, tmp_path, None)


def test_native_indexed_restore_batches_assignments_at_most_128_rows(native, tmp_path, monkeypatch):
    write = Mock()
    result = restore_indexed(native, tmp_path, monkeypatch, {'registers': 257, 'counters': 129, 'meters': 130}, write)
    assert [len(call.args[0]) for call in write.call_args_list] == [128, 128, 1, 128, 1, 128, 2]
    assert all(call.args[1] == pb.Update.MODIFY for call in write.call_args_list)
    for category, count in (('registers', 257), ('counters', 129), ('meters', 130)):
        assert result['categories'][category]['restored'] == count
        assert result['categories'][category]['failed'] == 0
    assert result['status'] == 'complete'


def test_native_failed_batch_retries_assignments_and_reports_only_actual_cell_failures(native, tmp_path, monkeypatch):
    from controller.targets.bfrt_client import BfRtError
    import grpc
    applied = {}
    def apply(entries, operation):
        assert operation == pb.Update.MODIFY
        if len(entries) > 1:
            # Simulate CONTINUE_ON_ERROR applying a prefix before failing.
            applied[0] = entries[0].SerializeToString()
            raise BfRtError(grpc.StatusCode.INVALID_ARGUMENT, 'Batch has a rejected cell')
        index = int.from_bytes(entries[0].key.fields[0].exact.value, 'big')
        if index == 5:
            raise BfRtError(grpc.StatusCode.INVALID_ARGUMENT, 'Register cell 5 was rejected')
        applied[index] = entries[0].SerializeToString()
    write = Mock(side_effect=apply)
    result = restore_indexed(native, tmp_path, monkeypatch, {'registers': 129}, write)
    status = result['categories']['registers']
    assert status == {'status': 'partial', 'restored': 128, 'captured': 129, 'failed': 1,
                      'errors': ['Register cell 5 was rejected']}
    assert result['status'] == 'partial'
    assert len(applied) == 128 and 5 not in applied
    assert [len(call.args[0]) for call in write.call_args_list] == [128] + [1] * 129
