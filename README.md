<p align="center">
  <img src="logo.png" alt="UniCorn-P4 logo" width="150">
</p>

<h1 align="center">UniCorn-P4</h1>

<p align="center">
  A browser-based P4 development platform: program switches, inspect state, and build emulated networks.
</p>

<p align="center">
  <a href="https://github.com/uni-tue-kn/UniCorn-P4/actions/workflows/docker-image.yml"><img src="https://github.com/uni-tue-kn/UniCorn-P4/actions/workflows/docker-image.yml/badge.svg" alt="Tests and build status"></a>
  <img src="https://img.shields.io/badge/control_plane-P4Runtime-7b4ca0" alt="P4Runtime control plane">
  <img src="https://img.shields.io/badge/Python-3.12-3776ab?logo=python&amp;logoColor=white" alt="Python 3.12">
  <img src="https://img.shields.io/badge/React-19-61dafb?logo=react&amp;logoColor=black" alt="React 19">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
</p>

<p align="center">
  <img src="docs/screenshots/topology.png" alt="Interactive topology editor with link settings" width="1100">
</p>

## From P4 program to running network

- **Build and visualize networks** with Mininet, a drag-and-drop topology editor, saved layouts, interface maps, and per-node terminals.
- **Program match-action tables** discovered from P4Info, with single/bulk editing, filtering, decoding, and saved MAT snapshots.
- **Inspect live traffic** with counters, resets, traffic graphs, and digest events emitted by your program.
- **Configure registers and meters** through P4Runtime, with precise integer values and per-entry direct meters.
- **Manage packet replication** through mirror sessions and multicast groups.
- **Tune BMv2 queues** with per-port depth and packet-rate controls.

<table>
  <tr>
    <td><img src="docs/screenshots/tables.png" alt="Match-action table editor"></td>
    <td><img src="docs/screenshots/registers.png" alt="Register values and editing"></td>
  </tr>
  <tr>
    <td align="center"><strong>Match-action tables</strong></td>
    <td align="center"><strong>Lossless register values</strong></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/meters.png" alt="Meter rate and burst configuration"></td>
    <td><img src="docs/screenshots/mirrors.png" alt="Mirror session management"></td>
  </tr>
  <tr>
    <td align="center"><strong>Meters and direct meters</strong></td>
    <td align="center"><strong>Mirror sessions</strong></td>
  </tr>
</table>

<details>
  <summary><strong>Traffic and control-plane tools</strong></summary>
  <br>
  <img src="docs/screenshots/counters.png" alt="Live counter traffic graphs and reset controls">
  <img src="docs/screenshots/multicast.png" alt="Multicast group configuration">
  <img src="docs/screenshots/digests.png" alt="Digest configuration and received events">
  <img src="docs/screenshots/queues.png" alt="BMv2 queue depth and rate controls">
</details>

_The topology and throughput screenshots show the campus telemetry example with real emulated traffic._

## Quick start

You need Linux and Docker with Compose v2.

```sh
git clone https://github.com/uni-tue-kn/UniCorn-P4.git
cd UniCorn-P4/docker
docker compose pull
docker compose up -d
```

Open http://localhost:3000. Put your P4 files in `p4-files/` and topology JSON in
`topologies/` inside the current `docker/` directory, then compile, load a topology,
and initialize a switch. This uses the published `latest` images. For local source
changes, see [development and tests](docs/usage.md#development-and-tests).

Try the [sample network bundles](examples/networks/README.md) for forwarding,
multicast, mirroring, and metering demonstrations. Import a bundle from the global network archive menu.

Published [release archives](https://github.com/uni-tue-kn/UniCorn-P4/releases) use
the same deployment layout: extract `UniCorn-P4.tar.gz`, enter `UniCorn-P4/`, and run
`docker compose pull` followed by `docker compose up -d`.

## Target support

The bundled BMv2 emulator supports scalar registers up to **64 bits** through a
P4Runtime server extension. Stock external BMv2/PI needs the explicit register
adapter, which conservatively supports up to **63 bits**. Tables, counters, meters,
and supported mirror sessions continue to use standard P4Runtime operations.

See the [usage guide](docs/usage.md) for setup, resource workflows, external switches,
testing, and releases. The [runtime notes](runtime/README.md) explain compatibility
limits. Component versions are shown in the UI and recorded in [VERSION](VERSION).
Development changes are listed in the [changelog](CHANGELOG.md).
