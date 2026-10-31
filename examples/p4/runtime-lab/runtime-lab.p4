/* Small Ethernet resource lab for the bundled BMv2 v1model runtime. */
#include <core.p4>
#include <v1model.p4>

header ethernet_t {
    bit<48> destination;
    bit<48> source;
    bit<16> ether_type;
}
struct headers_t { ethernet_t ethernet; }
struct metadata_t { bit<2> ingress_color; bit<2> flow_color; }
struct packet_digest_t { bit<9> ingress_port; bit<48> src_mac; }

parser LabParser(packet_in packet, out headers_t hdr, inout metadata_t meta,
              inout standard_metadata_t standard_metadata) {
    state start {
        packet.extract(hdr.ethernet);
        transition accept;
    }
}
control LabVerifyChecksum(inout headers_t hdr, inout metadata_t meta) { apply { } }

control LabIngress(inout headers_t hdr, inout metadata_t meta,
                inout standard_metadata_t standard_metadata) {
    counter(16, CounterType.packets_and_bytes) port_counter;
    register<bit<32>>(16) packet_count;
    register<bit<64>>(16) wide_packet_count;
    meter(16, MeterType.packets) port_meter;
    direct_meter<bit<2>>(MeterType.packets) flow_meter;

    action send(bit<9> port) {
        flow_meter.read(meta.flow_color);
        standard_metadata.egress_spec = port;
    }
    action send_and_mirror(bit<9> port) {
        flow_meter.read(meta.flow_color);
        standard_metadata.egress_spec = port;
        clone(CloneType.I2E, 20);
    }
    action multicast(bit<16> group) {
        flow_meter.read(meta.flow_color);
        standard_metadata.mcast_grp = group;
    }
    action metered_send(bit<9> port) {
        flow_meter.read(meta.flow_color);
        if (meta.flow_color == 2) {
            mark_to_drop(standard_metadata);
        } else {
            standard_metadata.egress_spec = port;
        }
    }
    action drop() {
        flow_meter.read(meta.flow_color);
        mark_to_drop(standard_metadata);
    }
    table forward {
        key = { standard_metadata.ingress_port: exact; }
        actions = { send; send_and_mirror; multicast; metered_send; drop; }
        meters = flow_meter;
        size = 16;
        default_action = drop();
    }
    apply {
        if (hdr.ethernet.isValid()) {
            // These arrays cover ports 0..15. Count before forwarding so an
            // observer also counts packets that its default action drops.
            if (standard_metadata.ingress_port < 16) {
                bit<32> previous;
                bit<64> previous_wide;
                port_counter.count((bit<32>) standard_metadata.ingress_port);
                port_meter.execute_meter((bit<32>) standard_metadata.ingress_port,
                                         meta.ingress_color);
                @atomic {
                    packet_count.read(previous, (bit<32>) standard_metadata.ingress_port);
                    packet_count.write((bit<32>) standard_metadata.ingress_port, previous + 1);
                    wide_packet_count.read(previous_wide, (bit<32>) standard_metadata.ingress_port);
                    wide_packet_count.write((bit<32>) standard_metadata.ingress_port, previous_wide + 1);
                }
            }
            // P4Runtime controls whether the runtime delivers these events.
            digest<packet_digest_t>(1, { standard_metadata.ingress_port,
                                       hdr.ethernet.source });
            forward.apply();
        } else {
            mark_to_drop(standard_metadata);
        }
    }
}

control LabEgress(inout headers_t hdr, inout metadata_t meta,
               inout standard_metadata_t standard_metadata) { apply { } }
control LabComputeChecksum(inout headers_t hdr, inout metadata_t meta) { apply { } }
control LabDeparser(packet_out packet, in headers_t hdr) {
    apply { packet.emit(hdr.ethernet); }
}
V1Switch(LabParser(), LabVerifyChecksum(), LabIngress(), LabEgress(),
         LabComputeChecksum(), LabDeparser()) main;
