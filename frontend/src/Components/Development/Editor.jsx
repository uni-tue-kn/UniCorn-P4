import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Paper, Stack, Tab, Tabs, TextField, Tooltip, Typography, useMediaQuery } from '@mui/material';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import NoteAddOutlinedIcon from '@mui/icons-material/NoteAddOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CloseIcon from '@mui/icons-material/Close';
import CodeIcon from '@mui/icons-material/Code';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useEditor } from '../../Contexts/EditorContext';
import MonacoEditor from './MonacoEditor';

function tree(files) {
  const root = { children: new Map() };
  for (const file of files) {
    let node = root, path = '';
    const parts = file.path.split('/');
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map() });
      node = node.children.get(part);
      if (index === parts.length - 1) node.file = file;
    });
  }
  return root;
}
function Files({ files, activePath, dirty, openFile, busy, filter }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const root = useMemo(() => tree(files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()))), [files, filter]);
  function children(node, depth = 0) {
    return [...node.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name)).map(item => {
      const expanded = Boolean(filter) || !collapsed.has(item.path);
      return item.file ? <ListItemButton component="button" key={item.path} disabled={busy} selected={activePath === item.path} aria-label={`Open ${item.path}`} title={item.path}
        onClick={() => openFile(item.path)} sx={{ width: '100%', pl: 1.5 + depth * 1.5, py: 0.25, minHeight: 32 }}>
        <ListItemIcon sx={{ minWidth: 28 }}>{item.path.endsWith('.p4') ? <CodeIcon fontSize="small" /> : <DescriptionOutlinedIcon fontSize="small" />}</ListItemIcon>
        <ListItemText primary={item.name + (dirty.includes(item.path) ? ' •' : '')} slotProps={{ primary: { fontSize: 12, noWrap: true } }} />
        {item.file.read_only && <Typography variant="caption" sx={{ ml: 0.5 }} color="text.secondary">R</Typography>}
      </ListItemButton> : <React.Fragment key={item.path}>
        <ListItemButton component="button" aria-label={`Folder ${item.path}`} aria-expanded={expanded} onClick={() => setCollapsed(previous => {
          const next = new Set(previous); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next;
        })} sx={{ width: '100%', pl: 1.5 + depth * 1.5, py: 0.25, minHeight: 32 }}>
          <ListItemIcon sx={{ minWidth: 28 }}>{expanded ? <FolderOpenOutlinedIcon fontSize="small" /> : <FolderOutlinedIcon fontSize="small" />}</ListItemIcon>
          <ListItemText primary={item.name} slotProps={{ primary: { fontSize: 12, noWrap: true } }} />
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </ListItemButton>
        {expanded && children(item, depth + 1)}
      </React.Fragment>;
    });
  }
  return <List dense aria-label="Workspace files" sx={{ py: 0.5 }}>{children(root)}</List>;
}

export default function Editor() {
  const workspace = useEditor();
  const desktop = useMediaQuery('(min-width:900px)');
  const [filesOpen, setFilesOpen] = useState(desktop);
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState(null);
  const [filename, setFilename] = useState('');
  const [panel, setPanel] = useState('output');
  const [outputOpen, setOutputOpen] = useState(true);
  const [languageStatus, setLanguageStatus] = useState({ state: 'connecting' });
  const [reconnect, setReconnect] = useState(0);
  const [languageProblems, setLanguageProblems] = useState({});
  const [reveal, setReveal] = useState(null);
  const documents = useMemo(() => workspace.order.map(path => workspace.documents[path]), [workspace.order, workspace.documents]);
  const active = workspace.documents[workspace.activePath];
  const sources = workspace.files.filter(file => file.path.endsWith('.p4') && !file.read_only);
  useEffect(() => { workspace.refresh(); }, [workspace.refresh]);
  const receiveDiagnostics = useCallback(params => setLanguageProblems(previous => ({ ...previous, [params.uri]: params.diagnostics || [] })), []);
  const syntaxProblems = useMemo(() => Object.entries(languageProblems).flatMap(([uri, diagnostics]) => {
    let absolute;
    try { absolute = decodeURIComponent(new URL(uri).pathname); } catch { return []; }
    if (!absolute.startsWith(workspace.root + '/')) return [];
    const path = absolute.slice(workspace.root.length + 1);
    if (!workspace.documents[path]) return [];
    return diagnostics.map(item => ({ path, line: item.range.start.line + 1, column: item.range.start.character + 1,
      severity: item.severity === 2 ? 'warning' : 'error', message: item.message, source: 'P4 language server' }));
  }), [languageProblems, workspace.root, workspace.documents]);
  const problems = [...workspace.diagnostics.map(item => ({ ...item, source: 'p4c' })), ...syntaxProblems];
  async function showProblem(problem) {
    if (await workspace.openFile(problem.path)) setReveal({ path: problem.path, line: problem.line, column: problem.column, sequence: Date.now() });
  }
  async function compile() { setPanel('output'); setOutputOpen(true); await workspace.compile(); }
  async function create() {
    const value = dialog?.kind === 'copy' ? workspace.documents[dialog.path]?.content || '' : '';
    if (await workspace.createFile(filename.trim(), value)) { setDialog(null); if (!desktop) setFilesOpen(false); }
  }
  function close(path) {
    if (workspace.dirty.includes(path)) setDialog({ kind: 'close', path });
    else workspace.closeFile(path);
  }
  async function saveAndClose() { if (await workspace.save(dialog.path)) { workspace.closeFile(dialog.path); setDialog(null); } }
  async function reload() { if (await workspace.reload(dialog.path)) setDialog(null); }
  const completionStatus = workspace.compileStatus === 'busy' ? 'Compiling…' : workspace.compileStatus === 'success' ? 'Compilation completed' : workspace.compileStatus === 'error' ? 'Compilation failed' : '';

  return <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', height: { xs: 'auto', md: 'calc(100dvh - 232px)' }, minHeight: { xs: 660, md: 720 }, overflow: 'hidden' }}>
    <Stack direction="row" spacing={1} useFlexGap sx={{ p: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
      <Typography variant="h6" sx={{ mr: 1 }}>P4 Editor</Typography>
      <Tooltip title={languageStatus.state === 'ready' ? 'P4 syntax diagnostics and scoped completion. Compile with p4c to check the full program.' : languageStatus.message || 'Starting P4 language support…'}>
        <Chip size="small" variant="outlined" color={languageStatus.state === 'ready' ? 'success' : 'default'} label={languageStatus.state === 'ready' ? 'P4 language server ready' : languageStatus.state === 'connecting' ? 'Language server connecting…' : 'Language server unavailable'} />
      </Tooltip>
      {languageStatus.state === 'unavailable' && <Button size="small" onClick={() => setReconnect(value => value + 1)}>Reconnect language server</Button>}
      <Box sx={{ flex: 1 }} />
      <Button size="small" startIcon={<FolderOpenOutlinedIcon />} onClick={() => setFilesOpen(value => !value)} aria-expanded={filesOpen}>Files</Button>
      <Button size="small" startIcon={<NoteAddOutlinedIcon />} disabled={workspace.busy} onClick={() => { workspace.clearError(); setFilename(''); setDialog({ kind: 'new' }); }}>New file</Button>
      <Tooltip title="Refresh the workspace file list"><span><IconButton size="small" aria-label="Refresh files" disabled={workspace.busy} onClick={workspace.refresh}><RefreshIcon /></IconButton></span></Tooltip>
    </Stack>
    <Divider />
    <Stack direction="row" spacing={1} useFlexGap sx={{ px: 1.5, py: 1, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button size="small" startIcon={<SaveOutlinedIcon />} disabled={workspace.busy || !active || active.read_only || !workspace.dirty.includes(active.path)} onClick={() => workspace.save(active.path)}>Save</Button>
      <Tooltip title="Save changes in all open files"><span><IconButton size="small" aria-label="Save all files" disabled={workspace.busy || !workspace.dirty.length} onClick={workspace.saveAll}><DoneAllIcon /></IconButton></span></Tooltip>
      <Box sx={{ flex: 1 }} />
      <TextField select label="P4 source file" size="small" value={sources.some(file => file.path === workspace.target) ? workspace.target : ''} disabled={workspace.busy}
        onChange={event => { workspace.setTarget(event.target.value); workspace.openFile(event.target.value); }} sx={{ minWidth: 200, width: { xs: '100%', sm: 320 }, maxWidth: '100%' }}>
        {sources.length ? sources.map(file => <MenuItem key={file.path} value={file.path}>{file.absolute_path}</MenuItem>) : <MenuItem disabled>No P4 source file found</MenuItem>}
      </TextField>
      <Tooltip title="Save all modified files, then compile the selected P4 program. Ctrl/Cmd+Enter."><span><Button variant="contained" size="small" disabled={workspace.busy || !workspace.target} startIcon={workspace.compileStatus === 'busy' ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />} onClick={compile}>{workspace.compileStatus === 'busy' ? 'Compiling…' : 'Compile'}</Button></span></Tooltip>
    </Stack>
    {workspace.error && <Alert severity="error" onClose={workspace.clearError} sx={{ mx: 1.5, mb: 1 }}>{workspace.error}</Alert>}
    {workspace.notice && <Alert severity="success" sx={{ mx: 1.5, mb: 1 }}>{workspace.notice}</Alert>}
    <Divider />
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, flex: 1, minHeight: 280, minWidth: 0 }}>
      {filesOpen && <Box component="aside" aria-label="P4 workspace" sx={{ width: { xs: '100%', md: 245 }, maxHeight: { xs: 200, md: 'none' }, flexShrink: 0, overflow: 'auto', borderRight: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
        <Box sx={{ p: 1 }}><TextField size="small" label="Find files" value={filter} onChange={event => setFilter(event.target.value)} fullWidth /></Box>
        <Files files={workspace.files} activePath={workspace.activePath} dirty={workspace.dirty} busy={workspace.busy} filter={filter} openFile={async path => { if (await workspace.openFile(path)) { if (!desktop) setFilesOpen(false); } }} />
        {!workspace.files.length && <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>Create a file or add P4 sources to the workspace directory.</Typography>}
      </Box>}
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
        {!!workspace.order.length && <Tabs value={workspace.activePath || false} onChange={(_event, path) => workspace.activate(path)} variant="scrollable" scrollButtons="auto" aria-label="Open files" sx={{ minHeight: 38, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 38, py: 0.5 } }}>
          {workspace.order.map(path => <Tab key={path} value={path} title={path} aria-label={`Switch to ${path}`} label={<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <span>{path.split('/').at(-1)}{workspace.dirty.includes(path) ? ' •' : ''}</span>
            <IconButton component="span" role="button" tabIndex={0} aria-label={`Close ${path}`} size="small" disabled={workspace.busy}
              onClick={event => { event.stopPropagation(); close(path); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); close(path); } }}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
          </Stack>} />)}
        </Tabs>}
        {active && <Stack direction="row" spacing={1} sx={{ px: 1.5, py: 0.5, alignItems: 'center', minWidth: 0 }}>
          <Typography variant="caption" noWrap sx={{ flex: 1 }}>{active.path}</Typography>
          {active.read_only && <Chip size="small" label="Read only" />}
          <Tooltip title="Save this buffer as a new file"><span><IconButton size="small" aria-label="Save file copy" disabled={workspace.busy} onClick={() => { workspace.clearError(); setFilename(active.path.replace(/(\.[^/.]+)$/, '-copy$1')); setDialog({ kind: 'copy', path: active.path }); }}><ContentCopyIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Reload this file from disk"><span><IconButton size="small" aria-label="Reload file" disabled={workspace.busy} onClick={() => workspace.dirty.includes(active.path) ? setDialog({ kind: 'reload', path: active.path }) : workspace.reload(active.path)}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip>
        </Stack>}
        <Box sx={{ flex: 1, minHeight: { xs: 280, md: 0 }, minWidth: 0, position: 'relative' }}>
          <MonacoEditor documents={documents} activePath={workspace.activePath} readOnly={workspace.busy || !active || active.read_only} onChange={workspace.edit}
            onSave={() => active && workspace.save(active.path)} onCompile={compile} onStatus={setLanguageStatus} onDiagnostics={receiveDiagnostics} compilerProblems={workspace.diagnostics} reveal={reveal} reconnect={reconnect} />
          {!active && <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.paper', p: 3 }}>
            <Stack spacing={1} sx={{ maxWidth: 400, textAlign: 'center' }}><CodeIcon sx={{ mx: 'auto', fontSize: 42 }} color="disabled" /><Typography variant="h6">Your P4 workspace</Typography><Typography color="text.secondary">Open a file from Files or select a P4 source above. Save and compile without leaving the editor.</Typography><Typography variant="caption" color="text.secondary">Ctrl/Cmd+S to save · Ctrl/Cmd+Enter to compile</Typography></Stack>
          </Box>}
        </Box>
      </Box>
    </Box>
    <Divider />
    <Stack direction="row" spacing={1} sx={{ px: 1.5, alignItems: 'center', minHeight: 32 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{workspace.dirty.length ? `${workspace.dirty.length} unsaved file${workspace.dirty.length === 1 ? '' : 's'}` : 'All changes saved'}</Typography>
      <Typography variant="caption" role="status" aria-live="polite" color={workspace.compileStatus === 'error' ? 'error' : 'text.secondary'}>{completionStatus}</Typography>
      <Tooltip title={outputOpen ? 'Hide compiler panel' : 'Show compiler panel'}><IconButton size="small" aria-label={outputOpen ? 'Hide compiler panel' : 'Show compiler panel'} onClick={() => setOutputOpen(value => !value)}>{outputOpen ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}</IconButton></Tooltip>
    </Stack>
    {outputOpen && <Box sx={{ height: { xs: 175, md: 190 }, flexShrink: 0, borderTop: 1, borderColor: 'divider', overflow: 'auto' }}>
      <Tabs value={panel} onChange={(_event, value) => setPanel(value)} aria-label="Editor output" sx={{ minHeight: 34, '& .MuiTab-root': { minHeight: 34, py: 0.5 } }}><Tab value="output" label="Compiler output" /><Tab value="problems" label={`Problems (${problems.length})`} /></Tabs>
      {panel === 'output' ? <TextField label="Compiler output" fullWidth multiline minRows={4} maxRows={7} value={workspace.output} slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12, borderRadius: 0 } } }} />
        : <List dense aria-label="Editor problems">{problems.length ? problems.map((problem, index) => <ListItemButton key={`${problem.source}:${problem.path}:${index}`} onClick={() => showProblem(problem)}>
          <ListItemText primary={problem.message} secondary={`${problem.path}:${problem.line}:${problem.column} · ${problem.source}`} slotProps={{ primary: { fontSize: 12 }, secondary: { fontSize: 11 } }} />
        </ListItemButton>) : <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>No reported problems. Compile to check the full program.</Typography>}</List>}
    </Box>}
    <Dialog open={Boolean(dialog)} onClose={() => { if (!workspace.busy) setDialog(null); }} fullWidth maxWidth="sm">
      <DialogTitle>{dialog?.kind === 'close' ? 'Close file with unsaved changes?' : dialog?.kind === 'reload' ? 'Reload file from disk?' : dialog?.kind === 'copy' ? 'Save a file copy' : 'New workspace file'}</DialogTitle>
      <DialogContent>
        {dialog?.kind === 'close' || dialog?.kind === 'reload' ? <Typography>Your unsaved changes to {dialog.path} will be discarded.</Typography>
          : <TextField autoFocus margin="dense" label="File path" value={filename} onChange={event => setFilename(event.target.value)} fullWidth helperText="Relative to your P4 workspace, for example my-program/includes/headers.p4" disabled={workspace.busy} />}
        {workspace.error && <Alert severity="error" sx={{ mt: 1 }}>{workspace.error}</Alert>}
      </DialogContent>
      <DialogActions><Button disabled={workspace.busy} onClick={() => setDialog(null)}>Cancel</Button>
        {dialog?.kind === 'close' ? <><Button color="warning" disabled={workspace.busy} onClick={() => { workspace.closeFile(dialog.path); setDialog(null); }}>Discard changes</Button><Button variant="contained" disabled={workspace.busy} onClick={saveAndClose}>Save and close</Button></>
          : dialog?.kind === 'reload' ? <Button color="warning" disabled={workspace.busy} onClick={reload}>Discard and reload</Button>
            : <Button variant="contained" disabled={workspace.busy || !filename.trim()} onClick={create}>{dialog?.kind === 'copy' ? 'Save copy' : 'Create file'}</Button>}
      </DialogActions>
    </Dialog>
  </Paper>;
}
