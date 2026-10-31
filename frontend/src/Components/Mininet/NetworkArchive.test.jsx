import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
