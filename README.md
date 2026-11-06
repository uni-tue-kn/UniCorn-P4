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

- **Edit and compile P4** with a browser editor, completion and diagnostics.
- **Build networks** with a visual Mininet editor and host/switch terminals.
- **Connect switches** using BMv2, optional Tofino models, or external devices.
- **Program resources** including tables, registers, meters, mirror sessions and multicast groups.
- **Inspect traffic** with counters, throughput plots, digests and queue controls.
- **Export/import networks** with their topology, programs and captured switch state.

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

Also available in dark mode: [topology](docs/screenshots/topology-dark.png) · [throughput](docs/screenshots/counters-dark.png).

## Quick start

You need Linux and Docker with Compose v2.

```sh
git clone https://github.com/uni-tue-kn/UniCorn-P4.git
cd UniCorn-P4/docker
docker compose pull
docker compose up -d
```

Open http://localhost:3000. Put P4 files in `docker/p4-files/` and topology JSON
in `docker/topologies/`. Compile a program, deploy a topology, then initialize a switch.

Try a [sample network bundle](examples/networks/README.md) through the global
**Network archive** menu.

Or extract a [release archive](https://github.com/uni-tue-kn/UniCorn-P4/releases)
and run the same Compose commands from its `UniCorn-P4/` folder.
Both use published `latest` images. For source changes, see
[development and tests](docs/usage.md#development-and-tests).

## Target support

BMv2 is included. The optional [Tofino setup](docs/tofino.md) adds the Open P4Studio
model and compiler. Both targets share the same resource screens.

[Usage guide](docs/usage.md) · [Physical interfaces](docs/usage.md#use-external-network-interfaces) · [Compatibility](docs/compatibility.md) · [Changelog](CHANGELOG.md)
