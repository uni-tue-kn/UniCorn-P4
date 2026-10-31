import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Menu, MenuItem, Paper, Portal, Snackbar, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import { useTopology } from '../../Contexts/TopologyContext';
import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import Close from '@mui/icons-material/Close';
import { useNavigate } from 'react-router-dom';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

const message = value => typeof value === 'string' ? value : JSON.stringify(value);
async function failureMessage(failure) {
  let data = failure.response?.data;
  if (data instanceof Blob) {
    try { data = JSON.parse(await data.text()); } catch { data = null; }
  }
  return data?.error || failure.message || 'The network operation failed.';
}

export function externalMappings(preview, drafts, enabled) {
  if (!enabled) return {};
  const result = {};
  for (const target of preview?.switches || []) {
    const draft = drafts[target.key];
    if (target.kind !== 'external' || !draft?.selected) continue;
    if (!draft.address?.trim()) throw new Error(`Enter a destination P4Runtime address for ${target.name}.`);
    if (!/^\d+$/.test(String(draft.device_id)) || BigInt(draft.device_id) > 9007199254740991n) throw new Error(`Enter a valid device ID for ${target.name}.`);
    const port = draft.thrift_host?.trim() ? Number(draft.thrift_port) : null;
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`Enter a valid Thrift port for ${target.name}.`);
    if (draft.adapter && !draft.thrift_host?.trim()) throw new Error(`Enter a Thrift host for ${target.name}'s register adapter.`);
    result[target.key] = { name: target.name, address: draft.address.trim(), device_id: Number(draft.device_id), proto_dump_file: null,
      register_adapter_enabled: Boolean(draft.adapter), register_thrift_host: draft.thrift_host?.trim() || null, register_thrift_port: port };
  }
  return result;
}

export default function NetworkArchive({ disabled = false, onImported, onBusyChange }) {
  const { getSwitches, getSwitchesOnline, getHistorySwitches, setCurrentSwitchID } = useSwitch() || {};
  const { getLoadedTopology, getTopologies, publishImportedTopology, acquireNetworkOperation, archiveBusy, topologyOperationBusy } = useTopology() || {};
  const navigate = useNavigate();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [token, setToken] = useState(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [restoreExternal, setRestoreExternal] = useState(false);
  const [attachInterfaces, setAttachInterfaces] = useState(false);
  const [restoreQueues, setRestoreQueues] = useState(true);
  const [targets, setTargets] = useState({});
  const [working, setWorking] = useState(false);
  const input = useRef(null);
  const request = useRef(null);
  const releaseLease = useRef(null);
  const feedback = useAsyncFeedback('network-archive');
  useEffect(() => { onBusyChange?.(working); }, [onBusyChange, working]);
  useEffect(() => () => { request.current?.abort(); releaseLease.current?.(); }, []);
  const unavailable = disabled || working || archiveBusy || topologyOperationBusy;

  function start(action) {
    if (unavailable) return null;
    const release = acquireNetworkOperation ? acquireNetworkOperation('archive') : () => {};
    if (!release) return null;
    releaseLease.current = release;
    request.current = new AbortController();
    setWorking(true); setError(''); setNoticeOpen(true);
    return { controller: request.current, status: feedback.begin(action), release };
  }
  function finish(operation) {
    operation.release();
    if (releaseLease.current === operation.release) releaseLease.current = null;
    if (!operation.controller.signal.aborted) setWorking(false);
  }
  async function exportNetwork() {
    setMenuAnchor(null);
    const operation = start('export');
    if (!operation) return;
    try {
      const response = await axios.get('/network/export', { responseType: 'blob', signal: operation.controller.signal, timeout: 120000 });
      if (operation.controller.signal.aborted) return;
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = response.headers?.['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || 'UniCorn-P4-network.zip';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback.complete(operation.status);
    } catch (failure) {
      if (!operation.controller.signal.aborted) { setError(await failureMessage(failure)); feedback.fail(operation.status); }
    } finally { finish(operation); }
  }
  async function validateFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || unavailable) return;
    if (file.size > 64 * 1024 * 1024) { setError('Network archives must be at most 64 MiB.'); setNoticeOpen(true); return; }
    const operation = start('import');
    if (!operation) return;
    setFilename(file.name); setPreview(null); setToken(null); setResult(null); setTargets({});
    setRestoreExternal(false); setAttachInterfaces(false); setRestoreQueues(true); setOpen(true);
    try {
      const data = new FormData(); data.append('file', file);
      const response = await axios.post('/network/import', data, { signal: operation.controller.signal, timeout: 120000 });
      if (operation.controller.signal.aborted) return;
      setPreview(response.data.preview); setToken(response.data.import_token);
      feedback.complete(operation.status);
    } catch (failure) {
      if (!operation.controller.signal.aborted) { setError(await failureMessage(failure)); feedback.fail(operation.status); }
    } finally { finish(operation); }
  }
  function close() {
    if (working) return;
    setOpen(false); setError(''); setToken(null); setPreview(null); setResult(null);
  }
  async function deploy() {
    let mappings;
    try { mappings = externalMappings(preview, targets, restoreExternal); }
    catch (failure) { setError(failure.message); return; }
    const operation = start('deploy');
    if (!operation) return;
    try {
      const response = await axios.post('/network/import/deploy', { import_token: token, restore_external: restoreExternal,
        external_targets: mappings, attach_external_interfaces: attachInterfaces, restore_queues: restoreQueues }, { signal: operation.controller.signal, timeout: 300000 });
      if (operation.controller.signal.aborted) return;
      setResult(response.data); setToken(null);
      const changed = Boolean(response.data.topology) || response.data.switches?.some(target => ['complete', 'restored', 'partial'].includes(target.status));
      if (changed) {
        setCurrentSwitchID?.(null);
        if (response.data.topology) publishImportedTopology?.(response.data.topology);
        navigate(response.data.topology ? '/topology' : '/switches');
      }
      await Promise.allSettled([getSwitches?.(), getSwitchesOnline?.(), getHistorySwitches?.(), getLoadedTopology?.(), getTopologies?.()]);
      if (response.data.topology || response.data.switches?.some(target => ['complete', 'restored'].includes(target.status))) {
        try { await onImported?.(response.data); }
        catch (refreshError) { setError(`The network import finished, but its live view could not be refreshed: ${refreshError.message}`); }
      }
      if (response.data.status === 'complete') feedback.complete(operation.status);
      else feedback.fail(operation.status, 'Import finished with unavailable or failed state. Review the report below.');
    } catch (failure) {
      if (!operation.controller.signal.aborted) { setError(await failureMessage(failure)); feedback.fail(operation.status); }
    } finally { finish(operation); }
  }
  function changeTarget(key, change) { setTargets(previous => ({ ...previous, [key]: { ...previous[key], ...change } })); }
  const external = (preview?.switches || []).filter(target => target.kind === 'external');
  const warnings = [...(preview?.warnings || []), ...(result?.warnings || [])];
  return <>
    <Tooltip title="Network archive"><span><IconButton aria-label="Network archive" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)} aria-controls={menuAnchor ? 'network-archive-menu' : undefined} color="inherit" disabled={unavailable} onClick={event => setMenuAnchor(event.currentTarget)}><ArchiveOutlined /></IconButton></span></Tooltip>
    <Menu id="network-archive-menu" anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
      <MenuItem disabled={unavailable} onClick={exportNetwork}>Export network</MenuItem>
      <MenuItem disabled={unavailable} onClick={() => { setMenuAnchor(null); input.current.click(); }}>Import network</MenuItem>
    </Menu>
    <input ref={input} aria-label="Import network archive" type="file" accept=".zip,application/zip" hidden onChange={validateFile} />
    <Portal><Snackbar open={!open && noticeOpen} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} autoHideDuration={working ? null : 8000} onClose={(_event, reason) => { if (!working && reason !== 'clickaway') setNoticeOpen(false); }}>
      <Paper elevation={6} sx={{ p: 2, maxWidth: 420 }}><Stack direction="row" sx={{ alignItems: 'flex-start', gap: 1 }}><Box><AsyncFeedback feedback={feedback} />{error && <Alert severity="error">{error}</Alert>}</Box><IconButton size="small" aria-label="Dismiss network feedback" disabled={working} onClick={() => setNoticeOpen(false)}><Close fontSize="small" /></IconButton></Stack></Paper>
    </Snackbar></Portal>
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>Import network</DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 2 }}>{filename}</Typography><AsyncFeedback feedback={feedback} sx={{ mb: 2 }} />
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {preview && <Stack spacing={2}>
          <Typography>Bundle version {preview.version} · captured {preview.captured_at}</Typography>
          <Typography>{preview.topology ? `${preview.topology.hosts?.length || 0} hosts · ${Object.keys(preview.topology.switches || {}).length} switches · ${preview.topology.links?.length || 0} links` : 'No emulated topology in this bundle.'}</Typography>
          {warnings.map((warning, index) => <Alert key={index} severity="warning">{message(warning)}</Alert>)}
          <TableContainer><Table size="small" aria-label="Switches in network bundle"><TableHead><TableRow><TableCell>Switch</TableCell><TableCell>Target</TableCell><TableCell>Pipeline</TableCell><TableCell>Captured state</TableCell></TableRow></TableHead><TableBody>{preview.switches.map(target => <TableRow key={target.key}>
            <TableCell>{target.name}</TableCell><TableCell>{target.kind}</TableCell><TableCell>{target.pipeline ? 'Included' : 'Unavailable'}</TableCell>
            <TableCell><Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 0.5 }}>{Object.entries(target.runtime || {}).map(([category, value]) => <Chip size="small" key={category} label={`${category}: ${value.status || value}`} title={message(value)} />)}</Stack>{target.warnings?.map((warning, index) => <Typography key={index} variant="caption" component="div" color="warning.main">{message(warning)}</Typography>)}</TableCell>
          </TableRow>)}</TableBody></Table></TableContainer>
          {!result && <>
            <Alert severity="warning">Import and deploy recreates the emulated network and restores captured switch state. Runtime state currently in that network will be replaced.</Alert>
            <FormControlLabel control={<Checkbox checked={restoreQueues} disabled={working} onChange={event => setRestoreQueues(event.target.checked)} />} label="Restore recorded queue settings (not switch readback)" />
            {preview.topology?.ext_intfs?.length > 0 && <FormControlLabel control={<Checkbox checked={attachInterfaces} disabled={working} onChange={event => setAttachInterfaces(event.target.checked)} />} label="Attach the bundle's physical network interfaces" />}
            {external.length > 0 && <>
              <FormControlLabel control={<Checkbox checked={restoreExternal} disabled={working} onChange={event => setRestoreExternal(event.target.checked)} />} label="Restore external switches with explicit destination mappings" />
              {restoreExternal && external.map(target => <Box key={target.key} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                <FormControlLabel control={<Checkbox checked={Boolean(targets[target.key]?.selected)} disabled={working} onChange={event => changeTarget(target.key, { selected: event.target.checked, device_id: targets[target.key]?.device_id ?? String(target.device_id) })} />} label={`Restore ${target.name}`} />
                {targets[target.key]?.selected && <Stack spacing={2}>
                  <TextField label={`P4Runtime address for ${target.name}`} value={targets[target.key].address || ''} disabled={working} onChange={event => changeTarget(target.key, { address: event.target.value })} placeholder="192.0.2.10:50051" />
                  <TextField label={`Device ID for ${target.name}`} value={targets[target.key].device_id ?? ''} disabled={working} onChange={event => changeTarget(target.key, { device_id: event.target.value })} />
                  <FormControlLabel control={<Checkbox checked={Boolean(targets[target.key].adapter)} disabled={working} onChange={event => changeTarget(target.key, { adapter: event.target.checked })} />} label={`Use register adapter for ${target.name}`} />
                  <TextField label={`Thrift host for ${target.name}`} value={targets[target.key].thrift_host || ''} disabled={working} onChange={event => changeTarget(target.key, { thrift_host: event.target.value })} />
                  <TextField label={`Thrift port for ${target.name}`} value={targets[target.key].thrift_port ?? '9090'} disabled={working} onChange={event => changeTarget(target.key, { thrift_port: event.target.value })} />
                </Stack>}
              </Box>)}
            </>}
          </>}
        </Stack>}
        {result && <Box sx={{ mt: 2 }}>
          <Alert severity={result.status === 'complete' ? 'success' : 'warning'}>{result.status === 'complete' ? 'Network imported successfully.' : 'Network imported with incomplete state.'}</Alert>
          {result.switches?.map(target => <Box key={target.key || target.name} sx={{ mt: 1 }}><Typography variant="subtitle2">{target.name}: {target.status}</Typography>{target.errors?.map((error, index) => <Typography key={index} variant="body2" color="error">{message(error)}</Typography>)}</Box>)}
        </Box>}
      </DialogContent>
      <DialogActions><Button onClick={close} disabled={working}>{result ? 'Close' : 'Cancel'}</Button><Button variant="contained" disabled={working || !token || !preview || Boolean(result)} onClick={deploy}>{working && feedback.action === 'deploy' ? 'Importing network…' : 'Import and deploy'}</Button></DialogActions>
    </Dialog>
  </>;
}
