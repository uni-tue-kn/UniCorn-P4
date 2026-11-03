import React, { useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import { useTheme } from '../../Contexts/ThemeContext';
import { P4LanguageClient } from './languageClient';

globalThis.MonacoEnvironment = { getWorker: (_moduleId, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
monaco.languages.register({ id: 'p4', extensions: ['.p4'] });
monaco.languages.setLanguageConfiguration('p4', { comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']], autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }] });
monaco.languages.setMonarchTokensProvider('p4', {
  keywords: 'action apply bit bool const control default else enum error exit extern false header header_union if in inout int key list match_kind out package parser return select state string struct switch table this transition true tuple typedef type varbit verify void'.split(' '),
  tokenizer: { root: [[/\/\/.*$/, 'comment'], [/\/\*/, 'comment', '@comment'], [/^\s*#\s*\w+/, 'keyword'], [/"([^"\\]|\\.)*"/, 'string'], [/\b\d+[ws](?:0[xX][\da-fA-F_]+|0[bB][01_]+|[\d_]+)\b/, 'number'], [/\b(?:0[xX][\da-fA-F_]+|\d[\d_]*)\b/, 'number'], [/[a-zA-Z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }], [/[{}()[\]]/, '@brackets'], [/[<>!=:+*/&|?~-]+/, 'operator']],
    comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']] },
});

const range = value => new monaco.Range(value.start.line + 1, value.start.character + 1, value.end.line + 1, value.end.character + 1);
const kinds = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
function completion(item, model, position) {
  const word = model.getWordUntilPosition(position);
  return { label: item.label, detail: item.detail, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    kind: monaco.languages.CompletionItemKind[kinds[(item.kind || 1) - 1]] ?? monaco.languages.CompletionItemKind.Text,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: item.textEdit?.range ? range(item.textEdit.range) : new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, model.getWordAtPosition(position)?.endColumn ?? word.endColumn),
    sortText: item.sortText, filterText: item.filterText, _p4Item: item };
}

export default function MonacoEditor({ documents, activePath, readOnly, onChange, onSave, onCompile, onStatus, onDiagnostics, compilerProblems, reveal, reconnect }) {
  const host = useRef(null), editor = useRef(null), models = useRef(new Map()), callbacks = useRef({});
  callbacks.current = { onChange, onSave, onCompile, onStatus, onDiagnostics };
  const language = useRef(null);
  const { darkMode } = useTheme();
  useEffect(() => {
    const instance = monaco.editor.create(host.current, { automaticLayout: true, theme: darkMode ? 'vs-dark' : 'vs', model: null,
      fontSize: 14, lineHeight: 21, minimap: { enabled: false }, padding: { top: 12 }, scrollBeyondLastLine: false,
      ariaLabel: 'Source editor', editContext: false, readOnly: true, tabSize: 4,
      fixedOverflowWidgets: true, quickSuggestions: { other: true, comments: false, strings: false } });
    editor.current = instance;
    instance.addAction({ id: 'unicorn.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => callbacks.current.onSave() });
    instance.addAction({ id: 'unicorn.compile', label: 'Save and compile', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => callbacks.current.onCompile() });
    const service = new P4LanguageClient({ onStatus: value => callbacks.current.onStatus(value), onDiagnostics: params => {
      const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
      if (model) monaco.editor.setModelMarkers(model, 'p4-language-server', (params.diagnostics || []).map(item => ({
        ...{ startLineNumber: item.range.start.line + 1, startColumn: item.range.start.character + 1, endLineNumber: item.range.end.line + 1, endColumn: item.range.end.character + 1 },
        message: item.message, severity: item.severity === 2 ? monaco.MarkerSeverity.Warning : item.severity === 3 ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Error,
        source: 'P4 language server' })));
      callbacks.current.onDiagnostics(params);
    } });
    language.current = service;
    const providers = [monaco.languages.registerCompletionItemProvider('p4', {
      triggerCharacters: ['.'],
      provideCompletionItems: async (model, position, _context, token) => {
        try {
          const result = await service.request('textDocument/completion', { textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
          if (token.isCancellationRequested || !result) return { suggestions: [] };
          return { suggestions: (Array.isArray(result) ? result : result.items || []).slice(0, 500).map(item => completion(item, model, position)), incomplete: result.isIncomplete || false };
        } catch { return { suggestions: [] }; }
      },
      resolveCompletionItem: async item => {
        if (!service.capabilities?.completionProvider?.resolveProvider) return item;
        try { const resolved = await service.request('completionItem/resolve', item._p4Item); return { ...item, detail: resolved?.detail || item.detail,
          documentation: typeof resolved?.documentation === 'string' ? resolved.documentation : resolved?.documentation?.value || item.documentation }; }
        catch { return item; }
      },
    }), monaco.languages.registerDocumentHighlightProvider('p4', {
      provideDocumentHighlights: async (model, position) => {
        if (!service.capabilities?.documentHighlightProvider) return [];
        try { const items = await service.request('textDocument/documentHighlight', { textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
          return (items || []).map(item => ({ range: range(item.range), kind: item.kind || 1 })); }
        catch { return []; }
      },
    })];
    return () => {
      service.dispose(); language.current = null;
      for (const provider of providers) provider.dispose();
      instance.dispose(); editor.current = null;
      for (const item of models.current.values()) { item.listener.dispose(); item.model.dispose(); }
      models.current.clear();
    };
  }, []);
  useEffect(() => {
    const retained = new Set(documents.map(doc => doc.path));
    for (const [path, item] of models.current) if (!retained.has(path)) {
      if (editor.current.getModel() === item.model) editor.current.setModel(null);
      item.listener.dispose(); item.model.dispose(); models.current.delete(path);
    }
    for (const doc of documents) {
      let item = models.current.get(doc.path);
      if (!item) {
        const model = monaco.editor.createModel(doc.content, /\.(p4|h|hpp)$/i.test(doc.path) ? 'p4' : doc.language || 'plaintext', monaco.Uri.file(doc.absolute_path));
        item = { model, view: null, listener: model.onDidChangeContent(() => callbacks.current.onChange(doc.path, model.getValue())) };
        models.current.set(doc.path, item);
      } else if (item.model.getValue() !== doc.content) item.model.setValue(doc.content);
    }
    const next = models.current.get(activePath);
    if (next && editor.current.getModel() !== next.model) {
      const previous = [...models.current.values()].find(item => item.model === editor.current.getModel());
      if (previous) previous.view = editor.current.saveViewState();
      editor.current.setModel(next.model);
      if (next.view) editor.current.restoreViewState(next.view);
    }
    editor.current.updateOptions({ readOnly, ariaLabel: activePath ? `${activePath} editor` : 'Source editor' });
    language.current?.sync(documents.filter(doc => /\.(p4|h|hpp)$/i.test(doc.path)).map(doc => ({ uri: monaco.Uri.file(doc.absolute_path).toString(), text: doc.content })));
  }, [documents, activePath, readOnly]);
  useEffect(() => { monaco.editor.setTheme(darkMode ? 'vs-dark' : 'vs'); }, [darkMode]);
  useEffect(() => { if (reconnect) language.current?.reconnect().catch(() => {}); }, [reconnect]);
  useEffect(() => {
    for (const [path, item] of models.current) monaco.editor.setModelMarkers(item.model, 'p4c', compilerProblems.filter(problem => problem.path === path).map(problem => ({
      startLineNumber: problem.line, startColumn: problem.column, endLineNumber: problem.line, endColumn: problem.column + 1,
      message: problem.message, severity: problem.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error, source: 'p4c' })));
  }, [compilerProblems, documents]);
  useEffect(() => {
    if (!reveal || reveal.path !== activePath || !editor.current.getModel()) return;
    const position = editor.current.getModel().validatePosition({ lineNumber: reveal.line, column: reveal.column });
    editor.current.setPosition(position); editor.current.revealPositionInCenter(position); editor.current.focus();
  }, [reveal, activePath]);
  return <Box ref={host} data-testid="source-editor" sx={{ height: '100%', minHeight: 0, minWidth: 0 }} />;
}
