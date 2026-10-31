import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import DirectMeterEditor, { directMeterKey, validateMeterConfig } from './DirectMeterEditor';

const context = vi.hoisted(() => ({ currentSwitchID: 0 }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('axios', () => ({ default: { get: vi.fn(), patch: vi.fn(), isCancel: () => false } }));

const meter = { id: 0x15000001, table_id: 0x02000001, name: 'Ingress.direct', alias: 'direct', unit: 2 };
const tableEntry = { table_name: 'Ingress.forward', match_fields: { key: ['9007199254740993', 64], other: '2' }, priority: 12, is_default_action: false, action_name: 'Ingress.send', action_params: { port: '3' } };
const config = { cir: '100', cburst: '10', pir: '200', pburst: '20' };
const response = value => ({ data: { entries: [{ table_entry: tableEntry, config: value }] } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.clearAllMocks(); context.currentSwitchID = 0; axios.patch.mockResolvedValue({ data: {} }); });

describe('direct meter entry dialog', () => {
  it('normalizes full match identity and ignores actions without losing large integers', () => {
    const reordered = { ...tableEntry, match_fields: { other: 2, key: ['09007199254740993', '64'] }, priority: '12', action_name: null, action_params: {} };
    expect(directMeterKey(reordered)).toBe(directMeterKey(tableEntry));
    expect(directMeterKey({ ...tableEntry, priority: 13 })).not.toBe(directMeterKey(tableEntry));
    expect(directMeterKey({ ...tableEntry, is_default_action: true })).not.toBe(directMeterKey(tableEntry));
    expect(validateMeterConfig({ ...config, cir: '9007199254740993', pir: '9007199254740994' }).cir).toBe('9007199254740993');
    expect(() => validateMeterConfig({ ...config, cir: '' })).toThrow('CIR');
    expect(() => validateMeterConfig({ ...config, pburst: '9223372036854775808' })).toThrow('PBS');
  });

  it('loads the exact entry by key rather than response order and saves only its meter', async () => {
    let current = config;
    axios.get.mockImplementation(async () => ({ data: { entries: [
      { table_entry: { ...tableEntry, match_fields: { key: ['9007199254740992', 64], other: '2' } }, config: { ...config, cir: '999' } },
      { table_entry: { ...tableEntry, priority: 13 }, config: { ...config, cir: '998' } },
      { table_entry: { ...tableEntry, match_fields: { other: 2, key: ['9007199254740993', '64'] }, action_name: null, action_params: {} }, config: current },
    ] } }));
    axios.patch.mockImplementation(async (_, body) => { current = body.entries[0].config; return { data: {} }; });
    const outerSubmit = vi.fn(event => event.preventDefault());
    const user = userEvent.setup();
    render(<form onSubmit={outerSubmit}><DirectMeterEditor meter={meter} tableEntry={tableEntry} /></form>);
    await user.click(screen.getByRole('button', { name: 'Edit meter' }));
    const cir = await screen.findByRole('textbox', { name: 'CIR', exact: true });
    expect(cir).toHaveValue('100');
    expect(screen.getByText(/Rates are measured in packets\/s/)).toBeVisible();
    await user.clear(cir); await user.type(cir, '150');
    await user.click(screen.getByRole('button', { name: 'Save meter' }));
    await screen.findByText('Saved');
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(axios.patch).toHaveBeenCalledWith('/direct-meters', { switch_id: 0, meter_id: meter.id,
      entries: [{ table_entry: tableEntry, config: { ...config, cir: '150' } }] }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(outerSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit direct meter' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('150');
    expect(screen.getByText(/Last updated/)).toBeVisible();
  });

  it('makes unset/default semantics explicit with blank fields and supports reset', async () => {
    let current = null;
    axios.get.mockImplementation(async () => response(current));
    axios.patch.mockImplementation(async (_, body) => { current = body.entries[0].config; return { data: {} }; });
    const user = userEvent.setup();
    render(<DirectMeterEditor meter={{ ...meter, unit: 1 }} tableEntry={tableEntry} />);
    await user.click(screen.getByRole('button', { name: 'Edit meter' }));
    expect(await screen.findByText('Unconfigured — always green.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset meter' })).toBeDisabled();
    expect(screen.getByText(/Rates are measured in bytes\/s/)).toBeVisible();
    for (const [field, value] of [['CIR', '100'], ['CBS', '10'], ['PIR', '200'], ['PBS', '20']]) await user.type(screen.getByRole('textbox', { name: field, exact: true }), value);
    await user.click(screen.getByRole('button', { name: 'Save meter' }));
    await screen.findByText('Saved');
    await user.click(screen.getByRole('button', { name: 'Reset meter' }));
    await screen.findByText('Reset complete');
    expect(axios.patch).toHaveBeenLastCalledWith('/direct-meters', { switch_id: 0, meter_id: meter.id, entries: [{ table_entry: tableEntry, config: null }] }, expect.any(Object));
    expect(screen.getByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('');
    expect(screen.getByText('Unconfigured — always green.')).toBeVisible();
  });

  it('allows cancel during a pending read and ignores a late response', async () => {
    const pending = deferred(); axios.get.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<DirectMeterEditor meter={meter} tableEntry={tableEntry} />);
    await user.click(screen.getByRole('button', { name: 'Edit meter' }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
    const signal = axios.get.mock.calls[0][1].signal;
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signal.aborted).toBe(true);
    pending.resolve(response(config));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('shows pending write feedback and keeps the editor open on target errors', async () => {
    axios.get.mockResolvedValue(response(config));
    const pending = deferred(); axios.patch.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<DirectMeterEditor meter={meter} tableEntry={tableEntry} />);
    await user.click(screen.getByRole('button', { name: 'Edit meter' }));
    await screen.findByRole('textbox', { name: 'CIR', exact: true });
    await user.click(screen.getByRole('button', { name: 'Save meter' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    expect(screen.getByRole('button', { name: 'Save meter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    pending.reject({ response: { data: { error: 'Direct meter unsupported by target' } } });
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported');
    expect(screen.getByRole('dialog', { name: 'Edit direct meter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save meter' })).toBeEnabled();
  });

  it('refuses to guess when the selected key is missing from the read', async () => {
    axios.get.mockResolvedValue({ data: { entries: [{ table_entry: { ...tableEntry, priority: 13 }, config }] } });
    const user = userEvent.setup();
    render(<DirectMeterEditor meter={meter} tableEntry={tableEntry} />);
    await user.click(screen.getByRole('button', { name: 'Edit meter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not returned');
    expect(screen.getByRole('button', { name: 'Save meter' })).toBeDisabled();
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('honors disabled table-edit mode without issuing a request', () => {
    render(<DirectMeterEditor meter={meter} tableEntry={tableEntry} disabled />);
    expect(screen.getByRole('button', { name: 'Edit meter' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit meter' }));
    expect(axios.get).not.toHaveBeenCalled();
  });
});
