"""LSP transport lifecycle, workspace restrictions, and actual upstream behavior."""
from pathlib import Path
import sys
import time

import pytest

from api import language_service as language


FAKE_SERVER = r'''
import json,sys,time

def send(message):
 data=json.dumps(message).encode();sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n'%len(data)).encode()+data);sys.stdout.buffer.flush()
while True:
 headers={}
 while True:
  line=sys.stdin.buffer.readline()
  if not line:sys.exit()
  if line in (b'\r\n',b'\n'):break
  key,value=line.decode().split(':',1);headers[key.lower()]=value.strip()
 data=json.loads(sys.stdin.buffer.read(int(headers['content-length'])))
 method=data.get('method')
 if method=='initialize':send({'jsonrpc':'2.0','id':data['id'],'result':{'capabilities':{'completionProvider':{'resolveProvider':True}}}})
 elif method in ('textDocument/didOpen','textDocument/didChange'):
  doc=data['params']['textDocument']
  if doc.get('text','').startswith('HANG'):time.sleep(30)
  send({'jsonrpc':'2.0','method':'textDocument/publishDiagnostics','params':{'uri':doc['uri'],'version':doc['version'],'diagnostics':[]}})
 elif method=='textDocument/completion':
  if data['params']['position']['line']==999:time.sleep(30)
  send({'jsonrpc':'2.0','id':data['id'],'result':[{'label':'from_server','kind':6}]})
 elif 'id' in data:send({'jsonrpc':'2.0','id':data['id'],'result':True})
'''


@pytest.fixture
def source(tmp_path, monkeypatch):
    root = tmp_path / 'sources'
    root.mkdir()
    path = root / 'hello world.p4'
    path.write_text('struct Header { bit<8> field; }\n')
    monkeypatch.setenv('P4_DIR', str(root))
    return path


@pytest.fixture
def fake_server(tmp_path, monkeypatch):
    path = tmp_path / 'fake_lsp.py'
    path.write_text(FAKE_SERVER)
    monkeypatch.setattr(language, '_server_command', lambda: [sys.executable, str(path)])
    return path


@pytest.fixture
def language_client(client, app, source):
    # Register explicitly if this is run before the root create_app integration.
    if 'p4_language_sessions' not in app.extensions:
        language.register_language_routes(app)
    yield client
    app.extensions['p4_language_sessions'].close()


def create(client):
    response = client.post('/language/sessions', json={})
    assert response.status_code == 201, response.json
    return response.json


def notify(method, path, **fields):
    return {'jsonrpc': '2.0', 'method': 'textDocument/' + method, 'params': {
        'textDocument': {'uri': path.as_uri(), **fields}}}


def post(client, identifier, *messages):
    return client.post('/language/sessions/' + identifier, json={'messages': list(messages)})


def test_session_initializes_and_transports_versioned_events(language_client, source, fake_server):
    client = language_client
    session = create(client)
    assert session['root_uri'] == source.parent.as_uri()
    assert session['capabilities']['completionProvider']['resolveProvider']
    response = post(client, session['session_id'], notify('didOpen', source, languageId='p4', version=1, text='struct Buffer {}'))
    assert response.status_code == 200
    event = next(item for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics')
    assert event['params']['version'] == 1
    response = post(client, session['session_id'], {'jsonrpc': '2.0', 'id': 7, 'method': 'textDocument/completion',
        'params': {'textDocument': {'uri': source.as_uri()}, 'position': {'line': 0, 'character': 0}}})
    assert response.status_code == 200
    assert response.json['messages'] == [{'jsonrpc': '2.0', 'id': 7, 'result': [{'label': 'from_server', 'kind': 6}]}]
    assert source.read_text() == 'struct Header { bit<8> field; }\n'


@pytest.mark.parametrize('uri', ['file:///etc/passwd', 'https://example.invalid/source.p4',
    'file://other-machine/p4/source.p4', 'file:///p4/%2e%2e/source.p4', 'untitled:hello.p4'])
def test_document_uris_cannot_escape_workspace(language_client, fake_server, uri):
    session = create(language_client)
    response = post(language_client, session['session_id'], {'jsonrpc': '2.0', 'method': 'textDocument/didOpen',
        'params': {'textDocument': {'uri': uri, 'languageId': 'p4', 'version': 1, 'text': 'struct X {}'}}})
    assert response.status_code == 400


def test_symlink_documents_and_arbitrary_methods_are_rejected(language_client, source, fake_server):
    linked = source.parent / 'linked.p4'
    linked.symlink_to(source)
    session = create(language_client)
    response = post(language_client, session['session_id'], notify('didOpen', linked, languageId='p4', version=1, text=''))
    assert response.status_code == 400
    for method in ('workspace/executeCommand', 'initialize', 'shutdown', {'invalid': True}):
        response = post(language_client, session['session_id'], {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': {}})
        assert response.status_code == 400


def test_batches_validate_before_forwarding_and_changes_require_new_versions(language_client, source, fake_server, app):
    identifier = create(language_client)['session_id']
    opening = notify('didOpen', source, languageId='p4', version=1, text='struct X {}')
    response = post(language_client, identifier, opening, {'jsonrpc': '2.0', 'id': 2, 'method': 'workspace/executeCommand'})
    assert response.status_code == 400
    assert app.extensions['p4_language_sessions'].get(identifier).documents == {}
    assert post(language_client, identifier, opening).status_code == 200
    change = {'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {
        'textDocument': {'uri': source.as_uri(), 'version': 1}, 'contentChanges': [{'text': 'struct Y {}'}]}}
    assert post(language_client, identifier, change).status_code == 400
    change['params']['textDocument']['version'] = 2
    assert post(language_client, identifier, change).status_code == 200
    assert post(language_client, identifier, notify('didClose', source)).status_code == 200


@pytest.mark.parametrize('replacement', ['missing', 'symlink'])
def test_closing_externally_removed_or_replaced_buffer_keeps_session_usable(language_client, source, fake_server, app, replacement):
    identifier = create(language_client)['session_id']
    assert post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text='struct Header {}')).status_code == 200
    source.unlink()
    outside = source.parent.parent / 'outside.p4'
    outside.write_text('PRIVATE CONTENT')
    if replacement == 'symlink':
        source.symlink_to(outside)
    # Equivalent file-URI spellings normalize to the already validated buffer.
    closing = notify('didClose', source)
    closing['params']['textDocument']['uri'] = source.as_uri().replace('file:///', 'file:/')
    assert post(language_client, identifier, closing).status_code == 200
    assert app.extensions['p4_language_sessions'].get(identifier).documents == {}
    assert outside.read_text() == 'PRIVATE CONTENT'
    next_source = source.parent / 'next.p4'
    next_source.write_text('struct Next {}')
    assert post(language_client, identifier, notify('didOpen', next_source, languageId='p4', version=1, text='struct Next {}')).status_code == 200
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'id': 8, 'method': 'textDocument/completion',
        'params': {'textDocument': {'uri': next_source.as_uri()}, 'position': {'line': 0, 'character': 7}}})
    assert response.status_code == 200
    assert any(item.get('id') == 8 for item in response.json['messages'])


def test_watched_file_deletions_do_not_require_the_file_to_still_exist(language_client, source, fake_server):
    identifier = create(language_client)['session_id']
    source.unlink()
    message = {'jsonrpc': '2.0', 'method': 'workspace/didChangeWatchedFiles', 'params': {'changes': [{'uri': source.as_uri(), 'type': 3}]}}
    assert post(language_client, identifier, message).status_code == 200
    message['params']['changes'][0]['type'] = 2
    assert post(language_client, identifier, message).status_code == 400
    message['params']['changes'][0] = {'uri': 'file:///etc/secret.p4', 'type': 3}
    assert post(language_client, identifier, message).status_code == 400


@pytest.mark.parametrize('uri', ['file:relative.p4', 'file://[invalid/source.p4', 'file:///p4/\ud800.p4'])
def test_malformed_document_uris_are_client_errors(language_client, fake_server, uri):
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'method': 'textDocument/didOpen',
        'params': {'textDocument': {'uri': uri, 'languageId': 'p4', 'version': 1, 'text': ''}}})
    assert response.status_code == 400


def test_sessions_expire_and_delete_reaps_the_process(language_client, source, fake_server, app, monkeypatch):
    identifier = create(language_client)['session_id']
    registry = app.extensions['p4_language_sessions']
    session = registry.get(identifier)
    session.last_used -= language.IDLE_SECONDS + 1
    assert language_client.get('/language/sessions/' + identifier).status_code == 410
    assert session.process.poll() is not None
    identifier = create(language_client)['session_id']
    session = registry.get(identifier)
    assert language_client.delete('/language/sessions/' + identifier).status_code == 200
    assert session.process.poll() is not None
    assert language_client.delete('/language/sessions/' + identifier).status_code == 200


def test_request_timeout_terminates_server(language_client, source, fake_server, monkeypatch, app):
    identifier = create(language_client)['session_id']
    assert post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text='struct X {}')).status_code == 200
    session = app.extensions['p4_language_sessions'].get(identifier)
    monkeypatch.setattr(language, 'REQUEST_TIMEOUT', 0.1)
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'id': 1, 'method': 'textDocument/completion',
        'params': {'textDocument': {'uri': source.as_uri()}, 'position': {'line': 999, 'character': 0}}})
    assert response.status_code == 503
    assert session.process.poll() is not None


def test_blocked_stdin_write_has_the_same_request_deadline(language_client, source, fake_server, monkeypatch, app):
    identifier = create(language_client)['session_id']
    session = app.extensions['p4_language_sessions'].get(identifier)
    second = source.parent / 'second.p4'
    second.write_text('struct Other {}')
    monkeypatch.setattr(language, 'REQUEST_TIMEOUT', 0.1)
    before = time.monotonic()
    response = post(language_client, identifier,
                    notify('didOpen', source, languageId='p4', version=1, text='HANG'),
                    notify('didOpen', second, languageId='p4', version=1, text='x' * 1024 * 1024))
    assert response.status_code == 503
    assert time.monotonic() - before < 3
    assert session.process.poll() is not None


def test_invalid_utf8_and_oversized_buffers_are_rejected(language_client, source, fake_server):
    identifier = create(language_client)['session_id']
    for text, status in [('\ud800', 400), ('x' * (language.MAX_FILE_BYTES + 1), 413)]:
        assert post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=text)).status_code == status


def test_server_capacity_is_bounded(language_client, source, fake_server, monkeypatch):
    monkeypatch.setattr(language, 'MAX_SESSIONS', 2)
    create(language_client)
    create(language_client)
    assert language_client.post('/language/sessions', json={}).status_code == 429


def test_session_settings_cannot_select_a_command(language_client, fake_server, app):
    response = language_client.post('/language/sessions', json={'command': ['anything']})
    assert response.status_code == 400
    assert app.extensions['p4_language_sessions'].sessions == {}


def test_unavailable_server_is_explicit(language_client, source, monkeypatch):
    def missing():
        raise language.LanguageError(503, 'P4 language server is unavailable in this backend image')
    monkeypatch.setattr(language, '_server_command', missing)
    assert language_client.get('/language/status').json['available'] is False
    assert language_client.post('/language/sessions', json={}).status_code == 503


def test_real_bundled_server_handles_unsaved_sources_and_includes(language_client, source):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Bundled upstream server is exercised in the backend image/browser integration suite')
    client = language_client
    identifier = create(client)['session_id']
    uri = source.as_uri()
    content = 'struct Header { bit<8> field; }\ncontrol Main(inout Header hdr) {\n bit<8> from_buffer;\n apply { from_buffer = 1; }\n}\n'
    response = post(client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json
    diagnostics = [item['params'] for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics']
    assert any(item['uri'] == uri and item['version'] == 1 and item['diagnostics'] == [] for item in diagnostics)
    completion = {'jsonrpc': '2.0', 'id': 10, 'method': 'textDocument/completion',
        'params': {'textDocument': {'uri': uri}, 'position': {'line': 3, 'character': 9}}}
    response = post(client, identifier, completion)
    assert response.status_code == 200, response.json
    assert 'from_buffer' in [item['label'] for item in next(item['result'] for item in response.json['messages'] if item.get('id') == 10)]
    include = source.parent / 'include space.p4'
    include.write_text('struct Header { bit<8> on_disk; }\n')
    assert post(client, identifier, notify('didOpen', include, languageId='p4', version=1,
        text='struct Header { bit<8> from_include_buffer; }\n')).status_code == 200
    content = '#include "include space.p4"\ncontrol Main(inout Header hdr) {\n bit<8> other;\n apply { hdr.from_include_buffer = 1; }\n}\n'
    change = {'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {
        'textDocument': {'uri': uri, 'version': 2}, 'contentChanges': [{'text': content}]}}
    response = post(client, identifier, change)
    assert response.status_code == 200, response.json
    completion['id'] = 11
    completion['params']['position'] = {'line': 3, 'character': content.splitlines()[3].index('hdr.') + 4}
    response = post(client, identifier, completion)
    assert response.status_code == 200, response.json
    assert 'from_include_buffer' in [item['label'] for item in next(item['result'] for item in response.json['messages'] if item.get('id') == 11)]
    change['params']['textDocument']['version'] = 3
    change['params']['contentChanges'][0]['text'] = 'this is not valid P4;'
    response = post(client, identifier, change)
    assert any(item.get('params', {}).get('version') == 3 and item['params']['diagnostics'] for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics')
    change['params']['textDocument']['version'] = 4
    change['params']['contentChanges'][0]['text'] = content
    response = post(client, identifier, change)
    assert any(item.get('params', {}).get('version') == 4 and item['params']['diagnostics'] == [] for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics')
    outside = source.parent.parent / 'outside.p4'
    outside.write_text('UNREADABLE_PRIVATE_TOKEN')
    hidden = source.parent / '.hidden.p4'
    hidden.write_text('UNREADABLE_PRIVATE_TOKEN')
    for version, requested in ((5, '../outside.p4'), (6, '.hidden.p4')):
        change['params']['textDocument']['version'] = version
        change['params']['contentChanges'][0]['text'] = '#include "' + requested + '"\nstruct Header { bit<8> field; }'
        response = post(client, identifier, change)
        assert response.status_code == 200, response.json
        errors = [item for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics']
        assert any('Cannot find include file' in diagnostic['message'] for item in errors for diagnostic in item['params']['diagnostics'])
        assert 'UNREADABLE_PRIVATE_TOKEN' not in str(errors)
    change['params']['textDocument']['version'] = 7
    change['params']['contentChanges'][0]['text'] = (Path(__file__).resolve().parents[1] / 'fixtures/resources.p4').read_text()
    response = post(client, identifier, change)
    assert response.status_code == 200, response.json
    assert any(item.get('params', {}).get('version') == 7 and not item['params']['diagnostics'] for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics')
    assert source.read_text() == 'struct Header { bit<8> field; }\n'
    assert 'on_disk' in include.read_text()


@pytest.mark.parametrize('main_name,include_name', [
    ("O'Brien.p4", "header's.h"),
    ('main#fragment.p4', 'header#field.hpp'),
    ('main space ü.p4', 'header space ß.p4'),
    ('symbols!$&()*+,;=@[].p4', 'fields!$&()*+,;=@[].h'),
    ('percent%25.p4', 'header%value.p4'),
])
def test_real_server_preserves_special_character_document_uris(language_client, source, main_name, include_name):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Bundled upstream server is exercised in the backend image/browser integration suite')
    directory = source.parent / "nested O'Brien # ü"
    directory.mkdir()
    main, include = directory / main_name, directory / include_name
    main.write_text('struct DiskOnly { bit<8> saved; }\n')
    include.write_text('struct Header { bit<8> saved_field; }\n')
    client = language_client
    identifier = create(client)['session_id']
    header = 'struct Header { bit<8> unsaved_field; }\n'
    assert post(client, identifier, notify('didOpen', include, languageId='p4', version=1, text=header)).status_code == 200
    content = f'#include "{include_name}"\ncontrol Main(inout Header hdr) {{\n apply {{ hdr.unsaved_field = 1; }}\n}}\n'
    response = post(client, identifier, notify('didOpen', main, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json

    def diagnostics(response):
        assert response.status_code == 200, response.json
        messages = [item['params'] for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics']
        assert all(item['uri'] in (main.as_uri(), include.as_uri()) for item in messages)
        return messages

    assert any(item['uri'] == main.as_uri() and item['version'] == 1 and item['diagnostics'] == [] for item in diagnostics(response))
    completion = {'jsonrpc': '2.0', 'id': 20, 'method': 'textDocument/completion', 'params': {
        'textDocument': {'uri': main.as_uri()},
        'position': {'line': 2, 'character': content.splitlines()[2].index('hdr.') + 4}}}
    response = post(client, identifier, completion)
    assert response.status_code == 200, response.json
    labels = [item['label'] for item in next(item['result'] for item in response.json['messages'] if item.get('id') == 20)]
    assert 'unsaved_field' in labels and 'saved_field' not in labels

    def change(path, version, text):
        return post(client, identifier, {'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {
            'textDocument': {'uri': path.as_uri(), 'version': version}, 'contentChanges': [{'text': text}]}})

    errors = diagnostics(change(main, 2, 'this is not valid P4;'))
    assert any(item['uri'] == main.as_uri() and item['version'] == 2 and item['diagnostics'] for item in errors)
    cleared = diagnostics(change(main, 3, content))
    assert any(item['uri'] == main.as_uri() and item['version'] == 3 and item['diagnostics'] == [] for item in cleared)
    errors = diagnostics(change(include, 2, 'this is not valid P4;'))
    assert any(item['uri'] == include.as_uri() and item['version'] == 2 and item['diagnostics'] for item in errors)
    cleared = diagnostics(change(include, 3, 'struct Header { bit<8> recovered_field; }\n'))
    assert any(item['uri'] == include.as_uri() and item['version'] == 3 and item['diagnostics'] == [] for item in cleared)
    completion['id'] = 21
    response = post(client, identifier, completion)
    assert response.status_code == 200, response.json
    labels = [item['label'] for item in next(item['result'] for item in response.json['messages'] if item.get('id') == 21)]
    assert 'recovered_field' in labels and 'saved_field' not in labels
    assert main.read_text() == 'struct DiskOnly { bit<8> saved; }\n'
    assert include.read_text() == 'struct Header { bit<8> saved_field; }\n'


@pytest.mark.parametrize('parent_first', [False, True])
def test_real_server_analyzes_open_includes_in_parent_context_and_clears_diagnostics(language_client, source, parent_first):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Requires the bundled upstream language server')
    include = source.parent / 'types.h'
    include.write_text('struct Header {\n FIELDS\n}\n')
    content = '#define FIELDS bit<8> foo;\n#include "types.h"\ncontrol Main(inout Header hdr) { apply { hdr.foo = 1; } }\n'
    source.write_text(content)
    identifier = create(language_client)['session_id']

    def diagnostics(response, path):
        assert response.status_code == 200, response.json
        values = [message['params'] for message in response.json['messages']
                  if message.get('method') == 'textDocument/publishDiagnostics'
                  and message['params']['uri'] == path.as_uri()]
        assert values, response.json
        return values[-1]['diagnostics']

    if parent_first:
        post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
        response = post(language_client, identifier, notify('didOpen', include, languageId='p4', version=1, text=include.read_text()))
    else:
        response = post(language_client, identifier, notify('didOpen', include, languageId='p4', version=1, text=include.read_text()))
        assert diagnostics(response, include)  # FIELDS has no definition without a parent.
        response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert diagnostics(response, include) == []

    assert diagnostics(response, source) == []

    def change(path, version, text):
        return post(language_client, identifier, {'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {
            'textDocument': {'uri': path.as_uri(), 'version': version}, 'contentChanges': [{'text': text}]}})

    assert diagnostics(change(include, 2, 'struct Header {\n bit<8> broken\n}\n'), include)
    assert diagnostics(change(include, 3, include.read_text()), include) == []
    # Another parent can contribute a real error; a successful reparse must clear it.
    second = source.parent / 'second.p4'
    second.write_text('#include "types.h"\n')
    response = post(language_client, identifier, notify('didOpen', second, languageId='p4', version=1, text=second.read_text()))
    assert diagnostics(response, include)
    assert diagnostics(change(second, 2, '#define FIELDS bit<8> bar;\n#include "types.h"\n'), include) == []
    # Closing all parents restores standalone analysis rather than retaining their macros.
    post(language_client, identifier, notify('didClose', second))
    response = post(language_client, identifier, notify('didClose', source))
    assert diagnostics(response, include)
    response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert diagnostics(response, include) == []


def test_real_server_include_fragment_completion_uses_parent_scope(language_client, source):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Requires the bundled upstream language server')
    include = source.parent / 'body.h'
    include.write_text(' local = 1;\n')
    source.write_text('control Main() {\n bit<8> local;\n apply {\n#include "body.h"\n }\n}\n')
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier,
                    notify('didOpen', source, languageId='p4', version=1, text=source.read_text()),
                    notify('didOpen', include, languageId='p4', version=1, text=include.read_text()))
    assert response.status_code == 200, response.json
    assert all(not message['params']['diagnostics'] for message in response.json['messages']
               if message.get('method') == 'textDocument/publishDiagnostics')
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'id': 31, 'method': 'textDocument/completion', 'params': {
        'textDocument': {'uri': include.as_uri()}, 'position': {'line': 0, 'character': 1}}})
    assert response.status_code == 200, response.json
    labels = [item['label'] for item in next(message['result'] for message in response.json['messages'] if message.get('id') == 31)]
    assert 'local' in labels


def test_real_server_reports_many_unopened_include_errors_without_flooding_events(language_client, source):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Requires the bundled upstream language server')
    includes = [source.parent / f'header_{index}.h' for index in range(70)]
    for index, include in enumerate(includes):
        include.write_text(f'struct Header{index} {{ bit<8> field }}\n')
    content = ''.join(f'#include "{include.name}"\n' for include in includes)
    source.write_text(content)
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json
    events = [message['params'] for message in response.json['messages'] if message.get('method') == 'textDocument/publishDiagnostics']
    assert len(events) == 1
    assert events[0]['uri'] == source.as_uri() and events[0]['version'] == 1
    assert 1 <= len(events[0]['diagnostics']) <= 100
    assert all(diagnostic['relatedInformation'][0]['location']['uri'] in {include.as_uri() for include in includes}
               for diagnostic in events[0]['diagnostics'])
    for index, include in enumerate(includes):
        include.write_text(f'struct Header{index} {{ bit<8> field; }}\n')
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'method': 'workspace/didChangeWatchedFiles', 'params': {
        'changes': [{'uri': include.as_uri(), 'type': 2} for include in includes]}})
    assert response.status_code == 200, response.json
    events = [message['params'] for message in response.json['messages'] if message.get('method') == 'textDocument/publishDiagnostics']
    assert events == [{'uri': source.as_uri(), 'version': 1, 'diagnostics': []}]


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
def test_real_server_maps_exact_diagnostics_and_completion_for_line_endings(language_client, source, newline):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Requires the bundled upstream language server')
    content = newline.join(['// pad'] * 100 + [
        'control A() {', ' bit<8> alpha;', ' apply { alpha = 1; }', '}',
        'control B() {', ' bit<8> beta;', ' apply { beta = 1; }', '}', ''])
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'id': 30, 'method': 'textDocument/completion', 'params': {
        'textDocument': {'uri': source.as_uri()}, 'position': {'line': 102, 'character': 10}}})
    assert response.status_code == 200, response.json
    labels = [item['label'] for item in next(message['result'] for message in response.json['messages'] if message.get('id') == 30)]
    assert 'alpha' in labels and 'beta' not in labels
    invalid = newline.join(['// pad'] * 20 + ['struct Header {', ' bit<8> field;', ' BROKEN', '}', ''])
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {
        'textDocument': {'uri': source.as_uri(), 'version': 2}, 'contentChanges': [{'text': invalid}]}})
    assert response.status_code == 200, response.json
    diagnostics = next(message['params']['diagnostics'] for message in response.json['messages']
                       if message.get('method') == 'textDocument/publishDiagnostics'
                       and message['params']['uri'] == source.as_uri() and message['params']['version'] == 2)
    assert diagnostics
    assert diagnostics[0]['range']['start'] == {'line': 23, 'character': 0}


@pytest.mark.parametrize('header,define,expected', [
    ('tna.p4', '', 'native_one'),
    ('tna.p4', '#define __TARGET_TOFINO__ 2\n', 'native_two'),
    ('t2na.p4', '', 'native_two'),
    ('v1model.p4', '', 'standard_target'),
])
def test_real_server_bundled_architecture_headers_preserve_target_defines(language_client, source, header, define, expected):
    try:
        command = language._server_command()
    except language.LanguageError:
        pytest.skip('Bundled upstream server is exercised in the backend image')
    includes = Path(command[2]).parents[2] / 'p4include'
    if not (includes / header).is_file():
        pytest.skip('Official architecture headers are installed by the optional backend image')
    content = define + f'#include <core.p4>\n#include <{header}>\n' + '''control Main() {
#if __TARGET_TOFINO__ == 1
 bit<8> native_one;
#elif __TARGET_TOFINO__ == 2
 bit<8> native_two;
#else
 bit<8> standard_target;
#endif
 apply {
 }
}
'''
    source.write_text(content)
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json
    diagnostics = [diagnostic for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics'
                   for diagnostic in item['params']['diagnostics']]
    assert diagnostics == [], diagnostics
    line = content.splitlines().index(' apply {') + 1
    response = post(language_client, identifier, {'jsonrpc': '2.0', 'id': 31, 'method': 'textDocument/completion',
        'params': {'textDocument': {'uri': source.as_uri()}, 'position': {'line': line, 'character': 1}}})
    assert response.status_code == 200, response.json
    labels = [item['label'] for item in next(item['result'] for item in response.json['messages'] if item.get('id') == 31)]
    assert expected in labels
    assert not ({'native_one', 'native_two', 'standard_target'} - {expected}) & set(labels)


def test_real_server_reports_only_active_preprocessor_errors(language_client, source):
    try:
        language._server_command()
    except language.LanguageError:
        pytest.skip('Bundled upstream server is exercised in the backend image')
    content = '#if 0\n#error inactive target branch\n#endif\n#error active target error\nstruct Header { bit<8> field; }\n'
    source.write_text(content)
    identifier = create(language_client)['session_id']
    response = post(language_client, identifier, notify('didOpen', source, languageId='p4', version=1, text=content))
    assert response.status_code == 200, response.json
    diagnostics = [diagnostic for item in response.json['messages'] if item.get('method') == 'textDocument/publishDiagnostics'
                   for diagnostic in item['params']['diagnostics']]
    assert [diagnostic['message'] for diagnostic in diagnostics] == ['active target error']
