# P4 language server

The web editor uses the standalone language server from
[fattaholmanan/p4-vscode-extension](https://github.com/fattaholmanan/p4-vscode-extension),
pinned to commit `48428a3bd9cb5508454eb2db2c73838be4076ffd` (server version 0.2.0,
Apache-2.0). The upstream license and README are copied into the backend image at
`/opt/p4-language-server/`. No VS Code extension host or marketplace access is required.

A cached Node 24 Docker build stage installs the upstream lockfile and bundles the
server. Only its executable bundle, Node runtime, license, and the matching p4c
standard-library headers enter the backend image. All assets work offline after
the image is built. The native p4c build remains a separate cached stage.

The server provides **P4 syntax diagnostics and scoped completion**. It does not
implement semantic/type checking, hover, or go-to-definition. The P4 compiler is
the authority for compile errors and target support. An upstream document-highlight
stub is disabled rather than advertised as a working feature.

## Integration adaptation

`adapt-server.mjs` applies checked source replacements to the pinned revision before
bundling. It fails the build if an expected upstream anchor changes. The adaptation:

- Reads unsaved document and include buffers without writing them onto the disk.
- Keeps completion caches per document and maps cursor positions through the
  preprocessor source map, preserving LF/CRLF positions and include scopes.
- Analyzes open includes in their open parent programs, preserving macros and
  context-dependent fragments. With multiple parents, diagnostics combine their
  results and completion uses the first open root. An include without an open
  parent is analyzed on its own.
- Publishes document versions and clears resolved diagnostics. Notifications are
  limited to open buffers. Errors in unopened includes appear on their parent,
  with the original file location attached, so large include trees cannot crowd
  open-buffer diagnostics out of the bounded transport queue.
- Decodes/encodes file URIs correctly, including paths containing spaces.
- Restricts includes to the configured P4 workspace and bundled compiler headers,
  excludes hidden paths, and bounds file sizes and include depth/count. File reads
  validate the opened descriptor before reading, so a changed directory symlink
  cannot redirect a read outside those roots.
- Adds an internal analysis barrier, allowing the backend to wait for an edited
  buffer's analysis with a fixed timeout.

The HTTP bridge in `backend/api/language_service.py` validates document URIs and a
small LSP method allowlist. Each browser session has a separate process, a maximum
of 16 open documents / 8 MiB of buffers, a five-second request/analysis timeout,
and three-minute idle expiry. At most four sessions run concurrently. The editor
can still read, edit, save, and compile when language analysis is unavailable.

## Local development

Docker builds configure `P4_LANGUAGE_SERVER` automatically. For a native backend,
set it to the built `server/out/server.js` from the pinned, adapted upstream tree
and ensure Node is installed (`NODE_BINARY` can select its executable). The server
expects its matching standard headers at `p4include/`, two directories above the
bundle. No command or include search path can be supplied through the browser API.

## Transport

- `GET /language/status`: server availability, revision, and supported feature names.
- `POST /language/sessions`: start and initialize a session; returns its ID,
  workspace file URI/root, server metadata, and actual LSP capabilities.
- `POST /language/sessions/<id>`: send `{ "messages": [...] }` containing JSON-RPC
  LSP notifications or supported requests; returns responses and diagnostics.
- `GET /language/sessions/<id>`: drain any remaining notifications.
- `DELETE /language/sessions/<id>`: terminate and reap the process; safe to repeat.

The frontend uses the existing same-origin `/api/` proxy. There is no additional
public port, WebSocket endpoint, or sidecar service.

The optional Tofino backend image adds the official SDK architecture headers
(`tna.p4`, `t2na.p4`, their architecture dependencies, and `tofino/`) to that same
bundled `p4include/` directory. Standard includes resolve through the existing
lookup and access restrictions; the editor needs no additional configuration or
language service. Compiler builds remain authoritative for target semantics.
The preprocessor supplies the compiler's `__TARGET_TOFINO__` default when loading
these bundled architecture headers (1 for `tna.p4`, 2 for `t2na.p4`), preserving an
explicit source definition. Explicit `#error` directives are reported only in
active conditional branches.
