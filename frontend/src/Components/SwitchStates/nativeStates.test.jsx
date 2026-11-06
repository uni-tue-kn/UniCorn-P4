import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import HistoryList from './History/HistoryList';
import SavedList from './Saved/SavedList';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
const state = vi.hoisted(() => ({ initialize: vi.fn(), files: { target: 'tofino', state_id: 2 } }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initialize: state.initialize, initializedFiles: state.files }) }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
const native = { id: 1, target: 'tofino', program_name: 'workshop', program_manifest: '/p4/.unicorn-builds/build/manifest.json',
  name: 'Saved workshop', p4_info_file: '', bmv2_file: '', last_init: '2026-11-03T10:00:00Z', date_created: '2026-11-03T10:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  state.files = { target: 'tofino', state_id: 2 };
  axios.get.mockResolvedValue({ data: [native] });
});

it('shows the native program in history and restores its portable build reference', async () => {
  const user = userEvent.setup();
  render(<HistoryList fullHistory />);
  await user.click(await screen.findByText('workshop'));
  const table = screen.getByRole('table');
  expect(within(table).getByRole('cell', { name: 'Program', exact: true })).toBeVisible();
  expect(within(table).getByRole('cell', { name: 'Tofino', exact: true })).toBeVisible();
  expect(screen.queryByText('p4 info file')).not.toBeInTheDocument();
  expect(screen.queryByText(/manifest\.json/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Re-Initialize state' }));
  expect(state.initialize).toHaveBeenCalledWith(expect.anything(), { id: native.program_manifest }, '', false, 1);
});

it.each([HistoryList, SavedList])('keeps state previews readable but blocks restoring an observer pipeline (%s)', async Component => {
  state.files = { target: 'tofino', capabilities: { pipeline: { write: false } } };
  const user = userEvent.setup();
  render(<Component fullHistory />);
  await user.click(await screen.findByText(Component === HistoryList ? 'workshop' : 'Saved workshop'));
  expect(screen.getByRole('button', { name: 'Re-Initialize state' })).toBeDisabled();
  expect(screen.getByRole('table')).toBeVisible();
  expect(state.initialize).not.toHaveBeenCalled();
});

it('shows native saved-state program details and prevents applying it to a different target', async () => {
  state.files = { target: 'bmv2' };
  const user = userEvent.setup();
  render(<SavedList />);
  await user.click(await screen.findByText('Saved workshop'));
  expect(screen.getByRole('columnheader', { name: 'Program' })).toBeVisible();
  expect(screen.getByRole('cell', { name: 'workshop', exact: true })).toBeVisible();
  expect(screen.queryByText('bmv2 file')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Re-Initialize state' })).toBeDisabled();
  expect(state.initialize).not.toHaveBeenCalled();
});
