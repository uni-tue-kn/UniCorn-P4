# Using UniCorn-P4

UniCorn-P4 combines a P4Runtime controller, a browser UI, and a Mininet network
emulator for developing and teaching P4 on BMv2. The [project overview](../README.md)
shows the main screens; this guide covers operation, compatibility, and development.

## Start the platform

Use Linux and Docker with Compose v2. From a source checkout, run:

```sh
cd docker
docker compose up --build -d
```

Open http://localhost:3000. Put programs in `docker/p4-files/` and topology JSON
files in `docker/topologies/`. These directories and `docker/database/` are persistent
volumes. The initial build compiles official upstream sources and can take much
longer than cached application rebuilds.

For a published deployment archive, extract `UniCorn-P4.tar.gz`, enter its
`UniCorn-P4/` directory, and run `docker compose pull` followed by
`docker compose up -d`. The archive root corresponds to a checkout's `docker/`
directory and contains version-pinned images, compiled samples, and a fresh database.

The frontend serves a Vite production build through nginx. Same-origin `/api/`
and `/netsim/` proxies include terminal WebSocket traffic, so a browser on another
machine can use the UI. `BACKEND_URL` and `NETSIM_URL` configure proxy destinations.
Use the development services and privileged emulator terminal on a trusted network.

## Compile and initialize a switch

1. Select **P4 Compile**, choose a source file, and compile it for BMv2/v1model.
2. On **Topology**, use its **Topology** menu to import a saved topology or JSON,
   then choose **Deploy topology**.
   Automatic switch connection is enabled by default. Alternatively, use **New Switch Connection**
   and enter the switch name, P4Runtime address/port, device ID, and optional log path.
3. Select a switch tab and choose **Edit initialization** on its dashboard.
4. Select a **Compiled program** and initialize. Matching P4Info and BMv2 JSON
   files are selected together. **Advanced** retains manual file selection for
   custom builds. Available resources are discovered from P4Info.

To compile manually with an installed p4c:

```sh
p4c /path/example.p4 --target bmv2 --arch v1model \
  --p4runtime-files /path/example.p4info.txt -o /path/
```

Keep generated files alongside the corresponding program. “Keep existing entries”
preserves an identical active pipeline; loading a different program requires an
explicit reset because PI reconciliation cannot safely preserve every resource.

## Create and inspect topologies

One topology canvas shows the running network and edits a draft. Use **Add host**
and **Add switch** to create nodes. Choose **Add link**, select the first node,
then select the other endpoint directly on the canvas. The source is highlighted
and a dashed line previews the connection. Escape or **Cancel link** cancels
without adding an edge. To use the keyboard, focus nodes and press Enter or Space
to choose endpoints. Arrow keys move focus while drawing; otherwise they move the
focused node. Parallel switch-to-switch links appear as separate curves. Each host
supports one switch link; remove or rewire that link before connecting it elsewhere.

Select a node or link to open its compact properties panel beside the canvas.
Link properties provide latency and bandwidth, with **Change endpoints** available
for manual rewiring. **Update link** applies the settings to the draft. Node
properties support renaming and deletion. Nodes can also be dragged directly.

The **Topology** menu groups new/reload, saved-file import, JSON import/export,
save, auto-arrange, and clearing the running network. Import and save open focused
dialogs. JSON export includes node positions. Editing and saving leave the running
network unchanged. **Deploy topology** creates a fresh saved snapshot, recreates
the network, and connects discovered switches. The menu also controls automatic
switch connection. **Reload active topology** explicitly discards the draft and
shows the running network. Ordinary background refreshes preserve unsaved changes.
Unfinished drafts can be imported, edited and saved. Deployment requires exactly
one switch link for every host, and checks this before saving a deployment snapshot
or changing the running network.

Latency and bandwidth are enforced by Linux traffic control after loading.
Latency applies in each direction: one `10ms` link adds roughly `20ms` to a
ping round trip. Bandwidth is measured in Mbps.

A minimal file in `docker/topologies/` looks like this:

```json
{
  "hosts": ["h1", "h2"],
  "switches": {"s1": {}},
  "links": [["h1", "s1"], ["h2", "s1"]]
}
```

Node names must end in a numeric ID. Link entries can add latency and bandwidth:
`["h1", "s1", "2ms", 100]`. Saved `layout` positions map node names to `{x, y}`.
The active topology's interface map shows actual switch ports and peers.
**Terminals** is a dedicated page with host/switch shell tabs and Ctrl+C
interruption. Output and the selected terminal are retained when moving between
pages in the same running network; deploying a new network clears them.
Hosts permit explicit
IPv6 and SIT tunnel configuration while automatic router discovery/addressing
remain disabled.

Physical interfaces can be attached using `"ext_intfs": [["s1", "INTERFACE_NAME"]]`.
Choose an existing interface intentionally: it becomes part of the emulated network.
Unknown switches, duplicate/reserved interfaces, and malformed links are rejected.

## Work with switch resources

The header can collapse or expand the resource sidebar. Drag its right divider
to resize it, or focus **Resize sidebar** and use the arrow keys, Home, or End.
The selected width and collapsed state are remembered.

| Screen | Operations |
| --- | --- |
| Tables | Read, add, edit, bulk-edit, and delete MAT entries; sort/filter and choose numeric, address, hexadecimal, or binary display. |
| Counters | Refresh or reset indexed counters, sample packet/bit rates, and view direct counters beside their matching MAT entries. |
| Registers | Read indexed cells, change display base, edit values, save, and refresh without losing integer precision. |
| Meters | Read/write CIR, CBS, PIR, and PBS using the P4 program's packet/byte unit. Direct meters open through **Edit meter** on their owning MAT row. |
| Mirrors | Create, modify, read, and delete clone sessions with destination port/instance replicas. |
| Multicast | Manage port/instance replication groups selected by the P4 program. |
| Digests | Configure digest delivery and inspect bounded, acknowledged event lists from the switch. |
| Queues | Apply native BMv2 queue depth and packet-rate limits to all ports or one port. |

Register values travel through HTTP as decimal strings. The bundled emulator's
P4Runtime extension supports `bit<W>` and `int<W>` for **1–64 bits**. Stock PI
does not implement register RPCs. For an external BMv2 switch, explicitly enable
the connection's register adapter and supply its Thrift host and port. That
conservative adapter supports **1–63 bits**; no remote native endpoint is guessed.
Unsupported register access does not prevent other supported resources from working.
See the [runtime notes](../runtime/README.md) for transport and synchronization details.

Meter fields have tooltips with their meanings and P4Info-derived units. An
unconfigured meter returns green for every packet without imposing a rate
constraint. It differs from an explicit configuration of zero rates. Reset
removes the explicit configuration. The P4 program decides how to handle each
meter color.

A mirror session produces traffic only when the P4 program calls `clone`/`clone3`
with the matching session ID. Use IDs 1–32767 and unique port/instance pairs.
Nonzero class of service and packet truncation depend on target support; tested
upstream BMv2 rejects those optional settings. Defaults of zero work normally.

Multicast groups use IDs 1–65535. The P4 program must select a configured group
through `standard_metadata.mcast_grp`. Configuring a group alone does not
replicate unrelated traffic.

Digest instances are discovered from P4Info. Enable delivery and set buffering
and acknowledgement options, then view events emitted by the program's
`digest` calls. The controller keeps one background P4Runtime stream per
connection, records complete lists within bounded memory, and acknowledges
accepted lists. Events are held in memory, with explicit drop/stream status.
Clearing the viewer removes captured events and does not disable the digest.

Counter resets write zero through P4Runtime. A reset is scoped to an index or
one counter array. Direct-counter resets preserve the associated MAT entries.
Live graphs calculate packet and bit rates from consecutive counter samples.
Their window is bounded, polling stops when the view closes, and a reset starts
a new measurement baseline. These are counter-derived rates, not physical wire
rates including Ethernet overhead.

Queue controls require a reachable BMv2 Thrift host and port in the connection
settings. The bundled emulator supplies its actual endpoint automatically.
External endpoints are always explicit, even when the register adapter is off.
Queue depth is measured in packets. Queue rate is measured in packets per
second, with zero meaning unlimited. This differs from topology link bandwidth
in Mbps. Settings apply to every priority queue on the selected port or all
ports. The native interface has setters without getters, so the page shows
per-port **Last configured here** values, not switch readback. Unknown values
stay unknown. All-port writes and later per-port overrides are merged by field.
The change history is available separately. Depth and rate are separate
operations and failures can leave an earlier change applied.

## Network bundles and samples

The **Network archive** menu in the global header is available from every page.
**Export network** downloads a ZIP with topology/layout, active source files
and quoted includes, compiled P4Info/BMv2 files, and readable runtime entities.
It includes tables, registers, counters, meters, replication groups, digest
configuration, and recorded queue settings. This is a live, best-effort capture.
The manifest records unsupported state and missing sources rather than
inventing values. Queue values come from acknowledged changes, not native
readback. Database history, terminal history, logs, and packet captures are
not included.

From the same header menu, **Import network** validates paths, checksums, limits, programs, and resource
dependencies before offering **Import and deploy**. Imported projects get new
directories. Restore recreates the emulated network and writes captured state
in dependency order. Partial failures are reported. Retrying the same import
token does not deploy twice. External targets need explicit destination
mappings, and physical interface attachment is disabled unless selected.

The [public sample bundles](../examples/networks/README.md) demonstrate
forwarding, multicast, mirroring, and metering/queues. They use a separate demo
program and contain no lecture solutions. Importing one replaces the emulated
network, just like any other network bundle.

Saved/history snapshots include **MAT entries and decoding options**. Registers,
counters, meters, mirror/multicast groups, digest configuration, and queue settings remain live switch state and are not part of
those snapshots. Failed MAT edits compensate individual changes without resetting
the pipeline or unrelated state; concurrent data-plane changes are not an atomic snapshot.

## Versions and compatibility

The root [VERSION](../VERSION) is baked into frontend, backend, and emulator images.
The version dialog distinguishes component versions, client P4Runtime schemas, and
the server's advertised API. Current pins are BMv2 **1.15.7**, p4c **v1.2.5.18**,
official PI/Mininet commits, and P4Runtime client schemas **1.6.0**. Current upstream
PI advertises server API **1.3.0**; newer schemas alone do not implement missing RPCs.
Documented source compatibility/precision/bounds fixes are described in the runtime notes.

At backend startup, one bounded background check reads the official repository's
`main/VERSION`. It only reports updates; it never changes an installation. Set
`UPDATE_CHECK_ENABLED=false` to disable it. Offline or malformed responses do not
prevent startup. See [CHANGELOG](../CHANGELOG.md) for the development changes.

## Development and tests

Use Python 3.12 and Node 24, matching CI and the containers:

```sh
python -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt -r netsim/requirements-dev.txt
PYTHONPATH=.:backend UPDATE_CHECK_ENABLED=false .venv/bin/python -m pytest tests/backend tests/unit tests/netsim runtime/tests
cd frontend
npm ci
npm run lint
npm test
npm run build
npm run dev
```

For real BMv2/browser integration:

```sh
npm --prefix tests/e2e ci
cd tests/e2e && npx playwright install --with-deps chromium && cd ../..
bash scripts/test-e2e.sh
```

The test stack uses isolated network namespaces and volumes/databases. Its UI is
on port 3001 by default (`E2E_UI_PORT` overrides it), so the normal platform can
keep running. It records browser/container artifacts
under `test-results/`, and tears down on exit. Coverage includes compilation,
multiple switches, MAT edits, register/meter round-trips, mirrors, multicast,
digests, counter resets/graphs, queue controls, topology drafting,
traffic-driven state, terminals, snapshots, versions, and device-zero disconnection.
Regenerate protocol bindings offline with `python backend/controller/p4/generate.py`.

## Release automation

After a PR merges into `main` and CI passes, the release workflow promotes the
development version to a stable release, then increments patch versions on later
merges. It reserves the version commit/tag, builds all component images, and publishes
both version and `latest` image tags plus a GitHub release with `UniCorn-P4.tar.gz`. Direct pushes
do not create releases. Failed publication can reuse its reservation on retry.

Configure `DOCKER_USERNAME`/`DOCKER_PASSWORD` secrets for the `unituekn/unicornp4-*`
images, and allow the workflow token to push version commits/tags under the repository's
branch rules. Archives include tracked documentation, compiled examples, and topologies;
they exclude live databases, logs, packet captures, and untracked files. Local development
on the feature branch does not publish a release.
