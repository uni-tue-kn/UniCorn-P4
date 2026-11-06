Native proof must use actual `tofino-model`, `bf_switchd`, and compiled artifacts.

Run the full shared-UI integration from the repository root with
`bash scripts/test-tofino.sh`. It provisions both the pinned public workshop and
the BMv2 resource sample, starts an isolated stack on port 3002, and removes its
containers and volumes afterward. Install the Playwright browser first with
`npm --prefix tests/e2e ci` and `cd tests/e2e && npx playwright install chromium`.
Use `E2E_SKIP_BUILD=true` for already built test images, or
`E2E_KEEP_RUNNING=true` to inspect the disposable stack afterward.

`native_smoke.py` runs with the official SDK's `bfrt_grpc.client` Python paths,
program `unicorn_resources`, BFRT endpoint 127.0.0.1:50052, and veth peers
`uttest0`/`uttest1` connected to native ports 0/1 for Tofino 1 or 8/9 for
Tofino 2. It writes forwarding, register,
counter and meter resources and checks a real 60-byte Ethernet frame and native
register/counter changes. It is intentionally not a mocked unit test.

Fresh dual-generation SDK verification passed on 2026-11-06:

* Open P4Studio `6d8b203700e3ca0f1208418072f88dc4a6a597e8` and matching
  p4c `ff5070480d76cd171df54051404f118d005fbf5e` built one SDK image containing
  both model/compiler families.
* The real Tofino 1 model forwarded a 60-byte frame from device port 0 to 1;
  the real Tofino 2 model forwarded the same frame from its front-panel ports
  8 to 9. Each run updated register cell 7 from 100 to 101, counted one packet
  and 64 bytes, and returned the configured meter state.
* The Tofino 1 priority case and official-SDK structured-register test also
  passed. The complete runner ended with
  `PASS: native compiler/model/driver lifecycle smoke`.
* The validated image was published as
  `unituekn/unicornp4-tofino-sdk:tofino1-tofino2-6d8b203` and normal builds pin
  digest `sha256:b6a4c770c9c483a2b125e4de4c3d32eb7d046a6e69648c534707ac7a655904a3`.

Fresh pinned official-source verification passed on 2026-11-04:

* open-p4studio `6d8b203700e3ca0f1208418072f88dc4a6a597e8` and matching p4c
  `ff5070480d76cd171df54051404f118d005fbf5e`; actual compiler version 1.2.5.17.
* SDK source build, compiler image, and final runtime/backend images built
  successfully, using the current SDK-free application bases.
* The full `scripts/validate-tofino-release.sh` gate passed: real model/driver
  lifecycle with resources, unmodified pinned workshop and structured-register
  programs; actual HTTP compilation/errors/path confinement; and the finished
  runtime plus common backend's structured-register checks.
* The single-pipe resource program forwarded 60 bytes, updated register cell 7
  to 101, counted one packet/64 bytes, and passed quantized meter readback.
* Additional common-adapter checks passed against the finished latest images:
  register/counter/meter operations, mirror and multicast CRUD/cleanup, port PPS
  shaping, workshop 32/16-bit registers, regular-entry direct-counter reset,
  direct byte-meter roundtrip, table/default reads and typed timestamp digests.

The fresh build required shallow first-level gRPC dependency fetches while
retaining its original re2 cherry-pick object. SDK preparation accepts the
compiler's actual seven-character SHA after checking full source Git pins.
These build adaptations and cached dependency/object layers are documented in
`docker/tofino/README.md`. All verification used isolated containers with no host
ports or host hugepage changes. Exact image IDs, binary hash and complete logs
were recorded in the repository's ignored `.cache/tofino-latest-*` proof files.

Observed cached official-source image verification (2026-11-03):

* open-p4studio `caf41f60aab293e32ccdb85e292433acdb1849b1` and matching p4c
  `17ade03c106793ef0d3cd15a3f789de2760ed486`.
* Real model started successfully with the explicit simulator DMA adaptation;
  no host settings were changed.
* Forwarded 60 bytes; register cell 7 changed 100→101 in ingress pipe 0 and remained
  100 in pipes 1..3; native packet counter 1 and byte counter 64 (including FCS).
* Meter writes/readback worked, including native hardware quantization:
  CIR 1000000→998787, PIR 2000000→1997574, CBS 10000→9984, PBS 20000→19968.

These historical results cover the older cached SDK; the completed fresh build
and its native verification are recorded above.

`workshop_smoke.py` validates the unmodified user-provided
`n1tr0-5urf3r/tofino-rbfrt-workshop` revision
`336f13b0291c913c58babf74bd7b1399d4391d13` compiled for Tofino1. Real model
validation passed:16 random-branch IPv4 packets distributed over ports 0/1, a
UDP CRC hash lookup overriding the output port, TTL/checksum updates, 32+16 bit
MAC timestamp register writes, time-series pointer 17, direct packet counter 17,
quantized direct byte meter, actual red-meter drop and 17 native BFRT digests.
The original upstream P4 files and includes were compiled without source edits.
`compiler_smoke.py` checks actual HTTP compilation, diagnostic propagation and
shared-volume path confinement.

Both native tests were repeated successfully with `pipe_scope:[0]`, the default
bundle profile. Register reads then contain only pipe 0, and the native sample
again returned 101, one packet and 64 bytes. The workshop repeated all dataplane
checks with scalar single-pipe register values and direct counter 17.

The namespace relay was also tested in a minimal trusted Ubuntu container with
no workspace mounts, a read-only filesystem, disabled external networking and
only namespace capabilities. A private-namespace echo listener was inaccessible
from the root namespace; the BFRT relay preserved 65536 random bytes across it.

Run the native suites through one lifecycle runner in the freshly built image:

```sh
docker run --rm --name unicorn-tofino-ci --cap-add NET_ADMIN --cap-add NET_RAW \
  --mount type=bind,src="$PWD/tests/tofino",dst=/tests,readonly \
  --mount type=bind,src="$PWD/examples/p4/tofino",dst=/sources,readonly \
  --mount type=bind,src="$PWD/.cache/tofino-rbfrt-workshop",dst=/workshop,readonly \
  --entrypoint bash unicorn-tofino-compiler:official /tests/run_native.sh
```

The workshop mount is optional. The runner compiles source, creates private
veths, starts and waits for the real model/driver, runs packet/resource checks,
and terminates both native processes before the next program. It requires no
host networking or host hugepage changes.

The common application adapter was additionally validated against the actual
single-pipe model: register read/write, indirect counter read/reset, indirect
meter write/read with quantization, mirror CRUD, multicast CRUD with owned-node
cleanup and per-port PPS shaper write/read/disable. Against the workshop it
passed 32/16-bit register reads, regular direct-counter reset, direct byte-meter
roundtrip, table CRUD/default reads and typed 48-bit timestamp digest reception.

A limitation was reproduced in the cached older driver: resetting a direct
counter attached to a *default* entry and then reading hardware statistics can
assert in `pipe_mgr_stat_mgr_process_lock_ack_msg` and stall that statistics
thread. The adapter rejects that operation explicitly. This does not affect the
verified regular-entry direct counters. The official BFRT server also owns
digest acknowledgement; explicitly sending `StreamDigestAck` returns
UNIMPLEMENTED, so the adapter uses server acknowledgement.

`structured_register.p4` and `structured_register_smoke.py` close the native
structured-value coverage gap through the common application adapter. The real
model exposed two independent unsigned 32-bit fields. Full writes/readback
preserved 4294967295 exactly; modifying one component with the complete typed
value preserved the other field and the neighboring cell. Incomplete structured
writes were rejected without mutation. The disposable model was separate from
the integration workshop switch.

The read-only observer was also verified against an external two-pipe program
with another controller already running. A client interceptor allowed only
`GetForwardingPipelineConfig` and `Read` RPCs. Program discovery, a selected-pipe
register cell, an indexed meter, and a match table were readable without a
subscription or `BIND`. Attempts to write or initialize were rejected before
an RPC was sent. External switch addresses and live state are not test fixtures.

The one native runner also exercises the structured fixture with the official
SDK Python client. `structured_register_smoke.py` separately verifies the common
application adapter, whose generated grpc/protobuf versions differ from the
SDK's Python environment; that adapter proof was run from the current backend
image against the disposable model namespace.

A fresh SDK source build runs on the prepared VM, not in GitHub Actions. Reserve
at least 60GB available disk and 16GB RAM (32GB preferred) for the image and
build cache. The optional release workflow instead pulls the installed SDK by
digest and builds the compiler, runtime, and backend in independent standard
hosted-runner jobs. Compiler validation and the two runtime generations also
run independently; a runtime job removes the compiler image after producing its
test bundle so it remains below the hosted runner's disk limit.

Prebuilt SDK packaging was then validated through the production Dockerfile
`SDK_IMAGE` hook, not only a prototype image. The known cached SDK digest was
`sha256:1431aaa7183f30191c16fda9880dc916b3e73fc2db14e93dc45177a48291412c`;
its actual source pins were `caf41f60aab293e32ccdb85e292433acdb1849b1` and
`17ade03c106793ef0d3cd15a3f789de2760ed486`. The source stage was skipped.
A prepared SDK was reused without rebuilding it; sample/workshop/structured
native suites passed after normalization to `/opt/open-p4studio/install`.
The final runtime/backend targets were built on SDK-free standard source bases.
With the old `/open-p4studio` path absent, real model startup and common-adapter
register/counter/meter/mirror/multicast/port-shaper checks all passed. This
validates the prebuilt path; the newer pinned source build passed separately as
recorded above.

On 2026-11-04 the public SDK became the default for the Dockerfile, both Compose
overrides and optional releases. All three image targets built without SDK or
revision overrides, skipping source compilation. The full native release gate
passed again, including workshop packets, compiler diagnostics and structured
register read/write through the finished backend. Release and Compose regression
checks passed (49 tests), including an explicit SDK override.
