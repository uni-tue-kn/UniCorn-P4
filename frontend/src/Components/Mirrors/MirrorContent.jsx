import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useSwitch } from '../../Contexts/SwitchContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

const blankSession = () => ({ session_id: '', replicas: [{ egress_port: '', instance: '0' }], class_of_service: '0', packet_length_bytes: '0' });
function unsigned(value, label, maximum, minimum = 0) {
  if (!/^\d+$/.test(String(value)) || BigInt(value) < BigInt(minimum) || BigInt(value) > BigInt(maximum)) throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  return Number(value);
}
export function validateSession(draft) {
  const session_id = unsigned(draft.session_id, 'Session ID', 32767, 1);
  const replicas = draft.replicas.map(row => ({ egress_port: String(unsigned(row.egress_port, 'Egress port', 4294967295)), instance: unsigned(row.instance, 'Instance', 65535) }));
  if (new Set(replicas.map(row => `${row.egress_port}:${row.instance}`)).size !== replicas.length) throw new Error('Each egress port and instance pair must be unique.');
  return { session_id, replicas, class_of_service: unsigned(draft.class_of_service, 'Class of service', 255), packet_length_bytes: unsigned(draft.packet_length_bytes, 'Packet length', 65535) };
}

export default function MirrorContent() {
  const { currentSwitchID } = useSwitch();
  const currentID = useRef(currentSwitchID);
  currentID.current = currentSwitchID;
  const feedback = useAsyncFeedback(currentSwitchID);
  const { begin, complete, fail, cancel } = feedback;
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteSession, setDeleteSession] = useState(null);
  const load = useCallback(async (signal, manual = false) => {
    if (currentSwitchID == null) return;
    const token = begin('refresh', { quiet: !manual });
    try {
      setBusy(true); setError('');
      const response = await axios.get('/mirrors', { params: { switch_id: currentSwitchID }, signal });
      if (!signal?.aborted && currentID.current === currentSwitchID) { setSessions(response.data.entries); complete(token); return true; }
      cancel(token); return false;
    } catch (err) { if (!signal?.aborted && !axios.isCancel(err) && currentID.current === currentSwitchID) { setError(err.response?.data?.error || err.message); fail(token); } else cancel(token); return false; }
    finally { if (!signal?.aborted && currentID.current === currentSwitchID) setBusy(false); }
  }, [currentSwitchID, begin, complete, fail, cancel]);
  useEffect(() => {
    setSessions(null); setEditor(null); setDeleteSession(null); setBusy(false); setError('');
    const controller = new AbortController(); load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const openEditor = session => {
    setEditing(Boolean(session)); setFormError('');
    setEditor(session ? { session_id: String(session.session_id), replicas: session.replicas.map(row => ({ egress_port: String(row.egress_port), instance: String(row.instance) })), class_of_service: String(session.class_of_service), packet_length_bytes: String(session.packet_length_bytes) } : blankSession());
  };
  async function save(event) {
    event.preventDefault();
    let token;
    const id = currentSwitchID;
    try {
      const session = validateSession(editor);
      token = begin('save');
      setBusy(true); setFormError('');
      await axios[editing ? 'patch' : 'post']('/mirrors', { switch_id: currentSwitchID, ...session });
      if (currentID.current === id) { setEditor(null); if (await load()) complete(token); else fail(token, 'Saved; refresh failed'); }
    } catch (err) { if (currentID.current === id) { setFormError(err.response?.data?.error || err.message); fail(token); } }
    finally { if (currentID.current === id) setBusy(false); }
  }
  async function remove() {
    const token = begin('delete');
    const id = currentSwitchID;
    try {
      setBusy(true);
      await axios.delete('/mirrors', { data: { switch_id: currentSwitchID, session_id: deleteSession } });
      if (currentID.current === id) { setDeleteSession(null); if (await load()) complete(token); else fail(token, 'Deleted; refresh failed'); }
    } catch (err) { if (currentID.current === id) { setError(err.response?.data?.error || err.message); fail(token); } }
    finally { if (currentID.current === id) setBusy(false); }
  }
  function setReplica(index, field, value) { setEditor(previous => ({ ...previous, replicas: previous.replicas.map((row, i) => i === index ? { ...row, [field]: value } : row) })); }
  return <Box>
    <Typography variant="h5" gutterBottom>Mirrors</Typography>
    <Typography sx={{ mb: 2 }} color="text.secondary">Clone sessions copy packets to one or more switch ports. The P4 program selects the session ID when cloning a packet.</Typography>
    <Alert severity="info" sx={{ mb: 2 }}>A mirror session configures where packet copies go. Configuration alone does not mirror traffic: the P4 program must call clone or clone3 with the same session ID. Original forwarding is still decided by the program. For example, session 10 with port 3 sends a copy to port 3 when the program clones to session 10.</Alert>
    <Paper sx={{ p: 3 }}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}><Button variant="contained" onClick={() => openEditor(null)} disabled={busy || currentSwitchID == null}>Add mirror session</Button><Button onClick={() => load(undefined, true)} disabled={busy || currentSwitchID == null}>{feedback.pending && feedback.action === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button></Stack>
      {!editor && deleteSession == null && <AsyncFeedback feedback={feedback} sx={{ mb: 2 }} />}
      {error && <Alert severity="error">{error}</Alert>}
      {sessions == null && busy && <CircularProgress aria-label="Loading mirror sessions" />}
      {sessions?.length === 0 && <Typography>No mirror sessions configured.</Typography>}
      {sessions?.length > 0 && <TableContainer><Table aria-label="Mirror sessions"><TableHead><TableRow>{['Session ID', 'Replicas (port / instance)', 'Class of service', 'Packet length', 'Actions'].map(title => <TableCell key={title}>{title}</TableCell>)}</TableRow></TableHead><TableBody>{sessions.map(session => <TableRow key={session.session_id} data-testid={`mirror-session-${session.session_id}`}><TableCell>{session.session_id}</TableCell><TableCell>{session.replicas.map(row => `${row.egress_port} / ${row.instance}`).join(', ') || 'None'}</TableCell><TableCell>{session.class_of_service}</TableCell><TableCell>{session.packet_length_bytes || 'Full packet'}</TableCell><TableCell><Button disabled={busy} onClick={() => openEditor(session)}>Edit</Button><Button disabled={busy} onClick={() => setDeleteSession(session.session_id)}>Delete</Button></TableCell></TableRow>)}</TableBody></Table></TableContainer>}
    </Paper>
    <Dialog open={editor != null} onClose={() => !busy && setEditor(null)} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? 'Edit mirror session' : 'Add mirror session'}</DialogTitle>
      {editor && <form onSubmit={save}><DialogContent><Stack spacing={2}>
        <AsyncFeedback feedback={feedback} />
        {formError && <Alert severity="error">{formError}</Alert>}
        <TextField label="Session ID" required value={editor.session_id} disabled={editing || busy} onChange={event => setEditor(previous => ({ ...previous, session_id: event.target.value }))} helperText="1–32767; the P4 clone call must use this same ID" />
        <Typography variant="subtitle2">Replicas</Typography>
        {editor.replicas.map((row, index) => <Stack key={index} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}><TextField label={`Egress port ${index + 1}`} required value={row.egress_port} disabled={busy} helperText="Switch output port for the copy" onChange={event => setReplica(index, 'egress_port', event.target.value)} /><TextField label={`Instance ${index + 1}`} required value={row.instance} disabled={busy} helperText="Usually 0; copy ID exposed as egress_rid" onChange={event => setReplica(index, 'instance', event.target.value)} /><Button disabled={busy} aria-label={`Remove replica ${index + 1}`} onClick={() => setEditor(previous => ({ ...previous, replicas: previous.replicas.filter((_, i) => i !== index) }))}>Remove</Button></Stack>)}
        <Button disabled={busy} onClick={() => setEditor(previous => ({ ...previous, replicas: [...previous.replicas, { egress_port: '', instance: '0' }] }))}>Add replica</Button>
        <TextField label="Class of service" required disabled={busy} value={editor.class_of_service} onChange={event => setEditor(previous => ({ ...previous, class_of_service: event.target.value }))} helperText="0 is the default; other values require target support (0–255)" />
        <TextField label="Packet length" required disabled={busy} value={editor.packet_length_bytes} onChange={event => setEditor(previous => ({ ...previous, packet_length_bytes: event.target.value }))} helperText="0 copies the full packet; nonzero truncates to this many bytes if supported. Target errors are shown." />
      </Stack></DialogContent><DialogActions><Button onClick={() => setEditor(null)} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{feedback.pending && feedback.action === 'save' ? 'Saving…' : 'Save session'}</Button></DialogActions></form>}
    </Dialog>
    <Dialog open={deleteSession != null} onClose={() => !busy && setDeleteSession(null)}><DialogTitle>Delete mirror session</DialogTitle><DialogContent>Delete session {deleteSession}? Packets using this session will no longer be mirrored.<AsyncFeedback feedback={feedback} /></DialogContent><DialogActions><Button onClick={() => setDeleteSession(null)} disabled={busy}>Cancel</Button><Button onClick={remove} disabled={busy}>{feedback.pending && feedback.action === 'delete' ? 'Deleting…' : 'Confirm delete'}</Button></DialogActions></Dialog>
  </Box>;
}
