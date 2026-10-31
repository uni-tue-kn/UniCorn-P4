import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, IconButton, Menu, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import AddLinkIcon from '@mui/icons-material/AddLink';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { TOPOLOGY_DRAFT_STORAGE_KEY, useTopology } from '../../../Contexts/TopologyContext';
import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { autoLayout } from './topologyLayout';
import { deploymentFilename, emptyDraft, liveLinkLabels, nodeNames, normalizeTopology, numericId, removeNode, renameNode, safeFilename, validateDraft } from './topologyModel';
import { clearTopology, deployTopology } from './topologyService';

export { removeNode, renameNode, validateDraft } from './topologyModel';
const storageKey = TOPOLOGY_DRAFT_STORAGE_KEY;
const boundsFor = topology => {
  const external = new Set((topology.ext_intfs || []).map(item => item[0]));
  return { width: Math.max(800, ...Object.entries(topology.layout || {}).map(([name, point]) => point.x + (external.has(name) ? 180 : 70))), height: Math.max(400, ...Object.entries(topology.layout || {}).map(([name, point]) => point.y + (external.has(name) ? 90 : 70))) };
};
const basename = value => safeFilename(value).replace(/-deploy-\d+(?:-[a-z0-9]+)?\.json$/, '.json');
function initialDraft(loadedTopology) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey));
    if (stored?.dirty) return { topology: normalizeTopology(stored.topology), filename: safeFilename(stored.filename), dirty: true };
  } catch { /* An invalid saved draft never prevents opening the live canvas. */ }
  try { if (loadedTopology?.file_name) return { topology: normalizeTopology(loadedTopology), filename: basename(loadedTopology.file_name), dirty: false }; } catch { /* The editor can still start an empty draft. */ }
  return { topology: emptyDraft(), filename: 'my-topology.json', dirty: false };
}

export default function TopologyBuilder() {
  const context = useTopology() || {};
  const switches = useSwitch() || {};
  const { callSnackbar } = useSnackbar();
  const { knownTopologies = [], loadedTopology, getTopologies, getLoadedTopology, applyLoadedTopology } = context;
  const [initial] = useState(() => initialDraft(loadedTopology));
  const [draft, setDraft] = useState(initial.topology);
  const [filename, setFilename] = useState(initial.filename);
  const [dirty, setDirty] = useState(initial.dirty);
  const dirtyRef = useRef(initial.dirty);
  const [canvasSize, setCanvasSize] = useState(() => boundsFor(initial.topology));
  const [importName, setImportName] = useState('');
  const [selected, setSelected] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [selectedLink, setSelectedLink] = useState(null);
  const [drawingLink, setDrawingLink] = useState(false);
  const [linkSource, setLinkSource] = useState('');
  const [linkPreview, setLinkPreview] = useState(null);
  const [hoverNode, setHoverNode] = useState('');
  const [draggingNode, setDraggingNode] = useState('');
  const [drawError, setDrawError] = useState('');
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [fileDialog, setFileDialog] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [latency, setLatency] = useState('0ms');
  const [bandwidth, setBandwidth] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [connect, setConnect] = useState(true);
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || context.archiveBusy || context.topologyOperationBusy || false;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const svg = useRef(null), upload = useRef(null), drag = useRef(null), alive = useRef(true);
  const seenImportRevision = useRef(context.importRevision ?? 0);
  const names = nodeNames(draft);
  const live = !dirty && Boolean(loadedTopology?.file_name);
  const ports = useMemo(() => live ? liveLinkLabels(loadedTopology) : [], [live, loadedTopology]);
  const parallelLinks = useMemo(() => {
    const counts = new Map(), seen = new Map();
    for (const link of draft.links) { const pair = link.slice(0, 2).sort().join('|'); counts.set(pair, (counts.get(pair) || 0) + 1); }
    return draft.links.map(link => { const pair = link.slice(0, 2).sort().join('|'), ordinal = seen.get(pair) || 0; seen.set(pair, ordinal + 1); return { count: counts.get(pair), ordinal }; });
  }, [draft.links]);

  function markDirty(value) { dirtyRef.current = value; setDirty(value); }
  function select(name) { setSelected(name); setNameInput(name); }
  function cancelLink() { setDrawingLink(false); setLinkSource(''); setLinkPreview(null); setHoverNode(''); setDrawError(''); }
  function clearSelection() { drag.current = null; setDraggingNode(''); select(''); setSelectedLink(null); setFrom(''); setTo(''); setLatency('0ms'); setBandwidth(''); cancelLink(); }
  function adopt(topology, name, isDraft) {
    setDraft(topology); setCanvasSize(boundsFor(topology)); setFilename(basename(name)); markDirty(isDraft); setOverwrite(false); clearSelection(); setMessage(''); setError('');
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const imported = seenImportRevision.current !== (context.importRevision ?? 0);
    seenImportRevision.current = context.importRevision ?? 0;
    if (dirtyRef.current && !imported) return;
    try {
      if (loadedTopology?.file_name) adopt(normalizeTopology(loadedTopology), loadedTopology.file_name, false);
      else if (loadedTopology === null) adopt(emptyDraft(), 'my-topology.json', false);
    } catch (failure) { setError(failure.message); }
  }, [loadedTopology, context.importRevision]);
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ topology: draft, filename, dirty: true }));
      else sessionStorage.removeItem(storageKey);
    } catch { /* The current draft remains editable if browser storage is full. */ }
  }, [draft, filename, dirty]);
  useEffect(() => { if (busy) { cancelLink(); drag.current = null; setDraggingNode(''); } }, [busy]);

  function change(next) { setDraft(next); markDirty(true); setMessage(''); setError(''); }
  function position(name) { return draft.layout[name] || { x: 100, y: 100 }; }
  function addNode(kind) {
    cancelLink();
    let id = 1;
    const group = kind === 'host' ? draft.hosts : Object.keys(draft.switches), prefix = kind === 'host' ? 'h' : 's';
    while (group.some(name => numericId(name) === id) || names.includes(prefix + id)) id++;
    if (id > (kind === 'host' ? 254 : 255)) { setError('No automatic ID is available; rename an existing node first.'); return; }
    const name = prefix + id, point = { x: 100 + (names.length % 5) * 150, y: 100 + Math.floor(names.length / 5) * 110 };
    change({ ...draft, hosts: kind === 'host' ? [...draft.hosts, name] : draft.hosts, switches: kind === 'switch' ? { ...draft.switches, [name]: {} } : draft.switches, layout: { ...draft.layout, [name]: point } });
    setCanvasSize(size => ({ width: Math.max(size.width, point.x + 70), height: Math.max(size.height, point.y + 70) }));
    setSelectedLink(null); select(name);
  }
  function applyName() {
    if (nameInput !== selected && names.includes(nameInput)) { setError('Each node needs a unique name.'); return; }
    const next = renameNode(draft, selected, nameInput), problem = validateDraft(next);
    if (problem) { setError(problem); return; }
    change(next); select(nameInput); setFrom(value => value === selected ? nameInput : value); setTo(value => value === selected ? nameInput : value);
  }
  function deleteSelected() { change(removeNode(draft, selected)); clearSelection(); }
  function selectLink(index) {
    cancelLink();
    const [left, right, delay, rate] = draft.links[index];
    select(''); setSelectedLink(index); setFrom(left); setTo(right); setLatency(String(delay ?? '0ms')); setBandwidth(rate === undefined ? '' : String(rate));
  }
  function updateLink() {
    if (selectedLink == null) return;
    let delay = latency.trim() || '0ms';
    if (/^\d+(?:\.\d+)?$/.test(delay)) delay += 'ms';
    const link = [from, to, delay, ...(bandwidth === '' ? [] : [Number(bandwidth)])];
    const next = { ...draft, links: selectedLink == null ? [...draft.links, link] : draft.links.map((value, index) => index === selectedLink ? link : value) };
    const problem = validateDraft(next);
    if (problem) { setError(problem); return; }
    change(next); setLatency(delay);
  }
  function deleteLink(index) { change({ ...draft, links: draft.links.filter((_, item) => item !== index) }); clearSelection(); }
  function startLink() {
    if (drawingLink) { cancelLink(); return; }
    clearSelection(); setDrawingLink(true); setMessage(''); setError('');
  }
  function activateNode(name) {
    if (!drawingLink) { select(name); setSelectedLink(null); return; }
    if (!linkSource) {
      setLinkSource(name); setLinkPreview({ x: Math.min(canvasSize.width - 35, position(name).x + 90), y: Math.min(canvasSize.height - 45, position(name).y + 50) }); setDrawError(''); return;
    }
    if (linkSource === name) { setDrawError('Choose a different node to finish the link.'); return; }
    if (draft.hosts.includes(linkSource) && draft.hosts.includes(name)) { setDrawError('Hosts connect through a switch. Choose a switch as the other endpoint.'); return; }
    const next = { ...draft, links: [...draft.links, [linkSource, name, '0ms']] }, problem = validateDraft(next);
    if (problem) { setDrawError(problem); return; }
    change(next); setSelectedLink(draft.links.length); setFrom(linkSource); setTo(name); setLatency('0ms'); setBandwidth(''); select(''); cancelLink();
  }
  function escape(event) {
    if (event.key !== 'Escape' || confirmClear || fileDialog || menuAnchor) return;
    if (drawingLink) { event.preventDefault(); event.stopPropagation(); cancelLink(); }
    else if (selectedLink != null || selected) { event.preventDefault(); clearSelection(); }
  }
  function topologyAction(action) {
    setMenuAnchor(null); cancelLink();
    action();
  }
  async function refreshConnections() {
    await Promise.allSettled([getTopologies?.(), getLoadedTopology?.(), switches.getSwitches?.(), switches.getSwitchesOnline?.(), switches.getHistorySwitches?.()]);
  }
  async function importSaved() {
    setBusy(true); setError('');
    try {
      const response = await axios.get('/topologies', { params: { name: importName } });
      const topology = normalizeTopology(response.data[importName]);
      if (alive.current) { adopt(topology, importName, true); setFileDialog(null); setMessage('Topology imported into the draft. Deploy to update the running network.'); }
    } catch (failure) { if (alive.current) setError(failure.response?.data?.error || failure.message || 'Could not import topology.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function importJSON(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a topology JSON file smaller than 1 MiB.');
      const topology = normalizeTopology(JSON.parse(await file.text()));
      if (alive.current) { adopt(topology, file.name, true); setMessage('JSON imported into the draft. Deploy to update the running network.'); }
    } catch (failure) { if (alive.current) setError(failure instanceof SyntaxError ? 'The selected file is not valid JSON.' : failure.message); }
    finally { if (alive.current) setBusy(false); }
  }
  function exportJSON() {
    const problem = validateDraft(draft);
    if (problem) { setError(problem); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2) + '\n'], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = safeFilename(filename); document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function save() {
    const problem = validateDraft(draft);
    if (problem) { setError(problem); return; }
    if (safeFilename(filename) !== filename) { setError('Use a simple topology filename ending in .json, without directories.'); return; }
    setBusy(true); setError('');
    try {
      await axios.post('/topologies', { name: filename, topology: draft, overwrite });
      if (alive.current) { setFileDialog(null); setMessage('Topology saved. Deploy to update the running network.'); await getTopologies?.(); }
    } catch (failure) { if (alive.current) setError(failure.response?.data?.error || failure.message || 'Could not save topology.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function deploy() {
    const problem = validateDraft(draft);
    if (problem) { setError(problem); return; }
    const release = context.acquireNetworkOperation?.('topology');
    if (context.acquireNetworkOperation && !release) { setError('Another network operation is running.'); return; }
    setBusy(true); setError(''); setMessage(''); markDirty(true); switches.setCurrentSwitchID?.(null);
    try {
      const loaded = await deployTopology(draft, deploymentFilename(filename), connect);
      const topology = normalizeTopology(loaded);
      applyLoadedTopology?.(loaded);
      if (alive.current) { adopt(topology, loaded.file_name, false); setMessage('Topology deployed. Switch terminals and connections have been refreshed.'); }
      else callSnackbar?.('success', 'Topology deployed. Switch terminals and connections have been refreshed.');
      await refreshConnections();
    } catch (failure) {
      const message = failure.response?.data?.error || failure.message || 'Deployment failed. Your draft is preserved.';
      if (alive.current) setError(message); else callSnackbar?.('error', message);
      await refreshConnections();
    } finally { release?.(); if (alive.current) setBusy(false); }
  }
  async function reloadActive() {
    setBusy(true); setError('');
    try {
      const topology = getLoadedTopology ? await getLoadedTopology() : loadedTopology;
      if (!alive.current || topology === undefined) return;
      if (topology?.file_name) adopt(normalizeTopology(topology), topology.file_name, false);
      else if (topology == null || topology.file_name === null) adopt(emptyDraft(), 'my-topology.json', false);
    } catch (failure) { if (alive.current) setError(failure.response?.data?.error || failure.message); }
    finally { if (alive.current) setBusy(false); }
  }
  async function clearRunning() {
    const release = context.acquireNetworkOperation?.('topology');
    if (context.acquireNetworkOperation && !release) { setConfirmClear(false); setError('Another network operation is running.'); return; }
    setBusy(true); setError('');
    try {
      const cleared = await clearTopology();
      if (!alive.current) return;
      markDirty(true); applyLoadedTopology?.(cleared); switches.setCurrentSwitchID?.(null); setConfirmClear(false); setMessage('Running topology cleared. Your draft is preserved.');
      await refreshConnections();
    } catch (failure) { if (alive.current) { setConfirmClear(false); setError(failure.response?.data?.error || failure.message); await refreshConnections(); } }
    finally { release?.(); if (alive.current) setBusy(false); }
  }
  function cursor(event) {
    if (svg.current.createSVGPoint && svg.current.getScreenCTM()) {
      const point = svg.current.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      return point.matrixTransform(svg.current.getScreenCTM().inverse());
    }
    const rect = svg.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvasSize.width / (rect.width || canvasSize.width), y: (event.clientY - rect.top) * canvasSize.height / (rect.height || canvasSize.height) };
  }
  function move(event) {
    if (busy) return;
    if (drawingLink) { if (linkSource) setLinkPreview(cursor(event)); return; }
    if (!drag.current) return;
    const point = cursor(event), name = drag.current.name;
    const x = Math.round(Math.max(35, Math.min(canvasSize.width - 35, point.x - drag.current.x))), y = Math.round(Math.max(35, Math.min(canvasSize.height - 45, point.y - drag.current.y)));
    setDraft(previous => ({ ...previous, layout: { ...previous.layout, [name]: { x, y } } })); markDirty(true); setMessage('');
  }
  function finishDrag(showProperties) {
    const previous = drag.current;
    drag.current = null; setDraggingNode('');
    if (previous && showProperties) { select(previous.name); setSelectedLink(null); }
  }
  const inspector = !drawingLink && (selectedLink != null || selected);
  return <Stack spacing={2} onKeyDownCapture={escape}>
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Typography variant="h6">Topology</Typography><Chip size="small" color={live ? 'success' : 'warning'} label={live ? 'Live' : 'Draft changes'} />
      <Typography variant="caption" color="text.secondary">{draft.hosts.length} hosts · {Object.keys(draft.switches).length} switches · {draft.links.length} links</Typography>
      <Box sx={{ flex: 1 }} />
      <Button disabled={busy} aria-label="Topology menu" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} endIcon={<MoreVertIcon />} onClick={event => setMenuAnchor(event.currentTarget)}>Topology</Button>
    </Stack>
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <Button disabled={busy} variant="outlined" onClick={() => addNode('host')}>Add host</Button>
      <Button disabled={busy} variant="outlined" onClick={() => addNode('switch')}>Add switch</Button>
      <Button disabled={busy || names.length < 2} variant={drawingLink ? 'contained' : 'outlined'} startIcon={<AddLinkIcon />} aria-pressed={drawingLink} onClick={startLink}>Add link</Button>
      {drawingLink && <Button onClick={cancelLink}>Cancel link</Button>}
      <Box sx={{ flex: 1 }} />
      <Button variant="contained" disabled={busy || drawingLink || !Object.keys(draft.switches).length} onClick={deploy}>{busy ? 'Working…' : 'Deploy topology'}</Button>
    </Stack>
    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>Drag nodes to arrange them. Use Add link, then choose two nodes to connect. Edits stay in the draft until Deploy.{loadedTopology?.file_name ? ` Active: ${loadedTopology.file_name.split('/').at(-1)}.` : ' No network is running.'}</Typography>
    {error && !fileDialog && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success">{message}</Alert>}
    {drawingLink && <Box id="topology-link-instructions" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', flexWrap: 'wrap' }}>
      {linkSource && <Chip size="small" color="primary" label={`Source: ${linkSource}`} />}
      <Typography variant="body2">{linkSource ? 'Choose the other endpoint. Click a node or focus it and press Enter. Escape cancels.' : 'Choose the first node. Click a node or focus it and press Enter. Escape cancels.'}</Typography>
      {drawError && <Typography color="error" variant="body2" sx={{ width: '100%' }}>{drawError}</Typography>}
    </Box>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: inspector ? 'minmax(0, 1fr) 280px' : 'minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden', minWidth: 0 }}>
        <svg ref={svg} viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} role="group" aria-label="Topology canvas" aria-describedby={drawingLink ? 'topology-link-instructions' : undefined} style={{ display: 'block', width: '100%', maxHeight: 520, touchAction: 'none', cursor: drawingLink ? 'crosshair' : 'default' }} onPointerMove={move} onPointerUp={() => finishDrag(true)} onPointerCancel={() => finishDrag(false)}>
          {draft.links.map(([left, right], index) => {
            const a = position(left), b = position(right);
            const length = Math.hypot(b.x - a.x, b.y - a.y) || 1, offset = (parallelLinks[index].ordinal - (parallelLinks[index].count - 1) / 2) * 52 * (left < right ? 1 : -1);
            const control = { x: (a.x + b.x) / 2 - (b.y - a.y) / length * offset, y: (a.y + b.y) / 2 + (b.x - a.x) / length * offset };
            const point = t => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * control.x + t ** 2 * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * control.y + t ** 2 * b.y });
            const p = point(0.25), q = point(0.75), middle = point(0.5), label = ports[index];
            return <g key={index} role="button" tabIndex={busy || drawingLink ? -1 : 0} aria-label={`Select link ${index + 1}: ${left} to ${right}`} onClick={() => { if (!busy && !drawingLink) selectLink(index); }} onKeyDown={event => { if (!busy && !drawingLink && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectLink(index); } }} style={{ cursor: drawingLink ? 'crosshair' : 'pointer' }}>
              <path d={`M${a.x},${a.y} Q${control.x},${control.y} ${b.x},${b.y}`} stroke={selectedLink === index ? '#1565c0' : '#78909c'} strokeWidth={selectedLink === index ? 5 : 3} fill="none"><title>{label?.title || `${left} ↔ ${right}`}</title></path>
              <path d={`M${a.x},${a.y} Q${control.x},${control.y} ${b.x},${b.y}`} stroke="transparent" strokeWidth="16" fill="none" />
              {/* Stroke does not enlarge SVG group bounds; straight links need a filled hit target. */}
              <circle data-link-hit-target={index} cx={middle.x} cy={middle.y} r="8" fill="transparent" pointerEvents="all" aria-hidden="true" />
              {label && <><text x={p.x} y={p.y - 9} textAnchor="middle" fill="currentColor" fontSize="12">{label.ports[left]}</text><text x={q.x} y={q.y - 9} textAnchor="middle" fill="currentColor" fontSize="12">{label.ports[right]}</text></>}
            </g>;
          })}
          {drawingLink && linkSource && linkPreview && <line data-testid="connection-preview" x1={position(linkSource).x} y1={position(linkSource).y} x2={linkPreview.x} y2={linkPreview.y} stroke="#1565c0" strokeWidth="3" strokeDasharray="8 6" pointerEvents="none" />}
          {names.map(name => {
            const point = position(name), host = draft.hosts.includes(name), active = selected === name || linkSource === name || draggingNode === name;
            const hover = drawingLink && linkSource && hoverNode === name && name !== linkSource;
            const stroke = active ? '#1565c0' : hover ? (draft.hosts.includes(linkSource) && host ? '#c62828' : '#00887c') : '#607d8b';
            return <g key={name} data-topology-node={name} transform={`translate(${point.x},${point.y})`} role="button" tabIndex={busy ? -1 : 0} aria-label={`Select ${host ? 'host' : 'switch'} ${name}`} aria-pressed={active} style={{ cursor: busy ? 'default' : drawingLink ? 'crosshair' : 'grab', outlineOffset: 4 }}
              onFocus={() => { if (busy || drag.current) return; if (drawingLink) { setHoverNode(name); if (linkSource) setLinkPreview(point); } else { select(name); setSelectedLink(null); } }}
              onPointerEnter={() => { if (drawingLink) setHoverNode(name); }} onPointerLeave={() => setHoverNode('')}
              onPointerDown={event => { if (busy) return; event.preventDefault(); if (drawingLink) return; const mouse = cursor(event); drag.current = { name, x: mouse.x - point.x, y: mouse.y - point.y }; setDraggingNode(name); event.currentTarget.setPointerCapture?.(event.pointerId); }} onClick={() => { if (!busy) activateNode(name); }}
              onKeyDown={event => {
                if (busy) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateNode(name); return; }
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault();
                  if (drawingLink) {
                    const nodes = [...svg.current.querySelectorAll('[data-topology-node]')], offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                    nodes[(names.indexOf(name) + offset + nodes.length) % nodes.length]?.focus(); return;
                  }
                  const x = Math.max(35, Math.min(canvasSize.width - 35, point.x + (event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0))), y = Math.max(35, Math.min(canvasSize.height - 45, point.y + (event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 : 0)));
                  change({ ...draft, layout: { ...draft.layout, [name]: { x, y } } });
                }
              }}>
              {host ? <circle r="27" fill="#e3f2fd" stroke={stroke} strokeWidth={active || hover ? 4 : 2} /> : <rect x="-34" y="-24" width="68" height="48" rx="6" fill="#e8f5e9" stroke={stroke} strokeWidth={active || hover ? 4 : 2} />}
              {linkSource === name && <circle r="36" fill="none" stroke="#1565c0" strokeWidth="2" strokeDasharray="4 3" />}
              <text textAnchor="middle" y="5" fill="#172b38" fontSize="15" fontWeight="600" pointerEvents="none">{name}</text><text textAnchor="middle" y="44" fill="currentColor" fontSize="12" pointerEvents="none">{host ? 'Host' : 'BMv2 switch'}</text>
            </g>;
          })}
          {live && Object.values(loadedTopology.interface_mapping || {}).flat().filter(entry => entry.type === 'external' && draft.switches[entry.node]).map(entry => {
            const point = position(entry.node);
            return <g key={`${entry.node}:${entry.interface}`}><title>{entry.node}:{entry.port} {entry.interface} ↔ external</title><line x1={point.x + 34} y1={point.y} x2={point.x + 90} y2={point.y + 36} stroke="#b7791f" strokeWidth="2" strokeDasharray="4 3" /><text x={point.x + 90} y={point.y + 48} textAnchor="middle" fill="currentColor" fontSize="11">{entry.interface} · {entry.node}:{entry.port}</text></g>;
          })}
          {!names.length && <text x={canvasSize.width / 2} y={canvasSize.height / 2} textAnchor="middle" fill="currentColor" fontSize="15">Add a host and a switch, or import from the Topology menu.</text>}
        </svg>
      </Box>
      {!drawingLink && selectedLink != null && <Paper component="section" aria-label="Link properties" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
        <Stack spacing={2}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}><Typography variant="subtitle1">Link {selectedLink + 1}</Typography><IconButton aria-label="Close link properties" size="small" onClick={() => setSelectedLink(null)}><CloseIcon fontSize="small" /></IconButton></Stack>
          <Typography sx={{ overflowWrap: 'anywhere' }}>{draft.links[selectedLink]?.slice(0, 2).join(' ↔ ')}</Typography>
          {ports[selectedLink] && <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{ports[selectedLink].title}</Typography>}
          <TextField label="Latency" value={latency} disabled={busy} onChange={event => setLatency(event.target.value)} size="small" helperText="For example, 2ms" fullWidth />
          <TextField label="Bandwidth (Mbps)" value={bandwidth} disabled={busy} onChange={event => setBandwidth(event.target.value)} size="small" type="number" helperText="Empty means unlimited" fullWidth />
          <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon />}>Change endpoints</AccordionSummary><AccordionDetails><Stack spacing={2}>
            <TextField select label="Link from" value={from} disabled={busy} onChange={event => setFrom(event.target.value)} size="small" fullWidth>{names.map(name => <MenuItem value={name} key={name}>{name}</MenuItem>)}</TextField>
            <TextField select label="Link to" value={to} disabled={busy} onChange={event => setTo(event.target.value)} size="small" fullWidth>{names.map(name => <MenuItem value={name} key={name}>{name}</MenuItem>)}</TextField>
          </Stack></AccordionDetails></Accordion>
          <Button disabled={busy} variant="contained" onClick={updateLink}>Update link</Button><Button disabled={busy} color="error" onClick={() => deleteLink(selectedLink)}>Delete link</Button>
        </Stack>
      </Paper>}
      {!drawingLink && selected && <Paper component="section" aria-label="Node properties" variant="outlined" sx={{ p: 2, minWidth: 0 }}><Stack spacing={2}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}><Typography variant="subtitle1">{selected}</Typography><IconButton aria-label="Close node properties" size="small" onClick={() => select('')}><CloseIcon fontSize="small" /></IconButton></Stack>
        <TextField label="Node name" value={nameInput} disabled={busy} onChange={event => setNameInput(event.target.value)} size="small" helperText="End with a unique numeric ID" fullWidth /><Button disabled={busy} variant="outlined" onClick={applyName}>Apply name</Button><Button disabled={busy} color="error" onClick={deleteSelected}>Delete node</Button><Typography variant="caption" color="text.secondary">Drag the node or use arrow keys to move it.</Typography>
      </Stack></Paper>}
    </Box>
    <Typography variant="caption" color="text.secondary">{live ? 'Port labels come from the running network. Select a node or link to edit it.' : 'Draft changes are not running. Select a link to edit its latency and bandwidth.'}{draft.ext_intfs?.length ? ` ${draft.ext_intfs.length} external interface attachment(s) preserved.` : ''}</Typography>
    <Alert severity="warning" role="note" sx={{ py: 0 }}>Deploy recreates the running network, disconnects switch connections and resets runtime state. A fresh snapshot is saved first.</Alert>
    <input ref={upload} aria-label="Import topology JSON" type="file" accept=".json,application/json" hidden onChange={importJSON} />
    <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
      <MenuItem onClick={() => topologyAction(() => adopt(emptyDraft(), 'my-topology.json', true))}>New draft</MenuItem>
      <MenuItem onClick={() => topologyAction(reloadActive)}>Reload active topology</MenuItem><Divider />
      <MenuItem onClick={() => topologyAction(() => { setError(''); setFileDialog('import'); getTopologies?.()?.catch?.(() => {}); })}>Import saved topology</MenuItem>
      <MenuItem onClick={() => topologyAction(() => upload.current.click())}>Import topology JSON</MenuItem>
      <MenuItem onClick={() => topologyAction(exportJSON)}>Export topology JSON</MenuItem>
      <MenuItem disabled={!Object.keys(draft.switches).length} onClick={() => topologyAction(() => { setError(''); setFileDialog('save'); })}>Save topology</MenuItem><Divider />
      <MenuItem disabled={!names.length} onClick={() => topologyAction(() => { const layout = autoLayout(draft); change({ ...draft, layout }); setCanvasSize(boundsFor({ ...draft, layout })); })}>Auto arrange</MenuItem>
      <MenuItem role="menuitemcheckbox" aria-checked={connect} onClick={() => setConnect(value => !value)}><Checkbox checked={connect} tabIndex={-1} disableRipple slotProps={{ input: { readOnly: true, 'aria-hidden': true } }} sx={{ p: 0, mr: 1 }} />Connect switches after deployment</MenuItem><Divider />
      <MenuItem disabled={!loadedTopology?.file_name} onClick={() => topologyAction(() => setConfirmClear(true))}>Clear running topology</MenuItem>
    </Menu>
    <Dialog open={fileDialog === 'import'} onClose={() => { if (!busy) setFileDialog(null); }} fullWidth maxWidth="sm"><DialogTitle>Import saved topology</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <Typography variant="body2">Choose a saved topology to edit on this canvas. The running network changes only when you deploy.</Typography>
      <TextField select label="Saved topology" value={importName} onChange={event => setImportName(event.target.value)} disabled={busy} size="small" fullWidth>{knownTopologies.map(name => <MenuItem key={name} value={name}>{name.split('/').at(-1)}</MenuItem>)}</TextField>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={() => setFileDialog(null)}>Cancel</Button><Button disabled={!importName || busy} onClick={importSaved}>Import topology</Button></DialogActions></Dialog>
    <Dialog open={fileDialog === 'save'} onClose={() => { if (!busy) setFileDialog(null); }} fullWidth maxWidth="sm"><DialogTitle>Save topology</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <TextField label="Topology filename" value={filename} disabled={busy} onChange={event => { setFilename(event.target.value); markDirty(true); setMessage(''); }} size="small" fullWidth />
      <FormControlLabel control={<Checkbox checked={overwrite} disabled={busy} onChange={event => setOverwrite(event.target.checked)} />} label="Overwrite existing file" />
      <Typography variant="body2" color="text.secondary">Save keeps this topology as a reusable file. Deploy applies the draft to the emulator.</Typography>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={() => setFileDialog(null)}>Cancel</Button><Button disabled={busy} variant="contained" onClick={save}>Save topology</Button></DialogActions></Dialog>
    <Dialog open={confirmClear} onClose={() => { if (!busy) setConfirmClear(false); }}><DialogTitle>Clear running topology?</DialogTitle><DialogContent>This disconnects all switches, stops the emulator network and loses runtime state. The draft on this canvas is kept.</DialogContent><DialogActions><Button disabled={busy} onClick={() => setConfirmClear(false)}>Cancel</Button><Button color="error" disabled={busy} onClick={clearRunning}>Clear running topology</Button></DialogActions></Dialog>
  </Stack>;
}
