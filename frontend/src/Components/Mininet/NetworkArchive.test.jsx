import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { MemoryRouter, useLocation } from 'react-router-dom';
import NetworkArchive, { externalMappings } from './NetworkArchive';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const mocks = vi.hoisted(() => ({ release: vi.fn(), acquire: vi.fn(), publish: vi.fn(), select: vi.fn(), refresh: vi.fn() }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ getSwitches: mocks.refresh, getSwitchesOnline: mocks.refresh, getHistorySwitches: mocks.refresh, setCurrentSwitchID: mocks.select }) }));
vi.mock('../../Contexts/TopologyContext', () => ({ useTopology: () => ({ getLoadedTopology: mocks.refresh, getTopologies: mocks.refresh, publishImportedTopology: mocks.publish, acquireNetworkOperation: mocks.acquire }) }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ updateInitializedFiles: vi.fn() }) }));
function Location() { return <p data-testid="route">{useLocation().pathname}</p>; }
function renderArchive(props = {}) { return render(<MemoryRouter initialEntries={['/registers/test']}><header><NetworkArchive {...props} /></header><Location /></MemoryRouter>); }
const preview = { version: '1.2.0', captured_at: '2026-10-31T12:00:00Z', topology: { file_name: '/topologies/imported.json', hosts: ['h1'], switches: { s1: {} }, links: [['h1', 's1']] },
  switches: [{ key: 's1', name: 's1', kind: 'emulated', pipeline: true, device_id: 0, runtime: { registers: { status: 'captured' } } },
    { key: 'remote', name: 'remote', kind: 'external', pipeline: true, device_id: 42, runtime: {} }], warnings: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockReturnValue(mocks.release);
  axios.post.mockImplementation(url => Promise.resolve({ data: url.endsWith('/deploy') ? { status: 'complete', topology: preview.topology, switches: [] } : { preview, import_token: 'validated-token' } }));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
it('validates an upload before an explicit deploy and leaves external targets unmapped', async () => {
  const user = userEvent.setup();
  const onImported = vi.fn();
  renderArchive({ onImported });
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'lab.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post.mock.calls[0][1]).toBeInstanceOf(FormData);
  expect(screen.getByRole('checkbox', { name: /Restore external switches/ })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  await screen.findByText('Network imported successfully.');
  expect(axios.post.mock.calls[1][1]).toEqual({ import_token: 'validated-token', restore_external: false, external_targets: {}, attach_external_interfaces: false, restore_queues: true });
  expect(onImported).toHaveBeenCalled();
  expect(mocks.select).toHaveBeenCalledWith(null);
  expect(mocks.publish).toHaveBeenCalledWith(preview.topology);
  await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/topology'));
  expect(mocks.release).toHaveBeenCalledTimes(2);
});
it('shows validation progress and rejects a bad archive without offering deployment', async () => {
  let reject;
  axios.post.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['broken'], 'broken.zip', { type: 'application/zip' }));
  expect(screen.getByRole('button', { name: 'Import and deploy' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Validating network');
  await act(async () => reject({ response: { data: { error: 'Checksum mismatch' } } }));
  await screen.findByText('Checksum mismatch');
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Import and deploy' })).toBeDisabled();
});
it('exports a downloadable bundle with visible pending and completion feedback', async () => {
  let resolve;
  axios.get.mockImplementation(() => new Promise(done => { resolve = done; }));
  const user = userEvent.setup();
  renderArchive();
  await user.click(screen.getByRole('button', { name: 'Network archive' }));
  await user.click(screen.getByRole('menuitem', { name: 'Export network' }));
  expect(screen.getByRole('status')).toHaveTextContent('Exporting network');
  expect(screen.getByRole('button', { name: 'Network archive' })).toBeDisabled();
  expect(document.querySelector('header')).not.toContainElement(screen.getByRole('status'));
  await act(async () => resolve({ data: new Blob(['bundle']), headers: { 'content-disposition': 'attachment; filename="lab.zip"' } }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Network exported'));
  expect(URL.createObjectURL).toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
});
it('requires explicit external destinations and never uses archive addresses implicitly', () => {
  expect(externalMappings(preview, {}, false)).toEqual({});
  expect(externalMappings(preview, {}, true)).toEqual({});
  expect(() => externalMappings(preview, { remote: { selected: true, device_id: '42' } }, true)).toThrow('destination');
  expect(externalMappings(preview, { remote: { selected: true, address: '192.0.2.10:50051', device_id: '7' } }, true).remote)
    .toMatchObject({ address: '192.0.2.10:50051', device_id: 7, register_adapter_enabled: false, register_thrift_host: null });
  expect(() => externalMappings(preview, { remote: { selected: true, address: '192.0.2.10:50051', device_id: '7', thrift_host: '192.0.2.10', thrift_port: '' } }, true)).toThrow('valid Thrift port');
});

it('preserves native destination scope without carrying a stale program binding or Thrift settings', () => {
  const native = { switches: [{ key: 'native', name: 'remote', kind: 'external', target: 'tofino',
    target_options: { runtime_device_id: 2, pipe_id: 1, client_id: 7, program_name: 'old_program' } }] };
  const destination = externalMappings(native, { native: { selected: true, address: '192.0.2.10:50052', device_id: '8' } }, true).native;
  expect(destination).toMatchObject({ target: 'tofino', device_id: 8,
    target_options: { runtime_device_id: 2, pipe_id: 1, client_id: 7 },
    register_adapter_enabled: false, register_thrift_host: null, register_thrift_port: null });
  expect(destination.target_options).not.toHaveProperty('program_name');
  expect(() => externalMappings(native, { native: { selected: true, address: 'a:1', device_id: '8', target_options: { pipe_id: 65535 } } }, true)).toThrow('pipeline instance');
});

it('restores a native external archive through an asynchronous job with explicit destination options', async () => {
  const native = { ...preview, topology: null, switches: [{ key: 'native', name: 'remote', kind: 'external',
    target: 'tofino', target_options: { runtime_device_id: 2, pipe_id: 1, client_id: 7 },
    device_id: 8, pipeline: true, runtime: {} }] };
  axios.post.mockResolvedValueOnce({ data: { preview: native, import_token: 'native-token' } });
  axios.post.mockResolvedValueOnce({ status: 202, data: { import_token: 'native-token', status: 'pending', progress: { phase: 'Starting network' } } });
  axios.get.mockResolvedValueOnce({ data: { import_token: 'native-token', status: 'running', progress: { phase: 'Restoring remote' } } });
  axios.get.mockResolvedValueOnce({ data: { import_token: 'native-token', status: 'complete', result: {
    status: 'complete', topology: null, switches: [{ name: 'remote', status: 'complete', categories: {} }], warnings: [] } } });
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'native.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  await user.click(screen.getByRole('checkbox', { name: /Restore external switches/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Restore remote', exact: true }));
  await user.type(screen.getByRole('textbox', { name: 'Control address for remote' }), '192.0.2.10:50052');
  expect(screen.queryByRole('textbox', { name: 'Thrift host for remote' })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Use register adapter for remote' })).not.toBeInTheDocument();
  await user.click(screen.getByText('Advanced connection options'));
  const clientNumber = screen.getByRole('textbox', { name: 'Client number for remote' });
  await user.clear(clientNumber);
  await user.type(clientNumber, '9');
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  await screen.findByText('Restoring remote', {}, { timeout: 3000 });
  expect(screen.getByRole('button', { name: 'Importing network…' })).toBeDisabled();
  await screen.findByText('Network imported successfully.', {}, { timeout: 5000 });
  expect(axios.post.mock.calls[1][1]).toMatchObject({ async: true, import_token: 'native-token',
    external_targets: { native: { target: 'tofino', target_options: { runtime_device_id: 2, pipe_id: 1, client_id: 9 } } } });
  expect(axios.get).toHaveBeenCalledWith('/network/import/deploy', expect.objectContaining({ params: { import_token: 'native-token' } }));
  await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/switches'));
});

it.each([false, true])('uses the displayed Thrift default without edits and rejects an explicitly blank port (blank=%s)', async blank => {
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'external.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  await user.click(screen.getByRole('checkbox', { name: /Restore external switches/ }));
  await user.click(screen.getByRole('checkbox', { name: 'Restore remote', exact: true }));
  await user.type(screen.getByRole('textbox', { name: 'P4Runtime address for remote' }), '192.0.2.10:50051');
  await user.type(screen.getByRole('textbox', { name: 'Thrift host for remote' }), '192.0.2.10');
  expect(screen.getByRole('textbox', { name: 'Thrift port for remote' })).toHaveValue('9090');
  if (blank) await user.clear(screen.getByRole('textbox', { name: 'Thrift port for remote' }));
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  if (blank) {
    expect(await screen.findByText('Enter a valid Thrift port for remote.')).toBeVisible();
    expect(axios.post).toHaveBeenCalledTimes(1);
  } else {
    await screen.findByText('Network imported successfully.');
    expect(axios.post.mock.calls[1][1].external_targets.remote).toMatchObject({ address: '192.0.2.10:50051', device_id: 42, register_thrift_host: '192.0.2.10', register_thrift_port: 9090 });
  }
});

it('does not upload or deploy while another network operation owns the lease', async () => {
  mocks.acquire.mockReturnValue(null);
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'lab.zip', { type: 'application/zip' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('keeps failed imports on the original route without clearing its switch selection', async () => {
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'lab.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  axios.post.mockRejectedValueOnce(new Error('Connection refused'));
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  await screen.findByText('Connection refused');
  expect(screen.getByTestId('route')).toHaveTextContent('/registers/test');
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it('shows partial category diagnostics immediately and keeps successful restoration details collapsed', async () => {
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'mixed.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  axios.post.mockResolvedValueOnce({ data: {
    status: 'partial', topology: preview.topology, warnings: [], switches: [{
      key: 's1', name: 's1', status: 'partial', errors: ['Pipeline restored, but some runtime state was not applied.'],
      categories: {
        tables: { status: 'complete', restored: 3, captured: 3, failed: 0, errors: [] },
        registers: { status: 'partial', restored: 0, captured: 16, failed: 16, errors: ['Target rejected register write: register access is unsupported.'] },
        direct_meters: { status: 'partial', restored: 1, captured: 2, failed: 1, errors: ['Direct meter parent table entry was not restored.'] },
        queues: { status: 'skipped', restored: 0, readback_available: false, note: 'Queue replay was not requested.' },
      },
    }],
  } });
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  const report = await screen.findByRole('region', { name: 'Network restoration report' });
  expect(within(report).getByText('Network imported with incomplete state.')).toBeVisible();
  expect(within(report).getByText('Pipeline restored, but some runtime state was not applied.')).toBeVisible();
  const table = within(report).getByRole('table', { name: 'Incomplete restoration for s1' });
  const registers = within(table).getByRole('row', { name: /registers partial/ });
  expect(registers).toHaveTextContent('0 / 16');
  expect(registers).toHaveTextContent('Failed entries: 16');
  expect(within(registers).getByText('Target rejected register write: register access is unsupported.')).toBeVisible();
  expect(within(table).getByText('Direct meter parent table entry was not restored.')).toBeVisible();
  expect(within(table).getByText('Queue replay was not requested.')).toBeVisible();
  expect(within(table).getByRole('row', { name: /queues skipped/ })).toBeVisible();
  expect(within(report).getByText('tables')).not.toBeVisible();
  await user.click(within(report).getByText('Successfully restored resources (1)'));
  const completed = within(report).getByRole('table', { name: 'Successful restoration for s1' });
  expect(within(completed).getByRole('row', { name: /tables complete 3 \/ 3/ })).toBeVisible();
  expect(screen.getByRole('table', { name: 'Switches in network bundle' })).toHaveTextContent('registers: captured');
});

it('shows a top-level topology restoration failure without claiming a successful import or changing the active selection', async () => {
  const user = userEvent.setup();
  renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'failed-topology.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  axios.post.mockResolvedValueOnce({ data: { status: 'partial', switches: [], warnings: [], error: 'Emulator unavailable: topology could not be loaded.' } });
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  const report = await screen.findByRole('region', { name: 'Network restoration report' });
  expect(within(report).getByText('Network import could not finish.')).toBeVisible();
  expect(within(report).getByText('Emulator unavailable: topology could not be loaded.')).toBeVisible();
  expect(within(report).queryByText('Network imported successfully.')).not.toBeInTheDocument();
  expect(screen.getByTestId('route')).toHaveTextContent('/registers/test');
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it('reports uncaptured queue settings as an import warning without claiming deployment failed', async () => {
  const user = userEvent.setup(); renderArchive();
  await user.upload(screen.getByLabelText('Import network archive'), new File(['zip'], 'tutorial.zip', { type: 'application/zip' }));
  await screen.findByRole('table', { name: 'Switches in network bundle' });
  axios.post.mockResolvedValueOnce({ data: { status: 'partial', topology: preview.topology,
    warnings: ['Some queue fields are unknown and will not be inferred or restored', 'queues: unavailable'],
    switches: [{ key: 's1', name: 's1', status: 'complete', errors: [], categories: { tables: { status: 'complete', captured: 2, restored: 2, errors: [] } } }] } });
  await user.click(screen.getByRole('button', { name: 'Import and deploy' }));
  const report = await screen.findByRole('region', { name: 'Network restoration report' });
  expect(within(report).getByText('Network imported with warnings.')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Network imported with warnings. Some state was not captured or was skipped.');
  expect(screen.getByRole('status')).not.toHaveTextContent('failed');
  expect(screen.getByText('queues: unavailable')).toBeVisible();
  expect(mocks.publish).toHaveBeenCalledWith(preview.topology);
});
