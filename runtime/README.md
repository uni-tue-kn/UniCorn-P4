# BMv2 P4Runtime register extension

The emulator runs official BMv2 and PI sources pinned in the Dockerfile. PI
supports tables, counters and meters, but returns UNIMPLEMENTED for register
reads and writes. Updating the protocol definitions alone does not implement
register access.

Each emulator switch therefore runs `runtime.register_proxy` on its advertised
P4Runtime port. The proxy forwards pipeline management, arbitration, packets,
tables, counters and meters to the private loopback PI endpoint. It implements
standard `RegisterEntry` Read and MODIFY using BMv2's native Thrift register
operations. Controllers and the web backend continue to use only P4Runtime.
This server extension is part of UniCorn-P4, not an upstream BMv2 feature.

Supported register values are `bit<W>` and `int<W>` with **1 <= W <= 64**,
including P4Info new types with those underlying representations. Wider values
and structured types return UNIMPLEMENTED. Indices are checked against P4Info;
index zero is distinct from an omitted index (wildcard). Values travel through
P4Runtime as bytes, preserving 64-bit precision. Signed values use the standard
sign-extended two's-complement bytestring format. The Thrift i64 transport is
converted to/from the exact bit pattern.

Before any register write, an empty upstream Write request validates the
current primary election, role, and device. Only CONTINUE_ON_ERROR is supported,
matching PI. Per-update failures are reported using `google.rpc.Status` and
P4Runtime Error details. Ordinary upstream errors retain their status/metadata.
The extension supports the default role only; requests using custom roles are
rejected before register access because Thrift cannot enforce PI's per-resource
role policies. Cancellation and deadlines stop native wildcard operations
between individual cell accesses. A partially completed write is not rolled
back after cancellation, consistent with CONTINUE_ON_ERROR semantics.

Register operations are serialized with pipeline changes by the proxy. BMv2's
native register read/write functions acquire the same register-array mutex
used during compiled action execution (`Context::register_read/write`,
`ActionFnEntry::operator()`, and `RegisterSync`). A single-cell control-plane
operation cannot interrupt a compiled action's register operations. Wildcard
register reads are a sequence of single-cell operations and are not an atomic
snapshot relative to packets, consistent with standard P4Runtime wildcard
semantics. Remote switches running stock PI still return UNIMPLEMENTED; the
application must surface that response.

External stock BMv2 connections can explicitly opt into a connection-scoped
adapter by supplying their Thrift host and port. The backend starts a private
loopback P4Runtime extension and continues to use P4Runtime for every request.
No Thrift endpoint is guessed. This mode conservatively accepts widths 1..63:
unpatched upstream BMv2 Thrift saturates values above INT64_MAX, so 64-bit
registers are rejected instead of returning corrupted values. The emulator's
patched native server supports all 64 bits. Disabling the adapter preserves
ordinary table, counter and meter connections to stock external PI servers.

Switch teardown terminates its proxy and BMv2 process. The internal PI listener
uses an ephemeral loopback port; the advertised P4Runtime port is unchanged.

Builds use upstream BMv2 1.15.7, p4c v1.2.5.18, and exact PI/Mininet commits.
Mininet is installed once from its official repository, avoiding the outdated
PyPI package shadowing distro code. Initial source builds can take several
minutes; Docker caches the compiled layers across application changes.

The p4c build applies the included one-line const-correctness portability patch
to the official v1.2.5.18 source: its `std::erase_if` map predicate takes a const
pair on GCC 12. No compiler or language behavior is changed. Release builds use
`-O1` to keep initial development/CI compilation practical.

The BMv2 build applies the included Thrift register precision patch: converting
`Data` directly to signed i64 saturates values above INT64_MAX in upstream
BMv2. Reading via uint64 and casting its bit pattern to the Thrift signed i64
preserves all 64 bits. The patch covers scalar/array reads and scalar/range
writes, interpreting the signed Thrift i64 as an unsigned bit pattern before
constructing the native register value.

The BMv2 build also retains its existing counter, meter, register-read and
register-write bounds checks in release builds. Upstream wraps these four
checks in `#ifndef NDEBUG`, so release mode can dereference outside an array
when a P4 program computes an invalid index. A real lecture aggregation program
triggered this with a non-IPv4 packet and `egress_spec - 1`, terminating the
switch. The included patch removes only those four compile-time guards: an
invalid access logs the existing error and leaves the resource/destination
unchanged. Other release settings and assertions are unchanged.
The integration fixture deliberately executes all four invalid indexed
operations before forwarding real host traffic, so CI verifies that the switch
survives and ordinary forwarding/counter/register operations still work.

The native BMI packet handles are set to nonblocking mode after activation.
BMI already waits for readiness with `select()`; a blocking libpcap read can
otherwise stall packet processing when a Mininet interface is brought down.
This was reproduced by the lecture protection example: baseline duplication
worked, but bringing its primary link down stalled backup clones. Nonblocking
handles restored traffic across both primary and backup link failures without
changing its P4 program or clone sessions.

## Native queue controls

Queue depth (packets) and maximum queue rate (packets/second, zero unlimited)
use BMv2's official target-specific `simple_switch` Thrift service. These
controls are separate from P4Runtime and require an explicitly configured
Thrift host and port. Emulator discovery supplies the actual allocated port;
external endpoints are never guessed. Settings apply to all ports or one port,
across every priority queue. Priority selection is rejected because the native
API does not expose the configured queue count.

The native API exposes setters without configuration getters. GET `/queues`
therefore returns the acknowledged all-port defaults and per-port overrides
from the current connection, with unknown values left unset. All-port updates
clear only matching per-port field overrides. This configuration cache is
independent of the latest 100 acknowledged changes retained as history.
Read-only native port discovery supplies actual port numbers and interface
names; discovery failure leaves acknowledged configuration available and
reports its error. None of these cached settings claim queue readback, and
external changes cannot be detected. Depth and rate are separate native calls:
a failed request reports earlier acknowledged changes, and a transport failure
marks the current call's outcome unknown. Connection replacement clears the
local configuration cache and history.
