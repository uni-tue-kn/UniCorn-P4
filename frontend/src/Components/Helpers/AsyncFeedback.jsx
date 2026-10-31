import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

const labels = {
  refresh: ['Refreshing…', 'Refreshed', 'Refresh failed'],
  save: ['Saving…', 'Saved', 'Save failed'],
  reset: ['Resetting…', 'Reset complete', 'Reset failed'],
  delete: ['Deleting…', 'Deleted', 'Delete failed'],
  disable: ['Disabling…', 'Disable complete', 'Disable failed'],
  clear: ['Clearing…', 'Cleared', 'Clear failed'],
  export: ['Exporting network…', 'Network exported', 'Network export failed'],
  import: ['Validating network…', 'Network bundle validated', 'Network validation failed'],
  deploy: ['Importing network…', 'Network imported', 'Network import failed'],
};
const initial = () => ({ pending: false, action: null, message: '', failed: false, lastUpdated: null });

export function useAsyncFeedback(identity) {
  const [state, setState] = useState(initial);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const active = useRef(null);
  useEffect(() => { active.current = null; setState(initial()); }, [identity]);
  const begin = useCallback((action = 'refresh', { quiet = false } = {}) => {
    const token = { identity: currentIdentity.current, action, quiet };
    if (!quiet) {
      active.current = token;
      setState(previous => ({ ...previous, pending: true, action, message: labels[action][0], failed: false }));
    }
    return token;
  }, []);
  const complete = useCallback(token => {
    if (!token || token.identity !== currentIdentity.current || (!token.quiet && active.current !== token)) return;
    const lastUpdated = new Date().toISOString();
    setState(previous => token.quiet ? { ...previous, lastUpdated } :
      { pending: false, action: token.action, message: labels[token.action][1], failed: false, lastUpdated });
    if (!token.quiet) active.current = null;
  }, []);
  const fail = useCallback((token, message) => {
    if (!token || token.quiet || token.identity !== currentIdentity.current || active.current !== token) return;
    active.current = null;
    setState(previous => ({ ...previous, pending: false, action: token.action,
      message: message || labels[token.action][2], failed: true }));
  }, []);
  const cancel = useCallback(token => {
    if (!token || token.quiet || token.identity !== currentIdentity.current || active.current !== token) return;
    active.current = null;
    setState(previous => ({ ...previous, pending: false, action: null, message: '', failed: false }));
  }, []);
  return { ...state, begin, complete, fail, cancel };
}

export default function AsyncFeedback({ feedback, sx }) {
  return <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minHeight: feedback.message || feedback.lastUpdated ? 24 : 0, ...sx }}>
    <Box role="status" aria-live="polite" aria-atomic="true" sx={{ display: 'flex', alignItems: 'center', gap: 1, color: feedback.failed ? 'error.main' : 'text.primary' }}>
      {feedback.pending && <CircularProgress size={16} aria-hidden="true" />}
      <Typography component="span" variant="body2">{feedback.message}</Typography>
    </Box>
    {feedback.lastUpdated && <Typography component="span" variant="caption" color="text.secondary" aria-live="off">Last updated: <time dateTime={feedback.lastUpdated} title={feedback.lastUpdated}>{new Date(feedback.lastUpdated).toLocaleTimeString()}</time></Typography>}
  </Stack>;
}
