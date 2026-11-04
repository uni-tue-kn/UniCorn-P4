import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import Initialization from './Initialization';

const context = vi.hoisted(() => ({ currentSwitchID: 0, initializedFiles: null, initialize: vi.fn() }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => context }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('../SwitchStates/Dialogs/SaveStateDialog', () => ({ default: () => null }));
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
const program = { id: '/p4/lab/tutorial.json', name: 'lab/tutorial', p4_info: '/p4/lab/tutorial.p4info.txt', bmv2: '/p4/lab/tutorial.json', source: '/p4/lab/tutorial.p4' };
const files = { programs: [program], p4_info: [program.p4_info, '/p4/custom-info.txt'], bmv2: [program.bmv2, '/p4/custom-switch.json'] };
beforeEach(() => {
  vi.clearAllMocks(); context.currentSwitchID = 0; context.initializedFiles = null;
  context.initialize.mockResolvedValue(true); axios.get.mockResolvedValue({ data: files });
});

describe('program initialization', () => {
  it.each([{ read_only: true }, { capabilities: { pipeline: { write: false } } }])('shows the discovered observer program without offering initialization (%j)', async readonly => {
    context.initializedFiles = { target: 'tofino', program_name: 'external_router', table_info: {}, ...readonly };
    render(<Initialization />);
    expect(await screen.findByText('external_router')).toBeVisible();
    expect(screen.getByText(/Read-only connection.*discovered automatically/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit initialization' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Initialize', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Program files')).not.toBeInTheDocument();
    expect(context.initialize).not.toHaveBeenCalled();
  });
  it('selects a sole legacy compiled program and sends both matching artifacts', async () => {
    const user = userEvent.setup();
    render(<Initialization />);
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await expect(screen.findByRole('combobox', { name: 'Compiled program' })).resolves.toHaveTextContent('lab/tutorial');
    expect(screen.queryByRole('combobox', { name: 'P4Info file' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Initialize', exact: true }));
    expect(context.initialize).toHaveBeenCalledWith(expect.anything(), program.p4_info, program.bmv2, false);
    await expect(screen.findByRole('button', { name: 'Edit initialization' })).resolves.toBeVisible();
  });

  it('initializes a compatible manifest program by identity without exposing native artifact paths', async () => {
    const user = userEvent.setup();
    const native = { id: '/p4/.builds/router/manifest.json', name: 'router', target: 'tofino', build_manifest: '/p4/.builds/router/manifest.json', source: '/p4/router.p4' };
    context.initializedFiles = { target: 'tofino', program_manifest: native.id, program_name: 'router', table_info: {}, capabilities: { pipeline: { keep_entries: false } } };
    axios.get.mockResolvedValue({ data: { programs: [native] } });
    render(<Initialization />);
    expect(await screen.findByText('router')).toBeVisible();
    expect(screen.queryByText(native.id)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Initialize', exact: true })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Advanced', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Keep existing entries' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Initialize', exact: true }));
    expect(context.initialize).toHaveBeenCalledWith(expect.anything(), native, null, false);
    expect(axios.get).toHaveBeenCalledWith('/p4files', { params: { switch_id: 0 } });
  });

  it('refreshes programs when opening the editor after a compilation', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValueOnce({ data: { p4_info: [], bmv2: [], programs: [] } }).mockResolvedValue({ data: files });
    render(<Initialization />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Compiled program' })).toHaveTextContent('lab/tutorial'));
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('retains manual file selection for custom artifact names', async () => {
    const user = userEvent.setup();
    render(<Initialization />);
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Initialize', exact: true })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Advanced', exact: true }));
    for (const [label, path] of [['P4Info file', '/p4/custom-info.txt'], ['BMv2 JSON file', '/p4/custom-switch.json']]) {
      await user.click(screen.getByRole('combobox', { name: label, exact: true }));
      await user.click(screen.getByRole('option', { name: path, exact: true }));
    }
    expect(screen.getByText('Custom files selected in Advanced.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Initialize', exact: true }));
    expect(context.initialize).toHaveBeenCalledWith(expect.anything(), '/p4/custom-info.txt', '/p4/custom-switch.json', false);
  });

  it('keeps the selection open after an initialization failure', async () => {
    const user = userEvent.setup();
    context.initialize.mockResolvedValue(false);
    render(<Initialization />);
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Initialize', exact: true })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Initialize', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Initialization failed.');
    expect(screen.getByRole('combobox', { name: 'Compiled program' })).toHaveTextContent('lab/tutorial');
    expect(screen.getByRole('button', { name: 'Initialize', exact: true })).toBeEnabled();
  });

  it('prefills the current program, preserves entries on request and resets on target change', async () => {
    const user = userEvent.setup();
    context.initializedFiles = { p4_info_file: program.p4_info, bmv2_file: program.bmv2, table_info: {}, state_id: 1 };
    const view = render(<Initialization />);
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Compiled program' })).toHaveTextContent('lab/tutorial'));
    await user.click(screen.getByRole('checkbox', { name: 'Keep existing entries' }));
    await user.click(screen.getByRole('button', { name: 'Initialize', exact: true }));
    expect(context.initialize).toHaveBeenCalledWith(expect.anything(), program.p4_info, program.bmv2, true);
    await user.click(await screen.findByRole('button', { name: 'Edit initialization' }));
    context.currentSwitchID = 1; context.initializedFiles = null;
    view.rerender(<Initialization />);
    expect(screen.queryByRole('combobox', { name: 'Compiled program' })).not.toBeInTheDocument();
  });

  it('does not guess between multiple programs', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { ...files, programs: [program, { ...program, id: '/p4/other.json', name: 'other', bmv2: '/p4/other.json' }] } });
    render(<Initialization />);
    await user.click(screen.getByRole('button', { name: 'Edit initialization' }));
    expect(await screen.findByText('Compile a program or select files in Advanced.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Initialize', exact: true })).toBeDisabled();
  });
});
