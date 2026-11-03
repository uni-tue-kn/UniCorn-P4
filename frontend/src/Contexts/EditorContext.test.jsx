import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { EditorProvider, useEditor } from './EditorContext';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
const root = '/p4';
const recoveryKey = 'unicorn.editor.recovery.v1';
let editor, server;
const revision = letter => letter.repeat(64);
function document(path, content = '// saved\n', extra = {}) {
  return { path, absolute_path: `${root}/${path}`, name: path.split('/').at(-1), content,
    revision: revision('a'), language: path.endsWith('.json') ? 'json' : 'p4', read_only: false, size: content.length, ...extra };
}
function metadata(doc) {
  const { path, absolute_path, name, language, read_only, size } = doc;
  return { path, absolute_path, name, language, read_only, size };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function Probe() {
  editor = useEditor();
  return <pre data-testid="editor-state">{JSON.stringify({ documents: editor.documents, order: editor.order, activePath: editor.activePath })}</pre>;
}
function Pages() {
  const [visible, setVisible] = useState(true);
  return <EditorProvider><button onClick={() => setVisible(value => !value)}>Change page</button>{visible && <Probe />}</EditorProvider>;
}
async function call(method, ...args) {
  let result;
  await act(async () => { result = await editor[method](...args); });
  return result;
}
async function start() {
  render(<EditorProvider><Probe /></EditorProvider>);
  await call('refresh');
}
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  server = new Map([['main.p4', document('main.p4')], ['src/headers.p4', document('src/headers.p4', '// include\n')]]);
  axios.get.mockImplementation((url, options) => {
    if (url === '/workspace') return Promise.resolve({ data: { root, files: [...server.values()].map(metadata) } });
    const found = server.get(options?.params?.path);
    return found ? Promise.resolve({ data: { ...found } }) : Promise.reject({ response: { status: 404, data: { error: 'File not found' } } });
  });
  axios.patch.mockImplementation((url, body) => {
    const saved = { ...server.get(body.path), content: body.content, revision: revision('b') };
    server.set(body.path, saved);
    return Promise.resolve({ data: saved });
  });
  axios.post.mockImplementation((url, body) => {
    if (url === '/compile') return Promise.resolve({ data: { command: ['p4c', body.file, '--target', 'bmv2'], stdout: 'Generated pipeline', stderr: '' } });
    if (server.has(body.path)) return Promise.reject({ response: { status: 409, data: { error: 'A file with this path already exists' } } });
    const saved = document(body.path, body.content);
    server.set(body.path, saved);
    return Promise.resolve({ data: saved });
  });
});

describe('editor workspace and buffers', () => {
  it('opens source metadata and retains unsaved buffers while navigating away', async () => {
    render(<Pages />);
    await call('refresh');
    await call('openFile', 'main.p4');
    act(() => editor.edit('main.p4', '// local draft\n'));
    expect(editor.dirty).toEqual(['main.p4']);
    fireEvent.click(screen.getByRole('button', { name: 'Change page' }));
    expect(screen.queryByTestId('editor-state')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change page' }));
    expect(editor.documents['main.p4'].content).toBe('// local draft\n');
    expect(editor.documents['main.p4'].absolute_path).toBe('/p4/main.p4');
    expect(editor.activePath).toBe('main.p4');
    expect(editor.target).toBe('main.p4');
    await call('openFile', 'main.p4');
    expect(axios.get.mock.calls.filter(([url]) => url === '/workspace/file')).toHaveLength(1);
  });

  it('keeps the most recently selected file active when earlier requests finish late', async () => {
    await start();
    const first = deferred(), second = deferred();
    axios.get.mockImplementation((url, options) => options.params.path === 'main.p4' ? first.promise : second.promise);
    let pendingFirst, pendingSecond;
    act(() => { pendingFirst = editor.openFile('main.p4'); pendingSecond = editor.openFile('src/headers.p4'); });
    await act(async () => { second.resolve({ data: server.get('src/headers.p4') }); await pendingSecond; });
    expect(editor.activePath).toBe('src/headers.p4');
    await act(async () => { first.resolve({ data: server.get('main.p4') }); await pendingFirst; });
    expect(editor.activePath).toBe('src/headers.p4');
    expect(new Set(editor.order)).toEqual(new Set(['main.p4', 'src/headers.p4']));
  });

  it('explicitly activating an open tab wins over a pending file read', async () => {
    await start();
    await call('openFile', 'main.p4');
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    let opening;
    act(() => { opening = editor.openFile('src/headers.p4'); editor.activate('main.p4'); });
    await act(async () => { pending.resolve({ data: server.get('src/headers.p4') }); await opening; });
    expect(editor.activePath).toBe('main.p4');
  });

  it('preserves drafts and the selected workspace when the server root changes', async () => {
    await start();
    await call('openFile', 'main.p4');
    act(() => editor.edit('main.p4', '// keep this\n'));
    axios.get.mockResolvedValueOnce({ data: { root: '/other', files: [] } });
    await call('refresh');
    expect(editor.root).toBe('/p4');
    expect(editor.documents['main.p4'].content).toBe('// keep this\n');
    expect(editor.error).toContain('workspace directory changed');
  });

  it('reads generated files without permitting edits or spurious save requests', async () => {
    server.set('main.json', document('main.json', '{"compiled":true}', { read_only: true }));
    await start();
    await call('openFile', 'main.json');
    act(() => editor.edit('main.json', '{"compiled":false}'));
    expect(editor.documents['main.json'].content).toBe('{"compiled":true}');
    await call('save', 'main.json');
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('keeps an existing draft when creating a duplicate file returns409', async () => {
    await start();
    await call('openFile', 'main.p4');
    act(() => editor.edit('main.p4', '// draft\n'));
    expect(await call('createFile', 'main.p4', '// replacement\n')).toBe(false);
    expect(editor.documents['main.p4'].content).toBe('// draft\n');
    expect(editor.error).toContain('already exists');
    expect(editor.order).toEqual(['main.p4']);
  });

  it('creates a nested file, opens the saved document, and refreshes its tree entry', async () => {
    await start();
    expect(await call('createFile', 'project/includes/types.p4', '// new include\n')).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('/workspace/file', { path: 'project/includes/types.p4', content: '// new include\n', revision: null });
    expect(editor.activePath).toBe('project/includes/types.p4');
    expect(editor.documents[editor.activePath].savedContent).toBe('// new include\n');
    expect(editor.files.some(file => file.path === editor.activePath)).toBe(true);
    expect(editor.dirty).toEqual([]);
  });

  it('refuses new files and copies beyond the recovery and language-server tab limit', async () => {
    await start();
    for (let index = 0; index < 16; index++) await call('createFile', `file-${index}.p4`);
    act(() => editor.edit('file-15.p4', '// newest draft'));
    axios.post.mockClear();
    expect(await call('createFile', 'overflow.p4', '// copy')).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
    expect(editor.order).toHaveLength(16);
    expect(editor.documents['file-15.p4'].content).toBe('// newest draft');
    expect(editor.error).toContain('16 files maximum');
  });

  it('reserves the final tab while a file is loading, including against concurrent creates', async () => {
    await start();
    for (let index = 0; index < 15; index++) await call('createFile', `file-${index}.p4`);
    const pending = deferred();
    axios.get.mockReturnValueOnce(pending.promise);
    let opening;
    act(() => { opening = editor.openFile('main.p4'); });
    expect(await call('openFile', 'src/headers.p4')).toBeNull();
    expect(await call('createFile', 'overflow.p4')).toBe(false);
    await act(async () => { pending.resolve({ data: server.get('main.p4') }); await opening; });
    expect(editor.order).toHaveLength(16);
    await call('closeFile', 'main.p4');
    expect(await call('openFile', 'src/headers.p4')).toMatchObject({ path: 'src/headers.p4' });
    expect(editor.order).toHaveLength(16);
  });
});

describe('saving and recovery', () => {
  it('sends the original revision and keeps a conflicted draft for recovery', async () => {
    await start();
    await call('openFile', 'main.p4');
    act(() => editor.edit('main.p4', '// unsaved π\n'));
    axios.patch.mockRejectedValueOnce({ response: { status: 409, data: { error: 'External edit' } } });
    expect(await call('save', 'main.p4')).toBe(false);
    expect(axios.patch).toHaveBeenCalledWith('/workspace/file', { path: 'main.p4', content: '// unsaved π\n', revision: revision('a') });
    expect(editor.documents['main.p4']).toMatchObject({ content: '// unsaved π\n', savedContent: '// saved\n', revision: revision('a'), conflict: true });
    expect(editor.dirty).toEqual(['main.p4']);
    expect(editor.error).toContain('Your draft is kept');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(recoveryKey)).documents[0].content).toBe('// unsaved π\n');
  });

  it('serializes pending saves and prevents editing or closing the in-flight document', async () => {
    await start();
    await call('openFile', 'main.p4');
    act(() => editor.edit('main.p4', '// submitted\n'));
    const pending = deferred();
    axios.patch.mockReturnValueOnce(pending.promise);
    let saving;
    act(() => { saving = editor.save('main.p4'); });
    expect(editor.busy).toBe(true);
    act(() => { editor.edit('main.p4', '// later edit\n'); editor.closeFile('main.p4'); });
    expect(await call('saveAll')).toBe(false);
    expect(editor.documents['main.p4'].content).toBe('// submitted\n');
    expect(editor.order).toEqual(['main.p4']);
    expect(axios.patch).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ data: { revision: revision('b') } }); await saving; });
    expect(editor.busy).toBe(false);
    expect(editor.dirty).toEqual([]);
    expect(editor.documents['main.p4'].revision).toBe(revision('b'));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(sessionStorage.getItem(recoveryKey)).toBeNull();
  });

  it('recovers a draft as read-only until server metadata verifies its workspace file', async () => {
    sessionStorage.setItem(recoveryKey, JSON.stringify({ root, documents: [{ ...document('main.p4', '// recovered\n'), savedContent: '// saved\n' }], activePath: 'main.p4', target: 'main.p4' }));
    render(<EditorProvider><Probe /></EditorProvider>);
    expect(editor.documents['main.p4']).toMatchObject({ content: '// recovered\n', read_only: true, needsVerification: true });
    expect(await call('save', 'main.p4')).toBe(false);
    expect(axios.patch).not.toHaveBeenCalled();
    await call('refresh');
    expect(editor.documents['main.p4']).toMatchObject({ content: '// recovered\n', read_only: false, needsVerification: false });
    expect(await call('save', 'main.p4')).toBe(true);
    expect(axios.patch).toHaveBeenCalledWith('/workspace/file', { path: 'main.p4', content: '// recovered\n', revision: revision('a') });
  });

  it('keeps a recovered missing file protected so its draft can be saved as a copy', async () => {
    sessionStorage.setItem(recoveryKey, JSON.stringify({ root, documents: [{ ...document('missing.p4', '// recovered\n'), savedContent: '' }], activePath: 'missing.p4' }));
    await start();
    expect(editor.documents['missing.p4'].needsVerification).toBe(true);
    expect(await call('save', 'missing.p4')).toBe(false);
    expect(axios.patch).not.toHaveBeenCalled();
    expect(await call('createFile', 'recovered-copy.p4', editor.documents['missing.p4'].content)).toBe(true);
    expect(editor.documents['recovered-copy.p4'].content).toBe('// recovered\n');
  });

  it('discards malformed or unrelated recovered documents', () => {
    const valid = { ...document('main.p4', '// draft'), savedContent: '// saved' };
    sessionStorage.setItem(recoveryKey, JSON.stringify({ root, documents: [
      { ...valid, path: '../escape.p4' }, { ...valid, absolute_path: '/outside/main.p4' },
      { ...valid, revision: 'invalid' }, { ...valid, read_only: 'false' },
      { ...valid, savedContent: 'x'.repeat(2 * 1024 * 1024 + 1) }, { ...valid, language: null },
    ] }));
    render(<EditorProvider><Probe /></EditorProvider>);
    expect(editor.order).toEqual([]);
    expect(Object.keys(editor.documents)).toEqual([]);
  });
});

describe('Save & Compile', () => {
  it('saves source and include buffers before invoking the compiler', async () => {
    await start();
    await call('openFile', 'main.p4');
    await call('openFile', 'src/headers.p4');
    act(() => { editor.edit('main.p4', '// source changed\n'); editor.edit('src/headers.p4', '// include changed\n'); });
    const first = deferred(), second = deferred();
    axios.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let compiling;
    act(() => { compiling = editor.compile(); });
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    await act(async () => { first.resolve({ data: { revision: revision('b') } }); });
    await waitFor(() => expect(axios.patch).toHaveBeenCalledTimes(2));
    expect(axios.post).not.toHaveBeenCalled();
    await act(async () => { second.resolve({ data: { revision: revision('c') } }); await compiling; });
    expect(axios.patch.mock.calls.map(([, data]) => data.path)).toEqual(['main.p4', 'src/headers.p4']);
    expect(axios.post).toHaveBeenCalledWith('/compile', { file: '/p4/main.p4' });
    expect(editor.compileStatus).toBe('success');
    expect(editor.output).toContain('Generated pipeline');
    expect(editor.dirty).toEqual([]);
  });

  it('does not compile when an included buffer cannot be saved', async () => {
    await start();
    await call('openFile', 'main.p4');
    await call('openFile', 'src/headers.p4');
    act(() => editor.edit('src/headers.p4', '// unsaved include\n'));
    axios.patch.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Changed on disk' } } });
    expect(await call('compile')).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
    expect(editor.documents['src/headers.p4'].content).toBe('// unsaved include\n');
    expect(editor.documents['src/headers.p4'].conflict).toBe(true);
  });

  it('keeps apostrophes intact in source paths and legacy command output', async () => {
    const path = "O'Brien program.p4";
    server.set(path, document(path));
    await start();
    await call('openFile', path);
    const command = `['p4c', "/p4/O'Brien program.p4", '--target', 'bmv2']`;
    axios.post.mockResolvedValueOnce({ data: { command, stdout: '', stderr: "/p4/O'Brien program.p4(4): warning: unused declaration" } });
    expect(await call('compile')).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('/compile', { file: "/p4/O'Brien program.p4" });
    expect(editor.output).toContain(command);
    expect(editor.diagnostics[0]).toMatchObject({ path, line: 4, severity: 'warning' });
  });

  it.each([
    [new Error('Network Error'), 'Network Error'],
    [{ response: { status: 400, data: { error: 'File path is outside the allowed directory' } } }, 'File path is outside the allowed directory'],
  ])('handles compiler errors without command metadata and allows retry (%s)', async (failure, message) => {
    await start();
    await call('openFile', 'main.p4');
    axios.post.mockRejectedValueOnce(failure);
    expect(await call('compile')).toBe(false);
    expect(editor.compileStatus).toBe('error');
    expect(editor.output).toContain(`Error: ${message}`);
    expect(editor.output).not.toContain('Command:');
    expect(editor.busy).toBe(false);
    expect(await call('compile')).toBe(true);
    expect(editor.compileStatus).toBe('success');
  });
});
