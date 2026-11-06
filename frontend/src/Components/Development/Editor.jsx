import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
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
function savedTree(workspaceRoot) {
  try {
    const value = JSON.parse(sessionStorage.getItem(`unicorn.editor.tree.v1:${workspaceRoot}`));
    return { collapsed: new Set(Array.isArray(value?.collapsed) ? value.collapsed.filter(path => typeof path === 'string' && path.length <= 1024).slice(0, 5000) : []),
      filter: typeof value?.filter === 'string' ? value.filter.slice(0, 256) : '', scrollTop: Number.isFinite(value?.scrollTop) ? Math.max(0, value.scrollTop) : 0 };
  } catch { return { collapsed: new Set(), filter: '', scrollTop: 0 }; }
}
function Files({ workspaceRoot, files, activePath, dirty, openFile, busy }) {
  const [initial] = useState(() => savedTree(workspaceRoot));
  const [collapsed, setCollapsed] = useState(initial.collapsed);
  const [filter, setFilter] = useState(initial.filter);
  const viewport = useRef(null), scrollTop = useRef(initial.scrollTop), current = useRef(null), restored = useRef(false);
  current.current = { collapsed: [...collapsed], filter };
  const persist = useCallback(() => {
    if (!workspaceRoot) return;
    try { sessionStorage.setItem(`unicorn.editor.tree.v1:${workspaceRoot}`, JSON.stringify({ ...current.current, scrollTop: scrollTop.current })); } catch { /* Navigation still works when browser storage is full. */ }
  }, [workspaceRoot]);
  useLayoutEffect(() => {
    if (!restored.current && files.length) {
      viewport.current.scrollTop = initial.scrollTop;
      scrollTop.current = viewport.current.scrollTop;
      restored.current = true;
    }
  }, [files, initial]);
  useEffect(() => {
    window.addEventListener('pagehide', persist);
    return () => { persist(); window.removeEventListener('pagehide', persist); };
  }, [persist]);
  useEffect(() => { const timer = setTimeout(persist, 200); return () => clearTimeout(timer); }, [collapsed, filter, persist]);
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
  return <Box component="aside" aria-label="P4 workspace" ref={viewport} onScroll={event => { scrollTop.current = event.currentTarget.scrollTop; }} sx={{ width: { xs: 'min(85%, 260px)', md: 220 }, position: { xs: 'absolute', md: 'relative' }, inset: { xs: '0 auto 0 0', md: 'auto' }, zIndex: 2, boxShadow: { xs: 4, md: 'none' }, flexShrink: 0, overflow: 'auto', borderRight: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
    <Box sx={{ p: 1 }}><TextField size="small" label="Find files" value={filter} onChange={event => setFilter(event.target.value)} fullWidth /></Box>
    <List dense aria-label="Workspace files" sx={{ py: 0.5 }}>{children(root)}</List>
    {!files.length && <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>Create a file or add P4 sources to the workspace directory.</Typography>}
  </Box>;
}

export default function Editor() {
  const workspace = useEditor();
  const desktop = useMediaQuery('(min-width:900px)');
  const [filesOpen, setFilesOpen] = useState(desktop);
  const [dialog, setDialog] = useState(null);
  const [filename, setFilename] = useState('');
  const [panel, setPanel] = useState('output');
  const [outputOpen, setOutputOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [compileTarget, setCompileTarget] = useState('auto');
  const [languageStatus, setLanguageStatus] = useState({ state: 'connecting' });
  const [reconnect, setReconnect] = useState(0);
  const [languageProblems, setLanguageProblems] = useState({});
  const [reveal, setReveal] = useState(null);
  const documents = useMemo(() => workspace.order.map(path => workspace.documents[path]), [workspace.order, workspace.documents]);
  const active = workspace.documents[workspace.activePath];
  const sources = workspace.files.filter(file => file.path.endsWith('.p4') && !file.read_only);
  useEffect(() => { workspace.refresh(); }, [workspace.refresh]);
  useEffect(() => {
    if (!focused) return;
    const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && !dialog) setFocused(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [focused, dialog]);
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
  async function compile() { setPanel('output'); setOutputOpen(true); await workspace.compile(compileTarget); }
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

  return <Paper variant="outlined" data-testid="editor-workspace" sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden',
    ...(focused && { position: 'fixed', inset: 0, zIndex: theme => theme.zIndex.drawer + 2, borderRadius: 0 }) }}>
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ px: 1, py: 0.5, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
      <Typography component="h2" sx={{ fontSize: 14, fontWeight: 600, mr: 0.5, display: { xs: 'none', md: 'block' } }}>P4 Editor</Typography>
      <Tooltip title="Show or hide workspace files"><IconButton size="small" aria-label="Files" onClick={() => setFilesOpen(value => !value)} aria-expanded={filesOpen}><FolderOpenOutlinedIcon fontSize="small" /></IconButton></Tooltip>
      <Tooltip title="New file"><span><IconButton size="small" aria-label="New file" disabled={workspace.busy} onClick={() => { workspace.clearError(); setFilename(''); setDialog({ kind: 'new' }); }}><NoteAddOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
      <Tooltip title="Refresh the workspace file list"><span><IconButton size="small" aria-label="Refresh files" disabled={workspace.busy} onClick={workspace.refresh}><RefreshIcon /></IconButton></span></Tooltip>
      <Divider orientation="vertical" flexItem />
      <Button size="small" startIcon={<SaveOutlinedIcon />} disabled={workspace.busy || !active || active.read_only || !workspace.dirty.includes(active.path)} onClick={() => workspace.save(active.path)}>Save</Button>
      <Tooltip title="Save changes in all open files"><span><IconButton size="small" aria-label="Save all files" disabled={workspace.busy || !workspace.dirty.length} onClick={workspace.saveAll}><DoneAllIcon /></IconButton></span></Tooltip>
      <Box sx={{ flex: 1 }} />
      <TextField select label="P4 source file" size="small" value={sources.some(file => file.path === workspace.target) ? workspace.target : ''} disabled={workspace.busy}
        onChange={event => { workspace.setTarget(event.target.value); workspace.openFile(event.target.value); }} sx={{ minWidth: 140, width: { xs: 170, sm: 280 }, flexGrow: { xs: 1, md: 0 }, maxWidth: '100%', '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}>
        {sources.length ? sources.map(file => <MenuItem key={file.path} value={file.path}>{file.absolute_path}</MenuItem>) : <MenuItem disabled>No P4 source file found</MenuItem>}
      </TextField>
      <TextField select label="Compile for" size="small" value={compileTarget} disabled={workspace.busy} onChange={event => setCompileTarget(event.target.value)} sx={{ minWidth: 125, '& .MuiInputBase-root': { height: 34, fontSize: 12 } }}>
        <MenuItem value="auto">Auto</MenuItem><MenuItem value="bmv2">BMv2</MenuItem><MenuItem value="tofino">Tofino 1</MenuItem><MenuItem value="tofino2">Tofino 2</MenuItem>
      </TextField>
      <Tooltip title="Save all modified files, then compile the selected P4 program. Ctrl/Cmd+Enter."><span><Button variant="contained" size="small" disabled={workspace.busy || !workspace.target} startIcon={workspace.compileStatus === 'busy' ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />} onClick={compile}>{workspace.compileStatus === 'busy' ? 'Compiling…' : 'Compile'}</Button></span></Tooltip>
      <Tooltip title={focused ? 'Return to navigation (Esc)' : 'Hide navigation and fill the window'}><IconButton size="small" aria-label={focused ? 'Exit focus mode' : 'Focus mode'} aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <FullscreenExitIcon /> : <FullscreenIcon />}</IconButton></Tooltip>
    </Stack>
    {workspace.error && <Alert severity="error" onClose={workspace.clearError} sx={{ mx: 1.5, mb: 1 }}>{workspace.error}</Alert>}
    <Divider />
    <Box sx={{ display: 'flex', position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      {filesOpen && <Files key={workspace.root} workspaceRoot={workspace.root} files={workspace.files} activePath={workspace.activePath} dirty={workspace.dirty} busy={workspace.busy} openFile={async path => { if (await workspace.openFile(path)) { if (!desktop) setFilesOpen(false); } }} />}
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1 }}>
        {!!workspace.order.length && <Stack direction="row" sx={{ alignItems: 'center', borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}><Tabs value={workspace.activePath || false} onChange={(_event, path) => workspace.activate(path)} variant="scrollable" scrollButtons="auto" aria-label="Open files" sx={{ flex: 1, minWidth: 0, minHeight: 32, '& .MuiTab-root': { minHeight: 32, py: 0, px: 1.5, fontSize: 12 } }}>
          {workspace.order.map(path => <Tab key={path} value={path} title={path} aria-label={`Switch to ${path}`} label={<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <span>{path.split('/').at(-1)}{workspace.dirty.includes(path) ? ' •' : ''}</span>
            <IconButton component="span" role="button" tabIndex={0} aria-label={`Close ${path}`} size="small" disabled={workspace.busy}
              onClick={event => { event.stopPropagation(); close(path); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); close(path); } }}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
          </Stack>} />)}
        </Tabs>
        {active && <Stack direction="row" spacing={0.25} sx={{ pr: 0.5, alignItems: 'center', flexShrink: 0 }}>
          {active.read_only && <Chip size="small" label="Read only" />}
          <Tooltip title="Save this buffer as a new file"><span><IconButton size="small" aria-label="Save file copy" disabled={workspace.busy} onClick={() => { workspace.clearError(); setFilename(active.path.replace(/(\.[^/.]+)$/, '-copy$1')); setDialog({ kind: 'copy', path: active.path }); }}><ContentCopyIcon fontSize="small" /></IconButton></span></Tooltip>
          <Tooltip title="Reload this file from disk"><span><IconButton size="small" aria-label="Reload file" disabled={workspace.busy} onClick={() => workspace.dirty.includes(active.path) ? setDialog({ kind: 'reload', path: active.path }) : workspace.reload(active.path)}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip>
        </Stack>}</Stack>}
        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
          <MonacoEditor documents={documents} activePath={workspace.activePath} readOnly={workspace.busy || !active || active.read_only} onChange={workspace.edit}
            onSave={() => active && workspace.save(active.path)} onCompile={compile} onStatus={setLanguageStatus} onDiagnostics={receiveDiagnostics} compilerProblems={workspace.diagnostics} reveal={reveal} reconnect={reconnect} />
          {!active && <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.paper', p: 3 }}>
            <Stack spacing={1} sx={{ maxWidth: 400, textAlign: 'center' }}><CodeIcon sx={{ mx: 'auto', fontSize: 42 }} color="disabled" /><Typography variant="h6">Your P4 workspace</Typography><Typography color="text.secondary">Open a file from Files or select a P4 source above. Save and compile without leaving the editor.</Typography><Typography variant="caption" color="text.secondary">Ctrl/Cmd+S to save · Ctrl/Cmd+Enter to compile</Typography></Stack>
          </Box>}
        </Box>
      </Box>
    </Box>
    <Divider />
    <Stack direction="row" spacing={1} useFlexGap sx={{ px: 1, alignItems: 'center', flexShrink: 0, minHeight: 28, flexWrap: 'wrap' }}>
      <Typography variant="caption" noWrap title={active?.path} color="text.secondary" sx={{ flex: 1, minWidth: 60 }}>{workspace.notice || (workspace.dirty.length ? `${workspace.dirty.length} unsaved file${workspace.dirty.length === 1 ? '' : 's'}` : active?.path || 'All changes saved')}</Typography>
      <Tooltip title={languageStatus.state === 'ready' ? 'P4 syntax diagnostics and scoped completion. Compile with p4c to check the full program.' : languageStatus.message || 'Starting P4 language support…'}>
        <Typography variant="caption" sx={{ display: { xs: 'none', md: 'block' } }} color={languageStatus.state === 'ready' ? 'success.main' : 'text.secondary'}>{languageStatus.state === 'ready' ? 'P4 language server ready' : languageStatus.state === 'connecting' ? 'Language server connecting…' : 'Language server unavailable'}</Typography>
      </Tooltip>
      {languageStatus.state === 'unavailable' && <Button size="small" onClick={() => setReconnect(value => value + 1)}>Reconnect language server</Button>}
      <Typography variant="caption" role="status" aria-live="polite" color={workspace.compileStatus === 'error' ? 'error' : 'text.secondary'}>{completionStatus}</Typography>
      <Tabs value={outputOpen ? panel : false} onChange={(_event, value) => { setPanel(value); setOutputOpen(true); }} aria-label="Editor output" sx={{ minHeight: 28, '& .MuiTab-root': { minHeight: 28, minWidth: 0, px: 1, py: 0, fontSize: 11 } }}><Tab value="output" label="Compiler output" /><Tab value="problems" label={`Problems (${problems.length})`} /></Tabs>
      <Tooltip title={outputOpen ? 'Hide compiler panel' : 'Show compiler panel'}><IconButton size="small" aria-label={outputOpen ? 'Hide compiler panel' : 'Show compiler panel'} onClick={() => setOutputOpen(value => !value)}>{outputOpen ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}</IconButton></Tooltip>
    </Stack>
    {outputOpen && <Box sx={{ height: 170, maxHeight: '30%', minHeight: 70, flexShrink: 0, borderTop: 1, borderColor: 'divider', overflow: 'auto' }}>
      {panel === 'output' ? <>
        {workspace.compileStatus === 'success' && <Alert severity="info" sx={{ py: 0, '& .MuiAlert-message': { py: 0.5, fontSize: 12 }, '& .MuiAlert-icon': { py: 0.5, fontSize: 18 } }}>Remember to load the updated program onto your switches to apply these changes.</Alert>}
        <TextField label="Compiler output" fullWidth multiline minRows={4} maxRows={7} value={workspace.output} slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12, borderRadius: 0 } } }} /></>
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
