import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useSwitch } from '../../Contexts/SwitchContext';
import { Alert, Button, Dialog, DialogContent, DialogTitle, Link, List, ListItem, ListItemText, Typography } from '@mui/material';

export default function VersionInfo() {
  const { switches = [] } = useSwitch();
  const [open, setOpen] = useState(false);
  const [backend, setBackend] = useState(null);
  const [netsim, setNetsim] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    let attempts = 0;
    async function loadVersion() {
      try {
        const res = await axios.get('/version', { signal: controller.signal, timeout: 5000 });
        if (controller.signal.aborted) return;
        setBackend(res.data);
        if (['checking', 'pending'].includes(res.data.update?.status) && attempts++ < 10) timer = setTimeout(loadVersion, 1500);
      } catch { /* Offline update checks never block application startup. */ }
    }
    loadVersion();
    axios.get('/netsim/version', { baseURL: '', signal: controller.signal, timeout: 5000 }).then(res => setNetsim(res.data)).catch(() => {});
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const update = backend?.update;
  const versions = [['Frontend', __APP_VERSION__], ['Backend', backend?.version], ['Network emulator', netsim?.version]];
  return <>
    <Button color="inherit" size="small" onClick={() => setOpen(true)} aria-label="Component versions">v{__APP_VERSION__}{update?.update_available ? ' · Update available' : ''}</Button>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>Component versions</DialogTitle>
      <DialogContent>
        {update?.update_available && <Alert severity="info">Version {update.latest_version} is available. <Link href={update.url || 'https://github.com/uni-tue-kn/UniCorn-P4'} target="_blank" rel="noopener noreferrer">View update</Link></Alert>}
        <List>{versions.map(([name, value]) => <ListItem key={name}><ListItemText primary={name} secondary={value || 'Unavailable'} /></ListItem>)}</List>
        {switches.length > 0 && <><Typography variant="subtitle2">Connected switches</Typography>{switches.map(switchInfo => <Typography variant="body2" key={switchInfo.device_id}>{switchInfo.name}: P4Runtime {switchInfo.p4runtime_api_version || 'Unavailable'}</Typography>)}</>}
        {[['Backend runtime', backend?.runtime], ['Emulator runtime', netsim?.runtime]].map(([name, runtime]) => runtime && <div key={name}><Typography variant="subtitle2">{name}</Typography>{Object.entries(runtime).map(([key, value]) => <Typography key={key} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</Typography>)}</div>)}
        {update && !update.update_available && <Typography variant="body2" color="text.secondary">{update.status === 'disabled' ? 'Update checks are disabled.' : update.status === 'error' || update.status === 'unavailable' ? 'Update check unavailable. You can continue using this installation.' : update.status === 'checking' ? 'Checking for updates…' : 'No newer release reported.'}</Typography>}
        <Button onClick={() => setOpen(false)} sx={{ mt: 2 }}>Close</Button>
      </DialogContent>
    </Dialog>
  </>;
}
