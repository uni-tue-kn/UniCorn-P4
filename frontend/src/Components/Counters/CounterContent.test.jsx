import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import CounterContent from './CounterContent';
import DirectCounterReset from './DirectCounterReset';

const context = vi.hoisted(() => ({ currentSwitchID: 0 }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('axios', () => ({ default: { get: vi.fn(), patch: vi.fn(), isCancel: () => false } }));
const data = { entries: [{ index: 0, packets: '9007199254740993', bytes: '1234' }] };
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); context.currentSwitchID = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  axios.get.mockResolvedValue({ data }); axios.patch.mockResolvedValue({ data: { success: true } });
});
afterEach(() => { vi.useRealTimers(); });
const flush = () => act(async () => {});

describe('counter controls and polling', () => {
  it('preserves displayed integers and resets explicit index zero or the whole resource', async () => {
    render(<CounterContent counterId={9} counterName="Ingress.counter" />);
    await flush();
    expect(screen.getByText('9007199254740993')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reset counter index 0' }));
    await flush();
    expect(axios.patch).toHaveBeenCalledWith('/counters', { switch_id: 0, counter_id: 9, index: 0, reset: true }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset all counters' }));
    await flush();
    expect(axios.patch).toHaveBeenLastCalledWith('/counters', { switch_id: 0, counter_id: 9, index: null, reset: true }, expect.anything());
    expect(screen.getByRole('img', { name: 'Packet rate over time' })).toBeVisible();
  });

  it('polls while visible, pauses while hidden and cancels reads on unmount', async () => {
    const view = render(<CounterContent counterId={9} counterName="counter" />);
    await flush();
    expect(axios.get).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(axios.get).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(axios.get).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(axios.get).toHaveBeenCalledTimes(3);
    const signal = axios.get.mock.calls.at(-1)[1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('filters the plotted index and stops automatic polling when Live traffic is disabled', async () => {
    render(<CounterContent counterId={9} counterName="counter" />);
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Traffic index' }), { target: { value: '0' } });
    await flush();
    expect(axios.get).toHaveBeenLastCalledWith('/counters', expect.objectContaining({ params: { switch_id: 0, counter_id: 9, index: '0' } }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Live traffic' }));
    await flush();
    const count = axios.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(axios.get).toHaveBeenCalledTimes(count);
  });

  it('discards a late reply from a disconnected switch and exposes reset errors', async () => {
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<CounterContent counterId={9} counterName="counter" />);
    const signal = axios.get.mock.calls[0][1].signal;
    context.currentSwitchID = null;
    view.rerender(<CounterContent counterId={9} counterName="counter" />);
    await act(async () => resolve({ data }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
    context.currentSwitchID = 1;
    view.rerender(<CounterContent counterId={9} counterName="counter" />);
    await flush();
    axios.patch.mockRejectedValue({ response: { data: { error: 'Read-only target' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset all counters' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Read-only target');
  });

  it('resets a direct counter by its complete table key and refreshes only after success', async () => {
    const onReset = vi.fn();
    const entry = { table_name: 'Ingress.forward', match_fields: { port: '0' }, priority: null };
    render(<DirectCounterReset tableID={7} tableEntry={entry} onReset={onReset} label="Reset entry counter" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset entry counter' }));
    await flush();
    expect(axios.patch).toHaveBeenCalledWith('/direct-counters', { switch_id: 0, table_id: 7, table_entry: entry, reset: true }, expect.anything());
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows pending manual refresh while retaining counters, then polls quietly', async () => {
    render(<CounterContent counterId={9} counterName="counter" />);
    await flush();
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    expect(screen.getByText('9007199254740993')).toBeVisible();
    await act(async () => resolve({ data }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed');
    const timestamp = screen.getByText(/Last updated:/).querySelector('time').dateTime;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed');
    expect(screen.queryByText('Refreshing…')).not.toBeInTheDocument();
    expect(screen.getByText(/Last updated:/).querySelector('time').dateTime).not.toBe(timestamp);
  });

  it('announces counter reset failure without reporting a completed reset', async () => {
    render(<CounterContent counterId={9} counterName="counter" />);
    await flush();
    let reject;
    axios.patch.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset counter index 0' }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Resetting…');
    expect(screen.getByRole('button', { name: 'Reset all counters' })).toBeDisabled();
    await act(async () => reject({ response: { data: { error: 'Reset rejected' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Reset failed');
    expect(screen.queryByText('Reset complete')).not.toBeInTheDocument();
    expect(screen.getByText('9007199254740993')).toBeVisible();
  });

  it('keeps a direct-counter reset pending until its refresh callback completes', async () => {
    let acknowledge, refreshed;
    axios.patch.mockImplementationOnce(() => new Promise(done => { acknowledge = done; }));
    const onReset = vi.fn(() => new Promise(done => { refreshed = done; }));
    render(<DirectCounterReset tableID={7} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset counters' }));
    expect(screen.getByRole('status')).toHaveTextContent('Resetting…');
    await act(async () => acknowledge({ data: {} }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Resetting…' })).toBeDisabled();
    await act(async () => refreshed());
    expect(screen.getByRole('status')).toHaveTextContent('Reset complete');
    expect(screen.getByRole('button', { name: 'Reset counters' })).toBeEnabled();
  });
});
