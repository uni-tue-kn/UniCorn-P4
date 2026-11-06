import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SettingsIcon from '@mui/icons-material/Settings';
import DownloadIcon from '@mui/icons-material/Download';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import { useInit } from '../../Contexts/InitContext';
import { useSwitch } from '../../Contexts/SwitchContext';
import SaveStateDialog from '../SwitchStates/Dialogs/SaveStateDialog';

const emptyFiles = () => ({ p4_info: '', bmv2: '' });
const pairedFiles = program => ({ p4_info: program.p4_info || '', bmv2: program.bmv2 || '', ...(program.build_manifest ? { program_id: program.id } : {}) });
const manifestID = value => typeof value === 'string' ? value : value?.build_manifest || value?.id;
const findProgram = (programs, files) => programs.find(program => files.program_id ? program.id === files.program_id : files.program_manifest ? program.id === manifestID(files.program_manifest) || program.build_manifest === manifestID(files.program_manifest) : files.p4_info && files.bmv2 && program.p4_info === files.p4_info && program.bmv2 === files.bmv2);

export default function Initialization() {
  const { initializedFiles, initialize } = useInit();
  const { currentSwitchID } = useSwitch();
  const readOnly = initializedFiles?.read_only === true || initializedFiles?.capabilities?.pipeline?.write === false;
  const [fileNames, setFileNames] = useState({ p4_info: [], bmv2: [], programs: [] });
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState(emptyFiles);
  const [keepEntries, setKeepEntries] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const filesRequest = useRef(0);
  const target = useRef(currentSwitchID);
  target.current = currentSwitchID;

  async function refreshFiles(preferredFiles = null) {
    const request = ++filesRequest.current;
    setLoading(true);
    try {
      const response = await axios.get('/p4files', { params: { switch_id: currentSwitchID } });
      if (request !== filesRequest.current) return;
      const names = { p4_info: [], bmv2: [], programs: [], ...response.data };
      setFileNames(names);
      if (preferredFiles) {
        const hasExisting = preferredFiles.program_id || preferredFiles.program_manifest || preferredFiles.p4_info || preferredFiles.bmv2;
        setSelectedFiles(hasExisting ? preferredFiles : names.programs.length === 1 ? pairedFiles(names.programs[0]) : emptyFiles());
        setAdvanced(Boolean(hasExisting && !preferredFiles.program_manifest && !findProgram(names.programs, preferredFiles)));
      }
    } catch (failure) {
      if (request === filesRequest.current) setError(failure.response?.data?.error || 'Could not load program files.');
    } finally {
      if (request === filesRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    setEditing(false); setAdvanced(false); setSelectedFiles(emptyFiles()); setKeepEntries(false); setBusy(false); setError('');
    refreshFiles();
    return () => { filesRequest.current++; };
  }, [currentSwitchID]);

  // Initializing from history or a saved state also closes this editor.
  useEffect(() => { setEditing(false); }, [initializedFiles?.state_id]);

  function openEditor() {
    const previous = { p4_info: initializedFiles?.p4_info_file || '', bmv2: initializedFiles?.bmv2_file || '', program_manifest: initializedFiles?.program_manifest };
    setSelectedFiles(previous); setKeepEntries(false); setAdvanced(false); setError(''); setEditing(true);
    refreshFiles(previous);
  }

  async function newInit(event) {
    if (readOnly) { event.preventDefault(); return; }
    const requestedSwitch = currentSwitchID;
    setBusy(true); setError('');
    try {
      const program = findProgram(fileNames.programs, selectedFiles);
      const succeeded = await initialize(event, program?.build_manifest ? program : selectedFiles.p4_info, program?.build_manifest ? null : selectedFiles.bmv2, keepEntries && initializedFiles?.capabilities?.pipeline?.keep_entries !== false);
      if (target.current !== requestedSwitch) return;
      if (succeeded) setEditing(false);
      else setError('Initialization failed. Check the selected program or files and try again.');
    } catch (failure) {
      if (target.current === requestedSwitch) setError(failure.message || 'Initialization failed.');
    } finally {
      if (target.current === requestedSwitch) setBusy(false);
    }
  }

  const selectedProgram = findProgram(fileNames.programs, selectedFiles);
  const currentProgram = findProgram(fileNames.programs, { p4_info: initializedFiles?.p4_info_file, bmv2: initializedFiles?.bmv2_file, program_manifest: initializedFiles?.program_manifest });
  const manualOptions = kind => [...new Set([...fileNames[kind], ...(selectedFiles[kind] ? [selectedFiles[kind]] : [])])];
  return <Box id="Dashboard Initialization">
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography color="primary.text" variant="h6">Initialization</Typography>
        <Tooltip title="Takes a snapshot of the current state and saves it as a new state"><span><Button disabled={initializedFiles?.p4_info_file == null && !initializedFiles?.program_manifest} size="small" variant="contained" endIcon={<LibraryAddIcon />} onClick={() => setSaveOpen(true)}>Save state</Button></span></Tooltip>
      </Stack>
      {readOnly && <Alert severity="info">Read-only connection. The active program is discovered automatically; initialization and switch changes are disabled.</Alert>}
      {editing && !readOnly ? <Paper sx={{ p: { xs: 2, md: 3 } }}>
        <Stack spacing={2}>
          <TextField select fullWidth label="Compiled program" value={selectedProgram?.id || ''} disabled={loading || busy} size="small" onChange={event => {
            const program = fileNames.programs.find(item => item.id === event.target.value);
            if (program) setSelectedFiles(pairedFiles(program));
          }} helperText={loading ? 'Loading programs…' : selectedProgram ? 'The compiled program is selected.' : selectedFiles.p4_info && selectedFiles.bmv2 ? 'Custom files selected in Advanced.' : 'Compile a program or select files in Advanced.'}>
            {fileNames.programs.map(program => <MenuItem key={program.id} value={program.id}>{program.name}{program.target === 'tofino' ? ` · ${program.architecture === 'tofino2' ? 'Tofino 2' : 'Tofino 1'}` : ''}</MenuItem>)}
            {!fileNames.programs.length && <MenuItem disabled value="">No compiled programs found</MenuItem>}
          </TextField>
          {selectedProgram?.target !== 'tofino' && initializedFiles?.target !== 'tofino' && <Accordion expanded={advanced} onChange={(_, expanded) => setAdvanced(expanded)}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>Advanced</AccordionSummary>
            <AccordionDetails><Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">Choose files separately for custom builds. Both files must describe the same P4 program.</Typography>
              {[['p4_info', 'P4Info file'], ['bmv2', 'BMv2 JSON file']].map(([kind, label]) => <TextField key={kind} select fullWidth size="small" label={label} value={selectedFiles[kind]} disabled={loading || busy} onChange={event => setSelectedFiles(previous => ({ ...previous, [kind]: event.target.value, program_id: undefined, program_manifest: undefined }))}>
                {manualOptions(kind).map(file => <MenuItem key={file} value={file}>{file}</MenuItem>)}
                {!manualOptions(kind).length && <MenuItem disabled value="">No files found</MenuItem>}
              </TextField>)}
            </Stack></AccordionDetails>
          </Accordion>}
          {initializedFiles?.table_info != null && <FormControlLabel control={<Checkbox checked={keepEntries && initializedFiles?.capabilities?.pipeline?.keep_entries !== false} disabled={busy || initializedFiles?.capabilities?.pipeline?.keep_entries === false} onChange={event => setKeepEntries(event.target.checked)} />} label="Keep existing entries" />}
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction="row" spacing={1}>
            <Button fullWidth variant="outlined" disabled={busy} onClick={() => { filesRequest.current++; setLoading(false); setEditing(false); }}>Cancel</Button>
            <Button fullWidth variant="contained" endIcon={<DownloadIcon />} disabled={loading || busy || (!selectedProgram && (!selectedFiles.p4_info || !selectedFiles.bmv2))} onClick={newInit}>{busy ? 'Initializing…' : 'Initialize'}</Button>
          </Stack>
        </Stack>
      </Paper> : <>
        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          {initializedFiles?.program_name || initializedFiles?.program_manifest || initializedFiles?.p4_info_file || initializedFiles?.bmv2_file ? <Stack spacing={1}>
            <Typography variant="subtitle2">Current program</Typography>
            <Typography>{currentProgram?.name || initializedFiles?.program_name || initializedFiles?.program_manifest?.program_name || 'Custom program'}</Typography>
            {initializedFiles?.target !== 'tofino' && !initializedFiles?.program_manifest && <Accordion><AccordionSummary expandIcon={<ExpandMoreIcon />}>Program files</AccordionSummary><AccordionDetails>
              {[['P4Info', initializedFiles?.p4_info_file], ['BMv2 JSON', initializedFiles?.bmv2_file]].map(([label, file]) => <Typography key={label} variant="body2" sx={{ overflowWrap: 'anywhere' }}>{label}: {file || 'Unavailable'}</Typography>)}
            </AccordionDetails></Accordion>}
          </Stack> : initializedFiles?.table_info != null ? <Alert severity="info">{readOnly ? 'The active program resources are available for reading.' : 'Another controller already installed a P4 program on this switch. Its resources are available. Select a compiled program to save its initialization state.'}</Alert> : <Typography color="text.secondary">No P4 program has been initialized.</Typography>}
        </Paper>
        <Button variant="contained" endIcon={<SettingsIcon />} disabled={readOnly} onClick={openEditor}>Edit initialization</Button>
      </>}
    </Stack>
    {initializedFiles != null && <SaveStateDialog open={saveOpen} setOpen={setSaveOpen} />}
  </Box>;
}
