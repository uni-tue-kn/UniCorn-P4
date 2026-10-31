import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

function unsigned(value, label, maximum, minimum = 0) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) < BigInt(minimum) || BigInt(value) > BigInt(maximum)) throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  return Number(value);
}
export function validateGroup(draft) {
  const multicast_group_id = unsigned(draft.multicast_group_id, 'Group ID', 65535, 1);
  if (!Array.isArray(draft.replicas) || draft.replicas.length > 256) throw new Error('A group supports up to 256 replicas.');
  const replicas = draft.replicas.map(row => ({ egress_port: String(unsigned(row.egress_port, 'Egress port', 4294967295, 1)), instance: unsigned(row.instance, 'Instance', 65535) }));
  if (new Set(replicas.map(row => `${row.egress_port}:${row.instance}`)).size !== replicas.length) throw new Error('Each egress port and instance pair must be unique.');
  return { multicast_group_id, replicas };
}

export default function MulticastContent() {
  const { currentSwitchID } = useSwitch();
  const feedback = useAsyncFeedback(currentSwitchID);
  const { begin, complete, fail, cancel } = feedback;
  const currentID = useRef(currentSwitchID);
  currentID.current = currentSwitchID;
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteGroup, setDeleteGroup] = useState(null);
  const load = useCallback(async (signal, manual = false) => {
    if (currentSwitchID == null) return;
    const token = begin('refresh', { quiet: !manual });
    try {
      setBusy(true); setError('');
      const response = await axios.get('/multicast-groups', { params: { switch_id: currentSwitchID }, signal });
      if (!signal?.aborted && currentID.current === currentSwitchID) { setGroups(response.data.entries); complete(token); return true; }
      cancel(token); return false;
    } catch (err) {
      if (!signal?.aborted && !axios.isCancel(err) && currentID.current === currentSwitchID) { setError(err.response?.data?.error || err.message); fail(token); } else cancel(token);
      return false;
    } finally { if (!signal?.aborted && currentID.current === currentSwitchID) setBusy(false); }
  }, [currentSwitchID, begin, complete, fail, cancel]);
  useEffect(() => {
    setGroups(null); setEditor(null); setDeleteGroup(null); setError(''); setBusy(false);
    const controller = new AbortController(); load(controller.signal);
    return () => controller.abort();
  }, [load]);
  function openEditor(group) {
    setEditing(Boolean(group)); setFormError('');
    setEditor(group ? { multicast_group_id: String(group.multicast_group_id), replicas: group.replicas.map(row => ({ egress_port: String(row.egress_port), instance: String(row.instance) })) }
      : { multicast_group_id: '', replicas: [{ egress_port: '', instance: '0' }] });
  }
  async function save(event) {
    event.preventDefault();
    const id = currentSwitchID;
    let token;
    try {
      const group = validateGroup(editor);
      token = begin('save');
      setBusy(true); setFormError('');
      await axios[editing ? 'patch' : 'post']('/multicast-groups', { switch_id: id, ...group });
      if (currentID.current === id) { setEditor(null); if (await load()) complete(token); else fail(token, 'Saved; refresh failed'); }
    } catch (err) { if (currentID.current === id) { setFormError(err.response?.data?.error || err.message); fail(token); } }
    finally { if (currentID.current === id) setBusy(false); }
  }
  async function remove() {
    const id = currentSwitchID;
    const token = begin('delete');
    try {
      setBusy(true);
      await axios.delete('/multicast-groups', { data: { switch_id: id, multicast_group_id: deleteGroup } });
      if (currentID.current === id) { setDeleteGroup(null); if (await load()) complete(token); else fail(token, 'Deleted; refresh failed'); }
    } catch (err) { if (currentID.current === id) { setError(err.response?.data?.error || err.message); fail(token); } }
    finally { if (currentID.current === id) setBusy(false); }
  }
  function setReplica(index, field, value) { setEditor(previous => ({ ...previous, replicas: previous.replicas.map((row, i) => i === index ? { ...row, [field]: value } : row) })); }
  return <Box>
    <Typography variant="h5" gutterBottom>Multicast groups</Typography>
    <Typography sx={{ mb: 2 }} color="text.secondary">Replicate packets to a group of switch ports. The P4 program selects the group through its multicast metadata.</Typography>
    <Paper sx={{ p: 3 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}><Button variant="contained" onClick={() => openEditor(null)} disabled={busy || currentSwitchID == null}>Add multicast group</Button><Button onClick={() => load(undefined, true)} disabled={busy || currentSwitchID == null}>{feedback.pending && feedback.action === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button></Stack>
      {!editor && deleteGroup == null && <AsyncFeedback feedback={feedback} sx={{ mb: 2 }} />}
      {error && <Alert severity="error">{error}</Alert>}
      {groups == null && busy && <CircularProgress aria-label="Loading multicast groups" />}
      {groups?.length === 0 && <Typography>No multicast groups configured.</Typography>}
      {groups?.length > 0 && <TableContainer><Table aria-label="Multicast groups"><TableHead><TableRow><TableCell>Group ID</TableCell><TableCell>Replicas (port / instance)</TableCell><TableCell>Actions</TableCell></TableRow></TableHead><TableBody>{groups.map(group => <TableRow key={group.multicast_group_id} data-testid={`multicast-group-${group.multicast_group_id}`}><TableCell>{group.multicast_group_id}</TableCell><TableCell>{group.replicas.map(row => `${row.egress_port} / ${row.instance}`).join(', ') || 'None'}</TableCell><TableCell><Button disabled={busy} onClick={() => openEditor(group)}>Edit</Button><Button disabled={busy} onClick={() => setDeleteGroup(group.multicast_group_id)}>Delete</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>}
    </Paper>
    <Dialog open={editor != null} onClose={() => !busy && setEditor(null)} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? 'Edit multicast group' : 'Add multicast group'}</DialogTitle>
      {editor && <form onSubmit={save}><DialogContent><Stack spacing={2}>
        <AsyncFeedback feedback={feedback} />
        {formError && <Alert severity="error">{formError}</Alert>}
        <TextField label="Group ID" required value={editor.multicast_group_id} disabled={editing || busy} onChange={event => setEditor(previous => ({ ...previous, multicast_group_id: event.target.value }))} helperText="1–65535" />
        <Typography variant="subtitle2">Replicas</Typography>
        <Typography color="text.secondary" variant="body2">An empty group sends no packet copies.</Typography>
        {editor.replicas.map((row, index) => <Stack key={index} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}><TextField label={`Egress port ${index + 1}`} required value={row.egress_port} disabled={busy} onChange={event => setReplica(index, 'egress_port', event.target.value)} /><TextField label={`Instance ${index + 1}`} required value={row.instance} disabled={busy} onChange={event => setReplica(index, 'instance', event.target.value)} /><Button disabled={busy} aria-label={`Remove replica ${index + 1}`} onClick={() => setEditor(previous => ({ ...previous, replicas: previous.replicas.filter((_, i) => i !== index) }))}>Remove</Button></Stack>)}
        <Button disabled={busy || editor.replicas.length >= 256} onClick={() => setEditor(previous => ({ ...previous, replicas: [...previous.replicas, { egress_port: '', instance: '0' }] }))}>Add replica</Button>
      </Stack></DialogContent><DialogActions><Button onClick={() => setEditor(null)} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{feedback.pending && feedback.action === 'save' ? 'Saving…' : 'Save group'}</Button></DialogActions></form>}
    </Dialog>
    <Dialog open={deleteGroup != null} onClose={() => !busy && setDeleteGroup(null)}><DialogTitle>Delete multicast group</DialogTitle><DialogContent>Delete group {deleteGroup}? Packets using this group will no longer be replicated.<AsyncFeedback feedback={feedback} /></DialogContent><DialogActions><Button onClick={() => setDeleteGroup(null)} disabled={busy}>Cancel</Button><Button onClick={remove} disabled={busy}>{feedback.pending && feedback.action === 'delete' ? 'Deleting…' : 'Confirm delete'}</Button></DialogActions></Dialog>
  </Box>;
}
