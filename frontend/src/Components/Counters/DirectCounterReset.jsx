import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, Tooltip } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useSwitch } from '../../Contexts/SwitchContext';
import AsyncFeedback, { useAsyncFeedback } from '../Helpers/AsyncFeedback';

export default function DirectCounterReset({ tableID, tableEntry = null, onReset, disabled = false, label = 'Reset counters' }) {
  const { currentSwitchID } = useSwitch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef(null);
  const entryKey = JSON.stringify([tableEntry?.table_name, tableEntry?.match_fields, tableEntry?.priority, tableEntry?.is_default_action]);
  const feedback = useAsyncFeedback(`${currentSwitchID}:${tableID}:${entryKey}`);
  useEffect(() => {
    setBusy(false); setError('');
    return () => controller.current?.abort();
  }, [currentSwitchID, tableID, entryKey]);
  async function reset() {
    controller.current?.abort();
    const requested = new AbortController();
    controller.current = requested;
    const token = feedback.begin('reset');
    let accepted = false;
    setBusy(true); setError('');
    try {
      await axios.patch('/direct-counters', { switch_id: currentSwitchID, table_id: tableID, table_entry: tableEntry, reset: true }, { signal: requested.signal });
      accepted = true;
      if (!requested.signal.aborted) { await onReset?.(); feedback.complete(token); } else feedback.cancel(token);
    } catch (failure) {
      if (!requested.signal.aborted) { setError(`${failure.response?.data?.error || failure.message}${failure.response?.data?.partial_write_possible ? ' Some entries may already have been reset. Refresh to check current values.' : ''}`); feedback.fail(token, accepted ? 'Reset complete; refresh failed' : undefined); } else feedback.cancel(token);
    } finally {
      if (!requested.signal.aborted) setBusy(false);
    }
  }
  return <Box><Tooltip title={tableEntry ? 'Set this entry’s direct counter to zero. Its match and action remain unchanged.' : 'Set this table’s direct counters to zero. Table entries and meter settings remain unchanged.'}><span><Button size="small" variant="outlined" color="inherit" startIcon={<RestartAltIcon />} disabled={disabled || busy || currentSwitchID == null} onClick={reset}>{busy ? 'Resetting…' : label}</Button></span></Tooltip><AsyncFeedback feedback={feedback} />{error && <Alert severity="error">{error}</Alert>}</Box>;
}
