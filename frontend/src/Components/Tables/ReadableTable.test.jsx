import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import ReadableTable from './ReadableTable';

const contexts = vi.hoisted(() => ({ capabilities: {}, direct_meters: {}, direct_counters: {}, tableInfo: { 'Ingress.forward': { table_id: 0x02000001 } } }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('../../Contexts/TableContext', () => ({ useTable: () => ({ tableInfo: contexts.tableInfo, decoding: null }) }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: { capabilities: contexts.capabilities, direct_meters: contexts.direct_meters, direct_counters: contexts.direct_counters } }) }));
vi.mock('../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('../Helpers/DisplayHelper', () => ({
  StyledTableRow: ({ children }) => <tr>{children}</tr>, StyledTableCell: ({ children }) => <td>{children}</td>,
  displayTable: (row, entries) => <table><tbody>{entries.map(row)}</tbody></table>,
  displayMatchKeys: entry => JSON.stringify(entry.switch_entry.match_fields), displayActionData: () => 'send', displayCounterValue: () => null,
}));
vi.mock('../Helpers/EditHelper', () => ({ findEntry: (id, entries) => entries.find(entry => entry.id === id), editActionInput: () => 'Editing action', editMatchInput: () => 'Editing match' }));
vi.mock('axios', () => ({ default: { get: vi.fn(), patch: vi.fn(), delete: vi.fn(), isCancel: () => false } }));

const meter = { id: 0x15000001, table_id: 0x02000001, name: 'Ingress.direct', unit: 2 };
const entry = (id, key) => ({ id, switch_entry: { table_name: 'Ingress.forward', match_fields: { key }, action_name: 'Ingress.send', action_params: { port: '2' }, priority: null, is_default_action: false } });
const props = () => ({ tableName: 'Ingress.forward', tableEntries: [entry(0, 'ff'), entry(1, 'ee')], rawTableEntries: [entry(0, '255'), entry(1, '238')], filteredEntries: [entry(0, 'ff'), entry(1, 'ee')], updateTableEntries: vi.fn(), toggleInlineEditing: vi.fn(), needsPriority: false });
beforeEach(() => {
  vi.clearAllMocks(); contexts.capabilities = {}; contexts.direct_meters = { direct: meter }; contexts.direct_counters = {};
});

describe('direct-counter plots attached to table rows', () => {
  const counter = { id: 0x13000001, table_id: 0x02000001, name: 'Ingress.direct_counter', unit: 3 };
  it('opens a plot on demand using the selected row’s original numeric key', async () => {
    contexts.direct_counters = { direct: counter };
    axios.get.mockResolvedValue({ data: [
      { ...entry(0, '255'), counters: { packets: '100', bytes: '200' } },
      { ...entry(1, '238'), counters: { packets: '9007199254740993', bytes: '400' } },
    ] });
    const user = userEvent.setup();
    const view = render(<ReadableTable {...props()} />);
    expect(axios.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Plot counter for entry 1' }));
    expect(await screen.findByRole('dialog', { name: 'Direct-counter throughput' })).toBeVisible();
    expect(screen.getByText('Match: {"key":"238"}')).toBeVisible();
    expect(await screen.findByRole('status')).toHaveTextContent('9007199254740993 packets · 400 bytes');
    expect(axios.get).toHaveBeenCalledWith('/tables', expect.objectContaining({ params: { switch_id: 0, table_name: 'Ingress.forward' } }));
    view.unmount();
    expect(axios.get.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('only offers plots for the associated table and disables them during inline editing', async () => {
    contexts.direct_counters = { direct: { ...counter, table_id: 0x02000002 } };
    const supplied = props();
    const view = render(<ReadableTable {...supplied} />);
    expect(screen.queryByRole('button', { name: /Plot counter/ })).not.toBeInTheDocument();
    contexts.direct_counters = { direct: counter };
    view.rerender(<ReadableTable {...supplied} />);
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Edit', exact: true })[0]);
    expect(screen.getByRole('button', { name: 'Plot counter for entry 1' })).toBeDisabled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('direct meters attached to table rows', () => {
  it('uses the associated meter and original numeric match key for a selected decoded row', async () => {
    const first = { cir: '100', cburst: '10', pir: '200', pburst: '20' };
    const second = { cir: '300', cburst: '30', pir: '400', pburst: '40' };
    axios.get.mockResolvedValue({ data: { entries: [
      { table_entry: entry(0, '255').switch_entry, config: first },
      { table_entry: entry(1, '238').switch_entry, config: second },
    ] } });
    const user = userEvent.setup();
    render(<ReadableTable {...props()} />);
    expect(axios.get).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole('button', { name: 'Edit meter' })[1]);
    expect(await screen.findByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('300');
    expect(screen.getByText('Match: {"key":"238"}')).toBeVisible();
    expect(axios.get).toHaveBeenCalledWith('/direct-meters', expect.objectContaining({ params: { switch_id: 0, meter_id: meter.id } }));
  });

  it('only shows meter actions for the table referenced by its direct-meter metadata', () => {
    contexts.direct_meters = { other: { ...meter, table_id: 0x02000002 } };
    render(<ReadableTable {...props()} />);
    expect(screen.queryByRole('button', { name: 'Edit meter' })).not.toBeInTheDocument();
  });

  it('disables other meter actions while an entry is being edited inline', async () => {
    const user = userEvent.setup();
    const supplied = props();
    render(<ReadableTable {...supplied} />);
    await user.click(screen.getAllByRole('button', { name: 'Edit', exact: true })[0]);
    expect(supplied.toggleInlineEditing).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Edit meter' })).toBeDisabled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});


it('keeps MAT rows and direct meter values readable while disabling every switch mutation', async () => {
  contexts.capabilities = { tables: { write: false }, direct_counters: { write: false }, direct_meters: { read: true, write: false } };
  const supplied = props();
  supplied.tableEntries[0].counters = { packets: '7', bytes: '70' };
  supplied.filteredEntries[0].counters = supplied.tableEntries[0].counters;
  axios.get.mockResolvedValue({ data: { entries: [{ table_entry: supplied.rawTableEntries[0].switch_entry, config: { cir: '100', cburst: '10', pir: '200', pburst: '20' } }] } });
  const user = userEvent.setup();
  render(<ReadableTable {...supplied} />);
  for (const button of screen.getAllByRole('button', { name: /^(Edit|Delete)$/ })) expect(button).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reset counter for entry 0' })).toBeDisabled();
  await user.click(screen.getAllByRole('button', { name: 'View meter', exact: true })[0]);
  expect(await screen.findByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('100');
  expect(screen.getByRole('textbox', { name: 'CIR', exact: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save meter' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reset meter' })).toBeDisabled();
  expect(axios.patch).not.toHaveBeenCalled();
  expect(axios.delete).not.toHaveBeenCalled();
});
