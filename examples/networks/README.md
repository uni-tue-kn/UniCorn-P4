# Network examples

These small Ethernet networks demonstrate the UI and runtime resources using the public [runtime-lab P4 program](../p4/runtime-lab/runtime-lab.p4).

Open **Network archive** in the header, choose **Import network**, select a ZIP, review the preview, then choose **Import and deploy**. Importing replaces the running emulated network and its runtime state. Keep **Restore recorded queue settings** enabled for the queue example.

| Archive | Network and behavior | Try it |
| --- | --- | --- |
| [two-host-forwarding.zip](two-host-forwarding.zip) | `h1 — s1 — h2`; ingress ports 1 and 2 forward to each other. Packet/byte counters, 32/64-bit packet-count registers, and a source-MAC digest are available. | In the h1 terminal, run `ping -c 4 10.0.1.2`. Read counter/register index 1 and the digest events on s1. |
| [multicast-hub.zip](multicast-hub.zip) | Three hosts connect to s1. Groups 101, 102 and 103 replicate each ingress port to the other two ports. | Ping h2 from h1. Compare `ip -s link show dev h3-eth0` in h3 before and after to see the additional copies. A host discards unicast frames addressed to another MAC. |
| [mirror-observer.zip](mirror-observer.zip) | h1 and h2 use s1 ports 1 and 2. Clone session 20 copies h1 traffic to s1 port 3 and s2 port 1. The observer counts packets before dropping them. | Ping h2 from h1, then read s2 counter/register index 1. s2 deliberately has no forwarding entries. |
| [metering-queues.zip](metering-queues.zip) | h1→h2 uses a direct packet meter with CIR/PIR 5/10 packets/s and bursts 2/4 packets. Egress port 2 has depth 8 and rate 10 packets/s. | Start with `ping -c 4 10.0.1.2`, then try `ping -c 30 -i 0.02 10.0.1.2`. Bursty traffic can experience drops and queueing delay. Inspect the entry's direct meter and Queues. |
| [campus-telemetry.zip](campus-telemetry.zip) | Six hosts and four switches. The h1↔h2 circuit crosses all four switches, with mirroring, a multicast side branch, meters, registers, digests, and queue settings. | Ping `10.0.1.2` from h1 and `10.0.4.6` from h5. Open s1 counter index 1 and vary ping intervals and payload sizes to see changing traffic rates. |

The campus example leaves h3 and h4 available for your own experiments, with their forwarding entries initially unset.

Use the **Terminals** tab for host and switch commands. Open a second browser window beside the first to view live counter graphs while generating traffic. Counter polling pauses when its page is hidden. Counters can be reset from their resource page; registers and meters can be edited independently.

The program covers ingress ports 0–15 with `LabIngress.port_counter`, `LabIngress.packet_count` and `LabIngress.wide_packet_count`. Its independent `LabIngress.port_meter` executes for those ports. The forwarding action `metered_send` drops red packets from `LabIngress.flow_meter`; the other forwarding actions expose the direct meter without using its color to drop traffic. `packet_digest_t` reports ingress port and source MAC when enabled through P4Runtime. Disabling the digest leaves forwarding unchanged.

Each ZIP contains a topology with layout, the P4 source, compiled BMv2/P4Info artifacts, and captured switch state. Live capture is a best-effort snapshot: traffic can change counters while it is being read. The import report identifies unavailable or failed state. Digest event history and terminal output are transient. Queue values are acknowledged settings recorded by this application, rather than switch readback; external queue changes cannot be detected. Review the restored values before drawing conclusions about traffic rates.

## Regenerate

From a repository checkout, use a disposable local stack on a separate frontend port, such as 3001, with `UPDATE_CHECK_ENABLED=false` on its backend. The backend and emulator must share writable topology storage. Copy the public source into that backend's P4 volume:

```sh
SAMPLE_BACKEND_CONTAINER=unicorn-samples-backend-1
docker exec "$SAMPLE_BACKEND_CONTAINER" mkdir -p /p4/samples
docker cp examples/p4/. "$SAMPLE_BACKEND_CONTAINER":/p4/samples/
python3 scripts/create-sample-networks.py \
  --base-url http://127.0.0.1:3001/api \
  --output-dir examples/networks
```

The generator replaces that isolated network for each example, compiles the public source, configures each scenario through REST, checks resource readback, then downloads and validates its archive. It rejects the default application ports, non-loopback addresses, enabled update checks, and a missing known source path. It leaves the last example running for inspection. Packet-level validation can then be performed with the commands above.
