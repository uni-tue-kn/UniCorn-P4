#include <core.p4>
#include <tna.p4>

header ethernet_t { bit<48> dst; bit<48> src; bit<16> ether_type; }
struct headers_t { ethernet_t ethernet; }
struct metadata_t { bit<32> packets; bit<32> index; bit<8> color; }

parser IngressParser(packet_in pkt, out headers_t hdr, out metadata_t md,
                     out ingress_intrinsic_metadata_t intrinsic) {
    state start {
        md.packets = 0; md.index = 0; md.color = 0;
        pkt.extract(intrinsic);
        transition select(intrinsic.resubmit_flag) { 0: port_metadata; default: reject; }
    }
    state port_metadata { pkt.advance(PORT_METADATA_SIZE); transition ethernet; }
    state ethernet { pkt.extract(hdr.ethernet); transition accept; }
}
control Ingress(inout headers_t hdr, inout metadata_t md,
    in ingress_intrinsic_metadata_t intrinsic,
    in ingress_intrinsic_metadata_from_parser_t parser_md,
    inout ingress_intrinsic_metadata_for_deparser_t deparser_md,
    inout ingress_intrinsic_metadata_for_tm_t tm_md) {
    Register<bit<32>, bit<32>>(256, 0) packet_register;
    RegisterAction<bit<32>, bit<32>, bit<32>>(packet_register) increment = {
        void apply(inout bit<32> value, out bit<32> result) {
            value = value + 1; result = value;
        }
    };
    Counter<bit<64>, bit<32>>(256, CounterType_t.PACKETS_AND_BYTES) packet_counter;
    Meter<bit<32>>(256, MeterType_t.PACKETS) packet_meter;
    action forward(PortId_t port, bit<32> index) {
        tm_md.ucast_egress_port = port;
        md.index = index;
        deparser_md.drop_ctl = 0;
    }
    action drop() { deparser_md.drop_ctl = 1; }
    table forwarding {
        key = { intrinsic.ingress_port: exact; }
        actions = { forward; drop; }
        size = 256;
        default_action = drop();
    }
    action track() {
        md.packets = increment.execute(md.index);
        packet_counter.count(md.index);
    }
    table tracking { size = 1; actions = { track; } const default_action = track(); }
    action measure() { md.color = packet_meter.execute(md.index); }
    table metering { size = 1; actions = { measure; } const default_action = measure(); }
    apply {
        tm_md.bypass_egress = 1;
        forwarding.apply();
        tracking.apply();
        metering.apply();
    }
}
control IngressDeparser(packet_out pkt, inout headers_t hdr, in metadata_t md,
    in ingress_intrinsic_metadata_for_deparser_t deparser_md) {
    apply { pkt.emit(hdr); }
}
parser EgressParser(packet_in pkt, out headers_t hdr, out metadata_t md,
    out egress_intrinsic_metadata_t intrinsic) { state start { md.packets = 0; md.index = 0; md.color = 0; transition accept; } }
control Egress(inout headers_t hdr, inout metadata_t md,
    in egress_intrinsic_metadata_t intrinsic,
    in egress_intrinsic_metadata_from_parser_t parser_md,
    inout egress_intrinsic_metadata_for_deparser_t deparser_md,
    inout egress_intrinsic_metadata_for_output_port_t output_md) { apply {} }
control EgressDeparser(packet_out pkt, inout headers_t hdr, in metadata_t md,
    in egress_intrinsic_metadata_for_deparser_t deparser_md) { apply {} }
Pipeline(IngressParser(), Ingress(), IngressDeparser(), EgressParser(), Egress(), EgressDeparser()) pipe;
Switch(pipe) main;
