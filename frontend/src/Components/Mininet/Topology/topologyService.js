import axios from 'axios';

export function switchConfigs(topology) {
  const names = Object.keys(topology.switches || {});
  const online = topology.switches_online || [];
  const configs = online.filter(switchInfo => names.includes(switchInfo.name)).map(switchInfo => {
    if (!Number.isInteger(switchInfo.grpc_port) || switchInfo.grpc_port < 1 || switchInfo.grpc_port > 65535 || !Number.isInteger(switchInfo.dev_id) || switchInfo.dev_id < 0) throw new Error('The emulator returned invalid switch endpoints.');
    return { name: switchInfo.name, address: `127.0.0.1:${switchInfo.grpc_port}`, device_id: switchInfo.dev_id, proto_dump_file: `${switchInfo.name}_proto.log`, register_adapter_enabled: false, register_thrift_host: switchInfo.thrift_port ? '127.0.0.1' : null, register_thrift_port: switchInfo.thrift_port ?? null };
  });
  if (new Set(configs.map(config => config.name)).size !== names.length) throw new Error('Not all switch endpoints are available. Reload active topology and connect missing switches in Switch Menu.');
  return configs;
}

export async function deployTopology(topology, filename, connect = true) {
  const saved = await axios.post('/topologies', { name: filename, topology, overwrite: false });
  if (!saved.data?.name) throw new Error('The server did not return a saved topology path.');
  const path = saved.data.name;
  let loaded;
  try {
    loaded = (await axios.post('/netsim/topology/load', { topology_file: path }, { timeout: 60000 })).data;
  } catch (failure) {
    // Loading can finish before a transport breaks. Verify the exact snapshot
    // before reporting success; other errors leave the editor's draft intact.
    if (failure.response || failure.message !== 'Network Error') throw failure;
    loaded = (await axios.get('/netsim/topology/get')).data;
    if (loaded?.file_name !== path) throw failure;
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
  return loaded;
}

export async function clearTopology() {
  await axios.delete('/switches/active', { data: {} });
  return (await axios.delete('/netsim/topology/load', { data: {} })).data;
}
