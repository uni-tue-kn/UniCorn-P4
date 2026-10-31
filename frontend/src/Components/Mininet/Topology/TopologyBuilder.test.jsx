import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TopologyBuilder, { removeNode, renameNode, validateDraft } from './TopologyBuilder';

const context = vi.hoisted(() => ({ knownTopologies: ['/topologies/existing.json'], getTopologies: vi.fn(), loadedTopology: undefined, getLoadedTopology: vi.fn(), applyLoadedTopology: vi.fn(), importRevision: 0, archiveBusy: false, topologyOperationBusy: false, acquireNetworkOperation: undefined }));
vi.mock('../../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ getSwitches: vi.fn(), getSwitchesOnline: vi.fn(), getHistorySwitches: vi.fn() }) }));
vi.mock('../../../Contexts/TopologyContext', () => ({ TOPOLOGY_DRAFT_STORAGE_KEY: 'unicorn.topology.draft.v1', useTopology: () => context }));
vi.mock('../NetworkArchive', () => ({ default: () => null }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const topology = () => ({ hosts: ['h1'], switches: { s1: {}, s2: {} }, links: [['h1', 's1'], ['s1', 's2'], ['s1', 's2']], layout: { h1: { x: 100, y: 200 } }, ext_intfs: [['s1', 'eth0']] });

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); context.loadedTopology = undefined; context.importRevision = 0; context.archiveBusy = false; context.topologyOperationBusy = false; context.acquireNetworkOperation = undefined; context.getLoadedTopology.mockReset().mockResolvedValue(null); context.applyLoadedTopology.mockReset(); axios.get.mockReset(); axios.post.mockReset().mockResolvedValue({ data: { saved: true } }); });

async function choose(user, label, value) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: value }));
}

async function action(user, name) {
  await user.click(screen.getByRole('button', { name: 'Topology menu' }));
  await user.click(screen.getByRole('menuitem', { name, exact: true }));
}

async function saveDraft(user) {
  await action(user, 'Save topology');
  const dialog = await screen.findByRole('dialog', { name: 'Save topology' });
  await user.click(within(dialog).getByRole('button', { name: 'Save topology', exact: true }));
}

async function connect(user, source, target) {
  await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
  await user.click(screen.getByRole('button', { name: `Select ${source.startsWith('h') ? 'host' : 'switch'} ${source}` }));
  await user.click(screen.getByRole('button', { name: `Select ${target.startsWith('h') ? 'host' : 'switch'} ${target}` }));
}

describe('topology builder', () => {
  it('validates self links, host links, names and bandwidth while allowing parallel links', () => {
    expect(validateDraft(topology())).toBe('');
    expect(validateDraft({ ...topology(), links: [['h1', 'h1']] })).toMatch(/distinct/);
    expect(validateDraft({ ...topology(), hosts: ['h1', 'h2'], links: [['h1', 'h2']] })).toMatch(/switch/);
    expect(validateDraft({ ...topology(), hosts: ['h1', 'host1'] })).toMatch(/Numeric IDs/);
    expect(validateDraft({ ...topology(), links: [['h1', 's1', '2ms', 0]] })).toMatch(/positive/);
  });

  it('deleting a switch cascades its links, layout and external interfaces', () => {
    const value = topology();
    value.layout.s1 = { x: 50, y: 50 };
    const next = removeNode(value, 's1');
    expect(next.switches).toEqual({ s2: {} });
    expect(next.links).toEqual([]);
    expect(next.ext_intfs).toEqual([]);
    expect(next.layout.s1).toBeUndefined();
    expect(value.switches.s1).toEqual({});
  });

  it('renaming a node preserves switch settings, links and saved positions', () => {
    const next = renameNode(topology(), 'h1', 'host3');
    expect(next.hosts).toEqual(['host3']);
    expect(next.links[0]).toEqual(['host3', 's1']);
    expect(next.layout.host3).toEqual({ x: 100, y: 200 });
  });

  it('builds and saves an editable draft with explicit coordinates', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    expect(screen.getByRole('button', { name: 'Select host h1' })).toBeVisible();
    await connect(user, 'h1', 's1');
    const host = screen.getByRole('button', { name: 'Select host h1' });
    fireEvent.keyDown(host, { key: 'ArrowRight' });
    await saveDraft(user);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/topologies', {
      name: 'my-topology.json', overwrite: false,
      topology: { hosts: ['h1'], switches: { s1: {} }, links: [['h1', 's1', '0ms']], layout: { h1: { x: 110, y: 100 }, s1: { x: 250, y: 100 } } },
    }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Topology saved');
    expect(context.getTopologies).toHaveBeenCalledOnce();
    expect(axios.post.mock.calls.every(([url]) => url === '/topologies')).toBe(true);
  });

  it('imports existing files and supports renaming and deleting nodes', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { '/topologies/existing.json': topology() } });
    render(<TopologyBuilder />);
    await action(user, 'Import saved topology');
    await choose(user, 'Saved topology', 'existing.json');
    await user.click(screen.getByRole('button', { name: 'Import topology', exact: true }));
    await user.click(await screen.findByRole('button', { name: 'Select switch s1' }));
    await user.clear(screen.getByLabelText('Node name'));
    await user.type(screen.getByLabelText('Node name'), 'edge3');
    await user.click(screen.getByRole('button', { name: 'Apply name' }));
    expect(screen.getByRole('button', { name: 'Select switch edge3' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete node' }));
    expect(screen.queryByRole('button', { name: /Select link/ })).not.toBeInTheDocument();
    await saveDraft(user);
    await waitFor(() => expect(axios.post).toHaveBeenCalled());
    expect(axios.post.mock.calls[0][1]).toMatchObject({ name: 'existing.json', topology: { switches: { s2: {} }, ext_intfs: [], links: [] } });
  });

  it('displays conflict errors and only overwrites when selected', async () => {
    const user = userEvent.setup();
    axios.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Filename already exists' } } });
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await saveDraft(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Filename already exists');
    await user.click(screen.getByRole('checkbox', { name: 'Overwrite existing file' }));
    await user.click(screen.getByRole('button', { name: 'Save topology' }));
    await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/topologies', expect.objectContaining({ overwrite: true })));
  });

  it('prevents invalid node names without changing the draft', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.clear(screen.getByLabelText('Node name'));
    await user.type(screen.getByLabelText('Node name'), 'invalid');
    await user.click(screen.getByRole('button', { name: 'Apply name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('end with a numeric ID');
    expect(screen.getByRole('button', { name: 'Select host h1' })).toBeVisible();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('shows one live editable canvas and preserves a changed draft during background refresh', async () => {
    const user = userEvent.setup();
    const active = { hosts: ['h1'], switches: { s1: {} }, links: [{ node1: 's1', node2: 'h1', latency: '0ms', bandwidth: null }], file_name: '/topologies/live.json', layout: {}, interface_mapping: { s1: [{ node: 's1', port: 1, interface: 's1-eth1', peer_node: 'h1', peer_interface: 'h1-eth0' }] } };
    context.loadedTopology = active;
    const view = render(<TopologyBuilder />);
    expect(screen.getAllByRole('group', { name: 'Topology canvas' })).toHaveLength(1);
    expect(screen.getByText('Live', { exact: true })).toBeVisible();
    expect(screen.getByText('s1:1', { exact: true })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    expect(screen.getByText('Draft changes')).toBeVisible();
    expect(screen.queryByText('s1:1', { exact: true })).not.toBeInTheDocument();
    context.loadedTopology = { ...active, hosts: [], switches: { s3: {} }, links: [] };
    view.rerender(<TopologyBuilder />);
    expect(screen.getByRole('button', { name: 'Select host h2' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Select switch s3' })).not.toBeInTheDocument();
    context.getLoadedTopology.mockResolvedValue(context.loadedTopology);
    await action(user, 'Reload active topology');
    expect(await screen.findByRole('button', { name: 'Select switch s3' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Select host h2' })).not.toBeInTheDocument();
  });

  it('restores the draft and dragged layout after navigating away', async () => {
    const user = userEvent.setup();
    const view = render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Select host h1' }), { key: 'ArrowRight' });
    view.unmount();
    render(<TopologyBuilder />);
    expect(screen.getByRole('button', { name: 'Select host h1' })).toHaveAttribute('transform', 'translate(110,100)');
    expect(screen.getByText('Draft changes')).toBeVisible();
  });

  it('rejects invalid uploaded JSON without erasing the current draft', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    fireEvent.change(screen.getByLabelText('Import topology JSON'), { target: { files: [{ name: 'bad.json', size: 1, text: () => Promise.resolve('{') }] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON');
    expect(screen.getByRole('button', { name: 'Select switch s1' })).toBeVisible();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('imports valid JSON and retains its exact saved positions and switch properties', async () => {
    render(<TopologyBuilder />);
    const value = { ...topology(), switches: { s1: { label: 'edge' }, s2: {} } };
    fireEvent.change(screen.getByLabelText('Import topology JSON'), { target: { files: [{ name: 'imported.json', size: 500, text: () => Promise.resolve(JSON.stringify(value)) }] } });
    expect(await screen.findByRole('button', { name: 'Select host h1' })).toHaveAttribute('transform', 'translate(100,200)');
    await action(userEvent.setup(), 'Save topology');
    expect(await screen.findByRole('textbox', { name: 'Topology filename' })).toHaveValue('imported.json');
    expect(JSON.parse(sessionStorage.getItem('unicorn.topology.draft.v1')).topology.switches.s1).toEqual({ label: 'edge' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('exports JSON with editable topology and layout without touching the emulator', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:topology'); URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await action(user, 'Export topology JSON');
    const blob = URL.createObjectURL.mock.calls[0][0];
    const text = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
    expect(JSON.parse(text)).toMatchObject({ hosts: [], switches: { s1: {} }, links: [], layout: { s1: { x: 100, y: 100 } } });
    expect(click.mock.instances[0].download).toBe('my-topology.json');
    expect(axios.post).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('keeps the draft after a failed deployment and never connects invalid loads', async () => {
    const user = userEvent.setup();
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockRejectedValueOnce({ response: { data: { error: 'Mininet rejected the topology' } } });
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Deploy topology' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mininet rejected');
    expect(screen.getByRole('button', { name: 'Select switch s1' })).toBeVisible();
    expect(screen.getByText('Draft changes')).toBeVisible();
    expect(context.applyLoadedTopology).not.toHaveBeenCalled();
    expect(axios.post.mock.calls.map(call => call[0])).toEqual(['/topologies', '/netsim/topology/load']);
  });

  it('deploys a snapshot and adopts the actual live topology and port metadata', async () => {
    const user = userEvent.setup();
    let loaded;
    axios.post.mockImplementation((url, body) => {
      if (url === '/topologies') { loaded = { ...body.topology, file_name: '/topologies/' + body.name, switches_online: [{ name: 's1', dev_id: 4, grpc_port: 50057, thrift_port: 9097 }], interface_mapping: {} }; return Promise.resolve({ data: { name: loaded.file_name } }); }
      if (url === '/netsim/topology/load') return Promise.resolve({ data: loaded });
      return Promise.resolve({ data: [] });
    });
    context.applyLoadedTopology.mockImplementation(value => { context.loadedTopology = value; });
    context.getLoadedTopology.mockImplementation(() => Promise.resolve(loaded));
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Deploy topology' }));
    expect(await screen.findByText('Live', { exact: true })).toBeVisible();
    expect(context.applyLoadedTopology).toHaveBeenCalledWith(loaded);
    expect(JSON.parse(axios.post.mock.calls[2][1].switch_configs)[0]).toMatchObject({ address: '127.0.0.1:50057', register_thrift_port: 9097 });
    expect(sessionStorage.getItem('unicorn.topology.draft.v1')).toBeNull();
  });

  it('requires confirmation before clearing the running network and keeps the draft', async () => {
    const user = userEvent.setup();
    context.loadedTopology = { ...topology(), file_name: '/topologies/live.json' };
    context.applyLoadedTopology.mockImplementation(value => { context.loadedTopology = value.file_name ? value : null; });
    axios.delete.mockResolvedValue({ data: { file_name: null } });
    render(<TopologyBuilder />);
    await action(user, 'Clear running topology');
    expect(axios.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear running topology?' })).not.toBeInTheDocument());
    await action(user, 'Clear running topology');
    const dialog = await screen.findByRole('dialog', { name: 'Clear running topology?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear running topology', exact: true }));
    expect(await screen.findByText('Running topology cleared. Your draft is preserved.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear running topology?' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Select host h1' })).toBeVisible();
    expect(screen.getByText('Draft changes')).toBeVisible();
    expect(axios.delete.mock.calls.map(call => call[0])).toEqual(['/switches/active', '/netsim/topology/load']);
  });

  it('draws a link by selecting nodes and shows a preview without moving them', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    const host = screen.getByRole('button', { name: 'Select host h1' });
    const original = host.getAttribute('transform');
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
    expect(screen.queryByRole('combobox', { name: 'Link from' })).not.toBeInTheDocument();
    await user.click(host);
    expect(screen.getByRole('status')).toHaveTextContent('Source: h1');
    expect(screen.getByTestId('connection-preview')).toHaveAttribute('stroke-dasharray', '8 6');
    fireEvent(screen.getByRole('group', { name: 'Topology canvas' }), new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 180 }));
    expect(screen.getByTestId('connection-preview')).toHaveAttribute('x2', '300');
    expect(host).toHaveAttribute('transform', original);
    await user.click(screen.getByRole('button', { name: 'Select switch s1' }));
    expect(screen.getByRole('button', { name: 'Add link', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('connection-preview')).not.toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Link properties' });
    expect(within(panel).getByRole('textbox', { name: 'Latency' })).toHaveValue('0ms');
    expect(screen.getByRole('button', { name: 'Select link 1: h1 to s1' })).toBeVisible();
    expect(JSON.parse(sessionStorage.getItem('unicorn.topology.draft.v1')).topology.links).toEqual([['h1', 's1', '0ms']]);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('supports keyboard endpoint selection and Escape without creating duplicate edges', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
    const host = screen.getByRole('button', { name: 'Select host h1' }), sw = screen.getByRole('button', { name: 'Select switch s1' });
    act(() => host.focus());
    expect(screen.queryByTestId('connection-preview')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    act(() => sw.focus());
    await user.keyboard(' ');
    expect(screen.getAllByRole('button', { name: /^Select link/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
    act(() => host.focus());
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('connection-preview')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('connection-preview')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Select link/ })).toHaveLength(1);
    const position = host.getAttribute('transform');
    await user.keyboard('{ArrowRight}');
    expect(host).not.toHaveAttribute('transform', position);
  });

  it('rejects self links and host-to-host links while keeping the chosen source', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Select host h1' }));
    await user.click(screen.getByRole('button', { name: 'Select host h1' }));
    expect(screen.getByRole('status')).toHaveTextContent('Choose a different node');
    await user.click(screen.getByRole('button', { name: 'Select host h2' }));
    expect(screen.getByRole('status')).toHaveTextContent('Hosts connect through a switch');
    expect(screen.getByRole('status')).toHaveTextContent('Source: h1');
    expect(screen.queryByRole('button', { name: /^Select link/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel link' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps parallel connections distinct and edits only the selected link in its inspector', async () => {
    const user = userEvent.setup();
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await connect(user, 's1', 's2');
    await connect(user, 's1', 's2');
    const links = screen.getAllByRole('button', { name: /^Select link/ });
    expect(links).toHaveLength(2);
    expect(links[0].querySelector('path').getAttribute('d')).not.toBe(links[1].querySelector('path').getAttribute('d'));
    const panel = screen.getByRole('region', { name: 'Link properties' });
    await user.clear(within(panel).getByRole('textbox', { name: 'Latency' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Latency' }), '2ms');
    await user.type(within(panel).getByRole('spinbutton', { name: 'Bandwidth (Mbps)' }), '100');
    await user.click(within(panel).getByRole('button', { name: 'Update link' }));
    expect(JSON.parse(sessionStorage.getItem('unicorn.topology.draft.v1')).topology.links).toEqual([['s1', 's2', '0ms'], ['s1', 's2', '2ms', 100]]);
    await user.click(within(panel).getByRole('button', { name: 'Delete link', exact: true }));
    expect(screen.getAllByRole('button', { name: /^Select link/ })).toHaveLength(1);
  });

  it('saves isolated hosts as drafts but blocks deployment before acquiring a network operation', async () => {
    const user = userEvent.setup();
    context.acquireNetworkOperation = vi.fn(() => vi.fn());
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await saveDraft(user);
    await screen.findByText('Topology saved. Deploy to update the running network.');
    expect(axios.post).toHaveBeenCalledOnce();
    expect(axios.post.mock.calls[0][1].topology).toMatchObject({ hosts: ['h1'], links: [] });
    axios.post.mockClear();
    await user.click(await screen.findByRole('button', { name: 'Deploy topology' }));
    expect(screen.getByText('Host h1 must have exactly one switch link before deployment (found 0).')).toBeVisible();
    expect(context.acquireNetworkOperation).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejects second host uplinks both on the canvas and when changing link endpoints', async () => {
    const user = userEvent.setup();
    context.loadedTopology = { ...topology(), file_name: '/topologies/live.json' };
    render(<TopologyBuilder />);
    await connect(user, 's2', 'h1');
    expect(screen.getByRole('status')).toHaveTextContent('Host h1 already has a switch link');
    expect(screen.getAllByRole('button', { name: /^Select link/ })).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Cancel link' }));
    await user.click(screen.getByRole('button', { name: 'Select link 2: s1 to s2' }));
    await user.click(screen.getByRole('button', { name: 'Change endpoints' }));
    await choose(user, 'Link from', 'h1');
    await user.click(screen.getByRole('button', { name: 'Update link' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Host h1 already has a switch link');
    expect(screen.getByRole('button', { name: 'Select link 2: s1 to s2' })).toBeVisible();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('imports multihomed drafts for repair while blocking their deployment', async () => {
    const user = userEvent.setup();
    const imported = { ...topology(), links: [['h1', 's1'], ['h1', 's2']] };
    axios.get.mockResolvedValue({ data: { '/topologies/existing.json': imported } });
    render(<TopologyBuilder />);
    await action(user, 'Import saved topology');
    await choose(user, 'Saved topology', 'existing.json');
    await user.click(screen.getByRole('button', { name: 'Import topology', exact: true }));
    await screen.findByRole('button', { name: 'Select link 2: h1 to s2' });
    await user.click(screen.getByRole('button', { name: 'Deploy topology' }));
    expect(screen.getByText('Host h1 must have exactly one switch link before deployment (found 2).')).toBeVisible();
    expect(axios.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Select link 2: h1 to s2' }));
    await user.click(screen.getByRole('button', { name: 'Delete link', exact: true }));
    await saveDraft(user);
    await waitFor(() => expect(axios.post).toHaveBeenCalledOnce());
    expect(axios.post.mock.calls[0][1].topology.links).toEqual([['h1', 's1']]);
  });

  it('adopts a successful global import but preserves a new edited draft on later remount', async () => {
    const user = userEvent.setup();
    context.loadedTopology = { hosts: ['h1'], switches: { s1: {} }, links: [], file_name: '/topologies/before.json' };
    const view = render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    expect(screen.getByRole('button', { name: 'Select host h2' })).toBeVisible();
    context.importRevision = 1;
    context.loadedTopology = { hosts: [], switches: { s3: {} }, links: [], file_name: '/topologies/imported.json' };
    view.rerender(<TopologyBuilder />);
    expect(screen.queryByRole('button', { name: 'Select host h2' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select switch s3' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add host' }));
    view.unmount();
    render(<TopologyBuilder />);
    expect(screen.getByRole('button', { name: 'Select host h1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Select switch s3' })).toBeVisible();
    expect(screen.getByText('Draft changes')).toBeVisible();
  });

  it('blocks conflicting global operations before deployment can change the emulator', async () => {
    const user = userEvent.setup();
    context.acquireNetworkOperation = vi.fn(() => null);
    render(<TopologyBuilder />);
    await user.click(screen.getByRole('button', { name: 'Add switch' }));
    await user.click(screen.getByRole('button', { name: 'Deploy topology' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Another network operation');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    ['horizontal', { h1: { x: 100, y: 100 }, s1: { x: 300, y: 100 } }, 200, 100, '{Enter}'],
    ['vertical', { h1: { x: 100, y: 100 }, s1: { x: 100, y: 300 } }, 100, 200, ' '],
  ])('gives %s links a positive midpoint hit target for pointer and keyboard selection', async (_, layout, x, y, key) => {
    const user = userEvent.setup();
    context.loadedTopology = { hosts: ['h1'], switches: { s1: {} }, links: [['h1', 's1']], layout, file_name: '/topologies/live.json' };
    render(<TopologyBuilder />);
    const link = screen.getByRole('button', { name: 'Select link 1: h1 to s1' });
    const target = link.querySelector('[data-link-hit-target]');
    expect(target).toHaveAttribute('cx', String(x));
    expect(target).toHaveAttribute('cy', String(y));
    expect(target).toHaveAttribute('r', '8');
    expect(target).toHaveAttribute('pointer-events', 'all');
    await user.click(target);
    expect(screen.getByRole('region', { name: 'Link properties' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close link properties' }));
    act(() => link.focus());
    await user.keyboard(key);
    expect(screen.getByRole('region', { name: 'Link properties' })).toBeVisible();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('keeps the canvas transform stable throughout the first node drag', () => {
    context.loadedTopology = { hosts: ['h1'], switches: { s1: {} }, links: [], layout: { h1: { x: 100, y: 100 }, s1: { x: 300, y: 100 } }, file_name: '/topologies/live.json' };
    render(<TopologyBuilder />);
    const canvas = screen.getByRole('group', { name: 'Topology canvas' }), host = screen.getByRole('button', { name: 'Select host h1' });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: screen.queryByRole('region', { name: 'Node properties' }) ? 520 : 800, height: 400 });
    fireEvent(host, new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
    expect(screen.queryByRole('region', { name: 'Node properties' })).not.toBeInTheDocument();
    fireEvent(canvas, new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 120 }));
    expect(host).toHaveAttribute('transform', 'translate(140,120)');
    expect(screen.queryByRole('region', { name: 'Node properties' })).not.toBeInTheDocument();
    fireEvent(canvas, new MouseEvent('pointerup', { bubbles: true, clientX: 140, clientY: 120 }));
    expect(screen.getByRole('region', { name: 'Node properties' })).toBeVisible();
    expect(host).toHaveAttribute('transform', 'translate(140,120)');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
