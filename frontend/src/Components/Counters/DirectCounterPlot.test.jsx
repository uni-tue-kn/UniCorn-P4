import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import DirectCounterPlot, { directCounterEntryKey } from './DirectCounterPlot';

const context = vi.hoisted(() => ({ currentSwitchID: 0 }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('axios', () => ({ default: { get: vi.fn(), isCancel: () => false } }));
const counter = { id: 0x13000001, name: 'Ingress.flow_count', table_id: 0x02000001, unit: 3 };
const entry = { table_name: 'Ingress.forward', match_fields: { key: ['255', '255'] }, priority: 5, is_default_action: false };
const props = { counter, tableID: counter.table_id, tableEntry: entry };
const row = (packets = '9007199254740993', bytes = '10', tableEntry = entry) => ({ switch_entry: tableEntry, counters: { packets, bytes } });
let time;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); context.currentSwitchID = 0; time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  axios.get.mockResolvedValue({ data: [row()] });
});
afterEach(() => { vi.useRealTimers(); });
const flush = () => act(async () => {});
const open = async () => { fireEvent.click(screen.getByRole('button', { name: 'Plot counter' })); await flush(); };
const tick = async () => { time += 1000; await act(async () => vi.advanceTimersByTimeAsync(1000)); };

describe('entry direct-counter throughput', () => {
  it('polls only on demand and calculates lossless rates for exactly the full selected key', async () => {
    const otherPriority = row('99999999999999999', '99999', { ...entry, priority: 6 });
    const defaultRow = row('99999999999999999', '99999', { ...entry, is_default_action: true });
    axios.get.mockResolvedValueOnce({ data: [otherPriority, row(), defaultRow] })
      .mockResolvedValueOnce({ data: [defaultRow, row('9007199254740996', '30'), otherPriority] });
    render(<DirectCounterPlot {...props} />);
    expect(axios.get).not.toHaveBeenCalled();
    await open();
    expect(axios.get).toHaveBeenCalledWith('/tables', expect.objectContaining({ params: { switch_id: 0, table_name: entry.table_name }, signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('status')).toHaveTextContent('9007199254740993 packets');
    const transform = axios.get.mock.calls[0][1].transformResponse[0];
    expect(transform('[{"counters":{"packets":9007199254740993}}]')[0].counters.packets).toBe('9007199254740993');
    await tick();
    expect(screen.getByText('3 packets/s · 160 bits/s')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Packet rate over time' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Bit rate over time' })).toBeVisible();
  });

  it.each([[1, 'Bit rate over time', 'Packet rate over time'], [2, 'Packet rate over time', 'Bit rate over time']])('honors counting unit %s', async (unit, visible, absent) => {
    axios.get.mockResolvedValue({ data: [{ switch_entry: entry, counters: unit === 1 ? { bytes: '10' } : { packets: '20' } }] });
    render(<DirectCounterPlot {...props} counter={{ ...counter, unit }} />);
    await open();
    expect(screen.getByRole('img', { name: visible })).toBeVisible();
    expect(screen.queryByRole('img', { name: absent })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains unknown units without inventing rates or polling', async () => {
    render(<DirectCounterPlot {...props} counter={{ ...counter, unit: 0 }} />);
    await open();
    expect(screen.getByRole('alert')).toHaveTextContent('Throughput is unavailable');
    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('aborts a pending read on close and discards late data across reopen', async () => {
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<DirectCounterPlot {...props} />);
    await open();
    const signal = axios.get.mock.calls[0][1].signal;
    expect(screen.getByRole('status')).toHaveTextContent('Reading counter');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await flush();
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300)); // Finish the dialog exit transition.
    await open();
    await act(async () => resolve({ data: [row('777', '777')] }));
    expect(screen.getByRole('status')).toHaveTextContent('9007199254740993');
    expect(screen.getByText('Collecting the next sample…')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await tick(); await tick();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it.each(['switch', 'table', 'priority', 'default', 'match'])('closes and stops polling when %s identity changes', async kind => {
    const view = render(<DirectCounterPlot {...props} />);
    await open();
    const signal = axios.get.mock.calls[0][1].signal;
    const next = { ...props };
    if (kind === 'switch') context.currentSwitchID = 1;
    if (kind === 'table') next.tableID++;
    if (kind === 'priority') next.tableEntry = { ...entry, priority: 6 };
    if (kind === 'default') next.tableEntry = { ...entry, is_default_action: true };
    if (kind === 'match') next.tableEntry = { ...entry, match_fields: { key: ['238', '255'] } };
    view.rerender(<DirectCounterPlot {...next} />);
    expect(signal.aborted).toBe(true);
    await tick();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledTimes(1);
    context.currentSwitchID = 0;
    view.rerender(<DirectCounterPlot {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pauses on hidden tabs and creates a baseline when visibility returns', async () => {
    render(<DirectCounterPlot {...props} />);
    await open();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    await tick(); await tick();
    expect(axios.get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange')); await flush();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Collecting the next sample…')).toBeVisible();
  });

  it('does not overlap slow reads and aborts a pending request on unmount', async () => {
    let resolve;
    axios.get.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<DirectCounterPlot {...props} />);
    await open(); await tick(); await tick();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    const signal = axios.get.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ data: [row()] }));
    await tick();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('retains values during a manual refresh and makes its pending state visible', async () => {
    render(<DirectCounterPlot {...props} />);
    await open();
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('9007199254740993');
    time = 1000;
    await act(async () => resolve({ data: [row('9007199254740994', '20')] }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByText('1 packets/s · 80 bits/s')).toBeVisible();
  });

  it('creates gaps for resets, read failures and deleted entries, then resumes from a baseline', async () => {
    axios.get.mockResolvedValueOnce({ data: [row('100', '100')] })
      .mockResolvedValueOnce({ data: [row('1', '1')] })
      .mockRejectedValueOnce({ response: { data: { error: 'Read failed' } } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [row('50', '50')] });
    render(<DirectCounterPlot {...props} />);
    await open(); await tick();
    expect(screen.getByText(/Counter reset detected/)).toBeVisible();
    expect(screen.getByText('— packets/s · — bits/s')).toBeVisible();
    await tick(); expect(screen.getByRole('alert')).toHaveTextContent('Read failed');
    await tick(); expect(screen.getByRole('alert')).toHaveTextContent('no longer present');
    await tick(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Collecting the next sample…')).toBeVisible();
  });

  it.each([{ name: 'ambiguous keys', rows: [row(), row()], error: 'multiple entries' },
    { name: 'missing counters', rows: [{ switch_entry: entry }], error: 'did not return direct-counter values' },
    { name: 'negative counters', rows: [row('-1', '2')], error: 'negative counter' }])('rejects $name without a fabricated rate', async ({ rows, error }) => {
    axios.get.mockResolvedValue({ data: rows });
    render(<DirectCounterPlot {...props} />);
    await open();
    expect(screen.getByRole('alert')).toHaveTextContent(error);
    expect(screen.getByText('— packets/s · — bits/s')).toBeVisible();
  });

  it('canonicalizes key order and numeric representations while retaining priority/default distinctions', () => {
    const left = { ...entry, match_fields: { z: ['255', '255'], a: '01' }, priority: '05' };
    const right = { ...entry, match_fields: { a: 1, z: [255, 255] }, priority: 5 };
    expect(directCounterEntryKey(left)).toBe(directCounterEntryKey(right));
    expect(directCounterEntryKey(left)).not.toBe(directCounterEntryKey({ ...left, priority: 6 }));
    expect(directCounterEntryKey(left)).not.toBe(directCounterEntryKey({ ...left, is_default_action: true }));
  });
});
