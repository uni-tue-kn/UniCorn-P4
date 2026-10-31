/* Integration fixture: exercise every supported runtime resource with real packets. */
#include <core.p4>
#include <v1model.p4>

header ethernet_t { bit<48> dst_addr; bit<48> src_addr; bit<16> ether_type; }
struct headers_t { ethernet_t ethernet; }
struct metadata_t { bit<2> color; }
struct traffic_digest_t { bit<9> ingress_port; bit<48> source_mac; }

parser ParserImpl(packet_in packet, out headers_t hdr, inout metadata_t meta,
                  inout standard_metadata_t standard_metadata) {
    state start { packet.extract(hdr.ethernet); transition accept; }
}
control VerifyChecksumImpl(inout headers_t hdr, inout metadata_t meta) { apply { } }
control IngressImpl(inout headers_t hdr, inout metadata_t meta,
                    inout standard_metadata_t standard_metadata) {
    register<bit<32>>(8) test_register;
    register<bit<64>>(4) wide_register;
    register<int<17>>(4) signed_register;
    register<int<64>>(4) signed_wide_register;
    counter(8, CounterType.packets_and_bytes) test_counter;
    direct_counter(CounterType.packets_and_bytes) test_direct_counter;
    meter(8, MeterType.packets) test_meter;
    direct_meter<bit<2>>(MeterType.packets) test_direct_meter;

    action observe() {
        test_direct_counter.count();
        // Regression: an invalid dynamic index in a student program must not
        // crash the release runtime or corrupt its valid counter/register cells.
        bit<32> invalid_index = (bit<32>) standard_metadata.ingress_port + 1024;
        bit<32> ignored_value = 0;
        test_counter.count(invalid_index);
        test_meter.execute_meter(invalid_index, meta.color);
        test_register.read(ignored_value, invalid_index);
        test_register.write(invalid_index, ignored_value);
        digest<traffic_digest_t>(1, { standard_metadata.ingress_port, hdr.ethernet.src_addr });
    }
    table observation {
        key = { standard_metadata.ingress_port: exact; }
        actions = { observe; NoAction; }
        counters = test_direct_counter;
        size = 8;
        default_action = NoAction();
    }
    action send(bit<9> port) {
        bit<32> previous;
        standard_metadata.egress_spec = port;
        test_counter.count((bit<32>) standard_metadata.ingress_port);
        test_meter.execute_meter((bit<32>) standard_metadata.ingress_port, meta.color);
        test_direct_meter.read(meta.color);
        @atomic {
            test_register.read(previous, (bit<32>) standard_metadata.ingress_port);
            test_register.write((bit<32>) standard_metadata.ingress_port, previous + 1);
        }
        // Session 77 is installed only by the mirror packet/failover regression.
        if (standard_metadata.ingress_port == 1) {
            clone(CloneType.I2E, 77);
        }
    }
    action drop() { mark_to_drop(standard_metadata); }
    action multicast(bit<16> group) {
        standard_metadata.mcast_grp = group;
    }
    table forward {
        key = { standard_metadata.ingress_port: exact; }
        actions = { send; drop; multicast; }
        meters = test_direct_meter;
        size = 8;
        default_action = drop();
    }
    apply { observation.apply(); forward.apply(); }
}
control EgressImpl(inout headers_t hdr, inout metadata_t meta,
                   inout standard_metadata_t standard_metadata) { apply { } }
control ComputeChecksumImpl(inout headers_t hdr, inout metadata_t meta) { apply { } }
control DeparserImpl(packet_out packet, in headers_t hdr) {
    apply { packet.emit(hdr.ethernet); }
}
V1Switch(ParserImpl(), VerifyChecksumImpl(), IngressImpl(), EgressImpl(),
         ComputeChecksumImpl(), DeparserImpl()) main;
