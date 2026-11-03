import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Tooltip, Typography } from '@mui/material';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import { useSwitch } from '../../Contexts/SwitchContext';
import { parseLosslessJSON } from '../Helpers/LosslessJSON';
import TrafficChart from './TrafficChart';
import { appendSample, totals } from './traffic';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if ((typeof value === 'string' && /^-?\d+$/.test(value)) || (typeof value === 'number' && Number.isInteger(value))) return BigInt(value).toString();
  return value;
}

export function directCounterEntryKey(entry) {
  return JSON.stringify([entry.table_name, canonical(entry.match_fields || {}), canonical(entry.priority || 0), Boolean(entry.is_default_action)]);
}

export default function DirectCounterPlot({ counter, tableID, tableEntry, disabled = false, label = 'Plot counter' }) {
  const { currentSwitchID } = useSwitch();
  const entryKey = directCounterEntryKey(tableEntry);
  const unit = Number(counter.unit);
  const supported = [1, 2, 3].includes(unit);
  const identity = JSON.stringify([currentSwitchID, tableID, counter.id, unit, entryKey]);
  const [openIdentity, setOpenIdentity] = useState(null);
  const open = openIdentity === identity;
  const [samples, setSamples] = useState([]);
  const [counts, setCounts] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => { setOpenIdentity(null); }, [identity]);
  useEffect(() => {
    setSamples([]); setCounts(null); setError(''); setUpdated(null); setLoading(false);
  }, [identity, open]);

  useEffect(() => {
    if (!open || currentSwitchID == null || !supported) return;
    let active = true, timer, controller;
    const sample = (values, status) => setSamples(previous => appendSample(previous, values, performance.now(), status));
    async function load() {
      if (!active || document.hidden) return;
      clearTimeout(timer);
      controller?.abort();
      const requested = new AbortController();
      controller = requested;
      setLoading(true);
      try {
        const response = await axios.get('/tables', { params: { switch_id: currentSwitchID, table_name: tableEntry.table_name }, signal: requested.signal, transformResponse: [parseLosslessJSON] });
        if (!active || requested.signal.aborted) return;
        if (!Array.isArray(response.data)) throw new Error('The target returned an invalid table read.');
        const matches = response.data.filter(row => row.switch_entry && directCounterEntryKey(row.switch_entry) === entryKey);
        if (matches.length !== 1) throw new Error(matches.length ? 'The target returned multiple entries for this table key. Refresh the table and try again.' : 'This table entry is no longer present. Refresh the table and try again.');
        const values = matches[0].counters;
        if (!values || (unit !== 1 && values.packets == null) || (unit !== 2 && values.bytes == null)) throw new Error('The target did not return direct-counter values for this entry.');
        const total = totals([{ packets: unit === 1 ? '0' : values.packets, bytes: unit === 2 ? '0' : values.bytes }]);
        setCounts(total); sample(total, 'sample'); setError(''); setUpdated(new Date().toISOString());
      } catch (failure) {
        if (!active || requested.signal.aborted || axios.isCancel(failure)) return;
        setError(failure.response?.data?.error || failure.message); sample(null, 'missing');
      } finally {
        if (active && !requested.signal.aborted) {
          setLoading(false);
          if (!document.hidden) timer = setTimeout(load, 1000);
        }
      }
    }
    function visibility() {
      clearTimeout(timer); controller?.abort();
      if (document.hidden) { sample(null, 'paused'); setLoading(false); }
      else load();
    }
    document.addEventListener('visibilitychange', visibility);
    load();
    return () => { active = false; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [open, identity, currentSwitchID, tableEntry.table_name, entryKey, unit, supported, refresh]);

  return <>
    <Tooltip title="Plot this entry’s direct-counter changes per second."><span><Button size="small" variant="outlined" startIcon={<ShowChartIcon />} aria-label={label} disabled={disabled || currentSwitchID == null} onClick={() => setOpenIdentity(identity)}>Plot counter</Button></span></Tooltip>
    <Dialog open={open} onClose={() => setOpenIdentity(null)} fullWidth maxWidth="lg" aria-labelledby={`direct-counter-plot-${counter.id}`}>
      <DialogTitle id={`direct-counter-plot-${counter.id}`}>Direct-counter throughput</DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          <Typography>{counter.alias || counter.name} · {tableEntry.table_name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>Match: {JSON.stringify(tableEntry.match_fields || {})}{tableEntry.priority ? ` · priority ${tableEntry.priority}` : ''}{tableEntry.is_default_action ? ' · default entry' : ''}</Typography>
          <Typography variant="body2" color="text.secondary">This entry only. Reads every second while this dialog is open; polling pauses when the browser tab is hidden.</Typography>
          {!supported && <Alert severity="info">This counter does not advertise a supported counting unit (bytes, packets, or both). Throughput is unavailable.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          {supported && <>
            <Typography role="status" aria-live={counts ? 'off' : 'polite'} variant="body2">{!counts && loading ? 'Reading counter…' : counts ? [unit !== 1 && `${counts.packets} packets`, unit !== 2 && `${counts.bytes} bytes`].filter(Boolean).join(' · ') : 'Waiting for a counter read.'}</Typography>
            {updated && <Typography variant="caption" color="text.secondary">Last updated: <time dateTime={updated}>{new Date(updated).toLocaleTimeString()}</time></Typography>}
            <TrafficChart samples={samples} unit={unit} />
          </>}
        </Stack>
      </DialogContent>
      <DialogActions><Button disabled={!supported || loading} onClick={() => setRefresh(value => value + 1)}>{loading ? 'Refreshing…' : 'Refresh'}</Button><Button onClick={() => setOpenIdentity(null)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
