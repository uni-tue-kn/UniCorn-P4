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
  ["\t\t\tcase 'line':", `            case 'error':
                if (this.isActive(ifStack)) this.error(uri, lineNo, col, body.slice('error'.length).trim() || '#error');
                break;
            case 'line':`],
  ["if (existsSync(abs)) {", "if (existsSync(abs) && allowedPath(abs)) {"],
  ["\t\t\t\tthis.processFile(resolved, readText(resolved));", `                // The compiler supplies this builtin for native architecture headers.
                // Apply it only to bundled SDK headers; source defines take precedence.
                const architecture = resolved === join(bundledP4IncludeDir(), 'tna.p4') ? '1'
                  : resolved === join(bundledP4IncludeDir(), 't2na.p4') ? '2' : null;
                if (architecture && !this.macros.has('__TARGET_TOFINO__')) {
                  this.macros.set('__TARGET_TOFINO__', { kind: 'object', replacement: architecture });
                }
                this.processFile(resolved, readText(resolved));`],
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
  // Retain CR characters in raw lines so source offsets continue to count UTF-16
  // positions in the original buffer. The lexer accepts CRLF whitespace.
  ["const lines = source.split(/\\r?\\n/);", "const lines = source.split('\\n');"],
]);
edit('server/src/antlr_compiler_proxy.ts', [
  ["import { dirname } from 'node:path';", "import { dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';"],
  ["import { getDocumentSettings } from './utils';", "// Settings are fixed by the workspace service, never supplied by the browser."],
  ["export let MY_LISTENER: MyP4Listener | null = null;", "export let MY_LISTENER: MyP4Listener | null = null;\nexport const DOCUMENT_LISTENERS = new Map<string, MyP4Listener>();\nexport const DOCUMENT_SOURCES = new Map<string, ReturnType<typeof preprocess>>();"],
  ["const fileDir = dirname(forUri.replace(/^file:\\/\\//, ''));", "const fileDir = dirname(fileURLToPath(forUri));"],
  ["const settings = await getDocumentSettings(textDocument.uri);\n\tconst includePaths = [...defaultIncludePaths(textDocument.uri), ...settings.includePaths];", "// Preprocessing is shared with root/include discovery below."],
  ["uri: textDocument.uri.replace(/^file:\\/\\//, ''),", "uri: fileURLToPath(textDocument.uri),"],
  ["import { bundledP4IncludeDir } from './bundled_paths';", "import { bundledP4IncludeDir, canonicalFileUri } from './bundled_paths';\nimport { Diagnostic } from 'vscode-languageserver';"],
  ["export async function sendToAntlrCompiler(textDocument: TextDocument): Promise<void> {", "function analyzeRoot(prepared: ReturnType<typeof preprocess>): Map<string, Diagnostic[]> {"],
  ["const pp = preprocess({\n\t\turi: fileURLToPath(textDocument.uri),\n\t\tincludePaths,\n\t});", "const pp = prepared;"],
  ["\tfor (const [uri, diagnostics] of errorListener.diagnosticsByUri()) {\n\t\tp4ExtensionServer.connection.sendDiagnostics({ uri, diagnostics });\n\t}", `  // Included fragments inherit their parent's macros, parser scope and source map.
  // With multiple parents, completion consistently uses the first open root.
  for (const path of pp.fileContents.keys()) {
    const uri = canonicalFileUri(path);
    if (MY_LISTENER && p4ExtensionServer.documents.get(uri) && !DOCUMENT_LISTENERS.has(uri)) {
      DOCUMENT_LISTENERS.set(uri, MY_LISTENER);
      DOCUMENT_SOURCES.set(uri, pp);
    }
  }
  return errorListener.diagnosticsByUri();`],
  ["\nfunction parseText(source: string, errorListener: P4ErrorListener) {", `
const publishedUris = new Set<string>();

/** Analyze complete open programs, rather than parsing included fragments twice. */
export function analyzeOpenDocuments(): void {
  const documents = p4ExtensionServer.documents.all();
  const prepared = new Map(documents.map(document => [document.uri, preprocess({
    uri: fileURLToPath(document.uri),
    includePaths: [...defaultIncludePaths(document.uri), process.env.UNICORN_P4_WORKSPACE || process.cwd()],
  })]));
  const includes = (root: string, child: string) => root !== child && prepared.get(root)!.fileContents.has(fileURLToPath(child));
  const roots = documents.filter(document => !documents.some(other => includes(other.uri, document.uri)));
  // A cyclic include component has no natural root; analyze it once to report
  // the existing include-cycle diagnostic without dropping unrelated programs.
  for (const document of documents) {
    if (!roots.some(root => root.uri === document.uri || includes(root.uri, document.uri))) roots.push(document);
  }
  DOCUMENT_LISTENERS.clear();
  DOCUMENT_SOURCES.clear();
  const grouped = new Map<string, Diagnostic[]>();
  for (const root of roots) {
    for (const [uri, diagnostics] of analyzeRoot(prepared.get(root.uri)!)) {
      // Publish only for open buffers: a large compiler-header tree must not
      // evict editor diagnostics from the transport's bounded event queue.
      // Unopened include errors remain visible on the parent with their location.
      const target = p4ExtensionServer.documents.get(uri) ? uri : root.uri;
      const visible = target === uri ? diagnostics : diagnostics.map(diagnostic => ({
        ...diagnostic,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: 'Included file ' + fileURLToPath(uri) + ':' + (diagnostic.range.start.line + 1) + ': ' + diagnostic.message,
        relatedInformation: [{ location: { uri, range: diagnostic.range }, message: diagnostic.message }],
      }));
      const combined = grouped.get(target) || [];
      const seen = new Set(combined.map(diagnostic => JSON.stringify(diagnostic)));
      grouped.set(target, combined.concat(visible.filter(diagnostic => !seen.has(JSON.stringify(diagnostic)))));
    }
  }
  const touched = new Set([...publishedUris, ...documents.map(document => document.uri), ...grouped.keys()]);
  publishedUris.clear();
  for (const uri of touched) {
    const diagnostics = (grouped.get(uri) || []).slice(0, 100);
    if (diagnostics.length) publishedUris.add(uri);
    p4ExtensionServer.connection.sendDiagnostics({ uri, diagnostics, version: p4ExtensionServer.documents.get(uri)?.version });
  }
}

function parseText(source: string, errorListener: P4ErrorListener) {`],
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
  ["import { sendToAntlrCompiler } from './antlr_compiler_proxy';", "import { analyzeOpenDocuments } from './antlr_compiler_proxy';"],
  ["void sendToAntlrCompiler(change.document);", "void analyzeOpenDocuments();"],
  ["this.connection.onDidChangeWatchedFiles(() => {\n\t\t\tthis.documents.all().forEach((doc) => void sendToAntlrCompiler(doc));", "this.connection.onDidChangeWatchedFiles(() => {\n\t\t\tvoid analyzeOpenDocuments();"],
  ["this.connection.onDidChangeConfiguration(() => {\n\t\t\tthis.documents.all().forEach((doc) => void sendToAntlrCompiler(doc));", "this.connection.onDidChangeConfiguration(() => {\n\t\t\tvoid analyzeOpenDocuments();"],
  ["documentHighlightProvider: true", "documentHighlightProvider: false"],
  ["\t\tthis.connection.onCompletion(completionProvider);", "\t\tthis.connection.onRequest('unicorn/analysis', () => true);\n\t\tthis.connection.onCompletion(completionProvider);"],
  ["\t\t// When a watched file", "\t\tthis.documents.onDidClose(change => { this.connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] }); void analyzeOpenDocuments(); });\n\n\t\t// When a watched file"],
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
