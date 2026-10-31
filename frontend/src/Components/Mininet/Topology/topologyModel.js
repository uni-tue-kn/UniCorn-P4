import { autoLayout } from './topologyLayout';

export const emptyDraft = () => ({ hosts: [], switches: {}, links: [], layout: {} });
export const nodeNames = draft => [...draft.hosts, ...Object.keys(draft.switches)];
export const numericId = name => Number(name.match(/\d+$/)?.[0]);
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);

export function validateDraft(draft) {
  if (!object(draft) || !Array.isArray(draft.hosts) || !object(draft.switches) || !Array.isArray(draft.links)) return 'Topology requires hosts, switches and links.';
  const names = nodeNames(draft);
  if (names.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*\d$/.test(name))) return 'Node names must start with a letter and end with a numeric ID.';
  if (new Set(names).size !== names.length) return 'Each node needs a unique name.';
  if (Object.values(draft.switches).some(value => !object(value))) return 'Switch properties must be objects.';
  for (const [group, maximum] of [[draft.hosts, 254], [Object.keys(draft.switches), 255]]) {
    const ids = group.map(numericId);
    if (ids.some(id => id < 1 || id > maximum)) return 'Host IDs must be 1..254 and switch IDs 1..255.';
    if (new Set(ids).size !== ids.length) return 'Numeric IDs must be unique within hosts and within switches.';
  }
  for (const link of draft.links) {
    if (!Array.isArray(link) || link.length < 2 || link.length > 4) return 'Each link needs two nodes and optional latency and bandwidth.';
    const [from, to, latency, bandwidth] = link;
    if (!names.includes(from) || !names.includes(to)) return 'Every link needs two existing nodes.';
    if (from === to || (draft.hosts.includes(from) && draft.hosts.includes(to))) return 'Links must connect distinct nodes and include a switch.';
    if (latency !== undefined && !(typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) && !(typeof latency === 'string' && /^\d+(?:\.\d+)?\s*(us|ms|s)$/.test(latency))) return 'Latency must be nonnegative; use milliseconds or a value such as 2ms.';
    if (bandwidth !== undefined && (typeof bandwidth !== 'number' || !Number.isFinite(bandwidth) || bandwidth <= 0)) return 'Bandwidth must be positive.';
  }
  if (draft.layout !== undefined && (!object(draft.layout) || Object.entries(draft.layout).some(([name, point]) => !names.includes(name) || !object(point) || !['x', 'y'].every(axis => typeof point[axis] === 'number' && Number.isFinite(point[axis]) && point[axis] >= 0)))) return 'Layout must map existing nodes to finite, nonnegative coordinates.';
  const external = draft.ext_intfs || [];
  if (!Array.isArray(external) || external.some(item => !Array.isArray(item) || item.length !== 2 || !Object.hasOwn(draft.switches, item[0]) || typeof item[1] !== 'string' || !/^[A-Za-z0-9_.:-]{1,15}$/.test(item[1]) || item[1] === 'lo')) return 'External interfaces require a switch and a valid non-loopback interface.';
  if (new Set(external.map(item => item[1])).size !== external.length) return 'An external interface may only be attached once.';
  return '';
}

const hostLinkCount = (draft, host) => draft.links.filter(link => link.slice(0, 2).includes(host)).length;

export function validateDeployableTopology(draft) {
  const problem = validateDraft(draft);
  if (problem) return problem;
  for (const host of draft.hosts) {
    const count = hostLinkCount(draft, host);
    if (count !== 1) return `Host ${host} must have exactly one switch link before deployment (found ${count}).`;
  }
  return '';
}

// Imported drafts may need repairs. Keep existing links editable, but never
// introduce another uplink to a host; parallel switch links remain unrestricted.
export function validateHostLinkChange(draft, link, replacedIndex = -1) {
  for (const host of draft.hosts.filter(name => link.slice(0, 2).includes(name))) {
    const previousCount = hostLinkCount(draft, host);
    const removesHost = draft.links[replacedIndex]?.slice(0, 2).includes(host) ? 1 : 0;
    const count = previousCount - removesHost + 1;
    if (count > 1 && count > previousCount) return `Host ${host} already has a switch link. Remove or rewire its existing link before adding another.`;
  }
  return '';
}

export function normalizeTopology(value) {
  if (!object(value) || !Array.isArray(value.links)) throw new Error('This file is not a supported topology.');
  const topology = { hosts: value.hosts, switches: value.switches, links: value.links.map(link => {
    if (Array.isArray(link)) return [...link];
    if (!object(link)) return link;
    return [link.node1, link.node2, link.latency ?? '0ms', ...(link.bandwidth == null ? [] : [link.bandwidth])];
  }), layout: value.layout ?? {}, ...(value.ext_intfs ? { ext_intfs: Array.isArray(value.ext_intfs) ? value.ext_intfs.map(item => Array.isArray(item) ? [...item] : [item?.switch, item?.interface]) : value.ext_intfs } : {}) };
  const problem = validateDraft(topology);
  if (problem) throw new Error(problem);
  return { ...structuredClone(topology), layout: { ...autoLayout(topology), ...structuredClone(topology.layout) } };
}

export function removeNode(draft, name) {
  const switches = { ...draft.switches }, layout = { ...draft.layout };
  delete switches[name]; delete layout[name];
  return { ...draft, hosts: draft.hosts.filter(host => host !== name), switches, layout, links: draft.links.filter(link => !link.slice(0, 2).includes(name)), ...(draft.ext_intfs ? { ext_intfs: draft.ext_intfs.filter(item => item[0] !== name) } : {}) };
}

export function renameNode(draft, previous, name) {
  return { ...draft, hosts: draft.hosts.map(host => host === previous ? name : host), switches: Object.fromEntries(Object.entries(draft.switches).map(([key, value]) => [key === previous ? name : key, value])), layout: Object.fromEntries(Object.entries(draft.layout || {}).map(([key, value]) => [key === previous ? name : key, value])), links: draft.links.map(([a, b, ...properties]) => [a === previous ? name : a, b === previous ? name : b, ...properties]), ...(draft.ext_intfs ? { ext_intfs: draft.ext_intfs.map(([sw, intf]) => [sw === previous ? name : sw, intf]) } : {}) };
}

export function safeFilename(value) {
  const name = (value || 'my-topology.json').split('/').at(-1);
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}$/.test(name) && !name.includes('..') ? (name.endsWith('.json') ? name : name + '.json') : 'my-topology.json';
}

export function deploymentFilename(filename) {
  const stem = safeFilename(filename).replace(/\.json$/, '').replace(/-deploy-\d+(?:-[a-z0-9]+)?$/, '').slice(0, 78);
  return `${stem}-deploy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
}

export function liveLinkLabels(topology) {
  const pairs = new Map(), seen = new Set();
  for (const rows of Object.values(topology?.interface_mapping || {})) for (const entry of rows || []) {
    if (entry.type === 'external' || !entry.peer_node) continue;
    const token = [`${entry.node}:${entry.interface}`, `${entry.peer_node}:${entry.peer_interface}`].sort().join('|');
    if (seen.has(token)) continue;
    seen.add(token);
    const pair = [entry.node, entry.peer_node].sort().join('|');
    const ports = { [entry.node]: `${entry.node}:${entry.port}`, [entry.peer_node]: entry.peer_interface || entry.peer_node };
    const peer = (topology.interface_mapping?.[entry.peer_node] || []).find(item => item.interface === entry.peer_interface);
    if (peer) ports[entry.peer_node] = `${peer.node}:${peer.port}`;
    const group = pairs.get(pair) || [];
    group.push({ ports, title: `${entry.node}:${entry.port} ${entry.interface} ↔ ${entry.peer_node} ${entry.peer_interface}` });
    pairs.set(pair, group);
  }
  const used = new Map();
  return (topology?.links || []).map(link => {
    const [left, right] = Array.isArray(link) ? link : [link.node1, link.node2];
    const pair = [left, right].sort().join('|'), index = used.get(pair) || 0;
    used.set(pair, index + 1);
    return pairs.get(pair)?.[index];
  });
}
