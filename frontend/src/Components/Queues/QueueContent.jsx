import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

function whole(value, label, maximum, minimum = 0) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) < BigInt(minimum) || BigInt(value) > BigInt(maximum)) throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  return BigInt(value);
}

export function validateQueueSettings({ scope, port, depth, rate }) {
  const request = { port: scope === 'all' ? null : Number(whole(port, 'Port', 510)) };
  if (depth !== '') request.depth_packets = Number(whole(depth, 'Queue depth', 2147483647, 1));
  if (rate !== '') request.rate_pps = whole(rate, 'Queue rate', '9223372036854775807').toString();
  if (depth === '' && rate === '') throw new Error('Enter a queue depth or packet rate.');
  return request;
}
const queueValue = (value, field) => value == null ? 'Unknown' : field === 'depth_packets' ? `${value} packets` : String(value) === '0' ? 'Unlimited (0)' : `${value} packets/s`;

export default function QueueContent() {
  const { currentSwitchID } = useSwitch();
  const feedback = useAsyncFeedback(currentSwitchID);
  const { begin, complete, fail, cancel } = feedback;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [scope, setScope] = useState('all');
  const [port, setPort] = useState('1');
  const [depth, setDepth] = useState('');
  const [rate, setRate] = useState('');
  const selected = useRef(currentSwitchID);
  selected.current = currentSwitchID;
  const load = useCallback(async (signal, manual = false) => {
    if (currentSwitchID == null) return;
    const token = begin('refresh', { quiet: !manual });
    setBusy(true); setError('');
    try {
      const response = await axios.get('/queues', { params: { switch_id: currentSwitchID }, signal });
      if (!signal?.aborted && selected.current === currentSwitchID) { setData(response.data); complete(token); } else cancel(token);
    } catch (failure) {
      if (!signal?.aborted && selected.current === currentSwitchID && !axios.isCancel(failure)) { setError(failure.response?.data?.error || failure.message); fail(token); } else cancel(token);
    } finally { if (!signal?.aborted && selected.current === currentSwitchID) setBusy(false); }
  }, [currentSwitchID, begin, complete, fail, cancel]);
  useEffect(() => {
    setData(null); setDepth(''); setRate(''); setSuccess(''); setError(''); setBusy(false); setScope('all'); setPort('1');
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function apply(event) {
    event.preventDefault();
    const switchId = currentSwitchID;
    let token;
    try {
      const settings = validateQueueSettings({ scope, port, depth, rate });
      token = begin('save');
      setBusy(true); setError(''); setSuccess('');
      const response = await axios.patch('/queues', { switch_id: switchId, ...settings });
      if (selected.current !== switchId) return;
      setData(response.data);
      setSuccess('Queue changes acknowledged by BMv2.');
      complete(token);
    } catch (failure) {
      if (selected.current !== switchId) return;
      fail(token);
      const result = failure.response?.data;
      const applied = result?.applied || [];
      setError((result?.error || failure.message) +
        (applied.length ? ` ${applied.length} earlier change(s) were applied.` : '') +
        (result?.uncertain ? ' The failed setting may have reached the switch; its outcome is unknown.' : ''));
      if (result?.configuration) setData(previous => ({ ...previous, ...result }));
      else if (applied.length) setData(previous => ({ ...previous, state: 'last_applied', last_applied: [...(previous?.last_applied || []), ...applied].slice(-100) }));
    } finally { if (selected.current === switchId) setBusy(false); }
  }

  return <Box>
    <Typography variant="h5" gutterBottom>Queues</Typography>
    <Typography color="text.secondary" sx={{ mb: 2 }}>Configure BMv2 egress queue capacity in packets and maximum rate in packets per second. Settings apply to every priority queue on the selected port or all ports.</Typography>
    <Paper sx={{ p: 3 }}>
      <Button onClick={() => load(undefined, true)} disabled={busy || currentSwitchID == null} sx={{ mb: 2 }}>{feedback.pending && feedback.action === 'refresh' ? 'Refreshing…' : 'Refresh queues'}</Button>
      <AsyncFeedback feedback={feedback} sx={{ mb: 2 }} />
      {currentSwitchID == null && <Alert severity="info">Select a connected switch to configure queues.</Alert>}
      {busy && !data && <CircularProgress aria-label="Loading queue controls" />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}
      {data && <Alert severity={data.configured ? 'info' : 'warning'} sx={{ mb: 2 }}>{data.message}</Alert>}
      <Box component="form" onSubmit={apply}>
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start', mb: 3 }}>
          <TextField select label="Target queues" value={scope} onChange={event => setScope(event.target.value)} size="small" sx={{ minWidth: 150 }}>
            <MenuItem value="all">All ports</MenuItem><MenuItem value="port">One port</MenuItem>
          </TextField>
          {scope === 'port' && <TextField label="Egress port" value={port} onChange={event => setPort(event.target.value)} size="small" helperText="0–510" sx={{ width: 130 }} />}
          <TextField label="Queue depth (packets)" value={depth} onChange={event => setDepth(event.target.value)} size="small" helperText="Leave blank to keep unchanged" sx={{ width: 220 }} />
          <TextField label="Queue rate (packets/s)" value={rate} onChange={event => setRate(event.target.value)} size="small" helperText="0 = unlimited; blank = unchanged" sx={{ width: 240 }} />
          <Button type="submit" variant="contained" disabled={busy || currentSwitchID == null || !data?.write_available}>{feedback.pending && feedback.action === 'save' ? 'Saving…' : 'Apply queue settings'}</Button>
        </Stack>
      </Box>
      <Typography variant="h6" gutterBottom>Per-port configuration</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Last configured here: acknowledged settings from this connection. The native API has no queue configuration getter, so external changes are not detected. Depth and rate are applied separately; failed requests may leave earlier changes applied.</Typography>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mb: 2 }}>
        <Typography variant="subtitle2">Default for all ports</Typography>
        <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography variant="body2">Depth: {queueValue(data?.configuration?.defaults?.depth_packets, 'depth_packets')}</Typography>
          <Typography variant="body2">Rate: {queueValue(data?.configuration?.defaults?.rate_pps, 'rate_pps')}</Typography>
        </Stack>
      </Box>
      {data?.port_discovery?.error && <Alert severity="warning" sx={{ mb: 2 }}>Port discovery unavailable: {data.port_discovery.error}. Acknowledged settings are still shown.</Alert>}
      {data?.configuration?.ports?.length ? <TableContainer sx={{ mb: 2 }}><Table size="small" aria-label="Per-port queue configuration"><TableHead><TableRow>
        <TableCell>Port</TableCell><TableCell>Interface</TableCell><TableCell>Depth (packets)</TableCell><TableCell>Rate (packets/s)</TableCell>
      </TableRow></TableHead><TableBody>{data.configuration.ports.map(entry => <TableRow key={entry.port}>
        <TableCell>{entry.port}</TableCell><TableCell>{entry.interface || 'Not discovered'}</TableCell>
        {['depth_packets', 'rate_pps'].map(field => <TableCell key={field}>{queueValue(entry[field], field)}
          {entry[field] != null && <Typography variant="caption" component="div" color="text.secondary">{entry.sources?.[field] === 'all_ports' ? 'All-port default' : 'Port override'}</Typography>}
        </TableCell>)}
      </TableRow>)}</TableBody></Table></TableContainer> : <Typography color="text.secondary" sx={{ mb: 2 }}>No port list is available yet. Set a specific port or refresh to discover the target’s ports.</Typography>}
      <Accordion disableGutters sx={{ boxShadow: 'none', border: 1, borderColor: 'divider' }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>Change history</AccordionSummary><AccordionDetails>
      <Typography variant="h6" gutterBottom>Last applied in this connection</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Latest 100 acknowledged changes. Later all-port updates can override earlier per-port values; the summary above keeps those values merged independently of history.</Typography>
      {!data?.last_applied?.length ? <Typography color="text.secondary">Current switch settings are unknown. No changes have been applied through this connection.</Typography> :
        <TableContainer><Table size="small" aria-label="Queue changes"><TableHead><TableRow>
          <TableCell>Port</TableCell><TableCell>Depth (packets)</TableCell><TableCell>Rate (packets/s)</TableCell><TableCell>Applied at</TableCell>
        </TableRow></TableHead><TableBody>{data.last_applied.map((entry, index) => <TableRow key={index}>
          <TableCell>{entry.port == null ? 'All ports' : entry.port}</TableCell>
          <TableCell>{entry.depth_packets ?? '—'}</TableCell>
          <TableCell>{entry.rate_pps === '0' ? 'Unlimited (0)' : entry.rate_pps ?? '—'}</TableCell>
          <TableCell>{entry.applied_at}</TableCell>
        </TableRow>)}</TableBody></Table></TableContainer>}
        </AccordionDetails>
      </Accordion>
    </Paper>
  </Box>;
}
