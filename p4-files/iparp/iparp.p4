/* -*- P4_16 -*- */
#include <core.p4>
#include <v1model.p4>

const bit<16> TYPE_IPV4 = 0x800;
// 1. Ethertype for ARP
const bit<16> TYPE_ARP = 0x0806;


/*************************************************************************
*********************** H E A D E R S  ***********************************
*************************************************************************/

typedef bit<9>  egressSpec_t;
typedef bit<48> macAddr_t;
typedef bit<32> ip4Addr_t;

header ethernet_t {
    macAddr_t dstAddr;
    macAddr_t srcAddr;
    bit<16>   etherType;
}

header ipv4_t {
    bit<4>    version;
    bit<4>    ihl;
    bit<8>    diffserv;
    bit<16>   totalLen;
    bit<16>   identification;
    bit<3>    flags;
    bit<13>   fragOffset;
    bit<8>    ttl;
    bit<8>    protocol;
    bit<16>   hdrChecksum;
    ip4Addr_t srcAddr;
    ip4Addr_t dstAddr;
}

 // 2. ARP header
header arp_t {
    bit<16> hardware_type;
    bit<16> protocol_type;
    bit<8> hardware_length;
    bit<8> protocol_length;
    bit<16> operation;
    bit<32> sender_hw_addr;
    bit<32> sender_proto_addr;
    bit<32> target_hw_addr;
    bit<32> target_proto_addr;
}


struct metadata {
    /* empty */
}

struct headers {
    ethernet_t   ethernet;
     //3. Add to header stack
    arp_t        arp;
    
    ipv4_t       ipv4;
}

/*************************************************************************
*********************** P A R S E R  ***********************************
*************************************************************************/

parser MyParser(packet_in packet,
                out headers hdr,
                inout metadata meta,
                inout standard_metadata_t standard_metadata) {

    state start {
        transition parse_ethernet;
    }

    state parse_ethernet {
        packet.extract(hdr.ethernet);
        transition select(hdr.ethernet.etherType) {
            TYPE_IPV4: parse_ipv4;
             // 4. Adapt parser FSM
            TYPE_ARP: parse_arp;
            
            default: accept;
        }
    }

    state parse_ipv4 {
        packet.extract(hdr.ipv4);
        transition accept;
    }

     //5. add new parser state
    state parse_arp {
        packet.extract(hdr.arp);
        transition accept;
    }
    
}

/*************************************************************************
************   C H E C K S U M    V E R I F I C A T I O N   *************
*************************************************************************/

control MyVerifyChecksum(inout headers hdr, inout metadata meta) {
    apply {  }
}


/*************************************************************************
**************  I N G R E S S   P R O C E S S I N G   *******************
*************************************************************************/



control MyIngress(inout headers hdr,
                  inout metadata meta,
                  inout standard_metadata_t standard_metadata) {

    action drop() {
        mark_to_drop(standard_metadata);
    }

    action ipv4_forward(macAddr_t dstAddr, egressSpec_t port) {
        standard_metadata.egress_spec = port;
        hdr.ethernet.srcAddr = hdr.ethernet.dstAddr;
        hdr.ethernet.dstAddr = dstAddr;
        hdr.ipv4.ttl = hdr.ipv4.ttl - 1;
    }

    action something(bit<32> parameter){
        hdr.ipv4.ttl = 64;
    }

    table ipv4_lpm {
        key = {
            hdr.ipv4.dstAddr: lpm;
            hdr.ethernet.srcAddr: exact;
        }
        actions = {
            ipv4_forward;
            something;
            drop;
            NoAction;
        }
        size = 1024;
        default_action = drop();
    }

     //5. Add the Match-Action logic

    // This action receives a port from the control plane and sends to packet out via this port
    action arp_forward(egressSpec_t port) {
        standard_metadata.egress_spec = port;
    }

    // This table forwards arp requests coming from port 1 to port 2 and vice versa
    // Normally those would be broadcasted!!
    table arp_match {
        key = {
            standard_metadata.ingress_port: exact;
            hdr.ethernet.srcAddr: exact;
        }
        actions = {
            arp_forward;
            drop;
        }
        default_action = drop();
    }

    

    apply {
        if (hdr.ipv4.isValid()) {
       		ipv4_lpm.apply();
        }
         //6. Call the match action logic
        else if (hdr.arp.isValid()){
            // Apply the table
            arp_match.apply();
        }
        
    }
}

/*************************************************************************
****************  E G R E S S   P R O C E S S I N G   *******************
*************************************************************************/

control MyEgress(inout headers hdr,
                 inout metadata meta,
                 inout standard_metadata_t standard_metadata) {
    apply {  }
}

/*************************************************************************
*************   C H E C K S U M    C O M P U T A T I O N   **************
*************************************************************************/

control MyComputeChecksum(inout headers  hdr, inout metadata meta) {
     apply {
	update_checksum(
	    hdr.ipv4.isValid(),
            { hdr.ipv4.version,
	      hdr.ipv4.ihl,
              hdr.ipv4.diffserv,
              hdr.ipv4.totalLen,
              hdr.ipv4.identification,
              hdr.ipv4.flags,
              hdr.ipv4.fragOffset,
              hdr.ipv4.ttl,
              hdr.ipv4.protocol,
              hdr.ipv4.srcAddr,
              hdr.ipv4.dstAddr },
            hdr.ipv4.hdrChecksum,
            HashAlgorithm.csum16);
    }
}

/*************************************************************************
***********************  D E P A R S E R  *******************************
*************************************************************************/

control MyDeparser(packet_out packet, in headers hdr) {
    apply {
        packet.emit(hdr.ethernet);
         //7. Deparse ARP header
        // Order is important!!
        // Only headers with isValid() flag will be sent out
        packet.emit(hdr.arp);
        
        packet.emit(hdr.ipv4);
    }
}

/*************************************************************************
***********************  S W I T C H  *******************************
*************************************************************************/

V1Switch(
MyParser(),
MyVerifyChecksum(),
MyIngress(),
MyEgress(),
MyComputeChecksum(),
MyDeparser()
) main;
