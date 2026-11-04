import axios from 'axios';
import { validateDeployableTopology } from './topologyModel';

export function switchConfigs(topology) {
  const names = Object.keys(topology.switches || {});
  const online = topology.switches_online || [];
  const configs = online.filter(switchInfo => names.includes(switchInfo.name)).map(switchInfo => {
    const target = switchInfo.target ?? topology.switches[switchInfo.name]?.target ?? 'bmv2';
    if (!['bmv2', 'tofino'].includes(target) || !Number.isInteger(switchInfo.grpc_port) || switchInfo.grpc_port < 1 || switchInfo.grpc_port > 65535 || !Number.isInteger(switchInfo.dev_id) || switchInfo.dev_id < 0) throw new Error('The emulator returned invalid switch endpoints.');
    const config = { name: switchInfo.name, target, address: switchInfo.address || `127.0.0.1:${switchInfo.grpc_port}`, device_id: switchInfo.dev_id, proto_dump_file: `${switchInfo.name}_proto.log` };
    if (target === 'tofino') return { ...config, target_options: { client_id: 0, pipe_id: 0, runtime_device_id: switchInfo.runtime_device_id ?? 0, ...(switchInfo.target_options || {}) } };
    return { ...config, register_adapter_enabled: false, register_thrift_host: switchInfo.thrift_port ? '127.0.0.1' : null, register_thrift_port: switchInfo.thrift_port ?? null };
  });
  if (new Set(configs.map(config => config.name)).size !== names.length) throw new Error('Not all switch endpoints are available. Reload active topology and connect missing switches in Switch Menu.');
  return configs;
}

export async function deployTopology(topology, filename, connect = true, onProgress = () => {}) {
  const problem = validateDeployableTopology(topology);
  if (problem) throw new Error(problem);
  const saved = await axios.post('/topologies', { name: filename, topology, overwrite: false });
  if (!saved.data?.name) throw new Error('The server did not return a saved topology path.');
  const path = saved.data.name;
  onProgress('Starting network…');
  const started = (await axios.post('/netsim/topology/deploy', { topology_file: path })).data;
  if (!started?.deployment_id) throw new Error('The emulator did not return a deployment ID.');
  let loaded, warnings;
  for (;;) {
    const job = (await axios.get(`/netsim/topology/deploy/${encodeURIComponent(started.deployment_id)}`)).data;
    if (job.status === 'failed') throw new Error(job.error || 'Topology deployment failed.');
    if (job.status === 'ready') { loaded = job.topology; warnings = job.warnings || []; break; }
    if (!['pending', 'running'].includes(job.status)) throw new Error('The emulator returned an invalid deployment status.');
    const phases = Object.entries(job.switches || {}).map(([name, phase]) => `${name}: ${phase}`).join(' · ');
    onProgress(phases || 'Building network…');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (loaded?.file_name !== path || !Array.isArray(loaded.hosts) || !loaded.switches) throw new Error('The emulator returned an invalid deployment result.');
  if (!Array.isArray(loaded.switches_online)) loaded = { ...loaded, switches_online: (await axios.get('/netsim/switches/online')).data.switches_online || [] };
  try {
    const configs = connect ? switchConfigs(loaded) : [];
    await axios.post('/switches/from_topology', { switch_configs: JSON.stringify(configs), create_switches: connect });
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
