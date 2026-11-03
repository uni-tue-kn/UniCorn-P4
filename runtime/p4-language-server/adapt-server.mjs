// Integration fixes against the exact upstream revision documented in README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Pass the upstream source directory');
function edit(file, replacements) {
  const path = join(root, file);
  let source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Upstream integration anchor changed: ${file}: ${before.slice(0, 70)}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source);
}
edit('server/src/bundled_paths.ts', [
  ["import { join } from 'node:path';", `import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Match the RFC3986-escaped workspace URI used by Python and Monaco. */
export function canonicalFileUri(value: string): string {
  const path = value.startsWith('file://') ? fileURLToPath(value) : resolve(value);
  return 'file://' + path.split('/').map(segment => encodeURIComponent(segment)
    .replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
}`],
]);
edit('server/src/preprocessor/preprocessor.ts', [
  ["import { existsSync, readFileSync } from 'node:fs';", "import { existsSync, readFileSync, realpathSync, statSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nimport { p4ExtensionServer } from '../server';\nimport { bundledP4IncludeDir, canonicalFileUri } from '../bundled_paths';"],
  ["if (existsSync(abs)) {", "if (existsSync(abs) && allowedPath(abs)) {"],
  ["\t\tthis.fileContents.set(uri, source);", "\t\tif (this.visiting.size >= 32 || this.fileContents.size >= 128) { this.error(uri, 0, 0, 'Include limit exceeded'); return; }\n\t\tthis.fileContents.set(uri, source);"],
  ["function readText(path: string): string {\n\treturn readFileSync(path, 'utf8');\n}", `function allowedPath(path: string): boolean {
  try {
    const physical = realpathSync(path);
    const roots = [process.env.UNICORN_P4_WORKSPACE || process.cwd(), bundledP4IncludeDir()];
    return roots.some(root => { const trusted = realpathSync(root); return (physical === trusted || physical.startsWith(trusted + '/')) && !physical.slice(trusted.length + 1).split('/').some(part => part.startsWith('.')); })
      && statSync(physical).isFile() && statSync(physical).size <= 2 * 1024 * 1024;
  } catch { return false; }
}
function readText(path: string): string {
  if (!allowedPath(path)) throw new Error('Source file is outside the permitted workspace or exceeds the analysis limit');
  const document = p4ExtensionServer.documents.get(canonicalFileUri(path));
  if (document) return document.getText();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!allowedPath('/proc/self/fd/' + fd) || !fstatSync(fd).isFile() || fstatSync(fd).size > 2 * 1024 * 1024) throw new Error('Include is outside the permitted workspace');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > 2 * 1024 * 1024) throw new Error('Include exceeds the analysis size limit');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}`],
  ["return resolve(decodeURIComponent(p.slice('file://'.length)));", "return resolve(fileURLToPath(p));"],
]);
edit('server/src/antlr_compiler_proxy.ts', [
  ["import { dirname } from 'node:path';", "import { dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { defaultSettings } from './p4_extension_setting';"],
  ["import { getDocumentSettings } from './utils';", "// Settings are fixed by the workspace service, never supplied by the browser."],
  ["export let MY_LISTENER: MyP4Listener | null = null;", "export let MY_LISTENER: MyP4Listener | null = null;\nexport const DOCUMENT_LISTENERS = new Map<string, MyP4Listener>();\nexport const DOCUMENT_SOURCES = new Map<string, ReturnType<typeof preprocess>>();"],
  ["const fileDir = dirname(forUri.replace(/^file:\\/\\//, ''));", "const fileDir = dirname(fileURLToPath(forUri));"],
  ["const settings = await getDocumentSettings(textDocument.uri);", "const settings = { ...defaultSettings, includePaths: [process.env.UNICORN_P4_WORKSPACE || process.cwd()] };"],
  ["uri: textDocument.uri.replace(/^file:\\/\\//, ''),", "uri: fileURLToPath(textDocument.uri),"],
  ["\tfor (const [uri, diagnostics] of errorListener.diagnosticsByUri()) {\n\t\tp4ExtensionServer.connection.sendDiagnostics({ uri, diagnostics });\n\t}", `  if (MY_LISTENER) DOCUMENT_LISTENERS.set(textDocument.uri, MY_LISTENER);
  DOCUMENT_SOURCES.set(textDocument.uri, pp);
  const grouped = errorListener.diagnosticsByUri();
  if (!grouped.has(textDocument.uri)) grouped.set(textDocument.uri, []);
  for (const [uri, diagnostics] of grouped) {
    const version = p4ExtensionServer.documents.get(uri)?.version;
    p4ExtensionServer.connection.sendDiagnostics({ uri, diagnostics: diagnostics.slice(0, 100), version });
  }`],
]);
edit('server/src/providers/CompletionProvider.ts', [
  ["import { MY_LISTENER } from '../antlr_compiler_proxy';", "import { DOCUMENT_LISTENERS, DOCUMENT_SOURCES } from '../antlr_compiler_proxy';\nimport { fileURLToPath } from 'node:url';"],
  ["if (!textDocument || !MY_LISTENER) {", "const listener = DOCUMENT_LISTENERS.get(params.textDocument.uri);\n\tif (!textDocument || !listener) {"],
  ["return MY_LISTENER.getAutoCompletions(keyword, params);", `const source = DOCUMENT_SOURCES.get(params.textDocument.uri);
  const output = source?.sourceMap.outputOffset(fileURLToPath(params.textDocument.uri), offset);
  if (source && output != null) params = { ...params, position: { line: source.text.slice(0, output).split('\\n').length - 1, character: 0 } };
  return listener.getAutoCompletions(keyword, params);`],
]);
edit('server/src/antlr_error_listner.ts', [
  ["import { BaseErrorListener, Token } from 'antlr4ng';", "import { BaseErrorListener, Token } from 'antlr4ng';\nimport { canonicalFileUri } from './bundled_paths';"],
  ["return path.startsWith('file://') ? path : `file://${path}`;", "return canonicalFileUri(path);"],
]);
edit('server/src/server.ts', [
  ["import { sendToAntlrCompiler } from './antlr_compiler_proxy';", "import { DOCUMENT_LISTENERS, DOCUMENT_SOURCES, sendToAntlrCompiler } from './antlr_compiler_proxy';"],
  ["void sendToAntlrCompiler(change.document);", "this.documents.all().forEach(doc => void sendToAntlrCompiler(doc));"],
  ["documentHighlightProvider: true", "documentHighlightProvider: false"],
  ["\t\tthis.connection.onCompletion(completionProvider);", "\t\tthis.connection.onRequest('unicorn/analysis', () => true);\n\t\tthis.connection.onCompletion(completionProvider);"],
  ["\t\t// When a watched file", "\t\tthis.documents.onDidClose(change => { DOCUMENT_LISTENERS.delete(change.document.uri); DOCUMENT_SOURCES.delete(change.document.uri); this.connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] }); this.documents.all().forEach(doc => void sendToAntlrCompiler(doc)); });\n\n\t\t// When a watched file"],
]);

edit('server/src/preprocessor/source_map.ts', [
  ["\t/** Translate an offset in the flattened text back to its originating file/offset. */", `  /** Map an editor buffer position into the preprocessed parser input. */
  outputOffset(uri: string, offset: number): number | null {
    let nearest: number | null = null;
    for (const segment of this.segments) {
      if (segment.uri !== uri || segment.srcStart > offset) continue;
      nearest = segment.outStart + (segment.synthetic ? 0 : Math.min(offset - segment.srcStart, segment.length - 1));
      if (!segment.synthetic && offset < segment.srcStart + segment.length) return nearest;
    }
    return nearest;
  }
\t/** Translate an offset in the flattened text back to its originating file/offset. */`],
]);
