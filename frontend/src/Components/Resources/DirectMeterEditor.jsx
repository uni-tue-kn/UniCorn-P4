import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';
import { DEFAULT_METER_DESCRIPTION, meterFields, meterFieldInfo, meterUnit } from '../Helpers/MeterFields';

const blankConfig = () => Object.fromEntries(meterFields.map(([field]) => [field, '']));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if ((typeof value === 'string' && /^-?\d+$/.test(value)) || (typeof value === 'number' && Number.isInteger(value))) return BigInt(value).toString();
  return value;
}
export function directMeterKey(entry) {
  return JSON.stringify([entry.table_name, canonical(entry.match_fields || {}), canonical(entry.priority || 0), Boolean(entry.is_default_action)]);
}
export function validateMeterConfig(draft) {
  const config = {};
  for (const [field, label] of meterFields) {
    if (!/^\d+$/.test(draft[field]) || BigInt(draft[field]) > 9223372036854775807n) throw new Error(`${label} must be a whole number between 0 and 9223372036854775807.`);
    config[field] = BigInt(draft[field]).toString();
  }
  if (BigInt(config.cir) > BigInt(config.pir)) throw new Error('PIR must be at least CIR.');
  return config;
}

export default function DirectMeterEditor({ meter, tableEntry, disabled = false, onSaved }) {
  const { currentSwitchID } = useSwitch();
  const entryKey = directMeterKey(tableEntry);
  const identity = `${currentSwitchID}:${meter.id}:${entryKey}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const target = useRef(tableEntry);
  target.current = tableEntry;
  const requested = useRef(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState(null);
  const [config, setConfig] = useState(undefined);
  const [draft, setDraft] = useState(blankConfig);
  const [error, setError] = useState('');
  const feedback = useAsyncFeedback(`${identity}:${open}`);
  const { begin, complete, fail, cancel } = feedback;
  const busy = phase != null;
  const writing = phase === 'save' || phase === 'reset';
  const read = useCallback(async signal => {
    const response = await axios.get('/direct-meters', { params: { switch_id: currentSwitchID, meter_id: meter.id }, signal });
    const matches = response.data.entries.filter(row => directMeterKey(row.table_entry) === entryKey);
    if (matches.length !== 1) throw new Error(matches.length ? 'The target returned multiple meters for this table key. Refresh the table and try again.' : 'This table entry was not returned by the target. Refresh the table and try again.');
    return matches[0].config;
  }, [currentSwitchID, meter.id, entryKey]);
  useEffect(() => {
    setOpen(false); setError(''); setPhase(null);
    return () => requested.current?.abort();
  }, [identity]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requested.current = controller;
    setConfig(undefined); setDraft(blankConfig()); setError(''); setPhase('load');
    const token = begin('refresh');
    read(controller.signal).then(value => {
      if (controller.signal.aborted || currentIdentity.current !== identity) return;
      setConfig(value); setDraft(value == null ? blankConfig() : Object.fromEntries(meterFields.map(([field]) => [field, String(value[field])])));
      complete(token);
    }).catch(failure => {
      if (controller.signal.aborted) { cancel(token); return; }
      if (currentIdentity.current !== identity) return;
      setError(failure.response?.data?.error || failure.message); fail(token);
    }).finally(() => { if (!controller.signal.aborted && currentIdentity.current === identity) setPhase(null); });
    return () => controller.abort();
  }, [open, identity, read, begin, complete, fail, cancel]);
  function close() {
    if (writing) return;
    requested.current?.abort(); setOpen(false); setPhase(null);
  }
  async function write(next, action) {
    const controller = new AbortController();
    requested.current?.abort(); requested.current = controller;
    const token = begin(action);
    setPhase(action); setError('');
    let applied = false;
    try {
      await axios.patch('/direct-meters', { switch_id: currentSwitchID, meter_id: meter.id,
        entries: [{ table_entry: structuredClone(target.current), config: next }] }, { signal: controller.signal });
      applied = true;
      const actual = await read(controller.signal);
      if (controller.signal.aborted || currentIdentity.current !== identity) return;
      setConfig(actual); setDraft(actual == null ? blankConfig() : Object.fromEntries(meterFields.map(([field]) => [field, String(actual[field])])));
      complete(token); onSaved?.();
    } catch (failure) {
      if (controller.signal.aborted) { cancel(token); return; }
      if (currentIdentity.current !== identity) return;
      const message = `${applied ? 'Meter updated, but refreshing its value failed. ' : ''}${failure.response?.data?.error || failure.message}`;
      setError(message); fail(token);
    } finally { if (!controller.signal.aborted && currentIdentity.current === identity) setPhase(null); }
  }
  function save(event) {
    event.preventDefault();
    // The dialog is opened from the MAT's edit form. Its meter write must not
    // bubble into that enclosing form's table-entry submit handler.
    event.stopPropagation();
    try { write(validateMeterConfig(draft), 'save'); }
    catch (failure) { setError(failure.message); }
  }
  return <>
    <Button size="small" variant="outlined" disabled={disabled || busy || currentSwitchID == null} onClick={() => setOpen(true)}>Edit meter</Button>
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>Edit direct meter</DialogTitle>
      <Box component="form" onSubmit={save}>
        <DialogContent><Stack spacing={2}>
          <Typography>{meter.alias || meter.name} · {tableEntry.table_name}</Typography>
          <Typography variant="body2" color="text.secondary">Match: {JSON.stringify(tableEntry.match_fields || {})}{tableEntry.priority ? ` · priority ${tableEntry.priority}` : ''}{tableEntry.is_default_action ? ' · default entry' : ''}</Typography>
          <Typography variant="body2" color="text.secondary">Rates are measured in {meterUnit(meter)}/s; bursts in {meterUnit(meter)}. Changes apply to this table entry.</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          {config === null && <Alert severity="info"><strong>Unconfigured — always green.</strong> {DEFAULT_METER_DESCRIPTION}</Alert>}
          {config !== undefined && meterFields.map(([field, label]) => {
            const info = meterFieldInfo(field, meter);
            return <Tooltip key={field} title={info.description} placement="top"><TextField label={label} helperText={info.help} value={draft[field]} required disabled={busy} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} /></Tooltip>;
          })}
          <AsyncFeedback feedback={feedback} />
        </Stack></DialogContent>
        <DialogActions><Button onClick={close} disabled={writing}>Cancel</Button><Tooltip title="Remove rate configuration; meter marks every packet green."><span><Button color="warning" onClick={() => write(null, 'reset')} disabled={busy || config == null}>Reset meter</Button></span></Tooltip><Button variant="contained" type="submit" disabled={busy || config === undefined}>Save meter</Button></DialogActions>
      </Box>
    </Dialog>
  </>;
}
