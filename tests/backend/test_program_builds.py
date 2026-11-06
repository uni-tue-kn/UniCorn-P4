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
        'name': 'workshop', 'source': None, 'created_at': None, 'architecture': 'tofino'}]


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
    monkeypatch.setattr('api.program_builds.validate_bundle', validator)
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


def test_auto_detection_ignores_unreadable_includes_and_keeps_bmv2(workspace, tmp_path_factory):
    outside = tmp_path_factory.mktemp('shared') / 'headers.p4'
    outside.write_text('header h_t { bit<8> x; }\n')
    source = workspace / 'main.p4'
    source.write_text('#include <v1model.p4>\n#include "' + str(outside) + '"\n#include "missing.p4"\n')
    (workspace / 'real.p4').write_text('// shared\n')
    (workspace / 'alias.p4').symlink_to(workspace / 'real.p4')
    source.write_text(source.read_text() + '#include "alias.p4"\n')
    assert source_target(source) == 'bmv2'


@pytest.mark.parametrize('requested', ['auto', 'tofino'])
def test_tofino2_programs_are_detected_for_compilation(workspace, requested):
    (workspace / 'arch.p4').write_text('#include <t2na.p4>\n')
    source = workspace / 'main.p4'
    source.write_text('#include "arch.p4"\n')
    assert source_target(source, requested) == 'tofino'
    assert source_target(source, 'bmv2') == 'bmv2'


def test_program_picker_keeps_both_tofino_generations(workspace):
    for name, architecture in (('t1', 'tofino'), ('t2', 'tofino2')):
        directory = workspace / '.unicorn-builds' / name
        metadata = make_bundle(directory)
        metadata['architecture'] = architecture
        (directory / 'manifest.json').write_text(json.dumps(metadata))
    assert {program['architecture'] for program in discover_builds()} == {'tofino', 'tofino2'}


def test_multigeneration_workshop_uses_the_available_tofino1_branch(workspace):
    source = workspace / 'main.p4'
    source.write_text('#if __TARGET_TOFINO__ == 2\n#include <t2na.p4>\n#else\n#include <tna.p4>\n#endif\n')
    assert source_target(source) == 'tofino'


def test_commented_architecture_does_not_change_a_bmv2_program(workspace):
    source = workspace / 'main.p4'
    source.write_text('/*\n#include <t2na.p4>\n*/\n#include <v1model.p4>\n')
    assert source_target(source) == 'bmv2'


def test_listing_skips_artifact_hashing_but_loading_verifies_it(workspace):
    directory = workspace / '.unicorn-builds' / 'example'
    metadata = make_bundle(directory)
    metadata['sha256'] = {'tofino.bin': hashlib.sha256(b'native program').hexdigest()}
    (directory / 'manifest.json').write_text(json.dumps(metadata))
    (directory / 'tofino.bin').write_bytes(b'tampered program')
    assert [program['id'] for program in discover_builds()] == [str(directory / 'manifest.json')]
    with pytest.raises(BuildError, match='checksum'):
        validate_bundle(directory / 'manifest.json')


def test_successful_build_prunes_only_unreferenced_builds_of_the_same_source(workspace, monkeypatch):
    source = workspace / 'workshop.p4'
    source.write_text('#include <tna.p4>\n')
    for name, origin in (('stale', source), ('saved', source), ('other', workspace / 'other.p4')):
        directory = workspace / '.unicorn-builds' / name
        metadata = make_bundle(directory)
        metadata.update(source=str(origin), created_at='2000-01-01T00:00:00Z')
        (directory / 'manifest.json').write_text(json.dumps(metadata))

    def compile_request(request, timeout):
        body = json.loads(request.data)
        return io.BytesIO(json.dumps({'manifest': make_bundle(Path(body['output']))}).encode())

    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', compile_request)
    jobs = BuildJobs()
    jobs.referenced = lambda: {str(workspace / '.unicorn-builds/saved/manifest.json')}
    jobs.jobs['fresh'] = {'status': 'pending'}
    jobs._compile('fresh', source, 'http://compiler:8080')
    assert jobs.get('fresh')['status'] == 'complete'
    remaining = {path.name for path in (workspace / '.unicorn-builds').iterdir()}
    assert remaining == {'fresh', 'saved', 'other'}


def test_builds_are_kept_when_references_are_unknown(workspace, monkeypatch):
    source = workspace / 'workshop.p4'
    source.write_text('#include <tna.p4>\n')
    old = workspace / '.unicorn-builds' / 'old'
    metadata = make_bundle(old)
    metadata.update(source=str(source), created_at='2000-01-01T00:00:00+00:00')
    (old / 'manifest.json').write_text(json.dumps(metadata))
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', lambda request, timeout: io.BytesIO(
        json.dumps({'manifest': make_bundle(Path(json.loads(request.data)['output']))}).encode()))
    jobs = BuildJobs()
    jobs.referenced = Mock(side_effect=RuntimeError('database unavailable'))
    jobs.jobs['fresh'] = {'status': 'pending'}
    jobs._compile('fresh', source, 'http://compiler:8080')
    assert jobs.get('fresh')['status'] == 'complete'
    jobs.referenced.assert_called_once_with()
    assert old.is_dir()
    # Prove that age/source would otherwise make this exact build removable.
    from api.program_builds import prune_builds
    prune_builds(workspace / '.unicorn-builds' / 'fresh', lambda: set())
    assert not old.exists()


def test_compile_and_prune_refuse_a_symlinked_build_root(workspace, tmp_path_factory, monkeypatch):
    from api.program_builds import prune_builds
    outside = tmp_path_factory.mktemp('outside-build-root')
    (workspace / '.unicorn-builds').symlink_to(outside, target_is_directory=True)
    source = workspace / 'main.p4'
    source.write_text('#include <tna.p4>\n')
    request = Mock()
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', request)
    jobs = BuildJobs()
    jobs.jobs['refused'] = {'status': 'pending'}
    jobs._compile('refused', source, 'http://compiler:8080')
    assert jobs.get('refused')['status'] == 'failed'
    request.assert_not_called()
    assert list(outside.iterdir()) == []
    prune_builds(outside, set)
    assert outside.is_dir()


def test_explicit_symlinked_workspace_root_is_canonicalized(tmp_path):
    real = tmp_path / 'real'
    real.mkdir()
    source = real / 'main.p4'
    source.write_text('// canonical file')
    alias = tmp_path / 'alias'
    alias.symlink_to(real, target_is_directory=True)
    assert contained_file(alias / 'main.p4', alias) == source
    (real / 'linked.p4').symlink_to(source)
    with pytest.raises(BuildError):
        contained_file(alias / 'linked.p4', alias)


def _build(workspace, name, source, created_at=None):
    directory = workspace / '.unicorn-builds' / name
    metadata = make_bundle(directory)
    metadata.update(source=str(source), **({'created_at': created_at} if created_at else {}))
    (directory / 'manifest.json').write_text(json.dumps(metadata))
    return directory


def test_cleanup_for_an_older_build_never_deletes_a_newer_or_undated_build(workspace):
    from api.program_builds import prune_builds
    source = workspace / 'workshop.p4'
    older = _build(workspace, 'older', source, '2026-11-04T10:00:00+00:00')
    newer = _build(workspace, 'newer', source, '2026-11-04T11:00:00+00:00')
    undated = _build(workspace, 'undated', source)
    prune_builds(older, set)
    assert older.is_dir() and newer.is_dir() and undated.is_dir()
    prune_builds(newer, set)
    assert not older.exists() and newer.is_dir() and undated.is_dir()


def test_build_is_reported_complete_only_after_cleanup(workspace, monkeypatch):
    source = workspace / 'workshop.p4'
    source.write_text('#include <tna.p4>\n')
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', lambda request, timeout: io.BytesIO(
        json.dumps({'manifest': make_bundle(Path(json.loads(request.data)['output']))}).encode()))
    jobs = BuildJobs()
    jobs.jobs['fresh'] = {'status': 'pending'}
    statuses = []
    jobs.referenced = lambda: statuses.append(jobs.jobs['fresh']['status']) or set()
    jobs._compile('fresh', source, 'http://compiler:8080')
    assert statuses == ['running']
    assert jobs.get('fresh')['status'] == 'complete'


def test_cleanup_failure_keeps_the_finished_build(workspace, monkeypatch):
    source = workspace / 'workshop.p4'
    source.write_text('#include <tna.p4>\n')
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', lambda request, timeout: io.BytesIO(
        json.dumps({'manifest': make_bundle(Path(json.loads(request.data)['output']))}).encode()))
    monkeypatch.setattr('api.program_builds.prune_builds', Mock(side_effect=RuntimeError('cleanup broke')))
    jobs = BuildJobs()
    jobs.referenced = lambda: set()
    jobs.jobs['fresh'] = {'status': 'pending'}
    jobs._compile('fresh', source, 'http://compiler:8080')
    assert jobs.get('fresh')['status'] == 'complete'
    assert (workspace / '.unicorn-builds' / 'fresh' / 'manifest.json').is_file()


def test_unreadable_includes_are_skipped_by_detection_but_fail_snapshots(workspace, monkeypatch):
    locked = workspace / 'locked.p4'
    locked.write_text('#include <tna.p4>\n')
    source = workspace / 'main.p4'
    source.write_text('#include <v1model.p4>\n#include "locked.p4"\n')
    original = Path.read_bytes

    def read_bytes(path):
        if path.name == 'locked.p4':
            raise PermissionError(13, 'Permission denied', str(path))
        return original(path)

    monkeypatch.setattr(Path, 'read_bytes', read_bytes)
    assert source_target(source) == 'bmv2'
    with pytest.raises(BuildError, match='unavailable'):
        snapshot_sources(source, workspace / '.snapshot')


def test_build_being_initialized_survives_cleanup_by_a_newer_compile(client, switch, workspace, monkeypatch):
    from api import exampleController
    from api.database.TableStates import TableStates
    from api.database import db

    source = workspace / 'workshop.p4'
    source.write_text('#include <tna.p4>\n')
    old = _build(workspace, 'old', source, '2026-11-04T10:00:00+00:00')
    switch.target = 'tofino'
    switch.program_manifest = None
    monkeypatch.setattr(exampleController, 'getTableEntries', lambda **kwargs: {})
    monkeypatch.setattr(exampleController, 'getInitialDecoding', lambda **kwargs: {})
    monkeypatch.setattr(exampleController, 'getTableInfo', lambda **kwargs: {})
    monkeypatch.setattr('api.program_builds.urlrequest.urlopen', lambda request, timeout: io.BytesIO(
        json.dumps({'manifest': make_bundle(Path(json.loads(request.data)['output']))}).encode()))
    with client.application.app_context():
        db.create_all()
    jobs = client.application.extensions['program_builds']

    def compile_newer(name):
        jobs.jobs[name] = {'status': 'pending'}
        jobs._compile(name, source, 'http://compiler:8080')
        assert jobs.get(name)['status'] == 'complete'

    def initialize(bundle, keep_entries):
        # A newer build of the same source finishes while the switch loads
        # the old one, before any state or switch references it.
        compile_newer('during')
        assert old.is_dir()
        switch.program_manifest = bundle['manifest_path']

    switch.initialize_bundle = initialize
    response = client.post('/init', json={'switch_id': 0, 'program_id': str(old / 'manifest.json')})
    assert response.status_code == 200, response.data
    with client.application.app_context():
        assert db.session.get(TableStates, switch.state_id).program_manifest == str(old / 'manifest.json')
    # Once the pin is released, the committed history state protects it.
    switch.program_manifest = None
    compile_newer('after')
    assert (old / 'manifest.json').is_file()
