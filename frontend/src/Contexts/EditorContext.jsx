import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { compileErrorMessage, compilerDiagnostics, formatCompileCommand } from '../Components/Development/compile';

const EditorContext = createContext(null);
const recoveryKey = 'unicorn.editor.recovery.v1';
const empty = { root: '', files: [], documents: {}, order: [], activePath: '', target: '', output: '', diagnostics: [], compileStatus: null };
function recover() {
  try {
    const value = JSON.parse(sessionStorage.getItem(recoveryKey));
    if (!value || typeof value.root !== 'string' || !Array.isArray(value.documents)) return empty;
    const documents = Object.create(null);
    for (const doc of value.documents.slice(0, 16)) {
      if (typeof doc.path === 'string' && !doc.path.startsWith('/') && !doc.path.split('/').some(part => !part || part === '..')
          && typeof doc.content === 'string' && doc.content.length <= 2 * 1024 * 1024
          && typeof doc.savedContent === 'string' && doc.savedContent.length <= 2 * 1024 * 1024
          && /^[a-f0-9]{64}$/.test(doc.revision) && typeof doc.read_only === 'boolean'
          && typeof doc.language === 'string' && doc.absolute_path === value.root + '/' + doc.path) {
        documents[doc.path] = { ...doc, conflict: false, needsVerification: true, read_only: true };
      }
    }
    const order = Object.keys(documents);
    return { ...empty, root: value.root, documents, order, activePath: order.includes(value.activePath) ? value.activePath : order[0] || '', target: value.target || '' };
  } catch { return empty; }
}
function persist(value) {
  try {
    const documents = value.order.map(path => value.documents[path]).filter(doc => doc.content !== doc.savedContent);
    if (documents.length) sessionStorage.setItem(recoveryKey, JSON.stringify({ root: value.root, documents, activePath: value.activePath, target: value.target }));
    else sessionStorage.removeItem(recoveryKey);
  } catch { /* Save remains available when browser recovery storage is full. */ }
}
export const useEditor = () => useContext(EditorContext);

export function EditorProvider({ children }) {
  const [state, setState] = useState(recover);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef(state);
  current.current = state;
  const operation = useRef(false);
  const opening = useRef(0);
  const openingFiles = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = state.order.filter(path => state.documents[path]?.content !== state.documents[path]?.savedContent);
  useEffect(() => {
    for (const path of openingFiles.current) if (state.documents[path]) openingFiles.current.delete(path);
  }, [state.documents]);
  useEffect(() => {
    const timer = setTimeout(() => persist(current.current), 300);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const unloading = event => {
      persist(current.current);
      if (current.current.order.some(path => current.current.documents[path].content !== current.current.documents[path].savedContent)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unloading);
    return () => { persist(current.current); window.removeEventListener('beforeunload', unloading); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.get('/workspace');
      if (!mounted.current) return;
      if (current.current.root && current.current.root !== data.root && current.current.order.length) {
        throw new Error('The workspace directory changed. Close the open files before switching workspaces.');
      }
      setState(previous => ({ ...previous, root: data.root, files: data.files, documents: Object.fromEntries(previous.order.map(path => {
        const doc = previous.documents[path], metadata = data.files.find(file => file.path === path);
        return [path, metadata ? { ...doc, absolute_path: metadata.absolute_path, language: metadata.language, read_only: metadata.read_only, needsVerification: false } : doc];
      })) }));
      if (data.truncated) setNotice('Only part of this large workspace is listed. Use a smaller project directory.');
    } catch (failure) { if (mounted.current) setError(compileErrorMessage(failure)); }
  }, []);
  const activate = useCallback(path => { opening.current++; setState(previous => ({ ...previous, activePath: path })); }, []);
  const openFile = useCallback(async path => {
    setError('');
    if (current.current.documents[path]) { activate(path); return current.current.documents[path]; }
    if (openingFiles.current.has(path)) return null;
    if (new Set([...current.current.order, ...openingFiles.current]).size >= 16) { setError('Close an open file before opening another (16 files maximum).'); return null; }
    openingFiles.current.add(path);
    const request = ++opening.current;
    try {
      const { data } = await axios.get('/workspace/file', { params: { path } });
      if (!mounted.current) { openingFiles.current.delete(path); return null; }
      const doc = { ...data, savedContent: data.content, conflict: false };
      setState(previous => ({ ...previous, documents: { ...previous.documents, [path]: previous.documents[path] || doc },
        order: previous.order.includes(path) ? previous.order : [...previous.order, path], activePath: request === opening.current ? path : previous.activePath,
        target: previous.target || (path.endsWith('.p4') && !doc.read_only ? path : '') }));
      return doc;
    } catch (failure) { openingFiles.current.delete(path); if (mounted.current) setError(compileErrorMessage(failure)); return null; }
  }, [activate]);
  const edit = useCallback((path, content) => {
    if (operation.current || current.current.documents[path]?.content === content) return;
    setNotice('');
    setState(previous => {
    const doc = previous.documents[path];
    if (operation.current || !doc || doc.read_only || doc.needsVerification || doc.content === content) return previous;
    return { ...previous, documents: { ...previous.documents, [path]: { ...doc, content } },
      diagnostics: [], compileStatus: null };
    });
  }, []);
  const saveOne = useCallback(async path => {
    const doc = current.current.documents[path];
    if (!doc || doc.content === doc.savedContent) return true;
    if (doc.read_only || doc.needsVerification) { setError(`${path} is read only. Save a copy to keep your changes.`); return false; }
    try {
      const { data } = await axios.patch('/workspace/file', { path, content: doc.content, revision: doc.revision });
      if (!mounted.current) return false;
      setState(previous => !previous.documents[path] ? previous : ({ ...previous, documents: { ...previous.documents,
        [path]: { ...previous.documents[path], revision: data.revision, savedContent: doc.content, conflict: false } } }));
      return true;
    } catch (failure) {
      if (mounted.current) {
        if (failure.response?.status === 409) {
          setState(previous => !previous.documents[path] ? previous : ({ ...previous, documents: { ...previous.documents, [path]: { ...previous.documents[path], conflict: true } } }));
          setError(`${path} changed outside this editor. Your draft is kept. Save a copy or reload the file before saving.`);
        } else setError(compileErrorMessage(failure));
      }
      return false;
    }
  }, []);
  const run = useCallback(async callback => {
    if (operation.current) return false;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try { return await callback(); }
    catch (failure) { if (mounted.current) setError(compileErrorMessage(failure)); return false; }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const save = useCallback(path => run(async () => {
    const saved = await saveOne(path);
    if (saved) setNotice('File saved.');
    return saved;
  }), [run, saveOne]);
  const saveAll = useCallback(() => run(async () => {
    for (const path of current.current.order) if (!(await saveOne(path))) return false;
    setNotice('All changes saved.'); return true;
  }), [run, saveOne]);
  const createFile = useCallback((path, content = '') => run(async () => {
    if (new Set([...current.current.order, ...openingFiles.current]).size >= 16) {
      setError('Close an open file before creating another (16 files maximum).'); return false;
    }
    const { data } = await axios.post('/workspace/file', { path, content, revision: null });
    setState(previous => ({ ...previous, documents: { ...previous.documents, [data.path]: { ...data, savedContent: content, conflict: false } },
      order: previous.order.includes(data.path) ? previous.order : [...previous.order, data.path], activePath: data.path,
      target: previous.target || (data.path.endsWith('.p4') ? data.path : '') }));
    await refresh(); setNotice('File created.'); return true;
  }), [refresh, run]);
  const reload = useCallback(path => run(async () => {
    const { data } = await axios.get('/workspace/file', { params: { path } });
    setState(previous => ({ ...previous, documents: { ...previous.documents, [path]: { ...data, savedContent: data.content, conflict: false } } }));
    setNotice('File reloaded from disk.'); return true;
  }), [run]);
  const closeFile = useCallback(path => setState(previous => {
    if (operation.current) return previous;
    const documents = { ...previous.documents }; delete documents[path];
    const order = previous.order.filter(item => item !== path);
    return { ...previous, documents, order, activePath: previous.activePath === path ? order.at(-1) || '' : previous.activePath };
  }), []);
  const target = useCallback(path => setState(previous => ({ ...previous, target: path })), []);
  const compile = useCallback((compileTarget = 'auto') => run(async () => {
    const snapshot = current.current;
    const source = snapshot.files.find(file => file.path === snapshot.target);
    if (!source || !source.path.endsWith('.p4')) { setError('Select a P4 source file to compile.'); return false; }
    for (const path of snapshot.order) if (!(await saveOne(path))) return false;
    setState(previous => ({ ...previous, compileStatus: 'busy', output: `Compiling ${source.absolute_path}\n…`, diagnostics: [] }));
    try {
      const requested = compileTarget === 'bmv2' ? { target: 'bmv2' }
        : compileTarget === 'tofino2' ? { target: 'tofino', architecture: 'tofino2' }
          : compileTarget === 'tofino' ? { target: 'tofino', architecture: 'tofino' }
            : { target: 'auto', architecture: 'tofino' };
      let { data } = await axios.post('/compile', { file: source.absolute_path, ...requested });
      if (data?.job_id) {
        const jobID = data.job_id;
        const deadline = Date.now() + 15 * 60 * 1000;
        let failures = 0;
        for (;;) {
          if (Date.now() >= deadline) throw new Error('Compilation monitoring timed out. Refresh the program list to check for a completed build.');
          let job;
          try {
            job = (await axios.get(`/compile/jobs/${encodeURIComponent(jobID)}`, { timeout: Math.min(15000, deadline - Date.now()) })).data;
            failures = 0;
          } catch (failure) {
            if ((failure.response && failure.response.status < 500) || ++failures >= 10) throw failure;
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          if (!mounted.current) return false;
          if (job.status === 'complete') { data = job.result; break; }
          if (job.status === 'failed') throw { response: { data: job.result || { error: job.error || 'Compilation failed.' } } };
          if (!['pending', 'running'].includes(job.status)) throw new Error('The compiler returned an invalid job status.');
          setState(previous => ({ ...previous, output: `Compiling ${source.absolute_path}\n${job.message || 'Compilation is running…'}` }));
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const output = [`Compiling ${source.absolute_path}`, `Command: ${formatCompileCommand(data.command)}`, data.stdout, data.stderr, 'Success: Compilation completed.'].filter(Boolean).join('\n');
      setState(previous => ({ ...previous, output, compileStatus: 'success', diagnostics: compilerDiagnostics(data.stderr || '', previous.root, source.absolute_path, previous.files.map(file => file.path)) }));
      await refresh(); return true;
    } catch (failure) {
      const data = failure.response?.data;
      const command = formatCompileCommand(data?.command);
      const message = compileErrorMessage(failure);
      setState(previous => ({ ...previous, compileStatus: 'error', output: [`Compiling ${source.absolute_path}`, command && `Command: ${command}`, data?.stdout, `Error: ${message}`].filter(Boolean).join('\n'),
        diagnostics: compilerDiagnostics(message, previous.root, source.absolute_path, previous.files.map(file => file.path)) }));
      return false;
    }
  }), [refresh, run, saveOne]);
  const value = useMemo(() => ({ ...state, busy, error, notice, dirty, refresh, openFile, activate, edit, save, saveAll, createFile, reload, closeFile, setTarget: target, compile, clearError: () => setError('') }),
    [state, busy, error, notice, dirty, refresh, openFile, activate, edit, save, saveAll, createFile, reload, closeFile, target, compile]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
