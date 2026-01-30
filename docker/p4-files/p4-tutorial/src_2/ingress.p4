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
    // This action receives a port from the control plane and sends to packet out via this port
    action arp_forward(egressSpec_t port) {
        standard_metadata.egress_spec = port;
    }

    // This table forwards arp requests coming from port 1 to port 2 and vice versa
    // Normally those would be broadcasted!!
    table arp_match {
        key = {
            standard_metadata.ingress_port: exact;
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
        // ! 7. Call the match action logic
        else if (hdr.arp.isValid()){
            // Apply the table
            arp_match.apply();
        }
    }
}