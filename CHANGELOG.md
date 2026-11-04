# Changelog

## Unreleased — 1.2.3

### Added

* Optional official Open P4Studio Tofino models and matching compiler, with per-switch target selection and mixed BMv2/Tofino topologies.
* Shared native table, register, counter, meter, digest, mirror, multicast, and port-shaping controls, including structured registers with exact integer values.
* Portable native program bundles, target-aware network archives, asynchronous model deployment and import progress, and official TNA headers in the editor.
* Native model and browser validation using the public Tofino workshop P4 program, plus an optional cached CI workflow for the full SDK build.
* Read-only connections to external Tofino switches alongside their existing controller, with automatic program discovery and writes blocked in the UI and backend.
* New switch connections automatically suggest the next available local ID, with a manual override.
* Optional Tofino release images with version and `latest` tags, a native validation gate before publishing, and a pull-only Compose override in the deployment archive.
* Tofino builds use the pinned public `n1tr0-5urf3r/open-p4studio` SDK image by default. Source compilation remains an explicit maintainer option.

### Changed

* Deployment archives include only Compose/runtime files, public examples and user documentation. Build/test instructions and preview images stay in the repository.
* Legacy preview images are stored in `docs/screenshots/`.
* GitHub release notes start with concise launch instructions for BMv2 and optional Tofino models.
* Program listings skip artifact hashing. Successful Tofino compiles clean older unused builds while preserving builds used by initialization, connected switches and saved/history states.

### Fixed

* Restored physical network interface setup instructions in the usage guide and deployment archive.
* Editing saved switch connections preserves the target, target options and register-adapter settings.
* Late BF Runtime stream readers cannot overwrite the replacement connection's state.
* Native IPv6 values encode correctly, and read-only table fields no longer block entry edits or restores.
* Automatic target detection skips unavailable includes and rejects unsupported Tofino 2 programs before compilation.
* Topology deployment bounds every request and the complete operation, with retries for transient polling failures.
* Native network archives retain default table actions, their parameters, and attached direct meters.
* Native archives omit fields that cannot be written back and report partial state instead of rejecting their own exports.
* Closed native control streams report a disconnected state instead of appearing healthy.
* Quoted standard SDK includes compile and survive network export/import while local header overrides remain frozen with the program.
* Terminal failures no longer misreport successful network deployment or clear the prior topology before replacement begins.

## 1.2.2 — 2026-11-03

### Added

* A dedicated P4 Editor tab with a workspace file tree, Monaco editing, multiple file tabs, file creation, and integrated save/compile output with clickable diagnostics.
* Local P4 language-server syntax diagnostics and scoped completion for unsaved buffers, using a pinned upstream server from the P4 VS Code extension.
* Atomic workspace saves with external-edit conflict detection, host file ownership preservation, read-only generated artifacts, and unsaved-buffer recovery.
* Per-entry direct-counter throughput plots in a dialog, with packet/bit rates and polling only while open.

### Changed

* Topology imports have visible saved-file and local-JSON buttons with icons and tooltips above the canvas.
* The former P4 Compile tab is integrated into Editor, with existing `/compile` links redirected to the new workspace.
* A consistent compact navigation header across all tabs. Editor fills the available window with compact controls, optional focus mode, and compiler output that opens on demand.
* Editor remembers folder expansion, search, and tree scroll position across navigation and reloads in the current browser session.
* Successful compilation reminds users to load the updated program onto their switches.

### Fixed

* Switch tabs retain their DOM and focus during background updates instead of being remounted and flickering.
* Terminals follow continuous output automatically, pause when scrolling up, and offer a jump to the latest output.
* Network imports with uncaptured or skipped state show warnings instead of failure feedback, while actual restore failures remain visible.
* P4 language diagnostics and completion preserve Windows line-ending positions and analyze included buffers in their parent program's macro and parser context.
* Rapidly closing and reopening editor files preserves language-server synchronization, including while earlier requests are pending.
* Language sessions can close externally removed or replaced buffers, and saves detect external edits made immediately after the atomic write.

## 1.2.1 — 2026-11-01

### Security

* Updated the backend and emulator Python Thrift runtime from 0.22.0 to 0.25.0 to address dependency security advisories, including CVE-2026-41608, CVE-2026-43871, and CVE-2026-66053.

### Changed

* Release bundles use the published `latest` Docker image tags so `docker compose pull` updates an existing deployment to the latest release.

## 1.2.0 — 2026-10-31

### Added

* Read and edit indexed registers, meters, and per-entry direct meters in the UI through P4Runtime.
* Bundled BMv2 P4Runtime register extension for signed and unsigned registers up to 64 bits, with lossless decimal/hexadecimal/binary display.
* Per-switch register capability reporting and an explicit adapter option for external BMv2 switches with an operator-configured Thrift endpoint.
* Mirror-session management using P4Runtime clone sessions, including destination replicas and target-validated optional settings.
* Multicast groups and a bounded digest event viewer using standard P4Runtime entities and streaming notifications.
* Counter resets through P4Runtime and live packet/bit-rate graphs with a bounded sampling window.
* Explicit BMv2 Thrift queue depth and packet-rate controls with connection-local change history.
* Visual topology drafting with draggable and keyboard-movable hosts/switches, links created directly between canvas nodes, latency/bandwidth editing, and saved node positions.
* One combined topology live view/editor with portable JSON import/export, deployment snapshots, and actual port labels.
* A global network archive menu for topology/layout, active P4 sources/includes, compiled pipelines, and readable switch state, with validated import and dependency-ordered restoration.
* Five importable sample networks demonstrating forwarding, multicast, mirroring, metering/queues, and a four-switch telemetry showcase, with public P4 source and a reproducible archive generator.
* One compiled-program selector for initialization, with automatic P4Info/BMv2 pairing and an advanced manual override.
* Component versions from a root `VERSION` file and a bounded, optional upstream update check at startup.
* Backend, emulator, register-extension, component, real-switch, and Playwright regression tests with isolated databases and volumes.
* Automatic version increments and GitHub releases after successful CI for pull requests merged into `main`.
* Release text from the matching changelog section, with Unreleased headings promoted to the final version and release date.
* Versioned and `latest` Docker tags for every released component, with protection against older retries replacing newer images.
* Download-ready `UniCorn-P4.tar.gz` release assets containing version-pinned Compose configuration, compiled sample programs, topologies, and a fresh database directory.

### Changed

* Migrated the frontend from Create React App to Vite and a static nginx production image; updated React, MUI, routing, and test dependencies.
* Updated BMv2 to 1.15.7 and p4c to v1.2.5.18, with pinned official PI and Mininet source revisions.
* Removed the obsolete PyPI Mininet prerelease that shadowed the distribution installation; the emulator now installs one official source revision with matching `mnexec`.
* Regenerated all bundled Python protobuf bindings from pinned official sources using modern protobuf and gRPC tooling. Client schemas are P4Runtime 1.6.0; the current upstream PI server advertises API 1.3.0.
* Centralized HTTP and WebSocket routing behind same-origin proxies, allowing UI access from another machine.
* Direct-meter configuration now opens from its owning MAT row in a focused modal.
* Queue controls show per-port last-configured values, with unknown fields explicit and detailed history available separately.
* Digest events show compact field/value records with technical metadata under Details.
* Topology file actions use a compact menu and focused dialogs, with selected-link settings beside the canvas.
* The resource sidebar has distinct icons, a collapsible icon rail, and a resizable width remembered between visits.
* Separate Topology and Terminals tabs share the running network, with bounded terminal output and selection preserved while navigating between pages.
* Added operation progress/completion feedback, clearer meter semantics and unit tooltips, and improved dark-mode/button/navigation contrast.
* Added reproducible npm lockfiles, source build pins, and cached CI image builds.

### Fixed

* Failed MAT edits no longer reset the entire pipeline or erase unrelated entries and register/meter state.
* Bulk MAT deletion and compensating writes now preserve captured direct-resource values.
* Disconnecting device ID zero no longer disconnects every switch.
* Counter reads retain every streamed response, honor index zero, and associate direct counters by normalized table-entry keys.
* Existing pipelines discovered on connection now create the resource managers needed for table operations.
* “Keep existing entries” preserves an identical active program and rejects unsafe replacement with a different pipeline.
* Removed render-time status/log requests and corrected stale switch-selection/pipeline responses, theme persistence, and large-integer rounding.
* Corrected terminal/topology lifecycle races and validated replacement topologies before dismantling the active network.
* Deployment rejects unattached or multiply connected hosts before replacing the running network, while incomplete drafts remain saveable.
* Deployment checks generated Linux interface-name lengths before replacing the running network.
* Network import reports show top-level and resource restoration failures, and external Thrift mappings honor the displayed default port.
* Link delays containing whitespace, such as `2 ms`, are normalized before Linux traffic control applies them.
* Direct-meter match keys retain exact wide integers through JSON, including nested LPM, ternary, and range values.
* Compiler errors and disconnected servers now show readable feedback without crashing the UI, and source paths containing apostrophes remain intact.
* Hosts allow explicit IPv6 and SIT tunnel configuration while automatic router discovery and address configuration remain disabled.
* Existing databases receive additive external-adapter fields without losing saved switch or MAT state.
* Applied documented upstream-source patches for a p4c GCC 12 predicate compatibility issue and BMv2 native Thrift register conversions above the signed 64-bit boundary.
* Kept BMv2 counter, meter, and register index guards active in release builds so invalid P4 indices do not crash the emulator.
* Made BMv2 packet capture nonblocking to keep cloned traffic moving when a primary link goes down.

### Compatibility

* Stock external BMv2/PI switches do not implement register P4Runtime RPCs. Tables, counters, meters, and supported clone sessions remain usable; register access requires the bundled extension or an explicitly configured external adapter.
* The conservative adapter for an unmodified external Thrift server supports register widths up to 63 bits; the bundled patched emulator supports up to 64 bits.
* Saved snapshots contain MAT state and decoding options. Registers, counters, meters, and mirror sessions remain live switch resources.
* Full network exports capture readable runtime resources while traffic may still be changing. The manifest records unavailable state. External targets and physical interface attachments require explicit destination choices during import.

## v1.0
* Initial release of UniCorn-P4
