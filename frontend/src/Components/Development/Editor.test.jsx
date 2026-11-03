import React, { useEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import Editor from './Editor';
import { EditorProvider } from '../../Contexts/EditorContext';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('./MonacoEditor', () => ({ default: function MockEditor(props) {
  useEffect(() => props.onStatus({ state: 'ready' }), [props.onStatus]);
  const doc = props.documents.find(item => item.path === props.activePath);
  return doc ? <textarea aria-label={`${doc.path} editor`} value={doc.content} readOnly={props.readOnly} onChange={event => props.onChange(doc.path, event.target.value)} /> : null;
} }));
const revision = 'a'.repeat(64);
let files;
beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  window.matchMedia.mockImplementation(query => ({ matches: query === '(min-width:900px)', media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  files = { 'main.p4': { content: '// source', language: 'p4' }, 'includes/headers.p4': { content: '// header', language: 'p4' }, 'main.json': { content: '{}', read_only: true, language: 'json' } };
  const data = path => ({ path, name: path.split('/').at(-1), absolute_path: '/p4/' + path, revision, read_only: false, ...files[path] });
  axios.get.mockImplementation((url, config) => Promise.resolve({ data: url === '/workspace' ? { root: '/p4', files: Object.keys(files).map(data) } : data(config.params.path) }));
  axios.patch.mockResolvedValue({ data: { revision: 'b'.repeat(64) } });
  axios.post.mockImplementation((url, body) => {
    if (url === '/compile') return Promise.resolve({ data: { command: ['p4c', body.file], stdout: 'Generated pipeline', stderr: '' } });
    files[body.path] = { content: body.content, language: body.path.endsWith('.p4') ? 'p4' : 'plaintext' };
    return Promise.resolve({ data: data(body.path) });
  });
});
const mount = () => render(<EditorProvider><Editor /></EditorProvider>);

it('opens source and include files, retains drafts while switching tabs, and saves through the workspace API', async () => {
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.p4' }));
  const source = await screen.findByRole('textbox', { name: 'main.p4 editor' });
  await user.type(source, '\n// edited');
  await user.click(screen.getByRole('button', { name: 'Open includes/headers.p4' }));
  expect(await screen.findByRole('textbox', { name: 'includes/headers.p4 editor' })).toHaveValue('// header');
  await user.click(screen.getByRole('tab', { name: 'Switch to main.p4' }));
  expect(screen.getByRole('textbox', { name: 'main.p4 editor' })).toHaveValue('// source\n// edited');
  await user.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/workspace/file', { path: 'main.p4', content: '// source\n// edited', revision }));
  expect(await screen.findByText('File saved.')).toBeVisible();
});

it('preserves a conflicting draft and can save it as a separate file', async () => {
  axios.patch.mockRejectedValue({ response: { status: 409, data: { error: 'File changed' } } });
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.p4' }));
  await user.type(await screen.findByRole('textbox', { name: 'main.p4 editor' }), '\n// my work');
  await user.click(screen.getByRole('button', { name: 'Save', exact: true }));
  expect(await screen.findByText(/changed outside this editor/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'main.p4 editor' })).toHaveValue('// source\n// my work');
  await user.click(screen.getByRole('button', { name: 'Save file copy' }));
  const dialog = screen.getByRole('dialog', { name: 'Save a file copy' });
  expect(within(dialog).getByRole('textbox', { name: 'File path' })).toHaveValue('main-copy.p4');
  await user.click(within(dialog).getByRole('button', { name: 'Save copy' }));
  expect(await screen.findByRole('textbox', { name: 'main-copy.p4 editor' })).toHaveValue('// source\n// my work');
});

it('requires an explicit choice before discarding unsaved changes on close or reload', async () => {
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.p4' }));
  await user.type(await screen.findByRole('textbox', { name: 'main.p4 editor' }), ' changed');
  await user.click(screen.getByRole('button', { name: 'Close main.p4' }));
  let dialog = screen.getByRole('dialog', { name: 'Close file with unsaved changes?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('textbox', { name: 'main.p4 editor' })).toHaveValue('// source changed');
  await user.click(screen.getByRole('button', { name: 'Reload file' }));
  dialog = screen.getByRole('dialog', { name: 'Reload file from disk?' });
  await user.click(within(dialog).getByRole('button', { name: 'Discard and reload' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'main.p4 editor' })).toHaveValue('// source'));
});

it('keeps generated artifacts read only while allowing a new editable file', async () => {
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.json' }));
  expect(await screen.findByRole('textbox', { name: 'main.json editor' })).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'New file' }));
  const dialog = screen.getByRole('dialog', { name: 'New workspace file' });
  await user.type(within(dialog).getByRole('textbox', { name: 'File path' }), 'new/includes/header.p4');
  await user.click(within(dialog).getByRole('button', { name: 'Create file' }));
  expect(await screen.findByRole('textbox', { name: 'new/includes/header.p4 editor' })).not.toHaveAttribute('readonly');
  expect(axios.post).toHaveBeenCalledWith('/workspace/file', { path: 'new/includes/header.p4', content: '', revision: null });
});

it('saves modified buffers before compilation and presents compiler output and file diagnostics', async () => {
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.p4' }));
  await user.type(await screen.findByRole('textbox', { name: 'main.p4 editor' }), '\ninvalid');
  axios.post.mockRejectedValueOnce({ response: { status: 500, data: { command: ['p4c', '/p4/main.p4'], stderr: '/p4/main.p4(2): error: unexpected token' } } });
  await user.click(screen.getByRole('button', { name: 'Compile', exact: true }));
  expect(await screen.findByText('Compilation failed')).toBeVisible();
  expect(axios.patch.mock.invocationCallOrder[0]).toBeLessThan(axios.post.mock.invocationCallOrder[0]);
  expect(screen.getByRole('textbox', { name: 'Compiler output' }).value).toContain('unexpected token');
  await user.click(screen.getByRole('tab', { name: 'Problems (1)' }));
  const problem = within(screen.getByRole('list', { name: 'Editor problems' })).getByRole('button');
  expect(problem).toHaveTextContent('main.p4:2:1 · p4c');
  await user.click(problem);
  expect(screen.getByRole('tab', { name: 'Switch to main.p4' })).toHaveAttribute('aria-selected', 'true');
});

it('disables editing and duplicate compilation while a build is pending', async () => {
  let finish;
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Open main.p4' }));
  await screen.findByRole('textbox', { name: 'main.p4 editor' });
  axios.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await user.click(screen.getByRole('button', { name: 'Compile', exact: true }));
  expect(await screen.findByRole('button', { name: 'Compiling…' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'main.p4 editor' })).toHaveAttribute('readonly');
  await act(async () => finish({ data: { command: ['p4c', '/p4/main.p4'], stdout: 'Generated', stderr: '' } }));
  expect(await screen.findByText('Compilation completed')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
});
