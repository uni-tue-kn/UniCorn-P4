import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

import pytest

from scripts.package_release import package
from scripts.release_version import eligible_merge, git, next_version, prepare
from scripts.release_changelog import release_notes

ROOT = Path(__file__).resolve().parents[2]


def write(repo, name, data):
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data)


def commit(repo, message):
    subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(repo), 'commit', '-m', message], check=True, capture_output=True)
    return git(repo, 'rev-parse', 'HEAD')


@pytest.fixture
def repo(tmp_path):
    subprocess.run(['git', 'init', '-b', 'main', str(tmp_path)], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(tmp_path), 'config', 'user.name', 'Release test'], check=True)
    subprocess.run(['git', '-C', str(tmp_path), 'config', 'user.email', 'release-test@example.invalid'], check=True)
    write(tmp_path, 'VERSION', '1.2.0-dev.0\n')
    write(tmp_path, 'frontend/package.json', json.dumps({'name': 'frontend', 'version': '1.2.0-dev.0', 'dependencies': {'react': '19.3.1'}}))
    write(tmp_path, 'frontend/package-lock.json', json.dumps({'name': 'frontend', 'version': '1.2.0-dev.0',
        'lockfileVersion': 3, 'packages': {'': {'name': 'frontend', 'version': '1.2.0-dev.0'}, 'node_modules/react': {'version': '19.3.1'}}}))
    write(tmp_path, 'README.md', 'Repository documentation\n')
    write(tmp_path, 'LICENSE', 'License\n')
    write(tmp_path, 'logo.png', 'tracked-logo-image')
    write(tmp_path, 'CHANGELOG.md', '# Changelog\n\n## Unreleased — 1.2.0\n\n### Added\n\n* New capabilities.\n\n## v1.0\n\n* Old history.\n')
    write(tmp_path, 'docs/usage.md', 'Usage guide\n')
    write(tmp_path, 'runtime/README.md', 'Runtime compatibility notes\n')
    for screenshot in ('topology', 'tables', 'registers', 'meters', 'mirrors'):
        write(tmp_path, f'docs/screenshots/{screenshot}.png', f'tracked-screenshot-{screenshot}')
    write(tmp_path, 'docker/docker-compose.yaml', 'services: {}\n')
    write(tmp_path, 'docker/p4-files/tutorial/tutorial.p4', '#include "src/headers.p4"\nV1Switch(a(),b(),c(),d(),e(),f()) main;\n')
    write(tmp_path, 'docker/p4-files/tutorial/src/headers.p4', '// included source\n')
    write(tmp_path, 'docker/p4-files/tutorial/tutorial.json', '{"compiled": true}\n')
    write(tmp_path, 'docker/p4-files/tutorial/tutorial.p4info.txt', 'pkg_info {}\n')
    write(tmp_path, 'docker/p4-files/tutorial/tutorial.p4i', 'preprocessor scratch\n')
    write(tmp_path, 'docker/topologies/topology.json', '{"hosts":[],"switches":{},"links":[]}\n')
    write(tmp_path, 'docker/database/p4db.db', 'DO NOT DISTRIBUTE LIVE DATABASE\n')
    write(tmp_path, 'docker/topologies/logs/s1.log', 'DO NOT DISTRIBUTE LOG\n')
    write(tmp_path, 'docker/topologies/pcaps/s1.pcap', 'DO NOT DISTRIBUTE PACKET CAPTURE\n')
    commit(tmp_path, 'Tested PR merge')
    return tmp_path


@pytest.mark.parametrize('current,expected', [('1.2.0-dev.0', '1.2.0'), ('1.2.0-rc.1', '1.2.0'),
    ('1.2.0', '1.2.1'), ('1.2.9', '1.2.10'), ('0.0.0', '0.0.1')])
def test_semantic_release_increment(current, expected):
    assert next_version(current) == expected


@pytest.mark.parametrize('current', ['1.2', 'v1.2.0', '1.2.0;rm', '01.2.0', 'bad'])
def test_invalid_versions_fail_before_git_changes(current):
    with pytest.raises(ValueError):
        next_version(current)


def test_release_commit_and_frontend_versions_are_synchronized(repo):
    tested = git(repo, 'rev-parse', 'HEAD')
    result = prepare(repo, tested, commit=True)
    assert result['version'] == '1.2.0'
    assert git(repo, 'show', '-s', '--format=%P', result['commit']) == tested
    assert git(repo, 'show', '-s', '--format=%s') == 'Release v1.2.0'
    assert (repo / 'VERSION').read_text() == '1.2.0\n'
    package_json = json.loads((repo / 'frontend/package.json').read_text())
    lock = json.loads((repo / 'frontend/package-lock.json').read_text())
    assert package_json['version'] == lock['version'] == lock['packages']['']['version'] == '1.2.0'
    assert package_json['dependencies']['react'] == lock['packages']['node_modules/react']['version'] == '19.3.1'
    assert 'Co-Authored-By' not in git(repo, 'show', '-s', '--format=%B')
    assert git(repo, 'rev-parse', 'v1.2.0') == result['commit']
    changelog = (repo / 'CHANGELOG.md').read_text()
    assert '## Unreleased' not in changelog
    assert '## 1.2.0 — ' in changelog
    assert release_notes(changelog, '1.2.0') == '### Added\n\n* New capabilities.\n'
    assert 'CHANGELOG.md' in git(repo, 'diff', '--name-only', tested, result['commit']).splitlines()


def test_next_release_promotes_only_new_changelog_entries(repo):
    first = prepare(repo, git(repo, 'rev-parse', 'HEAD'), commit=True)
    path = repo / 'CHANGELOG.md'
    path.write_text(path.read_text().replace('# Changelog\n', '# Changelog\n\n## Unreleased\n\n* New patch fix.\n', 1))
    tested = commit(repo, 'Next merged pull request')
    second = prepare(repo, tested, commit=True)
    assert first['version'] == '1.2.0'
    assert second['version'] == '1.2.1'
    assert 'Unreleased' not in path.read_text()
    assert release_notes(path.read_text(), '1.2.1') == '* New patch fix.\n'
    assert release_notes(path.read_text(), '1.2.0') == '### Added\n\n* New capabilities.\n'


def test_invalid_changelog_fails_without_changing_release_files(repo):
    write(repo, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\none\n\n## Unreleased\n\ntwo\n')
    tested = commit(repo, 'Ambiguous changelog')
    with pytest.raises(ValueError, match='ambiguous'):
        prepare(repo, tested, commit=True)
    assert git(repo, 'rev-parse', 'HEAD') == tested
    assert git(repo, 'status', '--porcelain', '--untracked-files=no') == ''


def test_retry_reuses_reserved_version_even_after_main_advances(repo):
    tested = git(repo, 'rev-parse', 'HEAD')
    first = prepare(repo, tested, commit=True)
    assert prepare(repo, tested, commit=True)['commit'] == first['commit']
    write(repo, 'next-merge.txt', 'later PR\n')
    commit(repo, 'Another merged pull request')
    retried = prepare(repo, tested, commit=True)
    assert retried['reused'] == 'true'
    assert retried['reserve_needed'] == 'false'
    assert git(repo, 'rev-parse', 'HEAD') == first['commit']
    assert (repo / 'VERSION').read_text().strip() == '1.2.0'


def test_stale_unreserved_tested_source_is_skipped(repo):
    tested = git(repo, 'rev-parse', 'HEAD')
    write(repo, 'new-merge.txt', 'newer commit\n')
    newer = commit(repo, 'Newer merge')
    result = prepare(repo, tested, commit=True)
    assert result['ready'] == 'false'
    assert git(repo, 'rev-parse', 'HEAD') == newer
    assert (repo / 'VERSION').read_text().strip() == '1.2.0-dev.0'


def test_tag_collision_is_an_error(repo):
    tested = git(repo, 'rev-parse', 'HEAD')
    subprocess.run(['git', '-C', str(repo), 'tag', 'v1.2.0'], check=True)
    with pytest.raises(ValueError, match='does not reserve'):
        prepare(repo, tested, commit=True)


def test_commit_association_accepts_squash_and_excludes_direct_pushes():
    sha = 'a' * 40
    merged = {'merged_at': '2026-10-31T12:00:00Z', 'merge_commit_sha': sha,
              'base': {'ref': 'main', 'repo': {'full_name': 'owner/repo'}}}
    assert eligible_merge([[merged]], 'owner/repo', sha)
    assert not eligible_merge([], 'owner/repo', sha)
    assert not eligible_merge([dict(merged, merged_at=None)], 'owner/repo', sha)
    assert not eligible_merge([merged], 'owner/repo', 'b' * 40)
    assert not eligible_merge([merged], 'fork/repo', sha)


def test_real_cli_does_not_release_unassociated_direct_push(repo, tmp_path):
    metadata, output = tmp_path / 'prs.json', tmp_path / 'output.txt'
    metadata.write_text('[]')
    tested = git(repo, 'rev-parse', 'HEAD')
    subprocess.run([sys.executable, str(ROOT / 'scripts/release_version.py'), '--repo', str(repo),
                    '--tested-sha', tested, '--merged-prs', str(metadata), '--repository', 'owner/repo',
                    '--commit', '--output', str(output)], check=True, capture_output=True)
    assert 'ready=false' in output.read_text()
    assert git(repo, 'rev-parse', 'HEAD') == tested


def test_archive_matches_deployment_layout_and_excludes_private_state(repo, tmp_path):
    prepare(repo, git(repo, 'rev-parse', 'HEAD'), commit=True)
    write(repo, 'docker/p4-files/private.p4', 'UNTRACKED SECRET\n')
    write(repo, 'docker/topologies/local.json', 'UNTRACKED TOPOLOGY\n')
    write(repo, 'docs/screenshots/private.png', 'UNTRACKED PRIVATE SCREENSHOT\n')
    # Modified tracked working files must not leak into the tagged release.
    write(repo, 'docker/p4-files/tutorial/src/headers.p4', 'UNCOMMITTED SECRET\n')
    output = tmp_path / 'download' / 'UniCorn-P4.tar.gz'
    package(repo, output)
    with tarfile.open(output) as archive:
        names = archive.getnames()
        assert 'UniCorn-P4/docker-compose.yaml' in names
        assert 'UniCorn-P4/p4-files/tutorial/tutorial.p4' in names
        assert 'UniCorn-P4/p4-files/tutorial/tutorial.json' in names
        assert 'UniCorn-P4/p4-files/tutorial/tutorial.p4info.txt' in names
        assert 'UniCorn-P4/topologies/topology.json' in names
        assert 'UniCorn-P4/database/.empty' in names
        assert 'UniCorn-P4/logo.png' in names
        assert 'UniCorn-P4/CHANGELOG.md' in names
        assert 'UniCorn-P4/docs/usage.md' in names
        assert 'UniCorn-P4/runtime/README.md' in names
        for screenshot in ('topology', 'tables', 'registers', 'meters', 'mirrors'):
            assert f'UniCorn-P4/docs/screenshots/{screenshot}.png' in names
        assert archive.extractfile('UniCorn-P4/VERSION').read() == b'1.2.0\n'
        assert archive.extractfile('UniCorn-P4/p4-files/tutorial/src/headers.p4').read() == b'// included source\n'
        deployment = archive.extractfile('UniCorn-P4/docker-compose.yaml').read().decode()
        assert deployment.count(':1.2.0') == 3
        assert 'build:' not in deployment
        assert 'context:' not in deployment
        assert ':latest' not in deployment
        assert not any(name.endswith(('.db', '.log', '.pcap', '.p4i')) for name in names)
        assert not any('private' in name or 'local.json' in name for name in names)
        assert all(name.startswith('UniCorn-P4') for name in names)


def test_archive_is_reproducible(repo, tmp_path):
    prepare(repo, git(repo, 'rev-parse', 'HEAD'), commit=True)
    first, second = tmp_path / 'one.tar.gz', tmp_path / 'two.tar.gz'
    package(repo, first)
    package(repo, second)
    assert hashlib.sha256(first.read_bytes()).digest() == hashlib.sha256(second.read_bytes()).digest()


def test_public_network_samples_are_packaged_without_untracked_archives(repo, tmp_path):
    write(repo, 'examples/networks/README.md', '[Public source](../p4/runtime-lab/include.p4)\n')
    write(repo, 'examples/networks/two-host-forwarding.zip', 'tracked sample archive')
    write(repo, 'examples/networks/campus-telemetry.zip', 'tracked public campus archive')
    write(repo, 'examples/p4/runtime-lab/include.p4', '// public sample fragment\n')
    commit(repo, 'Add public network samples')
    prepare(repo, git(repo, 'rev-parse', 'HEAD'), commit=True)
    write(repo, 'examples/networks/private.zip', 'UNTRACKED PRIVATE NETWORK')
    output = tmp_path / 'samples.tar.gz'
    package(repo, output)
    with tarfile.open(output) as archive:
        names = archive.getnames()
        assert 'UniCorn-P4/examples/networks/README.md' in names
        assert 'UniCorn-P4/examples/networks/two-host-forwarding.zip' in names
        assert 'UniCorn-P4/examples/networks/campus-telemetry.zip' in names
        assert archive.extractfile('UniCorn-P4/examples/networks/campus-telemetry.zip').read() == b'tracked public campus archive'
        assert 'UniCorn-P4/p4-files/runtime-lab/include.p4' in names
        assert b'(../../p4-files/runtime-lab/include.p4)' in archive.extractfile('UniCorn-P4/examples/networks/README.md').read()
        assert not any('private.zip' in name for name in names)


def test_resource_sample_requires_compiled_outputs_and_maps_to_archive(repo, tmp_path):
    write(repo, 'tests/fixtures/resources.p4', 'V1Switch(a(),b(),c(),d(),e(),f()) main;\n')
    write(repo, 'tests/fixtures/topology.json', '{"hosts":[],"switches":{},"links":[]}\n')
    commit(repo, 'Resource sample')
    prepare(repo, git(repo, 'rev-parse', 'HEAD'), commit=True)
    with pytest.raises(ValueError, match='resources.json'):
        package(repo, tmp_path / 'missing.tar.gz')
    compiled = tmp_path / 'compiled'
    for sample in ('tutorial/tutorial', 'resources/resources'):
        write(compiled, f'p4-files/{sample}.json', '{}')
        write(compiled, f'p4-files/{sample}.p4info.txt', 'pkg_info {}')
    output = tmp_path / 'complete.tar.gz'
    package(repo, output, compiled_dir=compiled)
    with tarfile.open(output) as archive:
        assert 'UniCorn-P4/p4-files/resources/resources.json' in archive.getnames()
        assert 'UniCorn-P4/p4-files/resources/resources.p4info.txt' in archive.getnames()
        assert 'UniCorn-P4/topologies/resources.json' in archive.getnames()
