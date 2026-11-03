import hashlib
import os
from pathlib import Path
import stat
from unittest.mock import patch

import pytest

from api.workspace import MAX_FILE_BYTES, WorkspaceError, resolve_workspace_path


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    root = tmp_path / "P4 files with 'quotes'"
    root.mkdir()
    (root / 'src').mkdir()
    (root / 'src/headers.p4').write_text('header ethernet_t { bit<48> dst; }\n')
    (root / 'main.p4').write_text('#include "src/headers.p4"\n// main program\n')
    (root / 'main.json').write_text('{"compiled": true}\n')
    (root / 'main.p4info.txt').write_text('pkg_info {}\n')
    (root / 'main.p4i').write_text('// preprocessed\n')
    (root / 'parameters.json').write_text('{"parameter": 4}\n')
    (root / 'README.md').write_text('Project notes\n')
    (root / 'control.py').write_text('print("controller")\n')
    (root / '.secret.p4').write_text('HIDDEN SECRET\n')
    (root / 'private.db').write_bytes(b'PRIVATE DATABASE')
    monkeypatch.setenv('P4_DIR', str(root))
    return root


def read(client, path='main.p4'):
    response = client.get('/workspace/file', query_string={'path': path})
    assert response.status_code == 200, response.json
    return response.json


def test_workspace_lists_sources_includes_and_read_only_artifacts(client, workspace):
    response = client.get('/workspace')
    assert response.status_code == 200
    body = response.json
    assert body['root'] == str(workspace)
    assert body['max_file_bytes'] == MAX_FILE_BYTES
    assert body['truncated'] is False
    rows = {row['path']: row for row in body['files']}
    assert set(rows) == {'main.p4', 'main.json', 'main.p4info.txt', 'main.p4i',
                         'parameters.json', 'README.md', 'control.py', 'src/headers.p4'}
    assert rows['src/headers.p4']['absolute_path'] == str(workspace / 'src/headers.p4')
    assert rows['main.p4']['language'] == 'p4'
    assert rows['parameters.json']['language'] == 'json'
    assert rows['control.py']['language'] == 'python'
    assert rows['main.p4']['read_only'] is False
    assert rows['parameters.json']['read_only'] is False
    for name in ('main.json', 'main.p4i', 'main.p4info.txt'):
        assert rows[name]['read_only'] is True


def test_workspace_reads_utf8_and_preserves_exact_revision(client, workspace):
    source = workspace / "src/O'Brien π.p4"
    original = '// π\r\nheader h { bit<8> f; }\r\n'.encode()
    source.write_bytes(original)
    result = read(client, "src/O'Brien π.p4")
    assert result['content'].encode() == original
    assert result['revision'] == hashlib.sha256(original).hexdigest()
    assert result['absolute_path'] == str(source)
    assert result['size'] == len(original)


def test_save_preserves_file_permissions_and_round_trips(client, workspace):
    source = workspace / 'main.p4'
    source.chmod(0o640)
    original = read(client)
    content = '// updated π\n'
    response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': content, 'revision': original['revision']})
    assert response.status_code == 200
    assert response.json['saved'] is True
    assert response.json['created'] is False
    assert response.json['content'] == content
    assert response.json['revision'] == hashlib.sha256(content.encode()).hexdigest()
    assert source.read_text() == content
    assert stat.S_IMODE(source.stat().st_mode) == 0o640
    assert not list(workspace.glob('.unicorn-editor-*'))


@pytest.mark.skipif(os.geteuid() != 0, reason='Cross-user ownership preservation needs a root-run container')
def test_root_backend_preserves_host_source_ownership(client, workspace):
    source = workspace / 'main.p4'
    os.chown(source, 12345, 12346)
    source.chmod(0o640)
    original = read(client)
    response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': '// updated\n', 'revision': original['revision']})
    assert response.status_code == 200
    info = source.stat()
    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (12345, 12346, 0o640)


@pytest.mark.skipif(os.geteuid() != 0, reason='Cross-user ownership inheritance needs a root-run container')
def test_new_files_and_directories_inherit_the_host_workspace_owner(client, workspace):
    os.chown(workspace, 12345, 12346)
    response = client.post('/workspace/file', json={'path': 'new/includes/types.p4', 'content': '// new\n'})
    assert response.status_code == 201
    for path in (workspace / 'new', workspace / 'new/includes', workspace / 'new/includes/types.p4'):
        assert (path.stat().st_uid, path.stat().st_gid) == (12345, 12346)


def test_stale_save_cannot_overwrite_external_changes(client, workspace):
    original = read(client)
    (workspace / 'main.p4').write_text('// external editor\n')
    response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': '// stale browser\n', 'revision': original['revision']})
    assert response.status_code == 409
    assert response.json['conflict'] is True
    assert (workspace / 'main.p4').read_text() == '// external editor\n'
    assert not list(workspace.glob('.unicorn-editor-*'))


def test_late_external_change_is_detected_before_atomic_replace(client, workspace):
    import api.workspace as module
    original = read(client)
    real_read = module._read
    calls = 0

    def external_edit(directory, name):
        nonlocal calls
        calls += 1
        if calls == 2:
            (workspace / 'main.p4').write_text('// changed while saving\n')
        return real_read(directory, name)

    with patch.object(module, '_read', side_effect=external_edit):
        response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': '// browser\n', 'revision': original['revision']})
    assert response.status_code == 409
    assert (workspace / 'main.p4').read_text() == '// changed while saving\n'
    assert not list(workspace.glob('.unicorn-editor-*'))


def test_create_nested_file_without_overwriting_existing_file(client, workspace):
    path = 'new-project/includes/types.p4'
    response = client.post('/workspace/file', json={'path': path, 'content': '// new include\n', 'revision': None})
    assert response.status_code == 201
    assert response.json['created'] is True
    assert response.json['path'] == path
    assert (workspace / path).read_text() == '// new include\n'
    duplicate = client.post('/workspace/file', json={'path': path, 'content': '// overwrite'})
    assert duplicate.status_code == 409
    assert (workspace / path).read_text() == '// new include\n'


def test_competing_create_does_not_overwrite_the_new_file(client, workspace):
    real_link = os.link

    def competing_link(source, destination, **kwargs):
        (workspace / 'new.p4').write_text('// competing writer\n')
        return real_link(source, destination, **kwargs)

    with patch('api.workspace.os.link', side_effect=competing_link):
        response = client.post('/workspace/file', json={'path': 'new.p4', 'content': '// editor\n'})
    assert response.status_code == 409
    assert (workspace / 'new.p4').read_text() == '// competing writer\n'
    assert not list(workspace.glob('.unicorn-editor-*'))


@pytest.mark.parametrize('path', ['main.json', 'main.p4i', 'main.p4info.txt'])
def test_generated_outputs_are_read_only(client, workspace, path):
    original = read(client, path)
    assert original['read_only'] is True
    response = client.patch('/workspace/file', json={'path': path, 'content': 'changed', 'revision': original['revision']})
    assert response.status_code == 403
    assert (workspace / path).read_text() == original['content']


def test_handwritten_json_is_editable(client, workspace):
    original = read(client, 'parameters.json')
    response = client.patch('/workspace/file', json={'path': 'parameters.json', 'content': '{"parameter": 8}\n', 'revision': original['revision']})
    assert response.status_code == 200
    assert (workspace / 'parameters.json').read_text() == '{"parameter": 8}\n'


def test_generated_json_without_source_is_read_only(client, workspace):
    (workspace / 'main.p4').unlink()
    assert read(client, 'main.json')['read_only'] is True


def test_new_generated_artifacts_cannot_be_created(client, workspace):
    response = client.post('/workspace/file', json={'path': 'other.p4info.txt', 'content': 'pkg_info {}'})
    assert response.status_code == 403
    assert not (workspace / 'other.p4info.txt').exists()


@pytest.mark.parametrize('path', [None, '', '../outside.p4', 'src/../../outside.p4', '/etc/passwd',
                                  'src/../main.p4', 'src//headers.p4', './main.p4', '.secret.p4',
                                  'src/.hidden/file.p4', 'src\\headers.p4', 'main.p4\n', 'private.db',
                                  'bad\x00.p4', [], True])
def test_invalid_paths_are_rejected_for_read_and_create(client, workspace, path):
    response = client.get('/workspace/file', query_string={} if path is None else {'path': path})
    assert response.status_code == 400
    response = client.post('/workspace/file', json={'path': path, 'content': '// file'})
    assert response.status_code == 400


def test_invalid_unicode_paths_have_a_structured_error(client, workspace):
    response = client.post('/workspace/file', json={'path': '\ud800.p4', 'content': '// file'})
    assert response.status_code == 400


def test_symlink_files_and_directories_are_never_followed(client, workspace, tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.p4').write_text('OUTSIDE SECRET')
    (workspace / 'linked.p4').symlink_to(outside / 'secret.p4')
    (workspace / 'external').symlink_to(outside, target_is_directory=True)
    (workspace / 'internal.p4').symlink_to(workspace / 'main.p4')
    rows = client.get('/workspace').json['files']
    assert not any(row['path'] in ('linked.p4', 'internal.p4') or row['path'].startswith('external/') for row in rows)
    for path in ('linked.p4', 'internal.p4', 'external/secret.p4'):
        assert client.get('/workspace/file', query_string={'path': path}).status_code == 400
        assert client.patch('/workspace/file', json={'path': path, 'content': '// bad', 'revision': '0' * 64}).status_code == 400
    assert client.post('/workspace/file', json={'path': 'external/new.p4', 'content': '// bad'}).status_code == 400
    assert (outside / 'secret.p4').read_text() == 'OUTSIDE SECRET'
    assert not (outside / 'new.p4').exists()


def test_fifo_cannot_block_a_workspace_read(client, workspace):
    os.mkfifo(workspace / 'pipe.p4')
    response = client.get('/workspace/file', query_string={'path': 'pipe.p4'})
    assert response.status_code == 400
    assert not any(row['path'] == 'pipe.p4' for row in client.get('/workspace').json['files'])


@pytest.mark.parametrize('content', ['bad\x00data', '\ud800', 3, None, [], {}])
def test_non_text_content_is_rejected_without_a_file(client, workspace, content):
    response = client.post('/workspace/file', json={'path': 'new.p4', 'content': content})
    assert response.status_code == 400
    assert not (workspace / 'new.p4').exists()


def test_file_size_limit_counts_utf8_bytes(client, workspace, monkeypatch):
    monkeypatch.setattr('api.workspace.MAX_FILE_BYTES', 5)
    response = client.post('/workspace/file', json={'path': 'new.p4', 'content': '€€'})
    assert response.status_code == 413
    assert not (workspace / 'new.p4').exists()
    (workspace / 'large.p4').write_bytes(b'x' * 6)
    assert client.get('/workspace/file', query_string={'path': 'large.p4'}).status_code == 413


@pytest.mark.parametrize('content', [b'\xff\xfe', b'hello\x00world'])
def test_non_utf8_and_binary_files_cannot_be_opened(client, workspace, content):
    (workspace / 'binary.p4').write_bytes(content)
    response = client.get('/workspace/file', query_string={'path': 'binary.p4'})
    assert response.status_code == 400
    response = client.patch('/workspace/file', json={'path': 'binary.p4', 'content': '// text', 'revision': hashlib.sha256(content).hexdigest()})
    assert response.status_code == 400
    assert (workspace / 'binary.p4').read_bytes() == content


def test_existing_save_requires_a_revision_and_cannot_create_missing_file(client, workspace):
    for revision in (None, '', 'bad', 0, 'A' * 64):
        response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': '// edited', 'revision': revision})
        assert response.status_code == 400
    response = client.patch('/workspace/file', json={'path': 'missing.p4', 'content': '// new', 'revision': '0' * 64})
    assert response.status_code == 404
    response = client.post('/workspace/file', json={'path': 'new.p4', 'content': '// new', 'revision': '0' * 64})
    assert response.status_code == 400


def test_unwritable_file_remains_read_only(client, workspace):
    source = workspace / 'main.p4'
    source.chmod(0o444)
    original = read(client)
    assert original['read_only'] is True
    response = client.patch('/workspace/file', json={'path': 'main.p4', 'content': '// bad', 'revision': original['revision']})
    assert response.status_code == 403


def test_missing_root_is_empty_and_first_create_initializes_it(client, tmp_path, monkeypatch):
    root = tmp_path / 'new-workspace'
    monkeypatch.setenv('P4_DIR', str(root))
    response = client.get('/workspace')
    assert response.status_code == 200
    assert response.json['files'] == []
    response = client.post('/workspace/file', json={'path': 'main.p4', 'content': '// project'})
    assert response.status_code == 201
    assert (root / 'main.p4').read_text() == '// project'


def test_listing_limit_is_reported(client, workspace, monkeypatch):
    monkeypatch.setattr('api.workspace.MAX_FILES', 2)
    response = client.get('/workspace')
    assert response.status_code == 200
    assert len(response.json['files']) == 2
    assert response.json['truncated'] is True


def test_path_resolver_is_reusable_and_rejects_links(workspace):
    assert resolve_workspace_path('src/headers.p4') == workspace / 'src/headers.p4'
    assert resolve_workspace_path('new/future.p4', must_exist=False) == workspace / 'new/future.p4'
    (workspace / 'link.p4').symlink_to(workspace / 'main.p4')
    with pytest.raises(WorkspaceError) as error:
        resolve_workspace_path('link.p4')
    assert error.value.status == 400


@pytest.mark.parametrize('body', [None, [], 'document'])
def test_non_object_save_requests_have_structured_errors(client, workspace, body):
    response = client.post('/workspace/file', json=body)
    assert response.status_code == 400
    assert 'error' in response.json
