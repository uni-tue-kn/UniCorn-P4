import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell, TableRow, TextField, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import { useInit } from '../../Contexts/InitContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

const defaults = { max_timeout_ns: '0', max_list_size: '1', ack_timeout_ns: '1000000000' };
const fields = [
  ['max_timeout_ns', 'Maximum timeout (ns)', 'Wait before sending a partial digest list; 0 requests immediate delivery.'],
  ['max_list_size', 'Maximum list size', 'Send after this many samples; 0 lets the target choose. Capture supports up to 256 samples per list.'],
  ['ack_timeout_ns', 'Acknowledgement timeout (ns)', 'Duplicate suppression timeout; the controller acknowledges captured lists automatically.'],
];
export function validateDigestConfig(config) {
  const result = {};
  for (const [field] of fields) {
    const value = String(config[field]);
    const minimum = 0n;
    const maximum = field === 'max_list_size' ? 2147483647n : 9223372036854775807n;
    if (!/^\d+$/.test(value) || BigInt(value) < minimum || BigInt(value) > maximum) throw new Error(`${field} must be a whole number between ${minimum} and ${maximum}.`);
    result[field] = BigInt(value).toString();
  }
  return result;
}

export function compactDigestRows(samples) {
  const rows = [];
  function visit(value, path, depth = 0) {
    const add = text => rows.push({ field: path || 'value', value: text });
    if (depth >= 20) { add('See Details'); return; }
    if (value == null || typeof value !== 'object') { add(value == null ? '—' : String(value)); return; }
    if (value.decimal != null) { add(String(value.decimal)); return; }
    if (value.kind === 'bool' || value.kind === 'enum' || value.kind === 'error') { add(String(value.value)); return; }
    if (value.fields && !Array.isArray(value.fields)) {
      for (const [name, child] of Object.entries(value.fields)) visit(child, path ? `${path}.${name}` : name, depth + 1);
      return;
    }
    const children = value.members || value.entries || (Array.isArray(value.fields) ? value.fields : null);
    if (children) { children.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1)); return; }
    if (value.kind === 'header_union' && value.value) { visit(value.value, path ? `${path}.${value.valid_header_name}` : value.valid_header_name, depth + 1); return; }
    if (value.valid === false || value.valid_header_name === null) { add('Not present'); return; }
    add('Raw value — see Details');
  }
  (samples || []).forEach((value, index) => visit(value, samples.length > 1 ? `[${index}]` : ''));
  return rows;
}

function DigestEvent({ event, alias }) {
  const [details, setDetails] = useState(false);
  return <Box data-testid={`digest-event-${event.sequence}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
    <Typography variant="subtitle2">{alias || `Digest ${event.digest_id}`}</Typography>
    <Typography variant="caption" color="text.secondary">{event.received_at}</Typography>
    <Table size="small" aria-label="Digest field values"><TableBody>{compactDigestRows(event.data).map((row, index) => <TableRow key={index}>
      <TableCell component="th" scope="row" sx={{ width: '40%', overflowWrap: 'anywhere' }}>{row.field}</TableCell><TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{row.value}</TableCell>
    </TableRow>)}</TableBody></Table>
    <Button size="small" aria-expanded={details} aria-controls={`digest-details-${event.sequence}`} onClick={() => setDetails(value => !value)}>Details</Button>
    {details && <Box id={`digest-details-${event.sequence}`} component="pre" sx={{ overflow: 'auto', m: 0, mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.85rem' }}>{JSON.stringify({ digest_id: event.digest_id, list_id: event.list_id,
      received_at: event.received_at, timestamp_ns: event.timestamp_ns, data: event.data }, null, 2)}</Box>}
  </Box>;
}

export default function DigestContent() {
  const { currentSwitchID } = useSwitch();
  const { initializedFiles } = useInit();
  const digests = useMemo(() => Object.values(initializedFiles?.digests || {}).sort((a, b) => a.name.localeCompare(b.name)), [initializedFiles]);
  const [selection, setSelection] = useState('');
  const digestID = digests.find(digest => String(digest.id) === selection)?.id ?? digests[0]?.id;
  const key = `${currentSwitchID}:${digestID}`;
  const configurationFeedback = useAsyncFeedback(key + ':configuration');
  const eventFeedback = useAsyncFeedback(key + ':events');
  const { begin: beginConfig, complete: completeConfig, fail: failConfig, cancel: cancelConfig } = configurationFeedback;
  const { begin: beginEvent, complete: completeEvent, fail: failEvent, cancel: cancelEvent } = eventFeedback;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [configurationError, setConfigurationError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [events, setEvents] = useState([]);
  const [streamState, setStreamState] = useState(null);
  const [eventError, setEventError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const cursor = useRef({ key, sequence: '0' });
  const eventRequest = useRef(null);
  const eventGeneration = useRef(0);
  const config = snapshot?.key === key ? snapshot.config : undefined;
  const values = draft?.key === key ? draft.values : defaults;
  const stream = streamState?.key === key ? streamState.value : null;
  const loadConfig = useCallback(async (signal, manual = false) => {
    if (currentSwitchID == null || digestID == null) return;
    const token = beginConfig('refresh', { quiet: !manual });
    try {
      setLoading(true); setConfigurationError('');
      const response = await axios.get('/digests', { params: { switch_id: currentSwitchID, digest_id: digestID }, signal });
      if (signal?.aborted || currentKey.current !== key) { cancelConfig(token); return false; }
      const active = response.data.entries.find(entry => entry.digest_id === digestID)?.config || null;
      setSnapshot({ key, config: active });
      setDraft({ key, values: active || { ...defaults } });
      completeConfig(token); return true;
    } catch (err) {
      if (!signal?.aborted && !axios.isCancel(err) && currentKey.current === key) { setConfigurationError(err.response?.data?.error || err.message); failConfig(token); } else cancelConfig(token);
      return false;
    } finally { if (!signal?.aborted && currentKey.current === key) setLoading(false); }
  }, [currentSwitchID, digestID, key, beginConfig, completeConfig, failConfig, cancelConfig]);
  const loadEvents = useCallback(async (signal, manual = false) => {
    if (currentSwitchID == null || digestID == null) return;
    if (eventRequest.current?.key === key) {
      if (manual) eventRequest.current.feedback = beginEvent('refresh');
      return;
    }
    const token = { key, generation: eventGeneration.current, feedback: beginEvent('refresh', { quiet: !manual }) };
    eventRequest.current = token;
    const after = cursor.current.key === key ? cursor.current.sequence : '0';
    try {
      const response = await axios.get('/digest-events', { params: { switch_id: currentSwitchID, digest_id: digestID, after, limit: 100 }, signal });
      if (signal?.aborted || currentKey.current !== key || token.generation !== eventGeneration.current) { cancelEvent(token.feedback); return false; }
      cursor.current = { key, sequence: response.data.next_sequence };
      setEvents(previous => [...new Map([...previous, ...response.data.events].map(event => [event.sequence, event])).values()].slice(-200));
      setStreamState({ key, value: response.data }); setEventError('');
      completeEvent(token.feedback); return true;
    } catch (err) {
      if (!signal?.aborted && !axios.isCancel(err) && currentKey.current === key) { setEventError(err.response?.data?.error || err.message); failEvent(token.feedback); } else cancelEvent(token.feedback);
      return false;
    } finally { if (eventRequest.current === token) eventRequest.current = null; }
  }, [currentSwitchID, digestID, key, beginEvent, completeEvent, failEvent, cancelEvent]);
  useEffect(() => {
    setConfigurationError(''); setConfirmDisable(false); setBusy(false);
    const controller = new AbortController(); loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);
  useEffect(() => {
    setEvents([]); setEventError(''); setStreamState(null);
    cursor.current = { key, sequence: '0' }; eventGeneration.current += 1;
  }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    loadEvents(controller.signal);
    const timer = autoRefresh ? setInterval(() => loadEvents(controller.signal), 2000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [autoRefresh, loadEvents]);
  async function save(event) {
    event.preventDefault();
    let token;
    try {
      const next = validateDigestConfig(values);
      token = beginConfig('save');
      setBusy(true); setConfigurationError('');
      await axios[config ? 'patch' : 'post']('/digests', { switch_id: currentSwitchID, digest_id: digestID, config: next });
      if (currentKey.current === key) { if (await loadConfig()) completeConfig(token); else failConfig(token, 'Saved; refresh failed'); }
    } catch (err) { if (currentKey.current === key) { setConfigurationError(err.response?.data?.error || err.message); failConfig(token); } }
    finally { if (currentKey.current === key) setBusy(false); }
  }
  async function disable() {
    const token = beginConfig('disable');
    try {
      setBusy(true); setConfigurationError('');
      await axios.delete('/digests', { data: { switch_id: currentSwitchID, digest_id: digestID } });
      if (currentKey.current === key) { setConfirmDisable(false); if (await loadConfig()) completeConfig(token); else failConfig(token, 'Disabled; refresh failed'); }
    } catch (err) { if (currentKey.current === key) { setConfigurationError(err.response?.data?.error || err.message); failConfig(token); } }
    finally { if (currentKey.current === key) setBusy(false); }
  }
  async function clearEvents() {
    const token = beginEvent('clear');
    try {
      setBusy(true);
      eventGeneration.current += 1;
      await axios.delete('/digest-events', { data: { switch_id: currentSwitchID, digest_id: digestID } });
      if (currentKey.current === key) { setEvents([]); cursor.current = { key, sequence: '0' }; if (await loadEvents() === false) failEvent(token, 'Cleared; refresh failed'); else completeEvent(token); }
    } catch (err) { if (currentKey.current === key) { setEventError(err.response?.data?.error || err.message); failEvent(token); } }
    finally { if (currentKey.current === key) setBusy(false); }
  }
  return <Box>
    <Typography variant="h5" gutterBottom>Digests</Typography>
    <Typography sx={{ mb: 2 }} color="text.secondary">Receive structured notifications emitted by the P4 program. Enable a digest, then send traffic that calls it.</Typography>
    {digests.length === 0 ? <Alert severity="info">The initialized program declares no digests.</Alert> : <Stack spacing={3}>
      <TextField select label="Digest" value={digestID ?? ''} onChange={event => setSelection(String(event.target.value))} disabled={busy} sx={{ maxWidth: 600 }}>{digests.map(digest => <MenuItem key={digest.id} value={digest.id}>{digest.alias || digest.name} ({digest.id})</MenuItem>)}</TextField>
      <Paper sx={{ p: 3 }}><Typography variant="h6" gutterBottom>Digest configuration</Typography>
        {!confirmDisable && <AsyncFeedback feedback={configurationFeedback} sx={{ mb: 1 }} />}
        {configurationError && <Alert severity="error" sx={{ mb: 2 }}>{configurationError}</Alert>}
        {loading && <CircularProgress aria-label="Loading digest configuration" size={24} />}
        <Typography sx={{ mb: 2 }}>{config ? 'Enabled' : config === null ? 'Disabled' : 'Loading configuration…'}</Typography>
        <form onSubmit={save}><Stack spacing={2} sx={{ maxWidth: 600 }}>{fields.map(([field, label, help]) => <TextField key={field} label={label} helperText={help} value={values[field]} required disabled={busy || loading} onChange={event => setDraft({ key, values: { ...values, [field]: event.target.value } })} />)}<Stack direction="row" spacing={1}><Button variant="contained" type="submit" disabled={busy || loading || config === undefined}>{configurationFeedback.pending && configurationFeedback.action === 'save' ? 'Saving…' : config ? 'Save configuration' : 'Enable digest'}</Button><Button onClick={() => setConfirmDisable(true)} disabled={busy || loading || !config}>Disable digest</Button><Button onClick={() => loadConfig(undefined, true)} disabled={busy || loading}>{configurationFeedback.pending && configurationFeedback.action === 'refresh' ? 'Refreshing…' : 'Refresh configuration'}</Button></Stack></Stack></form>
      </Paper>
      <Paper sx={{ p: 3 }}><Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'center', flexWrap: 'wrap' }}><Typography variant="h6">Captured events</Typography><Button onClick={() => loadEvents(undefined, true)} disabled={busy || eventFeedback.pending}>{eventFeedback.pending && eventFeedback.action === 'refresh' ? 'Refreshing…' : 'Refresh events'}</Button><Button onClick={clearEvents} disabled={busy || eventFeedback.pending}>{eventFeedback.pending && eventFeedback.action === 'clear' ? 'Clearing…' : 'Clear events'}</Button><FormControlLabel control={<Switch checked={autoRefresh} disabled={busy || eventFeedback.pending} onChange={event => setAutoRefresh(event.target.checked)} />} label="Auto refresh" /></Stack>
        <AsyncFeedback feedback={eventFeedback} sx={{ mb: 1 }} />
        <Typography color="text.secondary" sx={{ mb: 2 }}>The controller captures and acknowledges digest lists while connected. This view keeps the latest 200 lists; the server retains up to 256 lists within 4 MiB. Events are cleared when the pipeline changes or the connection closes.</Typography>
        {eventError && <Alert severity="error" sx={{ mb: 2 }}>{eventError}</Alert>}
        {stream?.stream?.error && <Alert severity="warning" sx={{ mb: 2 }}>{stream.stream.error}</Alert>}
        {stream && (!stream.stream?.active || !stream.stream?.primary) && <Alert severity="warning" sx={{ mb: 2 }}>Digest capture requires an active primary controller connection.</Alert>}
        {stream?.dropped > 0 && <Alert severity="warning" sx={{ mb: 2 }}>{stream.dropped} list(s) were rejected or evicted from the capture buffer.</Alert>}
        {events.length === 0 && <Typography>No digest events captured.</Typography>}
        <Stack spacing={2}>{events.map(event => <DigestEvent key={event.sequence} event={event} alias={digests.find(digest => digest.id === event.digest_id)?.alias || digests.find(digest => digest.id === event.digest_id)?.name} />)}</Stack>
      </Paper>
    </Stack>}
    <Dialog open={confirmDisable} onClose={() => !busy && setConfirmDisable(false)}><DialogTitle>Disable digest</DialogTitle><DialogContent>Stop notifications for this digest? Captured events remain available until cleared.<AsyncFeedback feedback={configurationFeedback} /></DialogContent><DialogActions><Button onClick={() => setConfirmDisable(false)} disabled={busy}>Cancel</Button><Button onClick={disable} disabled={busy}>{configurationFeedback.pending && configurationFeedback.action === 'disable' ? 'Disabling…' : 'Confirm disable'}</Button></DialogActions></Dialog>
  </Box>;
}
