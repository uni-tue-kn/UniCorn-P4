const bit<16> TYPE_IPV4 = 0x800;
// ! 1. Ethertype for ARP
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

// ! 2. ARP header
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
    // ! 3. Add to header stack
    arp_t        arp;
    ipv4_t       ipv4;
}