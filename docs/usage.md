# Using UniCorn-P4

Follow the [quick start](../README.md#quick-start), then open http://localhost:3000.
Programs, topologies and the database persist in the mounted `p4-files/`,
`topologies/` and `database/` directories.

## Compile and initialize a switch

1. Open your main P4 file in **Editor** and choose **Compile**.
2. Build or import a network in **Topology**, then **Deploy topology**.
3. Select a switch tab, open **Edit initialization**, and select a **Compiled program**.
4. Initialize the switch. Repeat after recompiling to apply your changes.

P4Info and BMv2 JSON are paired automatically. Use **Advanced** for custom files.
For Tofino, follow the [Tofino guide](tofino.md).

## Edit P4 programs

Use the file tree to open or create sources and includes. **Ctrl/Cmd+S** saves,
**Ctrl/Cmd+Enter** compiles, and **Focus mode** expands the editor.
Compilation saves modified files and links errors to their source locations.

Drafts survive navigation. If a file changes externally, reload it or use
**Save file copy**. Language-server suggestions help while editing, while the
compiler checks the complete program.

## Create and inspect topologies

Add hosts and switches, then choose **Add link** and click its endpoints.
Drag nodes to arrange them. Select a link to edit latency and bandwidth.
Each host needs one switch link before deployment.

Edits stay in the draft until **Deploy topology**, which recreates the network
and resets switch state. **Terminals** provides host and switch shells.

Topology JSON lives in `topologies/`. For example:

```json
{
  "hosts": ["h1", "h2"],
  "switches": {"s1": {}},
  "links": [["h1", "s1", "2ms", 100], ["h2", "s1"]]
}
```

Latency applies in each direction and bandwidth is in Mbps. Node names end in
a number and have at most 10 characters. The canvas shows actual switch ports.
Use **Import saved**, **Import JSON**, or the topology menu to save/export drafts.

## Use external network interfaces

Connect an emulated switch to a real network by adding `ext_intfs` to its topology
JSON, then import and deploy it in **Topology**:

```json
{
  "hosts": ["h1"],
  "switches": {"s1": {}},
  "links": [["h1", "s1"]],
  "ext_intfs": [["s1", "enp3s0"]]
}
```

Replace `enp3s0` with an existing Linux host interface (`ip -br link`). Each pair
is `[switch, interface]`. Use a dedicated interface, since attaching it can
disrupt host traffic. The supplied Compose setup provides the required host
network access and privileges. The topology view shows the assigned switch port.

The builder preserves these attachments when editing a topology. When importing
a network archive, select **Attach the bundle's physical network interfaces**
to restore them. Missing interfaces, duplicate attachments and `lo` are rejected.

## Work with switch resources

Select a switch and choose a resource in the sidebar. Available controls depend
on the target. Field tooltips explain units and supported settings.

| Screen | Use |
| --- | --- |
| Tables | Read, add, edit, bulk-edit and delete entries. Direct meters and counter plots open from their table row. |
| Counters | Read/reset values and plot packet or bit rates. |
| Registers | Read and edit cells with exact integer values. |
| Meters | Configure rates and bursts. The P4 program decides how to handle meter colors. |
| Mirrors | Configure clone destinations used by the P4 program. |
| Multicast | Configure replication groups selected by the P4 program. |
| Digests | View emitted events and configure delivery where supported. |
| Queues | Configure port rates and supported burst/depth settings. |

The sidebar can be collapsed and resized. BMv2 queue values show settings last
applied through UniCorn because its API has no configuration getters.

## External switches

Use **Connect switch** and select the target and control endpoint.
For BMv2, use the device ID configured on the switch. Registers and queues on
stock BMv2 may need an explicit Thrift endpoint in the connection settings.
For Tofino with an existing controller, use a [read-only connection](tofino.md#external-switches).
See [compatibility](compatibility.md) for target limits.

## Network bundles and samples

The global **Network archive** menu exports topology, sources, compiled programs
and captured switch state. **Import network** restores a bundle onto a fresh
network. Check the report for unavailable state or failed restores.

Try the [sample bundles](../examples/networks/README.md) for forwarding,
multicast, mirroring and metering. Import replaces the running emulated network.
The dashboard's Saved/History snapshots cover MAT entries and display settings,
while network bundles capture the broader switch state.

## Versions and compatibility

Component versions are shown in the UI. Startup checks report available updates
without installing them. Set `UPDATE_CHECK_ENABLED=false` to disable the check.
See [CHANGELOG](../CHANGELOG.md) and [compatibility](compatibility.md).

## Development and tests

Use Python 3.12 and Node 24. From the repository root:

```sh
python -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt -r netsim/requirements-dev.txt
PYTHONPATH=.:backend UPDATE_CHECK_ENABLED=false .venv/bin/python -m pytest tests/backend tests/unit tests/netsim runtime/tests
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
```

Run local source changes with `docker compose -f docker/docker-compose.yaml up --build -d`.
For frontend hot reload, stop the frontend container and run `npm --prefix frontend run dev`.

For browser integration, install Chromium with Playwright and run
`bash scripts/test-e2e.sh`. It uses disposable state on port 3001 and cleans up
afterward. [Native tests](../tests/tofino/README.md) cover the optional Tofino setup.

## Release automation

PR merges to `main` trigger a release after CI passes: version increment,
version/`latest` images, changelog notes and a deployment archive. Direct pushes
do not release. Configure `DOCKER_USERNAME`/`DOCKER_PASSWORD` and allow the workflow
to push version commits/tags. Optional Tofino images have a separate
[publication workflow](../docker/tofino/README.md).
