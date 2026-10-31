import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import Compile, { compileErrorMessage, formatCompileCommand } from './Compile';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const file = "/p4/O'Brien program.p4";
beforeEach(() => {
  vi.resetAllMocks();
  axios.get.mockResolvedValue({ data: { p4src: [file] } });
});
async function selectSource(user) {
  await user.click(screen.getByRole('combobox', { name: 'P4 source file' }));
  await user.click(await screen.findByRole('option', { name: file, exact: true }));
}

describe('compile controls', () => {
  it('displays JSON argument lists and legacy repr without guessing quote syntax', () => {
    const legacy = `['p4c', "/p4/O'Brien program.p4", '--target', 'bmv2']`;
    expect(formatCompileCommand(['p4c', file])).toBe(`p4c ${file}`);
    expect(formatCompileCommand(legacy)).toBe(legacy);
    expect(formatCompileCommand(undefined)).toBe('');
    expect(formatCompileCommand({ command: 'unexpected' })).toBe('');
    expect(compileErrorMessage({ response: { data: { message: { file: 'Missing source file' } } } })).toBe('Missing source file');
  });

  it('disables Compile while pending and shows successful output with quoted filenames intact', async () => {
    let resolve;
    axios.post.mockImplementation(() => new Promise(done => { resolve = done; }));
    const user = userEvent.setup();
    render(<Compile />);
    expect(screen.getByRole('button', { name: 'Compile' })).toBeDisabled();
    await selectSource(user);
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(screen.getByRole('button', { name: 'Compiling…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Compiling…');
    expect(axios.post).toHaveBeenCalledOnce();
    await act(async () => resolve({ data: { command: ['p4c', file, '--target', 'bmv2'], stdout: 'Generated BMv2 JSON', stderr: 'warning: unused field' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Compilation completed');
    expect(screen.getByRole('button', { name: 'Compile' })).toBeEnabled();
    const output = screen.getByRole('textbox', { name: 'Compiler output' });
    expect(output.value).toContain(`Command: p4c ${file} --target bmv2`);
    expect(output.value).toContain('Generated BMv2 JSON');
    expect(output.value).toContain('warning: unused field');
    expect(output.value).toContain('Success: Compilation completed.');
  });

  it('handles a response-less network rejection and permits retry', async () => {
    axios.post.mockRejectedValue(new Error('Network Error'));
    const user = userEvent.setup();
    render(<Compile />);
    await selectSource(user);
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText('Compilation failed')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Compiler output' }).value).toContain('Error: Network Error');
    expect(screen.getByRole('textbox', { name: 'Compiler output' }).value).not.toContain('Command:');
    expect(screen.getByRole('button', { name: 'Compile' })).toBeEnabled();
    expect(screen.queryByText('Compilation completed')).not.toBeInTheDocument();
  });

  it('handles a backend400 error without command metadata', async () => {
    axios.post.mockRejectedValue({ response: { status: 400, data: { error: 'File path is outside the allowed directory' } } });
    const user = userEvent.setup();
    render(<Compile />);
    await selectSource(user);
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText('Compilation failed')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Compiler output' }).value).toContain('Error: File path is outside the allowed directory');
    expect(screen.getByRole('button', { name: 'Compile' })).toBeEnabled();
  });

  it('accepts successful legacy-server repr responses containing apostrophes', async () => {
    const command = `['p4c', "/p4/O'Brien program.p4"]`;
    axios.post.mockResolvedValue({ data: { command, stdout: '' } });
    const user = userEvent.setup();
    render(<Compile />);
    await selectSource(user);
    await user.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText('Compilation completed')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Compiler output' }).value).toContain(command);
  });
});
