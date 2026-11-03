"""Bounded HTTP transport for the pinned, locally bundled P4 LSP server."""
import atexit
from collections import deque
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import subprocess
import threading
import time
from urllib.parse import unquote, urlsplit

from flask import Blueprint, jsonify, request

from .workspace import MAX_FILE_BYTES, WorkspaceError, resolve_workspace_path, workspace_root

SERVER_REVISION = '48428a3bd9cb5508454eb2db2c73838be4076ffd'
SERVER_NAME = 'p4-vscode-extension'
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_DOCUMENTS = 16
MAX_BUFFER_BYTES = 8 * 1024 * 1024
MAX_SESSIONS = 4
IDLE_SECONDS = 180
REQUEST_TIMEOUT = 5
ALLOWED_METHODS = {'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose',
                   'textDocument/completion', 'completionItem/resolve', 'textDocument/documentHighlight',
                   'workspace/didChangeWatchedFiles', '$/cancelRequest'}


class LanguageError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _server_command():
    script = Path(os.environ.get('P4_LANGUAGE_SERVER', '/opt/p4-language-server/server/out/server.js'))
    node = shutil.which(os.environ.get('NODE_BINARY', 'node'))
    if not node or not script.is_file():
        raise LanguageError(503, 'P4 language server is unavailable in this backend image')
    return [node, '--max-old-space-size=256', str(script), '--stdio']


def _uri_path(uri):
    if not isinstance(uri, str) or len(uri) > 8192:
        raise LanguageError(400, 'Expected a workspace file URI')
    try:
        parsed = urlsplit(uri)
    except ValueError:
        raise LanguageError(400, 'Expected a valid workspace file URI') from None
    if parsed.scheme != 'file' or parsed.netloc or parsed.query or parsed.fragment:
        raise LanguageError(400, 'Only local workspace file URIs are supported')
    try:
        path = Path(unquote(parsed.path, errors='strict'))
        if not path.is_absolute():
            raise ValueError('Expected an absolute path')
        path.as_posix().encode('utf-8')
    except (ValueError, UnicodeError):
        raise LanguageError(400, 'Expected an absolute workspace file URI') from None
    return path


def _document_path(uri, must_exist=True):
    path = _uri_path(uri)
    try:
        relative = path.relative_to(workspace_root()).as_posix()
        resolved = resolve_workspace_path(relative, must_exist=must_exist)
    except (ValueError, UnicodeError, OSError, WorkspaceError):
        raise LanguageError(400, 'Document URI is outside the editable P4 workspace') from None
    if resolved.suffix.lower() not in ('.p4', '.h', '.hpp'):
        raise LanguageError(400, 'Language analysis supports P4 source and include files')
    return resolved


def _text(value):
    if not isinstance(value, str):
        raise LanguageError(400, 'Expected source text')
    try:
        size = len(value.encode('utf-8'))
    except UnicodeEncodeError:
        raise LanguageError(400, 'Source must be valid UTF-8 text') from None
    if size > MAX_FILE_BYTES:
        raise LanguageError(413, 'Document exceeds the language analysis size limit')
    return value


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


class LanguageSession:
    def __init__(self):
        self.id = secrets.token_urlsafe(24)
        self.root = workspace_root()
        self.created = self.last_used = time.monotonic()
        self.operation = threading.Lock()
        self.condition = threading.Condition()
        self.write_lock = threading.Lock()
        self.events = deque(maxlen=64)
        self.responses = {}
        self.pending = set()
        self.documents = {}
        self.barrier = 0
        self.closed = False
        env = {**os.environ, 'UNICORN_P4_WORKSPACE': str(self.root)}
        try:
            self.process = subprocess.Popen(_server_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, cwd=self.root, env=env)
            os.set_blocking(self.process.stdin.fileno(), False)
        except (OSError, WorkspaceError) as error:
            raise LanguageError(503, 'Could not start the P4 language server') from error
        self.reader = threading.Thread(target=self._read, name='p4-language-reader', daemon=True)
        self.reader.start()
        try:
            response = self._exchange([{'jsonrpc': '2.0', 'id': '__unicorn_initialize', 'method': 'initialize', 'params': {
                'processId': None, 'rootUri': self.root.as_uri(),
                'capabilities': {'workspace': {'configuration': False, 'workspaceFolders': False},
                                 'textDocument': {'publishDiagnostics': {'versionSupport': True}}},
                'workspaceFolders': [{'uri': self.root.as_uri(), 'name': 'P4 workspace'}]}}])
            initialize = next(message for message in response if message.get('id') == '__unicorn_initialize')
            if 'error' in initialize:
                raise LanguageError(503, 'P4 language server initialization failed')
            self.capabilities = initialize.get('result', {}).get('capabilities', {})
            self._write({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
        except Exception:
            self.close()
            raise

    def _write(self, message, deadline=None):
        payload = json.dumps(message, separators=(',', ':'), ensure_ascii=False).encode()
        frame = f'Content-Length: {len(payload)}\r\n\r\n'.encode() + payload
        deadline = deadline if deadline is not None else time.monotonic() + REQUEST_TIMEOUT
        if not self.write_lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise LanguageError(503, 'P4 language server write timed out')
        try:
            offset = 0
            while offset < len(frame):
                if self.closed or self.process.poll() is not None:
                    raise LanguageError(503, 'P4 language server stopped; reconnect to resume analysis')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise LanguageError(503, 'P4 language server write timed out')
                descriptor = self.process.stdin.fileno()
                if not select.select([], [descriptor], [], remaining)[1]:
                    raise LanguageError(503, 'P4 language server write timed out')
                try:
                    offset += os.write(descriptor, frame[offset:])
                except BlockingIOError:
                    continue
        except (BrokenPipeError, OSError, ValueError):
            raise LanguageError(503, 'P4 language server connection closed') from None
        finally:
            self.write_lock.release()

    def _read(self):
        try:
            while True:
                headers = {}
                header_size = 0
                while True:
                    line = self.process.stdout.readline(8193)
                    header_size += len(line)
                    if not line or header_size > 8192:
                        return
                    if line in (b'\r\n', b'\n'):
                        break
                    key, value = line.decode('ascii').split(':', 1)
                    headers[key.lower()] = value.strip()
                length = int(headers['content-length'])
                if not 0 < length <= MAX_MESSAGE_BYTES:
                    return
                payload = bytearray()
                while len(payload) < length:
                    chunk = self.process.stdout.read(length - len(payload))
                    if not chunk:
                        return
                    payload.extend(chunk)
                message = json.loads(payload)
                if not isinstance(message, dict):
                    return
                if 'method' in message and 'id' in message:
                    result = None
                    if message['method'] == 'workspace/configuration':
                        items = message.get('params', {}).get('items', [])
                        result = [{'maxNumberOfProblems': 100, 'includePaths': [str(self.root)]} for _ in items[:16]]
                    self._write({'jsonrpc': '2.0', 'id': message['id'], 'result': result})
                    continue
                if message.get('method') == 'textDocument/publishDiagnostics':
                    params = message.get('params', {})
                    try:
                        _document_path(params.get('uri'))
                    except LanguageError:
                        continue
                    diagnostics = params.get('diagnostics')
                    if not isinstance(diagnostics, list):
                        continue
                    params['diagnostics'] = [{**diagnostic, 'message': diagnostic.get('message', '')[:2048]}
                                             for diagnostic in diagnostics[:100]
                                             if isinstance(diagnostic, dict) and isinstance(diagnostic.get('message', ''), str)]
                    with self.condition:
                        self.events.append(message)
                        self.condition.notify_all()
                elif 'id' in message:
                    with self.condition:
                        if message['id'] in self.pending:
                            self.responses[message['id']] = message
                            self.condition.notify_all()
        except (OSError, ValueError, KeyError, TypeError, LanguageError):
            pass
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()
            if self.process.poll() is None:
                self.process.terminate()

    def _exchange(self, messages):
        ids = {message['id'] for message in messages if 'id' in message}
        with self.condition:
            self.pending.update(ids)
        try:
            deadline = time.monotonic() + REQUEST_TIMEOUT
            for message in messages:
                self._write(message, deadline)
            with self.condition:
                while not ids.issubset(self.responses):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or self.closed:
                        self.close()
                        raise LanguageError(503, 'P4 language analysis timed out; reconnect to resume analysis')
                    self.condition.wait(remaining)
                replies = [self.responses.pop(identifier) for identifier in ids]
                replies.extend(self.events)
                self.events.clear()
                return replies
        except LanguageError:
            self.close()
            raise
        finally:
            with self.condition:
                self.pending.difference_update(ids)

    def validate(self, messages):
        if not isinstance(messages, list) or not 1 <= len(messages) <= 32:
            raise LanguageError(400, 'Send between 1 and 32 language messages')
        documents = dict(self.documents)
        ids = set()
        normalized = []
        for message in messages:
            if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
                raise LanguageError(400, 'Expected JSON-RPC 2.0 messages')
            method, params = message.get('method'), message.get('params', {})
            if not isinstance(method, str) or method not in ALLOWED_METHODS or not isinstance(params, dict):
                raise LanguageError(400, 'Unsupported language-server operation')
            notification = method in {'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose', 'workspace/didChangeWatchedFiles', '$/cancelRequest'}
            if notification == ('id' in message):
                raise LanguageError(400, 'Expected a notification or a request ID for this operation')
            identifier = message.get('id')
            if 'id' in message:
                if (not (_integer(identifier) or isinstance(identifier, str) and 0 < len(identifier) <= 128)
                        or str(identifier).startswith('__unicorn_') or identifier in ids):
                    raise LanguageError(400, 'Invalid or duplicate request ID')
                ids.add(identifier)
            if method.startswith('textDocument/'):
                document = params.get('textDocument')
                if not isinstance(document, dict):
                    raise LanguageError(400, 'Expected a textDocument')
                uri = _uri_path(document.get('uri')).as_uri()
                # Closing an already validated buffer does not read the file.
                # Its file may have been removed or replaced outside the editor.
                if method != 'textDocument/didClose' or uri not in documents:
                    uri = _document_path(document.get('uri')).as_uri()
                document = {**document, 'uri': uri}
                params = {**params, 'textDocument': document}
                if method == 'textDocument/didOpen':
                    if uri in documents or not _integer(document.get('version')) or document.get('languageId') != 'p4':
                        raise LanguageError(400, 'Invalid didOpen document')
                    documents[uri] = (document['version'], _text(document.get('text')))
                elif method == 'textDocument/didChange':
                    changes = params.get('contentChanges')
                    if (uri not in documents or not _integer(document.get('version')) or document['version'] <= documents[uri][0]
                            or not isinstance(changes, list) or len(changes) != 1 or not isinstance(changes[0], dict)
                            or 'range' in changes[0]):
                        raise LanguageError(400, 'Send a newer full-content document change')
                    documents[uri] = (document['version'], _text(changes[0].get('text')))
                elif method == 'textDocument/didClose':
                    documents.pop(uri, None)
                else:
                    position = params.get('position')
                    if uri not in documents or not isinstance(position, dict) or not all(_integer(position.get(key)) for key in ('line', 'character')):
                        raise LanguageError(400, 'Expected an open document and valid position')
            elif method == 'workspace/didChangeWatchedFiles':
                changes = params.get('changes')
                if not isinstance(changes, list) or len(changes) > 128:
                    raise LanguageError(400, 'Invalid watched file changes')
                for change in changes:
                    if not isinstance(change, dict) or change.get('type') not in (1, 2, 3):
                        raise LanguageError(400, 'Invalid watched file change')
                    _document_path(change.get('uri'), must_exist=change['type'] != 3)
            if len(documents) > MAX_DOCUMENTS or sum(len(item[1].encode()) for item in documents.values()) > MAX_BUFFER_BYTES:
                raise LanguageError(413, 'Too many open source buffers for language analysis')
            normalized.append({'jsonrpc': '2.0', 'method': method, 'params': params, **({'id': identifier} if 'id' in message else {})})
        return normalized, documents

    def exchange(self, messages):
        with self.operation:
            if self.closed:
                raise LanguageError(410, 'Language session expired; reconnect to resume analysis')
            normalized, documents = self.validate(messages)
            self.barrier += 1
            barrier_id = '__unicorn_barrier_' + str(self.barrier)
            normalized.append({'jsonrpc': '2.0', 'id': barrier_id, 'method': 'unicorn/analysis', 'params': {}})
            result = [message for message in self._exchange(normalized) if message.get('id') != barrier_id]
            self.documents = documents
            self.last_used = time.monotonic()
            return result

    def drain(self):
        with self.condition:
            if self.closed:
                raise LanguageError(410, 'Language session expired; reconnect to resume analysis')
            self.last_used = time.monotonic()
            messages = list(self.events)
            self.events.clear()
            return messages

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        for pipe in (self.process.stdin, self.process.stdout):
            try: pipe.close()
            except (OSError, ValueError): pass


class LanguageRegistry:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self.reaper = None
        self.stopped = threading.Event()
        atexit.register(self.close)

    def _reap(self):
        while not self.stopped.wait(15):
            self.expire()

    def expire(self):
        with self.lock:
            expired = [identifier for identifier, session in self.sessions.items()
                       if session.closed or time.monotonic() - session.last_used > IDLE_SECONDS]
            victims = [self.sessions.pop(identifier) for identifier in expired]
        for session in victims:
            session.close()

    def create(self):
        self.expire()
        with self.lock:
            if len(self.sessions) >= MAX_SESSIONS:
                raise LanguageError(429, 'All P4 language-server sessions are in use; close another editor tab and retry')
            session = LanguageSession()
            self.sessions[session.id] = session
            if self.reaper is None:
                self.reaper = threading.Thread(target=self._reap, name='p4-language-expiry', daemon=True)
                self.reaper.start()
            return session

    def get(self, identifier):
        self.expire()
        with self.lock:
            session = self.sessions.get(identifier)
            if session is not None:
                session.last_used = time.monotonic()
        if session is None:
            raise LanguageError(410, 'Language session expired; reconnect to resume analysis')
        return session

    def delete(self, identifier):
        with self.lock:
            session = self.sessions.pop(identifier, None)
        if session:
            session.close()

    def close(self):
        self.stopped.set()
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            session.close()


def register_language_routes(app):
    registry = LanguageRegistry()
    app.extensions['p4_language_sessions'] = registry
    routes = Blueprint('p4_language_service', __name__)

    @routes.errorhandler(LanguageError)
    def language_error(error):
        return jsonify(error=str(error)), error.status

    @routes.errorhandler(WorkspaceError)
    def workspace_error(error):
        return jsonify(error=str(error)), error.status

    @routes.route('/language/status')
    def status():
        try:
            _server_command()
            available = True
        except LanguageError:
            available = False
        return jsonify(available=available, server={'name': SERVER_NAME, 'version': '0.2.0', 'revision': SERVER_REVISION},
                       features=['syntax diagnostics', 'scoped completion'])

    @routes.route('/language/sessions', methods=['POST'])
    def create_session():
        if request.content_length and request.content_length > 1024:
            raise LanguageError(413, 'Session initialization body is too large')
        payload = request.stream.read(1025)
        if len(payload) > 1024:
            raise LanguageError(413, 'Session initialization body is too large')
        if payload:
            try:
                options = json.loads(payload)
            except (ValueError, UnicodeError):
                raise LanguageError(400, 'Expected an empty JSON object') from None
            if not isinstance(options, dict) or options:
                raise LanguageError(400, 'The language server uses fixed workspace settings')
        session = registry.create()
        return jsonify(session_id=session.id, root_uri=session.root.as_uri(), workspace_root=str(session.root),
                       capabilities=session.capabilities,
                       server={'name': SERVER_NAME, 'version': '0.2.0', 'revision': SERVER_REVISION}), 201

    @routes.route('/language/sessions/<identifier>', methods=['GET', 'POST', 'DELETE'])
    def session_messages(identifier):
        if request.method == 'DELETE':
            registry.delete(identifier)
            return jsonify(closed=True)
        session = registry.get(identifier)
        if request.method == 'GET':
            return jsonify(messages=session.drain())
        payload = request.stream.read(MAX_MESSAGE_BYTES + 1)
        if len(payload) > MAX_MESSAGE_BYTES:
            raise LanguageError(413, 'Language message batch is too large')
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeError):
            raise LanguageError(400, 'Expected a JSON language message batch') from None
        if not isinstance(data, dict) or set(data) != {'messages'}:
            raise LanguageError(400, 'Expected a messages array')
        return jsonify(messages=session.exchange(data['messages']))

    app.register_blueprint(routes)
