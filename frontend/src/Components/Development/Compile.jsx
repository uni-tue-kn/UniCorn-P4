import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Alert, Box, Button, CircularProgress, FormControl, Grid, MenuItem, Paper, TextField, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { displayFile } from '../Helpers/DisplayHelper';

export function formatCompileCommand(command) {
  if (Array.isArray(command) && command.every(argument => typeof argument === 'string')) return command.join(' ');
  // Older servers return Python's repr(argv). Display it verbatim: replacing
  // quotes or parsing it as JSON corrupts valid filenames such as O'Brien.p4.
  return typeof command === 'string' ? command : '';
}

export function compileErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  for (const key of ['stderr', 'error', 'message']) {
    if (typeof data?.[key] === 'string' && data[key].trim()) return data[key];
  }
  if (data?.message && typeof data.message === 'object') {
    const messages = Object.values(data.message).filter(value => typeof value === 'string');
    if (messages.length) return messages.join('\n');
  }
  return error?.message || 'Compilation failed.';
}

export default function Compile() {
  const [consoleOutput, setConsoleOutput] = useState('');
  const [compilationSuccess, setCompilationSuccess] = useState(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const requested = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    axios.get('/p4src', { signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) setFiles(Array.isArray(response.data?.p4src) ? response.data.p4src.filter(file => typeof file === 'string') : []);
    }).catch(error => {
      if (!controller.signal.aborted) setFileError('Could not load P4 source files: ' + compileErrorMessage(error));
    });
    return () => { controller.abort(); requested.current?.abort(); };
  }, []);

  async function startCompile() {
    if (busy || !selectedFile) return;
    const controller = new AbortController();
    requested.current = controller;
    const introduction = `Compiling ${selectedFile}`;
    setBusy(true); setCompilationSuccess(null); setConsoleOutput(introduction + '\n…');
    try {
      const response = await axios.post('/compile', { file: selectedFile }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const command = formatCompileCommand(response.data?.command);
      const output = [introduction, command && `Command: ${command}`,
        typeof response.data?.stdout === 'string' && response.data.stdout,
        typeof response.data?.stderr === 'string' && response.data.stderr,
        'Success: Compilation completed.'].filter(Boolean);
      setConsoleOutput(output.join('\n')); setCompilationSuccess(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      const command = formatCompileCommand(error?.response?.data?.command);
      setConsoleOutput([introduction, command && `Command: ${command}`, `Error: ${compileErrorMessage(error)}`].filter(Boolean).join('\n'));
      setCompilationSuccess(false);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <Box id="Compilation">
    <Grid container spacing={{ xs: 2, lg: 3 }}><Grid size={{ xs: 12, lg: 6, xl: 5 }}>
      <Paper sx={{ p: { xs: 2, md: 4 }, minHeight: 500 }} elevation={3}>
        <Typography variant="h6" sx={{ mb: 2 }}>Compile a P4 program</Typography>
        {fileError && <Alert severity="error" sx={{ mb: 2 }}>{fileError}</Alert>}
        <FormControl fullWidth sx={{ mb: 2 }}><TextField select label="P4 source file" value={selectedFile}
          disabled={busy} required onChange={event => { setSelectedFile(event.target.value); setCompilationSuccess(null); }}
          helperText="Select a P4 source file to compile." size="small">
          {files.length ? files.map(file => <MenuItem key={file} value={file}>{displayFile(file)}</MenuItem>) : <MenuItem disabled>No P4 source file found</MenuItem>}
        </TextField></FormControl>
        <Button fullWidth variant="contained" endIcon={busy ? <CircularProgress size={18} color="inherit" aria-hidden="true" /> : <DownloadIcon />}
          disabled={busy || !selectedFile} onClick={startCompile}>{busy ? 'Compiling…' : 'Compile'}</Button>
        <TextField fullWidth label="Compiler output" multiline minRows={8} value={consoleOutput} variant="outlined" margin="normal"
          slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace' } } }} />
        <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 32 }}>
          {compilationSuccess === true && <CheckCircleIcon color="success" />}
          {compilationSuccess === false && <CancelIcon color="error" />}
          <Typography variant="body2">{busy ? 'Compiling…' : compilationSuccess === true ? 'Compilation completed' : compilationSuccess === false ? 'Compilation failed' : ''}</Typography>
        </Box>
      </Paper>
    </Grid></Grid>
  </Box>;
}
