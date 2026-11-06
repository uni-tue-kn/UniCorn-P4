import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { clearTopology, deployTopology, switchConfigs } from './topologyService';
import { deploymentFilename, liveLinkLabels, normalizeTopology, validateDeployableTopology, validateDraft, validateHostLinkChange } from './topologyModel';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
const graph = () => ({ hosts: ['h1'], switches: { s1: {} }, links: [['h1', 's1']], layout: { h1: { x: 100, y: 200 }, s1: { x: 400, y: 200 } } });
const active = () => ({ ...graph(), file_name: '/topologies/deploy.json', switches_online: [{ name: 's1', dev_id: 4, grpc_port: 50057, thrift_port: 9097 }] });
beforeEach(() => { vi.resetAllMocks(); axios.get.mockResolvedValue({ data: { status: 'ready', topology: active() } }); });
describe('topology deployment boundaries', () => {
  it('keeps disconnected model drafts editable but requires an interface before deployment', async () => {
    const draft = { hosts: [], switches: { s1: { target: 'tofino' } }, links: [] };
    expect(validateDraft(draft)).toBe('');
    await expect(deployTopology(draft, 'deploy.json')).rejects.toThrow('Tofino switch s1 requires at least one interface');
    expect(axios.post).not.toHaveBeenCalled();
    expect(validateDeployableTopology({ ...draft, ext_intfs: [['s1', 'physical1']] })).toBe('');
    expect(validateDeployableTopology({ ...draft, switches: { s1: {} } })).toBe('');
  });
  it('accepts the node and generated interface name boundaries while keeping external interfaces separate', () => {
    const singlePort = { hosts: ['hostaaaaa1'], switches: { switchaaa1: {} }, links: [['hostaaaaa1', 'switchaaa1']], ext_intfs: [['switchaaa1', 'physical-iface1']] };
    expect(validateDeployableTopology(singlePort)).toBe('');
    const tenPorts = { hosts: [], switches: { switchaa1: {}, s2: {} }, links: Array.from({ length: 10 }, () => ['switchaa1', 's2']) };
    expect(validateDeployableTopology(tenPorts)).toBe('');
    expect(validateDraft({ hosts: ['hostaaaaaa1'], switches: {}, links: [] })).toMatch(/at most 10 characters/);
    expect(validateDraft({ hosts: [], switches: { switchaaaa1: {} }, links: [] })).toMatch(/at most 10 characters/);
  });
  it.each([
    { hosts: [], switches: { switchaaaa1: {} }, links: [] },
    { hosts: [], switches: { switchaaa1: {}, s2: {} }, links: Array.from({ length: 10 }, () => ['switchaaa1', 's2']) },
  ])('rejects oversized generated interface names before any HTTP for $switches', async draft => {
    await expect(deployTopology(draft, 'deploy.json')).rejects.toThrow(/10 characters|15-character/);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.delete).not.toHaveBeenCalled();
  });
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
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } }).mockResolvedValueOnce({ data: [] });
    const value = await deployTopology(graph(), 'deploy.json');
    expect(value).toEqual(active());
    expect(axios.post.mock.calls.map(call => call[0])).toEqual(['/topologies', '/netsim/topology/deploy', '/switches/from_topology']);
    expect(axios.post.mock.calls[0][1]).toEqual({ name: 'deploy.json', topology: graph(), overwrite: false });
    const connection = JSON.parse(axios.post.mock.calls[2][1].switch_configs)[0];
    expect(connection).toMatchObject({ name: 's1', device_id: 4, address: '127.0.0.1:50057', register_thrift_host: '127.0.0.1', register_thrift_port: 9097, register_adapter_enabled: false });
  });
  it('retains terminal warnings while connecting a successfully deployed network', async () => {
    const warnings = ['Terminals could not be initialized: terminal unavailable'];
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } }).mockResolvedValueOnce({ data: [] });
    axios.get.mockResolvedValueOnce({ data: { status: 'ready', topology: active(), warnings } });
    expect(await deployTopology(graph(), 'deploy.json')).toEqual({ ...active(), deployment_warnings: warnings });
    expect(axios.post).toHaveBeenLastCalledWith('/switches/from_topology', expect.objectContaining({ create_switches: true }), expect.objectContaining({ timeout: expect.any(Number) }));
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
    axios.post.mockReset().mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job2' } });
    axios.get.mockResolvedValueOnce({ data: { status: 'ready', topology: { ...active(), file_name: '/topologies/other.json' } } });
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toThrow('invalid deployment');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  it('connects only after a ready job and exposes model startup progress', async () => {
    vi.useFakeTimers();
    try {
      axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } }).mockResolvedValueOnce({ data: [] });
      axios.get.mockResolvedValueOnce({ data: { status: 'running', switches: { s1: 'starting' } } }).mockResolvedValueOnce({ data: { status: 'ready', topology: active() } });
      const progress = vi.fn();
      const pending = deployTopology(graph(), 'deploy.json', true, progress);
      await vi.advanceTimersByTimeAsync(0);
      expect(progress).toHaveBeenLastCalledWith('s1: starting');
      expect(axios.post).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual(active());
      expect(axios.post).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('never connects a failed startup job', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } });
    axios.get.mockResolvedValueOnce({ data: { status: 'failed', error: 'Model startup failed' } });
    await expect(deployTopology(graph(), 'deploy.json')).rejects.toThrow('Model startup failed');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  it('connects mixed targets with distinct logical and native identities', () => {
    const configs = switchConfigs({ switches: { s1: {}, s2: { target: 'tofino', architecture: 'tofino2' } }, switches_online: [
      ...active().switches_online,
      { name: 's2', target: 'tofino', dev_id: 9, runtime_device_id: 0, grpc_port: 51052, target_options: { pipe_id: 0, client_id: 0 } },
    ] });
    expect(configs[0]).toMatchObject({ target: 'bmv2', address: '127.0.0.1:50057' });
    expect(configs[1]).toMatchObject({ target: 'tofino', device_id: 9, address: '127.0.0.1:51052', target_options: { pipe_id: 0, runtime_device_id: 0, architecture: 'tofino2' } });
    expect(configs[1].register_thrift_port).toBeUndefined();
    expect(configs[1].runtime_device_id).toBeUndefined();
  });
  it('keeps discovered native runtime identity inside target options and preserves explicit scope', () => {
    const topology = { switches: { s1: { target: 'tofino' } }, switches_online: [{ name: 's1', target: 'tofino', dev_id: 7, grpc_port: 51051, runtime_device_id: 3 }] };
    expect(switchConfigs(topology)[0].target_options).toEqual({ runtime_device_id: 3, pipe_id: 0, client_id: 0, architecture: 'tofino' });
    topology.switches_online[0].target_options = { runtime_device_id: 5, pipe_id: 2, client_id: 9 };
    const configured = switchConfigs(topology)[0];
    expect(configured.target_options).toEqual({ runtime_device_id: 5, pipe_id: 2, client_id: 9, architecture: 'tofino' });
    expect(configured.runtime_device_id).toBeUndefined();
  });
  it('reports partial deployment when switch connection fails', async () => {
    axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } }).mockRejectedValueOnce(new Error('Switch unavailable'));
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
  it('labels each switch with the port number used by its dataplane', () => {
    const labels = liveLinkLabels({ links: [['s1', 's2']], interface_mapping: {
      s1: [{ node: 's1', port: 1, interface: 's1-eth1', peer_node: 's2', peer_interface: 's2-eth1' }],
      s2: [{ node: 's2', port: 1, device_port: 0, interface: 's2-eth1', peer_node: 's1', peer_interface: 's1-eth1' }],
    } });
    expect(labels[0].ports).toEqual({ s1: 's1:1', s2: 's2:0' });
  });
  it('bounds deployment names without stacking prior deployment suffixes', () => {
    const name = deploymentFilename('a'.repeat(110) + '.json');
    expect(name.length).toBeLessThanOrEqual(124);
    expect(deploymentFilename('sample-deploy-12345-abc1.json')).toMatch(/^sample-deploy-\d+-[a-z0-9]+\.json$/);
  });
});
describe('deployment polling', () => {
  const start = () => axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockResolvedValueOnce({ data: { deployment_id: 'job1' } }).mockResolvedValueOnce({ data: [] });
  it('survives transient status request failures', async () => {
    start();
    axios.get.mockRejectedValueOnce({ message: 'Network Error' }).mockRejectedValueOnce({ response: { status: 502 }, message: 'Bad gateway' })
      .mockResolvedValueOnce({ data: { status: 'ready', topology: active() } });
    expect(await deployTopology(graph(), 'deploy.json', true, () => {}, { interval: 0 })).toEqual(active());
    expect(axios.get).toHaveBeenCalledTimes(3);
  });
  it('reports definite errors and repeated failures without connecting switches', async () => {
    start();
    axios.get.mockRejectedValueOnce({ response: { status: 404 }, message: 'Unknown deployment' });
    await expect(deployTopology(graph(), 'deploy.json', true, () => {}, { interval: 0 })).rejects.toMatchObject({ message: 'Unknown deployment' });
    axios.post.mockReset(); start();
    axios.get.mockReset().mockRejectedValue({ message: 'Network Error' });
    await expect(deployTopology(graph(), 'deploy.json', true, () => {}, { interval: 0 })).rejects.toMatchObject({ message: 'Network Error' });
    expect(axios.get).toHaveBeenCalledTimes(10);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  it('stops polling after the deployment deadline', async () => {
    start();
    axios.get.mockResolvedValue({ data: { status: 'running', switches: { s1: 'starting' } } });
    await expect(deployTopology(graph(), 'deploy.json', true, () => {}, { deadline: 50, interval: 10 })).rejects.toThrow('did not finish within');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  it('bounds every request, including a start request that never answers', async () => {
    vi.useFakeTimers();
    try {
      // Like axios, the mocked request rejects once its timeout expires.
      const hang = (url, body, config) => new Promise((resolve, reject) => setTimeout(() => reject({ message: `timeout of ${config.timeout}ms exceeded` }), config.timeout));
      axios.post.mockResolvedValueOnce({ data: { name: '/topologies/deploy.json' } }).mockImplementationOnce(hang);
      const outcome = expect(deployTopology(graph(), 'deploy.json', true, () => {}, { deadline: 20000 })).rejects.toThrow('did not finish within');
      await vi.advanceTimersByTimeAsync(0);
      expect(axios.post.mock.calls.map(call => call[2].timeout)).toEqual([20000, 20000]);
      await vi.advanceTimersByTimeAsync(20000);
      await outcome;
      expect(axios.get).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('fails before sending anything once the deadline is exhausted', async () => {
    await expect(deployTopology(graph(), 'deploy.json', true, () => {}, { deadline: 0 })).rejects.toThrow('did not finish within');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
