import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { TopologyProvider, useTopology, TOPOLOGY_DRAFT_STORAGE_KEY } from './TopologyContext';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
let api;
function Current() { api = useTopology(); return <p>{api.loadedHosts.join(',')}:{api.loadedSwitches.join(',')}:{api.currentTopologyName}</p>; }
const active = { file_name: '/topologies/live.json', hosts: ['h1'], switches: { s1: {} }, links: [] };
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  axios.get.mockImplementation(url => Promise.resolve({ data: url === '/topologies' ? { topologies: ['/topologies/live.json'] } : active }));
});
describe('active topology context', () => {
  it('leases network operations atomically and ignores a stale release', async () => {
    render(<TopologyProvider><Current /></TopologyProvider>);
    await screen.findByText('h1:s1:/topologies/live.json');
    let release;
    act(() => { release = api.acquireNetworkOperation('archive'); expect(api.acquireNetworkOperation('topology')).toBeNull(); });
    expect(api.archiveBusy).toBe(true);
    act(() => release());
    let finish;
    act(() => { finish = api.acquireNetworkOperation('topology'); release(); });
    expect(api.topologyOperationBusy).toBe(true);
    act(() => finish());
    expect(api.topologyOperationBusy).toBe(false);
  });
  it('clears a stale draft only on import, preserving later edits on refresh', async () => {
    render(<TopologyProvider><Current /></TopologyProvider>);
    await screen.findByText('h1:s1:/topologies/live.json');
    sessionStorage.setItem(TOPOLOGY_DRAFT_STORAGE_KEY, 'old draft');
    act(() => api.publishImportedTopology(active));
    expect(api.importRevision).toBe(1);
    expect(sessionStorage.getItem(TOPOLOGY_DRAFT_STORAGE_KEY)).toBeNull();
    sessionStorage.setItem(TOPOLOGY_DRAFT_STORAGE_KEY, 'new draft');
    await act(async () => api.getLoadedTopology());
    expect(api.importRevision).toBe(1);
    expect(sessionStorage.getItem(TOPOLOGY_DRAFT_STORAGE_KEY)).toBe('new draft');
  });
  it('updates graph, hosts and terminals together, then clears all active state', async () => {
    render(<TopologyProvider><Current /></TopologyProvider>);
    expect(await screen.findByText('h1:s1:/topologies/live.json')).toBeVisible();
    await act(async () => api.applyLoadedTopology({ ...active, hosts: ['h2'], switches: { s2: {} } }));
    expect(screen.getByText('h2:s2:/topologies/live.json')).toBeVisible();
    await act(async () => api.applyLoadedTopology({ file_name: null }));
    expect(screen.getByText('::')).toBeVisible();
    expect(api.loadedTopology).toBeNull();
  });
  it('does not replace a deployed graph with an old background response', async () => {
    let complete;
    axios.get.mockImplementation(url => url === '/topologies' ? Promise.resolve({ data: { topologies: [] } }) : new Promise(resolve => { complete = resolve; }));
    render(<TopologyProvider><Current /></TopologyProvider>);
    await act(async () => api.applyLoadedTopology({ ...active, hosts: ['h2'], switches: { s2: {} } }));
    await act(async () => complete({ data: active }));
    expect(screen.getByText('h2:s2:/topologies/live.json')).toBeVisible();
  });
  it('retains active data when refresh fails or returns malformed data', async () => {
    render(<TopologyProvider><Current /></TopologyProvider>);
    await screen.findByText('h1:s1:/topologies/live.json');
    axios.get.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => { await expect(api.getLoadedTopology()).rejects.toThrow('Offline'); });
    expect(screen.getByText('h1:s1:/topologies/live.json')).toBeVisible();
    axios.get.mockResolvedValueOnce({ data: { file_name: '/bad.json', hosts: 1, switches: {}, links: [] } });
    await act(async () => { await expect(api.getLoadedTopology()).rejects.toThrow('invalid topology'); });
    expect(screen.getByText('h1:s1:/topologies/live.json')).toBeVisible();
  });
  it('keeps terminal state stable on an ordinary refresh and resets it for a new deployment', async () => {
    render(<TopologyProvider><Current /></TopologyProvider>);
    await screen.findByText('h1:s1:/topologies/live.json');
    const hosts = api.loadedHosts, switches = api.loadedSwitches;
    axios.get.mockResolvedValueOnce({ data: structuredClone(active) });
    await act(async () => api.getLoadedTopology());
    expect(api.loadedHosts).toBe(hosts);
    expect(api.loadedSwitches).toBe(switches);
    await act(async () => api.applyLoadedTopology({ ...active, file_name: '/topologies/new-deployment.json' }));
    expect(api.loadedHosts).not.toBe(hosts);
    expect(api.loadedSwitches).not.toBe(switches);
  });
});
