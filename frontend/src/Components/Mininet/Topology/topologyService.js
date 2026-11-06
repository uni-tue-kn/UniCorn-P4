import axios from 'axios';
import { validateDeployableTopology } from './topologyModel';

export function switchConfigs(topology) {
  const names = Object.keys(topology.switches || {});
  const online = topology.switches_online || [];
  const configs = online.filter(switchInfo => names.includes(switchInfo.name)).map(switchInfo => {
    const target = switchInfo.target ?? topology.switches[switchInfo.name]?.target ?? 'bmv2';
    if (!['bmv2', 'tofino'].includes(target) || !Number.isInteger(switchInfo.grpc_port) || switchInfo.grpc_port < 1 || switchInfo.grpc_port > 65535 || !Number.isInteger(switchInfo.dev_id) || switchInfo.dev_id < 0) throw new Error('The emulator returned invalid switch endpoints.');
    const config = { name: switchInfo.name, target, address: switchInfo.address || `127.0.0.1:${switchInfo.grpc_port}`, device_id: switchInfo.dev_id, proto_dump_file: `${switchInfo.name}_proto.log` };
    if (target === 'tofino') return { ...config, target_options: { client_id: 0, pipe_id: 0, runtime_device_id: switchInfo.runtime_device_id ?? 0, ...(switchInfo.target_options || {}), architecture: switchInfo.architecture || topology.switches[switchInfo.name]?.architecture || switchInfo.target_options?.architecture || 'tofino' } };
    return { ...config, register_adapter_enabled: false, register_thrift_host: switchInfo.thrift_port ? '127.0.0.1' : null, register_thrift_port: switchInfo.thrift_port ?? null };
  });
  if (new Set(configs.map(config => config.name)).size !== names.length) throw new Error('Not all switch endpoints are available. Reload active topology and connect missing switches in Switch Menu.');
  return configs;
}

// Tofino models may take several minutes each (TOFINO_START_TIMEOUT, 240 s
// by default). The deadline covers the whole deployment, from saving the
// topology to connecting its switches, and only stops one that never ends.
const DEPLOY_DEADLINE_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
const POLL_REQUEST_TIMEOUT_MS = 15000;
const MAX_POLL_FAILURES = 10;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// A missing response or a gateway/server error may be temporary. Errors with
// a definite answer, such as an unknown deployment, are reported at once.
const transientPollFailure = failure => !failure.response || failure.response.status >= 500;

export async function deployTopology(topology, filename, connect = true, onProgress = () => {}, { deadline = DEPLOY_DEADLINE_MS, interval = POLL_INTERVAL_MS } = {}) {
  const problem = validateDeployableTopology(topology);
  if (problem) throw new Error(problem);
  const stopAt = Date.now() + deadline;
  const expired = () => new Error(`The deployment did not finish within ${Math.max(1, Math.round(deadline / 60000))} minutes. Reload active topology to check the network state.`);
  // Bound every request by the time left. Axios treats a timeout of 0 as
  // unlimited, so an exhausted deadline fails before sending anything.
  const request = async (send, limit = Infinity) => {
    const left = stopAt - Date.now();
    if (left <= 0) throw expired();
    try {
      return await send({ timeout: Math.max(1, Math.min(limit, left)) });
    } catch (failure) {
      if (Date.now() >= stopAt) throw expired();
      throw failure;
    }
  };
  const saved = await request(config => axios.post('/topologies', { name: filename, topology, overwrite: false }, config), REQUEST_TIMEOUT_MS);
  if (!saved.data?.name) throw new Error('The server did not return a saved topology path.');
  const path = saved.data.name;
  onProgress('Starting network…');
  const started = (await request(config => axios.post('/netsim/topology/deploy', { topology_file: path }, config), REQUEST_TIMEOUT_MS)).data;
  if (!started?.deployment_id) throw new Error('The emulator did not return a deployment ID.');
  let loaded, warnings, failures = 0;
  for (;;) {
    let job;
    try {
      job = (await request(config => axios.get(`/netsim/topology/deploy/${encodeURIComponent(started.deployment_id)}`, config), POLL_REQUEST_TIMEOUT_MS)).data;
      failures = 0;
    } catch (failure) {
      if (Date.now() >= stopAt || !transientPollFailure(failure) || ++failures >= MAX_POLL_FAILURES) throw failure;
      onProgress('Waiting for the emulator…');
      await sleep(interval);
      continue;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Topology deployment failed.');
    if (job.status === 'ready') { loaded = job.topology; warnings = job.warnings || []; break; }
    if (!['pending', 'running'].includes(job.status)) throw new Error('The emulator returned an invalid deployment status.');
    const phases = Object.entries(job.switches || {}).map(([name, phase]) => `${name}: ${phase}`).join(' · ');
    onProgress(phases || 'Building network…');
    await sleep(interval);
  }
  if (loaded?.file_name !== path || !Array.isArray(loaded.hosts) || !loaded.switches) throw new Error('The emulator returned an invalid deployment result.');
  if (!Array.isArray(loaded.switches_online)) loaded = { ...loaded, switches_online: (await request(config => axios.get('/netsim/switches/online', config), REQUEST_TIMEOUT_MS)).data.switches_online || [] };
  try {
    const configs = connect ? switchConfigs(loaded) : [];
    // Connecting several model switches can take a while; only the overall
    // deadline bounds it.
    await request(config => axios.post('/switches/from_topology', { switch_configs: JSON.stringify(configs), create_switches: connect }, config));
  } catch (failure) {
    const message = failure.response?.data?.error || failure.response?.data || failure.message;
    throw new Error(`The network was deployed, but switch connections failed: ${message}. Your draft is preserved; reload active topology to inspect it.`, { cause: failure });
  }
  return warnings.length ? { ...loaded, deployment_warnings: warnings } : loaded;
}

export async function clearTopology() {
  await axios.delete('/switches/active', { data: {} });
  return (await axios.delete('/netsim/topology/load', { data: {} })).data;
}
