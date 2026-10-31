import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import ResourceContent from './ResourceContent';

const context = vi.hoisted(() => ({ currentSwitchID: 0, initializedFiles: null }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: context.initializedFiles }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), patch: vi.fn(), isCancel: () => false } }));

beforeEach(() => { vi.clearAllMocks(); context.currentSwitchID = 0; context.initializedFiles = null; axios.patch.mockResolvedValue({ data: {} }); });
const register = { id: 3, size: 512, type: { kind: 'bit', bitwidth: 64 } };

describe('indexed resources', () => {
  it('keeps a wide direct-meter key exact through legacy JSON parsing and reset', async () => {
    const wire = '{"entries":[{"table_entry":{"table_name":"forward","match_fields":{"key":9007199254740993},"priority":null},"config":{"cir":"1","cburst":"2","pir":"3","pburst":"4"}}]}';
    axios.get.mockImplementation(async (_url, options) => ({ data: options.transformResponse.reduce((data, transform) => transform(data), wire) }));
    const user = userEvent.setup();
    render(<ResourceContent kind="direct-meters" resource={{ id: 4, unit: 2 }} resourceName="meter" />);
    await user.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalled());
    expect(axios.patch.mock.calls[0][1].entries[0].table_entry.match_fields.key).toBe('9007199254740993');
  });

  it('reads and writes a register beyond JavaScript safe integers without precision loss', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 512, entries: [{ index: 0, value: '18446744073709551615' }] } });
    render(<ResourceContent kind="registers" resource={register} resourceName="Ingress.state" />);
    expect(await screen.findByTestId('value-0')).toHaveTextContent('18446744073709551615');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Value for index 0');
    await user.clear(input);
    await user.type(input, '9007199254740993');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/registers', { switch_id: 0, register_id: 3, entries: [{ index: 0, value: '9007199254740993' }] }));
  });

  it('rejects overflow before issuing a write', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 1, entries: [{ index: 0, value: '0' }] } });
    render(<ResourceContent kind="registers" resource={{ ...register, type: { kind: 'bit', bitwidth: 8 } }} resourceName="state" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Value for index 0'));
    await user.type(screen.getByLabelText('Value for index 0'), '256');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 0 and 255');
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('requests the next page rather than downloading a whole array', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 512, entries: [{ index: 0, value: '0' }] } });
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    await screen.findByTestId('value-0');
    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/registers', expect.objectContaining({ params: { switch_id: 0, register_id: 3, offset: 25, limit: 25 } })));
  });

  it('surfaces unsupported target responses without crashing', async () => {
    axios.get.mockRejectedValue({ response: { status: 501, data: { error: 'Register access unsupported by target' } } });
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    expect(await screen.findByText('Register access unsupported by target')).toBeVisible();
    expect(screen.getByText(/enable the BMv2 register adapter in its saved connection settings/)).toBeVisible();
  });

  it('shows per-switch unsupported capability without repeatedly querying a stock target', async () => {
    context.initializedFiles = { register_access: { mode: 'unsupported', status: 'unsupported', max_bitwidth: null } };
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    expect(await screen.findByText('This switch does not support P4Runtime register access.')).toBeVisible();
    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it.each(['meters', 'direct-meters'])('saves and resets %s with the correct identity', async kind => {
    const user = userEvent.setup();
    const table_entry = { table_name: 'forward', match_fields: { port: '1' }, action_name: 'send', action_params: {}, priority: null };
    const entry = kind === 'meters' ? { index: 0, config: null } : { table_entry, config: null };
    axios.get.mockResolvedValue({ data: { total: 1, entries: [entry] } });
    render(<ResourceContent kind={kind} resource={{ id: 4, size: 1, unit: 2 }} resourceName="meter" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const label = kind === 'meters' ? 'index 0' : 'entry {"port":"1"}';
    for (const [name, value] of [['CIR', '100'], ['CBS', '10'], ['PIR', '200'], ['PBS', '20']]) {
      const field = screen.getByLabelText(`${name} for ${label}`); await user.clear(field); await user.type(field, value);
    }
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const identity = kind === 'meters' ? { index: 0 } : { table_entry };
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(`/${kind}`, { switch_id: 0, meter_id: 4, entries: [{ ...identity, config: { cir: '100', cburst: '10', pir: '200', pburst: '20' } }] }));
    await user.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(axios.patch).toHaveBeenLastCalledWith(`/${kind}`, { switch_id: 0, meter_id: 4, entries: [{ ...identity, config: null }] }));
  });

  it('keeps register data visible and reports a pending manual refresh through completion', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 1, entries: [{ index: 0, value: '123' }] } });
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    await screen.findByTestId('value-0');
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    expect(screen.getByTestId('value-0')).toHaveTextContent('123');
    await act(async () => resolve({ data: { total: 1, entries: [{ index: 0, value: '456' }] } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed');
    expect(screen.getByTestId('value-0')).toHaveTextContent('456');
    expect(screen.getByText(/Last updated:/).querySelector('time')).toHaveAttribute('dateTime');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('does not claim refresh completion or discard the previous values on failure', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 1, entries: [{ index: 0, value: '123' }] } });
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    await screen.findByTestId('value-0');
    const timestamp = screen.getByText(/Last updated:/).querySelector('time').dateTime;
    let reject;
    axios.get.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => reject({ response: { data: { error: 'Target read failed' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed');
    expect(screen.getByTestId('value-0')).toHaveTextContent('123');
    expect(screen.getByText(/Last updated:/).querySelector('time').dateTime).toBe(timestamp);
    expect(screen.queryByText('Refreshed')).not.toBeInTheDocument();
  });

  it('shows saving while the write is pending and preserves the editor after a write failure', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { total: 1, entries: [{ index: 0, value: '1' }] } });
    render(<ResourceContent kind="registers" resource={register} resourceName="state" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Value for index 0'));
    await user.type(screen.getByLabelText('Value for index 0'), '42');
    let reject;
    axios.patch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => reject({ response: { data: { error: 'Write rejected by switch' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
    expect(screen.getByLabelText('Value for index 0')).toHaveValue('42');
    expect(screen.getByRole('alert')).toHaveTextContent('Write rejected');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it.each(['meters', 'direct-meters'])('distinguishes unset %s from explicit zero rates and requires an explicit new configuration', async kind => {
    const user = userEvent.setup();
    const key = port => ({ table_name: 'forward', match_fields: { port: String(port) }, action_name: 'send', action_params: {}, priority: null });
    const entries = [0, 1].map(index => ({ ...(kind === 'meters' ? { index } : { table_entry: key(index + 1) }),
      config: index ? { cir: '0', cburst: '0', pir: '0', pburst: '0' } : null }));
    axios.get.mockImplementation(async () => ({ data: { total: 2, entries: structuredClone(entries) } }));
    render(<ResourceContent kind={kind} resource={{ id: 4, size: 2, unit: 1 }} resourceName="byte-meter" />);
    await screen.findByText('Unconfigured — always green');
    const rows = screen.getAllByTestId(/^resource-row-/);
    expect(within(rows[1]).getAllByText('0')).toHaveLength(4);
    await user.hover(screen.getByText('CIR (bytes/s)'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Committed information rate');
    expect(screen.getByRole('tooltip')).toHaveTextContent('bytes per second');
    await user.unhover(screen.getByText('CIR (bytes/s)'));
    await user.click(within(rows[0]).getByRole('button', { name: 'Edit' }));
    const suffix = kind === 'meters' ? 'index 0' : 'entry {"port":"1"}';
    for (const name of ['CIR', 'CBS', 'PIR', 'PBS']) expect(screen.getByLabelText(`${name} for ${suffix}`)).toHaveValue('');
    expect(screen.getByText('Committed burst size · bytes')).toBeVisible();
    await user.click(within(rows[0]).getByRole('button', { name: 'Save' }));
    expect(within(rows[0]).getByRole('alert')).toHaveTextContent('nonnegative whole numbers');
    expect(axios.patch).not.toHaveBeenCalled();
    await user.click(within(rows[0]).getByRole('button', { name: 'Cancel' }));
    axios.patch.mockImplementationOnce(async () => { entries[1].config = null; return { data: {} }; });
    await user.click(within(rows[1]).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(axios.patch).toHaveBeenLastCalledWith(`/${kind}`, { switch_id: 0, meter_id: 4,
      entries: [{ ...(kind === 'meters' ? { index: 1 } : { table_entry: key(2) }), config: null }] }));
    expect(await screen.findByText('Reset complete')).toBeVisible();
    expect(screen.getAllByText('Unconfigured — always green')).toHaveLength(2);
  });
});
