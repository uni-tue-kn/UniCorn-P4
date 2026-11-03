import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { P4LanguageClient } from './languageClient';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } } }));
let clients;
beforeEach(() => {
  vi.resetAllMocks(); clients = [];
  axios.defaults.baseURL = '/api';
  axios.get.mockResolvedValue({ data: { messages: [] } });
  axios.delete.mockResolvedValue({ data: { closed: true } });
  axios.post.mockImplementation((url, body) => Promise.resolve({ data: url === '/language/sessions'
    ? { session_id: 'session', capabilities: { completionProvider: { resolveProvider: true } }, server: { name: 'P4' } }
    : { messages: body.messages.filter(message => message.id != null).map(message => ({ jsonrpc: '2.0', id: message.id, result: [{ label: 'header' }] })) } }));
});
afterEach(() => { for (const client of clients) client.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function client() { const callbacks = { onStatus: vi.fn(), onDiagnostics: vi.fn() }; const value = new P4LanguageClient(callbacks); clients.push(value); return { value, ...callbacks }; }
const uri = 'file:///p4/main.p4';
function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function numberedSessions() {
  let sequence = 0;
  const original = axios.post.getMockImplementation();
  axios.post.mockImplementation((url, body, options) => url === '/language/sessions'
    ? Promise.resolve({ data: { session_id: `session-${++sequence}`, capabilities: {}, server: { name: 'P4' } } })
    : original(url, body, options));
}

it('synchronizes unsaved content before completion and closes documents removed from the editor', async () => {
  const { value } = client(); await value.ready;
  value.sync([{ uri, text: 'header A {}' }]); await value.flush();
  value.sync([{ uri, text: 'header B {}' }]);
  expect(await value.request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 7 } })).toEqual([{ label: 'header' }]);
  const messages = axios.post.mock.calls.flatMap(([, body]) => body.messages || []);
  expect(messages[0]).toMatchObject({ method: 'textDocument/didOpen', params: { textDocument: { uri, version: 1, text: 'header A {}' } } });
  expect(messages[1]).toMatchObject({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'header B {}' }] } });
  expect(messages[2].method).toBe('textDocument/completion');
  value.sync([]); await value.flush();
  expect(axios.post.mock.calls.at(-1)[1].messages).toEqual([{ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }]);
});

it('drops diagnostics for older unsaved versions and closed files', async () => {
  const { value, onDiagnostics } = client(); await value.ready;
  value.sync([{ uri, text: 'first' }]); value.sync([{ uri, text: 'second' }]);
  onDiagnostics.mockClear();
  value.receive([{ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ message: 'stale' }] } }]);
  expect(onDiagnostics).not.toHaveBeenCalled();
  value.receive([{ method: 'textDocument/publishDiagnostics', params: { uri, version: 2, diagnostics: [] } }]);
  expect(onDiagnostics).toHaveBeenCalledWith({ uri, version: 2, diagnostics: [] });
  value.sync([]); onDiagnostics.mockClear();
  value.receive([{ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'closed' }] } }]);
  expect(onDiagnostics).not.toHaveBeenCalled();
});

it('cleans up a session whose creation finishes after the editor closes', async () => {
  let finish;
  axios.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { value } = client(); value.dispose();
  finish({ data: { session_id: 'late' } }); await value.ready;
  expect(axios.delete).toHaveBeenCalledWith('/language/sessions/late');
  expect(axios.get).not.toHaveBeenCalled();
});

it('reports an unavailable server without preventing ordinary editing', async () => {
  axios.post.mockRejectedValueOnce({ response: { data: { error: 'Server not installed' } } });
  const { value, onStatus } = client();
  expect(await value.ready).toBe(false);
  expect(onStatus).toHaveBeenLastCalledWith({ state: 'unavailable', message: 'Server not installed' });
  value.sync([{ uri, text: '// user work' }]);
  expect(await value.request('textDocument/completion', {})).toBeNull();
});

it('reconnects with fresh didOpen messages containing the latest unsaved buffers', async () => {
  vi.useFakeTimers();
  numberedSessions();
  const { value } = client(); await value.ready;
  value.sync([{ uri, text: '// original buffer' }]); await value.flush();
  value.sync([{ uri, text: '// latest unsaved buffer' }, { uri: 'file:///p4/src/types.p4', text: '// unsaved include' }]);
  expect(await value.reconnect()).toBe(true);
  expect(axios.delete).toHaveBeenCalledWith('/language/sessions/session-1');
  const reopened = axios.post.mock.calls.filter(([url]) => url === '/language/sessions/session-2').flatMap(([, body]) => body.messages);
  expect(reopened).toEqual([
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'p4', version: 2, text: '// latest unsaved buffer' } } },
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///p4/src/types.p4', languageId: 'p4', version: 1, text: '// unsaved include' } } },
  ]);
});

it.each([410, 500])('does not mark a reconnected session unavailable when an older poll fails late with HTTP%s', async status => {
  vi.useFakeTimers();
  numberedSessions();
  const oldPoll = deferred();
  axios.get.mockReturnValueOnce(oldPoll.promise);
  const { value, onStatus } = client(); await value.ready;
  expect(await value.reconnect()).toBe(true);
  onStatus.mockClear();
  oldPoll.reject({ response: { status, data: { error: 'Old session expired' } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(onStatus).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(800);
  expect(axios.get.mock.calls.map(([url]) => url)).toEqual([
    '/language/sessions/session-1', '/language/sessions/session-2', '/language/sessions/session-2',
  ]);
});

it('ignores diagnostics arriving from a successful old poll after reconnecting', async () => {
  vi.useFakeTimers();
  numberedSessions();
  const oldPoll = deferred();
  axios.get.mockReturnValueOnce(oldPoll.promise);
  const { value, onDiagnostics } = client(); await value.ready;
  value.sync([{ uri, text: '// draft' }]); await value.flush();
  await value.reconnect();
  onDiagnostics.mockClear();
  oldPoll.resolve({ data: { messages: [{ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ message: 'Stale old-session diagnostic' }] } }] } });
  await vi.advanceTimersByTimeAsync(0);
  expect(onDiagnostics).not.toHaveBeenCalled();
});

it('cleans up a superseded session initialization without replacing the newer session', async () => {
  vi.useFakeTimers();
  numberedSessions();
  const oldCreation = deferred();
  axios.post.mockImplementationOnce(() => oldCreation.promise);
  const { value, onStatus } = client();
  const originalReady = value.ready;
  expect(await value.reconnect()).toBe(true);
  onStatus.mockClear();
  oldCreation.resolve({ data: { session_id: 'old-initialization', capabilities: {} } });
  expect(await originalReady).toBe(false);
  expect(axios.delete).toHaveBeenCalledWith('/language/sessions/old-initialization');
  expect(axios.get.mock.calls.map(([url]) => url)).toEqual(['/language/sessions/session-1']);
  expect(onStatus).not.toHaveBeenCalled();
});

it('rejects outstanding requests on reconnect and clears their timeout timers', async () => {
  vi.useFakeTimers();
  numberedSessions();
  const { value } = client(); await value.ready;
  axios.post.mockResolvedValueOnce({ data: { messages: [] } });
  const pending = value.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } });
  const rejection = expect(pending).rejects.toThrow('Language server reconnected.');
  await vi.advanceTimersByTimeAsync(0);
  expect(await value.reconnect()).toBe(true);
  await rejection;
  value.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not apply queued diagnostics from an in-flight old request to the new session', async () => {
  vi.useFakeTimers();
  numberedSessions();
  const { value, onDiagnostics } = client(); await value.ready;
  value.sync([{ uri, text: '// draft' }]); await value.flush();
  const oldRequest = deferred();
  axios.post.mockReturnValueOnce(oldRequest.promise);
  const request = value.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } });
  const rejection = expect(request).rejects.toThrow('Language server reconnected.');
  await vi.advanceTimersByTimeAsync(0);
  await value.reconnect();
  onDiagnostics.mockClear();
  oldRequest.resolve({ data: { messages: [{ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ message: 'Old request diagnostic' }] } }] } });
  await rejection;
  expect(onDiagnostics).not.toHaveBeenCalled();
});

it('releases the active session with keepalive on pagehide and removes its handlers and timers', async () => {
  vi.useFakeTimers();
  const keepalive = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', keepalive);
  axios.defaults.baseURL = '/proxy/api/';
  const remove = vi.spyOn(window, 'removeEventListener');
  const { value } = client(); await value.ready;
  value.sync([{ uri, text: '// unsaved buffer' }]);
  const calls = axios.get.mock.calls.length;
  window.dispatchEvent(new Event('pagehide'));
  expect(keepalive).toHaveBeenCalledExactlyOnceWith('/proxy/api/language/sessions/session', { method: 'DELETE', keepalive: true });
  expect(axios.delete).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('pagehide', value.onPageHide);
  expect(vi.getTimerCount()).toBe(0);
  window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(keepalive).toHaveBeenCalledTimes(1);
  expect(axios.get).toHaveBeenCalledTimes(calls);
});

it('keeps the session and unsaved buffers alive when pagehide enters the back-forward cache', async () => {
  vi.useFakeTimers();
  const keepalive = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', keepalive);
  const { value } = client(); await value.ready;
  value.sync([{ uri, text: '// still unsaved' }]); await value.flush();
  const hiding = new Event('pagehide');
  Object.defineProperty(hiding, 'persisted', { value: true });
  window.dispatchEvent(hiding);
  expect(keepalive).not.toHaveBeenCalled();
  expect(axios.delete).not.toHaveBeenCalled();
  expect(await value.request('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } })).toEqual([{ label: 'header' }]);
  expect(axios.post.mock.calls.flatMap(([, body]) => body.messages || []).find(message => message.method === 'textDocument/didOpen').params.textDocument.text).toBe('// still unsaved');
});
