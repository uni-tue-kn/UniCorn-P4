import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, TextField, Tooltip, Typography } from '@mui/material';
import LoopIcon from '@mui/icons-material/Loop';
import { useSwitch } from '../../Contexts/SwitchContext';
import { useInit } from '../../Contexts/InitContext';
import TrafficChart from './TrafficChart';
import { appendSample, totals } from './traffic';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

const counterHelp = { index: 'Counter array cell selected by the P4 program.',
  packets: 'Cumulative packets counted by this resource, when packet counting is enabled in P4Info. The graph shows the change per second (packets/s).',
  bytes: 'Cumulative bytes counted by this resource, when byte counting is enabled in P4Info. The graph converts byte changes to bits per second (8 bits per byte).' };

export default function CounterContent({ counterId, counterName }) {
  const { currentSwitchID } = useSwitch();
  const { initializedFiles } = useInit() || {};
  const [entries, setEntries] = useState(null);
  const [samples, setSamples] = useState([]);
  const [error, setError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [sort, setSort] = useState({ key: 'index', ascending: true });
  const [indexFilter, setIndexFilter] = useState('');
  const [live, setLive] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [resetting, setResetting] = useState(false);
  const resetController = useRef(null);
  const identity = `${currentSwitchID}:${counterId}:${indexFilter}`;
  const feedback = useAsyncFeedback(identity);
  const { begin, complete, fail, cancel } = feedback;
  const manualRefresh = useRef(null);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  useEffect(() => { setIndexFilter(''); }, [currentSwitchID, counterId]);
  useEffect(() => {
    setEntries(null); setSamples([]); setError(''); setWriteError(''); setResetting(false);
    return () => { resetController.current?.abort(); };
  }, [identity]);

  useEffect(() => {
    if (currentSwitchID == null || resetting) return;
    if (indexFilter && !/^\d+$/.test(indexFilter)) { setError('Traffic index must be a nonnegative integer.'); return; }
    let active = true, timer, controller, activeToken;
    let manualToken = manualRefresh.current;
    manualRefresh.current = null;
    const sample = (counts, status) => setSamples(previous => appendSample(previous, counts, performance.now(), status));
    async function load() {
      if (!active || document.hidden) return;
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const requested = controller;
      const token = manualToken || begin('refresh', { quiet: true });
      manualToken = null;
      activeToken = token;
      try {
        const response = await axios.get('/counters', { params: { switch_id: currentSwitchID, counter_id: counterId, ...(indexFilter ? { index: indexFilter } : {}) }, signal: requested.signal });
        if (!active || requested.signal.aborted) { cancel(token); return; }
        setEntries(response.data.entries); setError('');
        sample(totals(response.data.entries), 'sample');
        complete(token);
      } catch (failure) {
        if (!active || requested.signal.aborted || axios.isCancel(failure)) { cancel(token); return; }
        setError(failure.response?.data?.error || failure.message);
        sample(null, 'missing');
        fail(token);
      } finally {
        if (active && !requested.signal.aborted && live && !document.hidden) timer = setTimeout(load, 1000);
      }
    }
    function visibility() {
      clearTimeout(timer); controller?.abort();
      if (document.hidden) sample(null, 'paused');
      else load();
    }
    document.addEventListener('visibilitychange', visibility);
    load();
    return () => { active = false; clearTimeout(timer); controller?.abort(); cancel(activeToken); document.removeEventListener('visibilitychange', visibility); };
  }, [currentSwitchID, counterId, indexFilter, live, refresh, resetting, begin, complete, fail, cancel]);

  async function reset(index) {
    const selected = identity;
    const token = begin('reset');
    resetController.current?.abort();
    const controller = new AbortController();
    resetController.current = controller;
    setResetting(true); setWriteError('');
    try {
      await axios.patch('/counters', { switch_id: currentSwitchID, counter_id: counterId, index, reset: true }, { signal: controller.signal });
      if (controller.signal.aborted || currentIdentity.current !== selected) return;
      setSamples(previous => appendSample(previous, null, performance.now(), 'reset'));
      setRefresh(previous => previous + 1);
      complete(token);
    } catch (failure) {
      if (!controller.signal.aborted && currentIdentity.current === selected) {
        const partial = failure.response?.data?.partial_write_possible;
        setWriteError(`${failure.response?.data?.error || failure.message}${partial ? ' Some entries may already have been reset. Refresh to check current values.' : ''}`);
        if (partial) setSamples(previous => appendSample(previous, null, performance.now(), 'possible reset'));
        fail(token);
      }
    } finally {
      if (!controller.signal.aborted && currentIdentity.current === selected) setResetting(false);
    }
  }

  const sorted = [...(entries || [])].sort((a, b) => {
    const left = BigInt(a[sort.key] ?? 0), right = BigInt(b[sort.key] ?? 0);
    return (left < right ? -1 : left > right ? 1 : 0) * (sort.ascending ? 1 : -1);
  });
  return <Box>
    <Typography variant="h5" gutterBottom sx={{ overflowWrap: 'anywhere' }}>{counterName}</Typography>
    <Paper sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Button startIcon={<LoopIcon />} onClick={() => { manualRefresh.current = begin('refresh'); setRefresh(previous => previous + 1); }} disabled={currentSwitchID == null || resetting || feedback.pending}>{feedback.pending && feedback.action === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button>
        <TextField label="Traffic index" size="small" value={indexFilter} onChange={event => setIndexFilter(event.target.value)} helperText="Leave empty to graph all entries combined" slotProps={{ htmlInput: { inputMode: 'numeric' } }} sx={{ maxWidth: '100%' }} />
        <FormControlLabel control={<Checkbox checked={live} onChange={event => setLive(event.target.checked)} />} label="Live traffic" />
        <Button color="warning" onClick={() => reset(null)} disabled={currentSwitchID == null || resetting || feedback.pending || entries == null}>Reset all counters</Button>
      </Stack>
      <AsyncFeedback feedback={feedback} sx={{ mt: 1 }} />
      {(error || writeError) && <Alert severity="error" sx={{ mt: 2 }}>{writeError || error}</Alert>}
      <TrafficChart samples={samples} unit={initializedFiles?.counters?.[counterName]?.unit} />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Reset affects only this counter resource. Traffic can increment counters immediately after a reset. Polling pauses when this page is hidden.</Typography>
      {entries == null && !error && currentSwitchID != null ? <CircularProgress aria-label="Loading counters" /> : <TableContainer><Table aria-label={counterName}>
        <TableHead><TableRow>{['index', 'packets', 'bytes'].map(key => <TableCell key={key}><Tooltip title={counterHelp[key]} describeChild><TableSortLabel active={sort.key === key} direction={sort.ascending ? 'asc' : 'desc'} onClick={() => setSort({ key, ascending: sort.key === key ? !sort.ascending : true })}>{key[0].toUpperCase() + key.slice(1)}</TableSortLabel></Tooltip></TableCell>)}<TableCell>Actions</TableCell></TableRow></TableHead>
        <TableBody>{sorted.map(entry => <TableRow key={entry.index} data-testid={`counter-row-${entry.index}`}><TableCell>{entry.index}</TableCell><TableCell>{entry.packets}</TableCell><TableCell>{entry.bytes}</TableCell><TableCell><Button aria-label={`Reset counter index ${entry.index}`} disabled={resetting || feedback.pending || currentSwitchID == null} onClick={() => reset(entry.index)}>Reset</Button></TableCell></TableRow>)}</TableBody>
      </Table></TableContainer>}
    </Paper>
  </Box>;
}
