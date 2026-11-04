import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, CircularProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import { useInit } from '../../Contexts/InitContext';

import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';
import { DEFAULT_METER_DESCRIPTION, meterFields, meterFieldInfo, meterUnit } from '../Helpers/MeterFields';
import { parseLosslessJSON } from '../Helpers/LosslessJSON';
import { displayRegisterValue, registerDraft, registerFields, registerFieldValue, registerWriteValue, RegisterFieldInput } from './RegisterFields';
export const formatRegister = (value, radix) => BigInt(value).toString(Number(radix));

function ResourceRow({ entry, kind, resource, radix, onWrite, busy, writeAvailable = true, resetAvailable = true }) {
  const isRegister = kind === 'registers';
  const direct = kind === 'direct-meters';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState('');
  const label = direct ? JSON.stringify(entry.table_entry.match_fields) : String(entry.index);
  const meterConfig = entry.config;
  const fields = registerFields(resource);
  const startEdit = () => {
    setError('');
    setDraft(isRegister ? registerDraft(entry, fields) : Object.fromEntries(meterFields.map(([key]) => [key, String(meterConfig?.[key] ?? '')])));
    setEditing(true);
  };
  const save = async () => {
    try {
      if (isRegister) {
        await onWrite({ index: entry.index, value: registerWriteValue(entry, fields, draft) });
      } else {
        const config = {};
        for (const [key] of meterFields) {
          if (!/^\d+$/.test(draft[key]) || BigInt(draft[key]) > 9223372036854775807n) throw new Error('Rates and bursts must be nonnegative whole numbers no greater than 9223372036854775807.');
          config[key] = BigInt(draft[key]).toString();
        }
        if (BigInt(config.cir) > BigInt(config.pir)) throw new Error('PIR must be at least CIR.');
        await onWrite({ ...(direct ? { table_entry: entry.table_entry } : { index: entry.index }), config });
      }
      setEditing(false);
    } catch (err) { setError(err.response?.data?.error || err.message); }
  };
  return <TableRow data-testid={`resource-row-${direct ? entry.id ?? label : entry.index}`}>
    <TableCell sx={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{label}</TableCell>
    {isRegister ? fields.map(field => <TableCell key={field.name}>{editing ? <RegisterFieldInput field={field} index={label} value={draft[field.name]} disabled={busy} onChange={value => setDraft(previous => ({ ...previous, [field.name]: value }))} /> : <span data-testid={fields.length === 1 ? `value-${entry.index}` : `value-${entry.index}-${field.name}`}>{displayRegisterValue(registerFieldValue(entry, field), radix, field.type || field)}</span>}</TableCell>) : !editing && !entry.config ?
      <TableCell colSpan={4}><Tooltip title={DEFAULT_METER_DESCRIPTION} describeChild><Box component="span" tabIndex={0} sx={{ textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>Unconfigured — always green</Box></Tooltip></TableCell> :
      meterFields.map(([key, title]) => <TableCell key={key}>{editing ? <Tooltip title={meterFieldInfo(key, resource).description} describeChild><TextField size="small" disabled={busy} label={`${title} for ${direct ? 'entry' : 'index'} ${label}`} helperText={meterFieldInfo(key, resource).help} value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} slotProps={{ htmlInput: { inputMode: 'numeric' } }} /></Tooltip> : entry.config[key]}</TableCell>)}
    <TableCell>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        {editing ? <><Button onClick={save} disabled={busy || !writeAvailable}>Save</Button><Button onClick={() => { setEditing(false); setError(''); }} disabled={busy}>Cancel</Button></> : <Button onClick={startEdit} disabled={busy || !writeAvailable || (isRegister && fields.every(field => field.read_only))}>Edit</Button>}
        {!isRegister && !editing && resetAvailable && <Tooltip title="Remove rate configuration; meter marks every packet green." describeChild><span><Button disabled={busy || !writeAvailable} onClick={async () => { setError(''); try { await onWrite({ ...(direct ? { table_entry: entry.table_entry } : { index: entry.index }), config: null }); } catch (err) { setError(err.response?.data?.error || err.message); } }}>Reset</Button></span></Tooltip>}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </TableCell>
  </TableRow>;
}

export default function ResourceContent({ kind, resource, resourceName }) {
  const { currentSwitchID } = useSwitch();
  const identity = `${currentSwitchID}:${kind}:${resource.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const feedback = useAsyncFeedback(identity);
  const { begin, complete, fail, cancel } = feedback;
  const { initializedFiles } = useInit() || {};
  const registerAccess = kind === 'registers' ? initializedFiles?.register_access : null;
  const capability = initializedFiles?.capabilities?.[kind.replace('-', '_')];
  const declaredUnsupported = registerAccess?.status === 'unsupported' || capability?.read === false;
  const [fieldDefinitions, setFieldDefinitions] = useState(null);
  const displayedResource = fieldDefinitions ? { ...resource, fields: fieldDefinitions } : resource;
  const registerType = resource.type || registerFields(displayedResource)[0].type || {};
  const registerKind = registerType.kind === 'bytes' ? 'bit' : registerType.kind || 'bit';
  const [targetUnsupported, setTargetUnsupported] = useState(false);
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [radix, setRadix] = useState('10');
  const [indexFilter, setIndexFilter] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [total, setTotal] = useState(0);
  const key = kind === 'registers' ? 'register_id' : 'meter_id';
  const direct = kind === 'direct-meters';
  const load = useCallback(async (signal, { manual = false, report = true, propagate = false } = {}) => {
    if (currentSwitchID == null) return;
    const token = report ? begin('refresh', { quiet: !manual }) : null;
    if (declaredUnsupported) { setError(kind === 'registers' ? 'This switch does not support register access.' : 'This switch does not support reading this resource.'); setBusy(false); fail(token); return false; }
    try {
      setBusy(true); setError(''); setTargetUnsupported(false);
      if (indexFilter && !/^\d+$/.test(indexFilter)) throw new Error('Index must be a nonnegative integer.');
      const response = await axios.get(`/${kind}`, { params: { switch_id: currentSwitchID, [key]: resource.id, ...(!direct && (indexFilter ? { index: indexFilter } : { offset: page * rowsPerPage, limit: rowsPerPage })) }, signal, transformResponse: [parseLosslessJSON] });
      if (!signal?.aborted && currentIdentity.current === identity) { setFieldDefinitions(response.data.fields || null); setEntries(response.data.entries); setTotal(indexFilter ? response.data.entries.length : response.data.total ?? response.data.entries.length); complete(token); return true; }
      cancel(token); return false;
    } catch (err) {
      if (!signal?.aborted && !axios.isCancel(err) && currentIdentity.current === identity) { setError(err.response?.data?.error || err.message); setTargetUnsupported(err.response?.status === 501); fail(token); }
      else cancel(token);
      if (propagate) throw err;
      return false;
    } finally { if (!signal?.aborted && currentIdentity.current === identity) setBusy(false); }
  }, [currentSwitchID, kind, resource.id, key, indexFilter, direct, page, rowsPerPage, declaredUnsupported, identity, begin, complete, fail, cancel]);
  useEffect(() => { setEntries(null); setFieldDefinitions(null); setError(''); setBusy(false); }, [identity]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function write(entry) {
    if (capability?.write === false) return;
    const token = begin(entry.config === null ? 'reset' : 'save');
    let accepted = false;
    setBusy(true);
    try {
      await axios.patch(`/${kind}`, { switch_id: currentSwitchID, [key]: resource.id, entries: [entry] });
      accepted = true;
      if (currentIdentity.current !== identity) return;
      await load(undefined, { report: false, propagate: true });
      complete(token);
    } catch (failure) { fail(token, accepted ? `${entry.config === null ? 'Reset complete' : 'Saved'}; refresh failed` : undefined); throw failure; }
    finally { if (currentIdentity.current === identity) setBusy(false); }
  }
  const filtered = (entries || []).filter(entry => !indexFilter || String(entry.index) === indexFilter);
  const visible = direct ? filtered.slice(page * rowsPerPage, (page + 1) * rowsPerPage) : filtered;
  return <Box>
    <Typography variant="h5" gutterBottom sx={{ overflowWrap: 'anywhere' }}>{resourceName}</Typography>
    <Typography color="text.secondary" sx={{ mb: 2 }}>{kind === 'registers' ? `${registerFields(displayedResource).length > 1 ? `${registerFields(displayedResource).length} fields` : `${registerKind}<${registerType.bitwidth || resource.bitwidth || '?'}>`} · ${resource.size} cells` : `${direct ? 'Direct meter' : `${resource.size} meters`} · ${meterUnit(resource)}`}</Typography>
    {(declaredUnsupported || targetUnsupported) && <Alert severity="info" sx={{ mb: 2 }}>This resource operation is unavailable. Check the switch connection settings or select another resource.</Alert>}
    {capability?.write === false && !declaredUnsupported && <Alert severity="info" sx={{ mb: 2 }}>This resource is available for reading. Changes are unavailable on this switch.</Alert>}
    <Paper sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'flex-start', flexWrap: 'wrap' }} useFlexGap>
        <Button variant="contained" onClick={() => load(undefined, { manual: true })} disabled={busy || currentSwitchID == null}>{feedback.pending && feedback.action === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button>
        {!direct && <TextField label="Index" size="small" disabled={feedback.pending} value={indexFilter} onChange={event => { setIndexFilter(event.target.value); setPage(0); }} helperText="Leave empty for all entries" />}
        {kind === 'registers' && <TextField select label="Display" size="small" disabled={feedback.pending} value={radix} onChange={event => setRadix(event.target.value)} sx={{ minWidth: 140 }}>{[['10', 'Decimal'], ['16', 'Hexadecimal'], ['2', 'Binary']].map(([value, name]) => <MenuItem key={value} value={value}>{name}</MenuItem>)}</TextField>}
      </Stack>
      <AsyncFeedback feedback={feedback} sx={{ mb: 2 }} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {entries == null && busy && <CircularProgress aria-label="Loading resource" />}
      {entries && !entries.length && <Alert severity="info">{direct ? 'Add a table entry to configure its direct meter.' : 'No entries returned.'}</Alert>}
      {entries && entries.length > 0 && <>
        <TableContainer><Table size="small" aria-label={resourceName}>
          <TableHead><TableRow><TableCell>{direct ? 'Match fields' : 'Index'}</TableCell>{kind === 'registers' ? registerFields(displayedResource).map(field => <TableCell key={field.name}>{field.label || field.name}</TableCell>) : meterFields.map(([key, title]) => <TableCell key={key}><Tooltip title={meterFieldInfo(key, resource).description} describeChild><Box component="span" tabIndex={0} sx={{ textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{title} ({meterFieldInfo(key, resource).unit})</Box></Tooltip></TableCell>)}<TableCell>Actions</TableCell></TableRow></TableHead>
          <TableBody>{visible.map(entry => <ResourceRow key={direct ? JSON.stringify(entry.table_entry) : entry.index} entry={entry} kind={kind} resource={displayedResource} radix={radix} onWrite={write} busy={busy} writeAvailable={capability?.write !== false} resetAvailable={capability?.reset !== false && resource.reset !== false} />)}</TableBody>
        </Table></TableContainer>
        <TablePagination component="div" disabled={feedback.pending} count={total} page={page} onPageChange={(_, value) => setPage(value)} rowsPerPage={rowsPerPage} rowsPerPageOptions={[10, 25, 50, 100]} onRowsPerPageChange={event => { setRowsPerPage(Number(event.target.value)); setPage(0); }} />
      </>}
    </Paper>
  </Box>;
}
