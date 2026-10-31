import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { clearTopology, deployTopology, switchConfigs } from './topologyService';
import { deploymentFilename, liveLinkLabels, normalizeTopology, validateDeployableTopology, validateDraft, validateHostLinkChange } from './topologyModel';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
const graph = () => ({ hosts: ['h1'], switches: { s1: {} }, links: [['h1', 's1']], layout: { h1: { x: 100, y: 200 }, s1: { x: 400, y: 200 } } });
const active = () => ({ ...graph(), file_name: '/topologies/deploy.json', switches_online: [{ name: 's1', dev_id: 4, grpc_port: 50057, thrift_port: 9097 }] });
beforeEach(() => vi.resetAllMocks());
describe('topology deployment boundaries', () => {
  it.each([{ links: [] }, { links: [['h1', 's1'], ['s1', 'h1']] }])('rejects host uplinks $links before saving or changing the running network', async ({ links }) => {
    const draft = { ...graph(), links };
    expect(validateDraft(draft)).toBe('');
    expect(() => normalizeTopology(draft)).not.toThrow();
    await expect(deployTopology(draft, 'deploy.json')).rejects.toThrow(`Host h1 must have exactly one switch link before deployment (found ${links.length})`);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.delete).not.toHaveBeenCalled();
  });
  it('permits parallel switch links and lets imported host uplinks be repaired', () => {
    const draft = { ...graph(), switches: { s1: {}, s2: {} }, links: [['h1', 's1'], ['s1', 's2'], ['s2', 's1']] };
    expect(validateDeployableTopology(draft)).toBe('');
    expect(validateHostLinkChange(draft, ['h1', 's2'])).toMatch(/already has a switch link/);
    expect(validateHostLinkChange(draft, ['s2', 'h1'], 1)).toMatch(/already has a switch link/);
    expect(validateHostLinkChange(draft, ['h1', 's2'], 0)).toBe('');
    const imported = { ...draft, links: [['h1', 's1'], ['h1', 's2']] };
    expect(validateHostLinkChange(imported, ['h1', 's1', '2ms'], 0)).toBe('');
    expect(validateDeployableTopology({ ...imported, links: [imported.links[1]] })).toBe('');
  });
  it('saves before loading and connects the actual discovered switch endpoints', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: active() }).mockResolvedValueOnce({ data: [] });
    const value = await deployTopology(graph(), 'deploy.json');
    expect(value).toEqual(active());
    expect(axios.post.mock.calls.map(call => call[0])).toEqual(['/topologies', '/netsim/topology/load', '/switches/from_topology']);
    expect(axios.post.mock.calls[0][1]).toEqual({ name: 'deploy.json', topology: graph(), overwrite: false });
    const connection = JSON.parse(axios.post.mock.calls[2][1].switch_configs)[0];
    expect(connection).toMatchObject({ name: 's1', device_id: 4, address: '127.0.0.1:50057', register_thrift_host: '127.0.0.1', register_thrift_port: 9097, register_adapter_enabled: false });
  });
  it('never changes the emulator when saving fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('Disk full'));
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toThrow('Disk full');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
  it('does not connect switches after a failed or mismatched load', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockRejectedValueOnce({ response: { status: 400 }, message: 'Invalid topology' });
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toMatchObject({ message: 'Invalid topology' });
    expect(axios.post).toHaveBeenCalledTimes(2);
    axios.post.mockReset().mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { ...active(), file_name: '/topologies/other.json' } });
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toThrow('invalid deployment');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  it('recovers a transport interruption only when the exact fresh snapshot is active', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce({ data: [] });
    axios.get.mockResolvedValueOnce({ data: active() });
    expect(await deployTopology(graph(), 'deploy.json')).toEqual(active());
  });
  it('reports partial deployment when switch connection fails', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: active() }).mockRejectedValueOnce(new Error('Switch unavailable'));
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toThrow('network was deployed, but switch connections failed');
  });
  it('requires complete discovered endpoints and clears controller connections before the network', async () => {
    expect(() => switchConfigs({ switches: { s1: {} }, switches_online: [] })).toThrow('Not all switch endpoints');
    axios.delete.mockResolvedValue({ data: { file_name: null } });
    await clearTopology();
    expect(axios.delete.mock.calls.map(call => call[0])).toEqual(['/switches/active', '/netsim/topology/load']);
  });
});

describe('live topology normalization', () => {
  it('preserves active link settings, layout and external interface attachments', () => {
    const value = normalizeTopology({ ...graph(), links: [{ node1: 's1', node2: 'h1', latency: '2ms', bandwidth: 100 }], ext_intfs: [{ switch: 's1', interface: 'eth0' }], file_name: '/topologies/active.json', interface_mapping: {} });
    expect(value.links).toEqual([['s1', 'h1', '2ms', 100]]);
    expect(value.ext_intfs).toEqual([['s1', 'eth0']]);
    expect(value.layout.h1).toEqual({ x: 100, y: 200 });
    expect(value.file_name).toBeUndefined();
    expect(validateDraft(value)).toBe('');
  });
  it('keeps parallel links associated with their own actual interfaces', () => {
    const topology = { links: [['s1', 's2'], ['s1', 's2']], interface_mapping: {
      s1: [{ node: 's1', port: 1, interface: 's1-eth1', peer_node: 's2', peer_interface: 's2-eth1' }, { node: 's1', port: 2, interface: 's1-eth2', peer_node: 's2', peer_interface: 's2-eth2' }],
      s2: [{ node: 's2', port: 1, interface: 's2-eth1', peer_node: 's1', peer_interface: 's1-eth1' }, { node: 's2', port: 2, interface: 's2-eth2', peer_node: 's1', peer_interface: 's1-eth2' }],
    } };
    const labels = liveLinkLabels(topology);
    expect(labels.map(label => label.ports)).toEqual([{ s1: 's1:1', s2: 's2:1' }, { s1: 's1:2', s2: 's2:2' }]);
  });
  it('bounds deployment names without stacking prior deployment suffixes', () => {
    const name = deploymentFilename('a'.repeat(110) + '.json');
    expect(name.length).toBeLessThanOrEqual(124);
    expect(deploymentFilename('sample-deploy-12345-abc1.json')).toMatch(/^sample-deploy-\d+-[a-z0-9]+\.json$/);
  });
});
