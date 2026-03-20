/*************************************************************************
**************  I N G R E S S   P R O C E S S I N G   *******************
*************************************************************************/
control MyIngress(inout headers hdr,
                  inout metadata meta,
                  inout standard_metadata_t standard_metadata) {

    direct_counter(CounterType.packets) table_counter;


    action drop() {
        mark_to_drop(standard_metadata);
        table_counter.count();
    }

    action ipv4_forward(macAddr_t dstAddr, egressSpec_t port) {
        standard_metadata.egress_spec = port;
        // Simplified, should actually be the Router MAC
        hdr.ethernet.srcAddr = hdr.ethernet.dstAddr;
        hdr.ethernet.dstAddr = dstAddr;
        hdr.ipv4.ttl = hdr.ipv4.ttl - 1;
        table_counter.count();
    }

    table ipv4_lpm {
        key = {
            hdr.ipv4.dstAddr: lpm;
        }
        actions = {
            ipv4_forward;
            drop;
            NoAction;
        }
        size = 1024;
        default_action = drop();
        counters = table_counter;
    }

    // ! 6.  Add the Match-Action logic
    // This action builds an arp reply for an arp request and sends it out via the specified port
    action build_arp_reply(macAddr_t routerIFMacAddr) {
        hdr.ethernet.dstAddr = hdr.ethernet.srcAddr;
        hdr.ethernet.srcAddr = routerIFMacAddr;
        hdr.arp.opcode = 2; // reply

        // Swap the sender and target IPv4 addresses
        ip4Addr_t temp = hdr.arp.target_proto_addr;
        hdr.arp.target_proto_addr = hdr.arp.sender_proto_addr;
        hdr.arp.sender_proto_addr = temp;

        // Swap the sender and target MAC addresses
        hdr.arp.target_hw_addr = hdr.arp.sender_hw_addr;
        hdr.arp.sender_hw_addr = routerIFMacAddr;

        // Return the packet
        standard_metadata.egress_spec = standard_metadata.ingress_port;
    }

    // This table matches on the ARP opcode and the target protocol address (the IPv4 address we want to resolve) and sends an ARP reply if there is a match
    table arp_reply {
        key = {
            hdr.arp.target_proto_addr: exact; // The IPv4 address we want to resolve
        }
        actions = {
            build_arp_reply;
            drop;
        }
        default_action = drop();
    }

    apply {
        if (hdr.ipv4.isValid()) {
       		ipv4_lpm.apply();
        }
        // ! 7. Call the match action logic
        else if (hdr.arp.isValid()){

            if (hdr.arp.opcode == 1) { // Request
                // Apply the table
                arp_reply.apply();
            }
        }
    }
}