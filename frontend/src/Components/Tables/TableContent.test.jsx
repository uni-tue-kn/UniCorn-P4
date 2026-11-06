import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import axios from 'axios';
import TableContent from './TableContent';

const state = vi.hoisted(() => ({ write: false, notify: vi.fn(), tableInfo: { forward: { table_id: 1, match_fields: {}, actions: {} } } }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: { capabilities: { tables: { read: true, write: state.write } } } }) }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('../../Contexts/TableContext', () => ({ useTable: () => ({ tableInfo: state.tableInfo, decoding: {} }) }));
vi.mock('../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: state.notify }) }));
vi.mock('../Helpers/Decoding/DecodingHelper', () => ({ decodeTableEntries: entries => entries }));
vi.mock('../Helpers/SortFilter/SortFilterHelper', () => ({ sortEntries: entries => entries, filterEntries: entries => entries }));
vi.mock('./ReadableTable', () => ({ default: () => <p>Readable entries</p> }));
vi.mock('../SwitchStates/Dialogs/SaveStateDialog', () => ({ default: () => null }));
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); axios.get.mockResolvedValue({ data: [{ id: 0 }] }); });

it.each([false, true])('keeps table display controls usable with write=%s', async write => {
  state.write = write;
  render(<TableContent tableName="forward" tableID={1} />);
  expect(await screen.findByText('Readable entries')).toBeVisible();
  for (const label of ['Add new Entry', 'Edit Table Entries']) {
    if (write) expect(screen.getByRole('button', { name: label })).toBeEnabled();
    else expect(screen.getByRole('button', { name: label })).toBeDisabled();
  }
  expect(screen.getByRole('button', { name: 'Sort & Filter' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Decoding Options' })).toBeEnabled();
});
