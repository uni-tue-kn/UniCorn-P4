import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import QueueContent, { validateQueueSettings } from './QueueContent';

const context = vi.hoisted(() => ({ currentSwitchID: 0 }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => context }));
vi.mock('axios', () => ({ default: { get: vi.fn(), patch: vi.fn(), isCancel: () => false } }));
const initial = { configured: true, write_available: true, readback_available: false,
  state: 'unknown', last_applied: [], message: 'Queue configuration readback is unavailable.',
  configuration: { defaults: { depth_packets: null, rate_pps: null }, ports: [
    { port: 1, interface: 's1-eth1', depth_packets: null, rate_pps: null, sources: {} },
  ] } };

beforeEach(() => {
  vi.clearAllMocks(); context.currentSwitchID = 0;
  axios.get.mockResolvedValue({ data: initial });
  axios.patch.mockResolvedValue({ data: { ...initial, state: 'last_applied', configuration: {
    defaults: { depth_packets: 128, rate_pps: '0' }, ports: [{ port: 1, interface: 's1-eth1', depth_packets: 128, rate_pps: '0', sources: { depth_packets: 'all_ports', rate_pps: 'all_ports' } }],
  }, last_applied: [
    { port: null, depth_packets: 128, applied_at: '2026-10-31T12:00:00+00:00' },
    { port: null, rate_pps: '0', applied_at: '2026-10-31T12:00:00+00:00' },
  ] } });
});

describe('queue controls', () => {
  it('validates native integer bounds and retains full i64 rate precision', () => {
    expect(validateQueueSettings({ scope: 'all', port: '', depth: '128', rate: '9223372036854775807' })).toEqual({ port: null, depth_packets: 128, rate_pps: '9223372036854775807' });
    expect(() => validateQueueSettings({ scope: 'all', depth: '0', rate: '' })).toThrow(/between 1/);
    expect(() => validateQueueSettings({ scope: 'all', depth: '', rate: '9223372036854775808' })).toThrow(/Queue rate/);
    expect(() => validateQueueSettings({ scope: 'port', port: '511', depth: '1', rate: '' })).toThrow(/Port/);
    expect(() => validateQueueSettings({ scope: 'all', depth: '', rate: '' })).toThrow(/Enter/);
  });

  it('shows unknown state and leaves fields empty instead of inventing target settings', async () => {
    render(<QueueContent />);
    expect(await screen.findByText('Queue configuration readback is unavailable.')).toBeVisible();
    expect(screen.getByText('Depth: Unknown')).toBeVisible();
    expect(screen.getByText('Rate: Unknown')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('s1-eth1');
    expect(screen.getByLabelText('Queue depth (packets)')).toHaveValue('');
    expect(screen.getByLabelText('Queue rate (packets/s)')).toHaveValue('');
    expect(screen.getByText(/native API has no queue configuration getter/)).toBeVisible();
  });

  it('applies all-port depth and unlimited rate and labels results as last applied', async () => {
    const user = userEvent.setup();
    render(<QueueContent />);
    await screen.findByText('Queue configuration readback is unavailable.');
    await user.type(screen.getByLabelText('Queue depth (packets)'), '128');
    await user.type(screen.getByLabelText('Queue rate (packets/s)'), '0');
    await user.click(screen.getByRole('button', { name: 'Apply queue settings' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/queues', { switch_id: 0, port: null, depth_packets: 128, rate_pps: '0' }));
    expect(await screen.findByText('Queue changes acknowledged by BMv2.')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('128 packets');
    await user.click(screen.getByRole('button', { name: 'Change history' }));
    expect(screen.getByRole('table', { name: 'Queue changes' })).toHaveTextContent('Unlimited (0)');
    expect(screen.getByRole('heading', { name: 'Last applied in this connection' })).toBeVisible();
  });

  it('can set only the rate on one port', async () => {
    const user = userEvent.setup();
    render(<QueueContent />);
    await screen.findByText('Queue configuration readback is unavailable.');
    await user.click(screen.getByRole('combobox', { name: 'Target queues' }));
    await user.click(screen.getByRole('option', { name: 'One port' }));
    await user.clear(screen.getByLabelText('Egress port'));
    await user.type(screen.getByLabelText('Egress port'), '3');
    await user.type(screen.getByLabelText('Queue rate (packets/s)'), '1000');
    await user.click(screen.getByRole('button', { name: 'Apply queue settings' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/queues', { switch_id: 0, port: 3, rate_pps: '1000' }));
  });

  it('rejects invalid settings before making a write request', async () => {
    const user = userEvent.setup();
    render(<QueueContent />);
    await screen.findByText('Queue configuration readback is unavailable.');
    await user.type(screen.getByLabelText('Queue depth (packets)'), '0');
    await user.click(screen.getByRole('button', { name: 'Apply queue settings' }));
    expect(await screen.findByText(/Queue depth must be/)).toBeVisible();
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('explains partial changes and unknown native outcomes', async () => {
    const user = userEvent.setup();
    axios.patch.mockRejectedValue({ response: { status: 503, data: {
      error: 'Native connection reset', uncertain: true,
      applied: [{ port: 2, depth_packets: 42, applied_at: '2026-10-31T12:00:00+00:00' }],
    } } });
    render(<QueueContent />);
    await screen.findByText('Queue configuration readback is unavailable.');
    await user.type(screen.getByLabelText('Queue depth (packets)'), '42');
    await user.type(screen.getByLabelText('Queue rate (packets/s)'), '100');
    await user.click(screen.getByRole('button', { name: 'Apply queue settings' }));
    expect(await screen.findByText(/1 earlier change\(s\) were applied/)).toBeVisible();
    expect(screen.getByText(/outcome is unknown/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Change history' }));
    expect(screen.getByRole('table', { name: 'Queue changes' })).toHaveTextContent('42');
    expect(screen.queryByText('Queue changes acknowledged by BMv2.')).not.toBeInTheDocument();
  });

  it('requires an explicit configured endpoint before enabling writes', async () => {
    axios.get.mockResolvedValue({ data: { ...initial, configured: false, write_available: false,
      message: 'Configure a BMv2 Thrift host and port.' } });
    render(<QueueContent />);
    expect(await screen.findByText('Configure a BMv2 Thrift host and port.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply queue settings' })).toBeDisabled();
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('clears a pending loading state when the switch is deselected', async () => {
    axios.get.mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(<QueueContent />);
    expect(screen.getByLabelText('Loading queue controls')).toBeVisible();
    context.currentSwitchID = null;
    rerender(<QueueContent />);
    expect(await screen.findByText('Select a connected switch to configure queues.')).toBeVisible();
    expect(screen.queryByLabelText('Loading queue controls')).not.toBeInTheDocument();
  });

  it('keeps the port configuration visible while refreshing and shows acknowledged values afterwards', async () => {
    const user = userEvent.setup();
    render(<QueueContent />);
    await screen.findByText('Queue configuration readback is unavailable.');
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Refresh queues' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('s1-eth1');
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    await act(async () => resolve({ data: { ...initial, configuration: {
      defaults: { depth_packets: 64, rate_pps: null }, ports: [{ port: 1, interface: 's1-eth1', depth_packets: 64, rate_pps: '250', sources: { depth_packets: 'all_ports', rate_pps: 'port' } }],
    } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('64 packets');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('250 packets/s');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('Port override');
  });

  it('keeps known configuration visible when native port discovery fails', async () => {
    axios.get.mockResolvedValue({ data: { ...initial, port_discovery: { status: 'unavailable', error: 'Native lookup failed' }, configuration: {
      defaults: { depth_packets: null, rate_pps: null }, ports: [{ port: 7, depth_packets: 42, rate_pps: null, sources: { depth_packets: 'port' } }],
    } } });
    render(<QueueContent />);
    expect(await screen.findByText(/Port discovery unavailable/)).toHaveTextContent('Native lookup failed');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('42 packets');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('Unknown');
    expect(screen.getByRole('table', { name: 'Per-port queue configuration' })).toHaveTextContent('Not discovered');
  });
});
