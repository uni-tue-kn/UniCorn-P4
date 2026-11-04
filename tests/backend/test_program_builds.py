"""Portable build validation and compilation lifecycle contracts."""
import hashlib
import io
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from api.program_builds import (BuildError, BuildJobs, contained_file, discover_builds,
                               snapshot_sources, source_target, validate_bundle)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv('P4_DIR', str(tmp_path))
    return tmp_path


def make_bundle(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'bf-rt.json').write_text('{"tables": []}')
    (root / 'context.json').write_text('{}')
    (root / 'tofino.bin').write_bytes(b'native program')
    metadata = {'target': 'tofino', 'program_name': 'workshop', 'bfrt_json': 'bf-rt.json',
                'profiles': [{'profile_name': 'pipe', 'context': 'context.json',
                              'binary': 'tofino.bin', 'pipe_scope': [0]}]}
    (root / 'manifest.json').write_text(json.dumps(metadata))
    return metadata


def test_nested_sources_are_detected_and_frozen_with_parent_includes(workspace):
    (workspace / 'src').mkdir()
    (workspace / 'common.p4').write_text('#include <tna.p4>\n')
    source = workspace / 'src' / 'main.p4'
    source.write_text('#include "../common.p4"\n')
    assert source_target(source) == 'tofino'
    frozen, hashes = snapshot_sources(source, workspace / '.snapshot')
    assert frozen.read_text() == source.read_text()
    assert (workspace / '.snapshot' / 'common.p4').is_file()
    assert hashes['common.p4'] == hashlib.sha256((workspace / 'common.p4').read_bytes()).hexdigest()
    (workspace / 'common.p4').write_text('changed')
    assert '#include <tna.p4>' in (workspace / '.snapshot' / 'common.p4').read_text()


def test_include_cannot_escape_workspace_or_pass_through_symlinks(workspace):
    source = workspace / 'main.p4'
    source.write_text('#include "../outside.p4"')
    with pytest.raises(BuildError):
        snapshot_sources(source, workspace / '.snapshot')
    (workspace / 'real.p4').write_text('#include <tna.p4>')
    (workspace / 'alias.p4').symlink_to(workspace / 'real.p4')
    with pytest.raises(BuildError):
        contained_file(workspace / 'alias.p4')


def test_absolute_quoted_includes_resolve_only_frozen_files(workspace):
    header = workspace / 'include' / 'port.p4'
    header.parent.mkdir()
    header.write_text('#define PORT 1\n')
    source = workspace / 'main.p4'
    source.write_text('#include "' + str(header) + '"\n')
    frozen, hashes = snapshot_sources(source, workspace / '.snapshot')
    header.write_text('#define PORT 2\n')
    assert frozen.read_text() == '#include "include/port.p4"\n'
    assert (frozen.parent / 'include/port.p4').read_text() == '#define PORT 1\n'
    assert hashes['include/port.p4'] == hashlib.sha256(b'#define PORT 1\n').hexdigest()


def test_native_bundle_resolves_files_and_is_discovered_once(workspace):
    directory = workspace / '.unicorn-builds' / 'example'
    make_bundle(directory)
    bundle = validate_bundle(directory / 'manifest.json')
    assert bundle['profiles'][0]['binary'] == str(directory / 'tofino.bin')
    assert discover_builds() == [{'id': str(directory / 'manifest.json'),
        'build_manifest': str(directory / 'manifest.json'), 'target': 'tofino',
        'name': 'workshop', 'source': None, 'created_at': None}]


def test_program_picker_advertises_latest_build_per_source_and_preserves_old_history(workspace):
    for name, source, created in (('old', '/p4/a/main.p4', '2026-11-03T10:00:00Z'),
                                   ('new', '/p4/a/main.p4', '2026-11-03T11:00:00Z'),
                                   ('other', '/p4/b/main.p4', '2026-11-03T10:00:00Z')):
        directory = workspace / '.unicorn-builds' / name
        metadata = make_bundle(directory)
        metadata.update(source=source, created_at=created)
        (directory / 'manifest.json').write_text(json.dumps(metadata))
    assert {Path(program['id']).parent.name for program in discover_builds()} == {'new', 'other'}
    assert validate_bundle(workspace / '.unicorn-builds/old/manifest.json')['program_name'] == 'workshop'


def test_imported_program_and_latest_workspace_source_have_distinct_readable_labels(workspace):
    local = workspace / '.unicorn-builds/build'
    metadata = make_bundle(local)
    metadata['source'] = str(workspace / 'workshop/main.p4')
    (local / 'manifest.json').write_text(json.dumps(metadata))
    imported = workspace / 'imported-network-example/programs/switch-0'
    metadata = make_bundle(imported)
    metadata['source'] = 'source/workshop/main.p4'
    (imported / 'manifest.json').write_text(json.dumps(metadata))
    programs = discover_builds()
    assert {program['name'] for program in programs} == {
        'workshop/main', 'imported-network-example/programs/switch-0/source/workshop/main'}
    assert all(Path(program['source']).is_absolute() for program in programs)
    assert not any('manifest.json' in program['name'] or '.unicorn-builds' in program['name'] for program in programs)


@pytest.mark.parametrize('change', [
    {'bfrt_json': '../bf-rt.json'}, {'bfrt_json': '/etc/passwd'},
    {'sha256': []}, {'sha256': {'context.json': 'invalid'}},
    {'sha256': {'tofino.bin': '0' * 64}},
    {'display_name': {}}, {'source': []},
    {'profiles': [{'profile_name': None, 'context': 'context.json', 'binary': 'tofino.bin', 'pipe_scope': [0]}]},
    {'profiles': [{'profile_name': 'pipe', 'context': 'context.json', 'binary': 'tofino.bin', 'pipe_scope': [False]}]},
    {'profiles': [{'profile_name': 'pipe', 'context': 'context.json', 'binary': 'tofino.bin', 'pipe_scope': [0, 1]}]},
])
def test_bundle_rejects_invalid_or_unsafe_metadata(workspace, change):
    metadata = make_bundle(workspace)
    (workspace / 'manifest.json').write_text(json.dumps({**metadata, **change}))
    with pytest.raises(BuildError):
        validate_bundle(workspace / 'manifest.json')


@pytest.mark.parametrize('include', ['<tna.p4>', '"tna.p4"'])
def test_build_worker_freezes_source_publishes_valid_manifest_and_hides_intermediates(workspace, monkeypatch, include):
    source = workspace / 'workshop.p4'
    source.write_text('#include "core.p4"\n#include ' + include)
    assert source_target(source) == 'tofino'
    jobs = BuildJobs()
    jobs.jobs['test'] = {'status': 'pending'}

    def compile_request(request, timeout):
        body = json.loads(request.data)
        assert Path(body['source']).read_text() == source.read_text()
        assert Path(body['source']) != source
        assert timeout == 600
        metadata = make_bundle(Path(body['output']))
        return io.BytesIO(json.dumps({'manifest': metadata, 'stdout': 'compiled',
            'stderr': body['source'] + '(1): compiler warning', 'command': ['bf-p4c']}).encode())

    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', compile_request)
    jobs._compile('test', source, 'http://compiler:8080')
    job = jobs.get('test')
    assert job['status'] == 'complete'
    assert job['result']['program']['target'] == 'tofino'
    assert job['result']['stderr'] == str(source) + '(1): compiler warning'
    manifest = Path(job['result']['program']['id'])
    assert validate_bundle(manifest)['profiles'][0]['pipe_scope'] == [0]
    assert json.loads(manifest.read_text())['sha256']['artifacts/tofino.bin']


def test_quoted_sdk_header_local_override_is_frozen(workspace):
    source = workspace / 'workshop.p4'
    source.write_text('#include "tna.p4"\n')
    header = workspace / 'tna.p4'
    header.write_text('// local override\n')
    frozen, hashes = snapshot_sources(source, workspace / '.snapshot')
    assert frozen.read_text() == source.read_text()
    assert (frozen.parent / 'tna.p4').read_text() == header.read_text()
    assert 'tna.p4' in hashes


def test_failed_build_cleans_partial_artifacts(workspace, monkeypatch):
    source = workspace / 'bad.p4'
    source.write_text('#include "missing.p4"')
    jobs = BuildJobs()
    jobs.jobs['failed'] = {'status': 'pending'}
    jobs._compile('failed', source, 'http://compiler:8080')
    assert jobs.get('failed')['status'] == 'failed'
    assert not (workspace / '.unicorn-builds' / 'failed').exists()


def test_unavailable_compiler_and_unknown_jobs_are_explicit(workspace, monkeypatch):
    monkeypatch.delenv('TOFINO_COMPILER_URL', raising=False)
    jobs = BuildJobs()
    with pytest.raises(BuildError) as error:
        jobs.start(workspace / 'main.p4')
    assert error.value.status == 503
    with pytest.raises(BuildError) as error:
        jobs.get('missing')
    assert error.value.status == 404


def test_listing_filters_programs_by_switch_target(client, switch, workspace):
    (workspace / 'basic.json').write_text('{}')
    (workspace / 'basic.p4info.txt').write_text('')
    make_bundle(workspace / '.unicorn-builds' / 'workshop')
    switch.target = 'tofino'
    result = client.get('/p4files?switch_id=0').json
    assert [program['target'] for program in result['programs']] == ['tofino']
    assert result['bmv2'] == [str(workspace / 'basic.json')]


@pytest.mark.parametrize('selection', [{'program_id': '/missing/manifest.json'}, {'state_id': '999999'}])
def test_observer_cannot_initialize_or_restore_before_program_validation(client, switch, monkeypatch, selection):
    switch.read_only = True
    switch.initialize_bundle = Mock()
    validator = Mock(side_effect=AssertionError('An observer must not load program artifacts'))
    monkeypatch.setattr('api.endpoints.init.validate_bundle', validator)
    result = client.post('/init', json={'switch_id': 0, **selection})
    assert result.status_code == 403
    assert 'read only' in result.json['error']
    validator.assert_not_called()
    switch.initialize_bundle.assert_not_called()


def test_init_validates_target_before_contacting_switch(client, switch, workspace):
    make_bundle(workspace)
    switch.initialize_bundle = Mock()
    result = client.post('/init', json={'switch_id': 0, 'program_id': str(workspace / 'manifest.json')})
    assert result.status_code == 400
    assert 'target' in result.json['error']
    switch.initialize_bundle.assert_not_called()


def test_native_initialization_saves_program_reference_and_generic_metadata(client, switch, workspace, monkeypatch):
    from api import exampleController
    from api.database.TableStates import TableStates
    from api.database import db

    make_bundle(workspace)
    switch.target = 'tofino'
    switch.initialize_bundle = Mock()
    monkeypatch.setattr(exampleController, 'getTableEntries', lambda **kwargs: {})
    monkeypatch.setattr(exampleController, 'getInitialDecoding', lambda **kwargs: {})
    monkeypatch.setattr(exampleController, 'getTableInfo', lambda **kwargs: {})
    with client.application.app_context():
        db.create_all()
    response = client.post('/init', json={'switch_id': 0, 'program_id': str(workspace / 'manifest.json')})
    assert response.status_code == 200, response.data
    switch.initialize_bundle.assert_called_once()
    with client.application.app_context():
        state = db.session.get(TableStates, switch.state_id)
        assert state.target == 'tofino'
        assert state.program_name == 'workshop'
        assert state.program_manifest == str(workspace / 'manifest.json')
        assert state.p4_info_file == state.bmv2_file == ''
