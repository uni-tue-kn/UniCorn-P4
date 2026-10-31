import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';

const TopologyContext = createContext(null);
export const useTopology = () => useContext(TopologyContext);
export const TOPOLOGY_DRAFT_STORAGE_KEY = 'unicorn.topology.draft.v1';

export function TopologyProvider({ children }) {
  const [knownTopologies, setKnownTopologies] = useState([]);
  const [loadedTopology, setLoadedTopology] = useState(null);
  const [loadedHosts, setLoadedHosts] = useState([]);
  const [loadedSwitches, setLoadedSwitches] = useState([]);
  const [currentTopologyName, setCurrentTopologyName] = useState('');
  const topologyRequest = useRef(0);
  const filesRequest = useRef(0);
  const currentNetwork = useRef('');
  const operation = useRef(null);
  const [networkOperation, setNetworkOperation] = useState(null);
  const [importRevision, setImportRevision] = useState(0);
  const acquireNetworkOperation = useCallback(kind => {
    if (operation.current) return null;
    const lease = { kind };
    operation.current = lease;
    setNetworkOperation(kind);
    return () => {
      if (operation.current !== lease) return;
      operation.current = null;
      setNetworkOperation(null);
    };
  }, []);
  const applyLoadedTopology = useCallback(topology => {
    if (!topology || topology.file_name === undefined || (topology.file_name !== null && (typeof topology.file_name !== 'string' || !topology.file_name || !Array.isArray(topology.hosts) || !topology.hosts.every(name => typeof name === 'string') || !topology.switches || typeof topology.switches !== 'object' || Array.isArray(topology.switches) || !Array.isArray(topology.links)))) throw new Error('The emulator returned an invalid topology.');
    topologyRequest.current++;
    const running = topology?.file_name != null;
    const name = running ? topology.file_name : '', sameNetwork = currentNetwork.current === name;
    currentNetwork.current = name;
    setCurrentTopologyName(name);
    setLoadedTopology(running ? topology : null);
    const hosts = running ? topology.hosts : [], switches = running ? Object.keys(topology.switches) : [];
    const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    setLoadedHosts(previous => sameNetwork && same(previous, hosts) ? previous : [...hosts]);
    setLoadedSwitches(previous => sameNetwork && same(previous, switches) ? previous : switches);
  }, []);
  const publishImportedTopology = useCallback(topology => {
    applyLoadedTopology(topology);
    try { sessionStorage.removeItem(TOPOLOGY_DRAFT_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
    setImportRevision(revision => revision + 1);
  }, [applyLoadedTopology]);
  const getLoadedTopology = useCallback(async () => {
    const request = ++topologyRequest.current;
    const response = await axios.get('/netsim/topology/get');
    if (request !== topologyRequest.current) return undefined;
    applyLoadedTopology(response.data);
    return response.data;
  }, [applyLoadedTopology]);
  const getTopologies = useCallback(async () => {
    const request = ++filesRequest.current;
    const response = await axios.get('/topologies');
    if (!Array.isArray(response.data?.topologies)) throw new Error('The server returned an invalid topology list.');
    if (request === filesRequest.current) setKnownTopologies(response.data.topologies);
    return response.data.topologies;
  }, []);
  useEffect(() => {
    getTopologies().catch(() => {});
    getLoadedTopology().catch(() => {});
    return () => { topologyRequest.current++; filesRequest.current++; };
  }, [getTopologies, getLoadedTopology]);
  return <TopologyContext.Provider value={{ knownTopologies, getTopologies, currentTopologyName, setCurrentTopologyName, loadTopologyByName: getLoadedTopology, getLoadedTopology, applyLoadedTopology, loadedTopology, loadedHosts, setLoadedHosts, loadedSwitches, setLoadedSwitches, setLoadedTopology, importRevision, publishImportedTopology, acquireNetworkOperation, archiveBusy: networkOperation === 'archive', topologyOperationBusy: networkOperation === 'topology' }}>{children}</TopologyContext.Provider>;
}
