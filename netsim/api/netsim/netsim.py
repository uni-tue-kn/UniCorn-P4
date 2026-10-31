# Copyright 2013-present Barefoot Networks, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Adapted by Robert MacDavid (macdavid@cs.princeton.edu) from scripts found in
# the p4app repository (https://github.com/p4lang/p4app)
#
# We encourage you to dissect this script to better understand the BMv2/Mininet
# environment used by the P4 tutorial.
#
import os, json, re, argparse, math
import subprocess
from threading import RLock
from time import sleep

from .utils.p4_mininet import P4Switch, P4Host
from .utils.p4runtime_switch import P4RuntimeSwitch

from mininet.net import Mininet
from mininet.topo import Topo
from mininet.link import TCLink, Intf
from mininet.cli import CLI

RESERVED_EXTERNAL_INTERFACES = {"lo"}

def extract_id(name):
    """Extract the trailing numeric ID from a node name (e.g. 'h1' -> 1, 'host1' -> 1)."""
    match = re.search(r'(\d+)$', name)
    if match:
        return int(match.group(1))
    raise ValueError(f"Node name '{name}' does not end with a number.")


def configureP4Switch(**switch_args):
    """ Helper class that is called by mininet to initialize
        the virtual P4 switches. 
        The switch must follow the simple_switch_grpc architecture.
    """
    class ConfiguredP4RuntimeSwitch(P4RuntimeSwitch):
        def __init__(self, *opts, **kwargs):
            kwargs.update(switch_args)
            P4RuntimeSwitch.__init__(self, *opts, **kwargs)

        def describe(self):
            print(f"{self.name} -> gRPC port: {self.grpc_port}")

    return ConfiguredP4RuntimeSwitch


class ParsedTopo(Topo):
    """ The mininet topology class for the P4 environment
    """
    def __init__(self, hosts: list, switches: list, links: list, log_dir: str, **opts):
        Topo.__init__(self, **opts)
        host_links = []
        switch_links = []
        self.sw_port_mapping = {}
        host_set = set(hosts)
        switch_set = set(switches)

        for link in links:
            if link['node1'] in host_set:
                host_links.append(link)
            elif link['node1'] in switch_set:
                switch_links.append(link)
            else:
                raise Exception(f"Node '{link['node1']}' is not listed in hosts or switches.")

        link_sort_key = lambda x: x['node1'] + x['node2']
        # Links must be added in a sorted order so bmv2 port numbers are predictable
        host_links.sort(key=link_sort_key)
        switch_links.sort(key=link_sort_key)

        for sw in switches:
            # Add switch to mininet topology graph
            self.addSwitch(sw, log_file="%s/%s.log" %(log_dir, sw))

        for link in host_links:
            host_name = link['node1']
            host_sw   = link['node2']
            host_num = extract_id(host_name)
            sw_num   = extract_id(host_sw)
            host_ip = "10.0.%d.%d" % (sw_num, host_num)
            host_mac = '00:00:00:00:%02x:%02x' % (sw_num, host_num)
            # Each host IP should be /24, so all traffic will use the
            # default gateway (the switch) without sending ARP requests.
            self.addHost(host_name, ip=host_ip+'/24', mac=host_mac)
            self.addLink(host_name, host_sw,
                         delay=link['latency'], bw=link['bandwidth'],
                         addr1=host_mac, addr2=host_mac)
            self.addSwitchPort(host_sw, host_name)

        for link in switch_links:
            self.addLink(link['node1'], link['node2'],
                        delay=link['latency'], bw=link['bandwidth'])
            # Add bidirectional link in internal port mapping representation
            self.addSwitchPort(link['node1'], link['node2'])
            self.addSwitchPort(link['node2'], link['node1'])

        self.printPortMapping()

    def addSwitchPort(self, sw, node2):
        """
        Internal mapping from sswitch to port id
        """
        if sw not in self.sw_port_mapping:
            self.sw_port_mapping[sw] = []
        portno = len(self.sw_port_mapping[sw])+1
        self.sw_port_mapping[sw].append((portno, node2))

    def printPortMapping(self):
        print("Switch port mapping:")
        for sw in sorted(self.sw_port_mapping.keys()):
            print(f"\t{sw}: "),
            for portno, node2 in self.sw_port_mapping[sw]:
                print(f"\t\tPort {portno}:{node2}\t"),
            print


class MininetRunner:
    """
        Attributes:
            log_dir  : string   // directory for mininet log files
            pcap_dir : string   // directory for mininet switch pcap files
            quiet    : bool     // determines if we print logger messages

            hosts    : list<string>       // list of mininet host names
            switches : dict<string, dict> // mininet host names and their associated properties
            links    : list<dict>         // list of mininet link properties

            switch_json : string // json of the compiled p4 example

            topo : Topo object   // The mininet topology instance
            net : Mininet object // The mininet instance

    """
    def logger(self, *items):
        if not self.quiet:
            print(' '.join(items))


    def __init__(self, topo_file, log_dir, pcap_dir, quiet=False):
        """ Initializes some attributes and reads the topology json. Does not
            actually create the mininet topology. Use run() for that.

            Arguments:
                topo_file : string    // A json file which describes the 
                                         mininet topology.
                log_dir  : string     // Path to a directory for storing logs
                pcap_dir : string     // Ditto, but for mininet switch pcap files
                quiet : bool          // Enable/disable script debug messages
        """
        self.quiet = quiet     
        self.lifecycle_lock = RLock()
        
        self.topo_file = topo_file
        # Ensure all the needed directories exist and are directories
        for dir_name in [log_dir, pcap_dir]:
            if not os.path.isdir(dir_name):
                if os.path.exists(dir_name):
                    raise Exception("'%s' exists and is not a directory!" % dir_name)
                os.mkdir(dir_name)
        self.log_dir = log_dir
        self.pcap_dir = pcap_dir
        # Switch has no P4 program loaded initially.
        self.switch_json = None
        # Controller communication is done with grpc
        self.bmv2_exe = "simple_switch_grpc"
        self.net = None
        
        # Will be filled in parse_topology_file()
        self.hosts = []
        self.switches = {}
        self.links = []
        self.ext_intfs = []
        self.interface_mapping = {}
        self.external_intf_objects = []
        self.layout = {}
        
        # Will be populated with dicts like d = {"dev_id": 0, "grpc_port": 50051, "name": s1} in self.run()
        self.switch_mappings = []
        
        if topo_file:
            self.run()

    def read_topology_file(self, path):
        """Validate a candidate without modifying the running topology."""
        with open(path, 'r') as source:
            topo = json.load(source)
        if not isinstance(topo, dict) or not isinstance(topo.get('hosts'), list) or not isinstance(topo.get('switches'), dict):
            raise ValueError("Topology requires hosts (list), switches (object) and links (list)")
        names = topo['hosts'] + list(topo['switches'])
        if any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*[0-9]', name) for name in names):
            raise ValueError("Node names must be alphanumeric and end with a numeric ID")
        if any(len(name) > 10 for name in names):
            raise ValueError('Node names must be at most 10 characters to fit Linux interface names')
        if len(set(names)) != len(names):
            raise ValueError("Host and switch names must be unique")
        # The built-in host addressing scheme encodes IDs in one IPv4 octet.
        if any(extract_id(name) > 254 for name in topo['hosts']) or any(extract_id(name) > 255 for name in topo['switches']):
            raise ValueError("Node IDs exceed the built-in IPv4 addressing range")
        layout = topo.get('layout', {})
        if not isinstance(layout, dict) or any(name not in names for name in layout):
            raise ValueError("Layout must map existing nodes to positions")
        for position in layout.values():
            if not isinstance(position, dict) or any(
                isinstance(position.get(axis), bool) or not isinstance(position.get(axis), (int, float))
                or not math.isfinite(position[axis]) or position[axis] < 0 for axis in ('x', 'y')
            ):
                raise ValueError("Layout positions require finite nonnegative x and y")
        links = self.parse_links(topo.get('links'), topo['hosts'], topo['switches'])
        for host in topo['hosts']:
            count = sum(link['node1'] == host or link['node2'] == host for link in links)
            if count != 1:
                raise ValueError(f'Host {host} must have exactly one switch link before deployment (found {count}).')
        for switch in topo['switches']:
            degree = sum(link['node1'] == switch or link['node2'] == switch for link in links)
            interface = f'{switch}-eth{degree}'
            if len(interface) > 15:
                raise ValueError(f"Switch {switch} requires interface {interface}, exceeding Linux's 15-character limit.")
        return {"hosts": topo['hosts'], "switches": topo['switches'], "layout": layout,
                "links": links,
                "ext_intfs": self.parse_ext_intfs(topo.get('ext_intfs', []), topo['switches'])}

    def parse_topology_file(self, candidate=None):
        self.logger('Reading topology file.')
        topo = self.read_topology_file(self.topo_file) if candidate is None else candidate
        self.hosts = topo['hosts']
        self.switches = topo['switches']
        self.links = topo['links']
        self.ext_intfs = topo['ext_intfs']
        self.layout = topo['layout']

    def parse_ext_intfs(self, unparsed_ext_intfs, switches=None):
        """Validate and normalize external interface attachments."""
        if unparsed_ext_intfs is None:
            return []
        if not isinstance(unparsed_ext_intfs, list):
            raise ValueError("ext_intfs must be a list of [switch, interface] pairs.")

        ext_intfs = []
        seen_interfaces = set()
        for index, ext_intf in enumerate(unparsed_ext_intfs):
            if not isinstance(ext_intf, list) or len(ext_intf) != 2:
                raise ValueError(f"ext_intfs[{index}] must be [switch, interface].")

            sw_name, intf_name = ext_intf
            if not isinstance(sw_name, str) or not sw_name.strip():
                raise ValueError(f"ext_intfs[{index}] has an invalid switch name.")
            if not isinstance(intf_name, str) or not intf_name.strip():
                raise ValueError(f"ext_intfs[{index}] has an invalid interface name.")

            sw_name = sw_name.strip()
            intf_name = intf_name.strip()

            if sw_name not in (self.switches if switches is None else switches):
                raise ValueError(f"External interface '{intf_name}' references unknown switch '{sw_name}'.")
            if intf_name in RESERVED_EXTERNAL_INTERFACES:
                raise ValueError(f"External interface '{intf_name}' is reserved and cannot be attached.")
            if intf_name in seen_interfaces:
                raise ValueError(f"External interface '{intf_name}' is configured more than once.")
            if not os.path.exists(os.path.join("/sys/class/net", intf_name)):
                raise ValueError(f"External interface '{intf_name}' does not exist on this system.")

            seen_interfaces.add(intf_name)
            ext_intfs.append({"switch": sw_name, "interface": intf_name})

        return ext_intfs

    def destroy_topology(self):
        # Cleanup mininet environment and old interfaces
        self.logger("Cleaning up old topologies")
        if self.net is not None:
            try:
                self.detach_external_interfaces()
                self.net.stop()
            except Exception as e:
                self.logger(f"Graceful Mininet shutdown failed: {e}")
        with open(os.devnull, 'wb') as devnull:
            subprocess.check_call(['mn', '-c'], stdout=devnull, stderr=devnull)
        # Clean up existing device id and grpc port mappings
        self.switch_mappings = []
        # Reset those mappings in the P4Switch class as well
        self.net = None
        P4Switch.device_id = 0
        P4RuntimeSwitch.next_grpc_port = 50051
        P4RuntimeSwitch.next_thrift_port = 9090
        
        self.hosts = []
        self.switches = {}
        self.links = []
        self.ext_intfs = []
        self.interface_mapping = {}
        self.external_intf_objects = []
        self.layout = {}

    def detach_external_interfaces(self):
        """Remove physical interfaces from Mininet tracking without deleting them."""
        for intf in list(self.external_intf_objects):
            node = getattr(intf, "node", None)
            if node is None:
                continue
            try:
                node.delIntf(intf)
                intf.node = None
            except Exception as e:
                self.logger(f"Failed to detach external interface {intf.name}: {e}")
        self.external_intf_objects = []

    def run(self, candidate=None):
        """ Sets up the mininet instance, programs the switches,
            and starts the mininet CLI. This is the main method to run after
            initializing the object.
        """
        # Validate before touching any existing network. The HTTP boundary can
        # supply its already parsed candidate, avoiding a second file read.
        candidate = self.read_topology_file(self.topo_file) if candidate is None else candidate
        # Clean up existing topologies
        self.destroy_topology()  
        
        self.parse_topology_file(candidate)
 
        self.logger("Started topology!")
        
        try:
            # Initialize mininet with the topology specified by the config
            self.create_network()
            sleep(3)
            self.switch_mappings = self.populate_switch_mappings()
            sleep(.1)

            self.net.start()
            sleep(.1)

            # some programming that must happen after the net has started
            self.program_hosts()
            self.interface_mapping = self.build_interface_mapping()
        except Exception:
            self.destroy_topology()
            raise

        #self.do_net_cli()


    def parse_links(self, unparsed_links, hosts=None, switches=None):
        """ Given a list of links descriptions of the form [node1, node2, latency, bandwidth]
            with the latency and bandwidth being optional, parses these descriptions
            into dictionaries and store them as self.links
        """
        
        def formatLatency(value):
            """Emit one tc delay argument, including for drafts such as '2 ms'."""
            if isinstance(value, str):
                match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(us|ms|s)', value)
                if not match or not math.isfinite(float(match.group(1))):
                    raise ValueError("Latency must be nonnegative milliseconds or use us, ms, s units")
                return match.group(1) + match.group(2)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError("Latency must be a finite nonnegative number")
            return str(value) + "ms"
            
        links = []
        if not isinstance(unparsed_links, list):
            raise ValueError("links must be a list")
        hosts = self.hosts if hosts is None else hosts
        switches = self.switches if switches is None else switches
        nodes = set(hosts) | set(switches)
        for link in unparsed_links:
            if not isinstance(link, list) or not 2 <= len(link) <= 4:
                raise ValueError("Each link must contain two nodes and optional latency/bandwidth")
            # make sure each link's endpoints are ordered alphabetically
            s, t, = link[0], link[1]
            if not isinstance(s, str) or not isinstance(t, str) or s not in nodes or t not in nodes:
                raise ValueError("Link references an unknown node")
            if s == t:
                raise ValueError("A link cannot connect a node to itself")
            if s in hosts and t in hosts:
                raise ValueError("Hosts must connect to switches")
            if t in hosts or (s in switches and t in switches and s > t):
                s, t = t, s

            link_dict = {'node1':s,
                        'node2':t,
                        'latency':'0ms',
                        'bandwidth':None
                        }
            
            if len(link) > 2:
                link_dict['latency'] = formatLatency(link[2])
            if len(link) > 3:
                link_dict['bandwidth'] = link[3]

            links.append(link_dict)
        return links

    def populate_switch_mappings(self):
        switch_mappings = []
        for s in self.net.switches:
            d = {"dev_id": s.device_id,
                "grpc_port": s.grpc_port,
                "thrift_port": s.thrift_port,
                "name": s.name}
            switch_mappings.append(d) 
        return switch_mappings

    def build_interface_mapping(self):
        mapping = {}
        external_interfaces = {ext_intf["interface"] for ext_intf in self.ext_intfs}

        if self.net is None:
            return mapping

        for switch in self.net.switches:
            entries = []
            for port, intf in sorted(switch.intfs.items()):
                if intf.IP():
                    continue

                entry = {
                    "port": port,
                    "type": "external" if intf.name in external_interfaces else "virtual",
                    "node": switch.name,
                    "interface": intf.name,
                    "peer_node": None,
                    "peer_interface": None
                }

                if entry["type"] == "virtual" and getattr(intf, "link", None) is not None:
                    peer_intf = intf.link.intf1 if intf.link.intf2 == intf else intf.link.intf2
                    entry["peer_node"] = peer_intf.node.name
                    entry["peer_interface"] = peer_intf.name

                entries.append(entry)
            mapping[switch.name] = entries

        return mapping

    def topology_state(self, include_switches_online=False):
        topo = {
            "hosts": self.hosts,
            "switches": self.switches,
            "links": self.links,
            "file_name": self.topo_file,
            "ext_intfs": self.ext_intfs,
            "interface_mapping": self.interface_mapping
        }
        topo["layout"] = self.layout
        if include_switches_online:
            topo["switches_online"] = self.switch_mappings
        return topo

    def create_network(self):
        """ Create the mininet network object, and store it as self.net.

            Side effects:
                - Mininet topology instance stored as self.topo
                - Mininet instance stored as self.net
        """
        self.logger("Building mininet topology.")

        self.topo = ParsedTopo(self.hosts, self.switches.keys(), self.links, self.log_dir)

        # The class each Switch represents
        # TODO upon loading a new topology, the dev_id and grpc ports are not freed but incremented
        switchClass = configureP4Switch(
                sw_path=self.bmv2_exe,  # simple_switch_grpc
                json_path=self.switch_json, # None. Switch_json will be programmed later from controller
                log_console=True,
                pcap_dump=self.pcap_dir)

        self.net = Mininet(topo = self.topo,
                      link = TCLink,
                      host = P4Host,
                      cleanup=True,
                      switch = switchClass,
                      controller = None)
        # Attaching physical / external interfaces to the switches
        for ext_intf in self.ext_intfs:
            sw_name = ext_intf["switch"]
            intf_name = ext_intf["interface"]
            sw = self.net.get(sw_name)
            intf = Intf(intf_name, node=sw)
            self.external_intf_objects.append(intf)
            self.logger(f"Attached external interface {intf_name} to switch {sw_name}")


    def program_hosts(self):
        """ Adds static ARP entries and default routes to each mininet host.

            Assumes:
                - A mininet instance is stored as self.net and self.net.start() has
                  been called.
        """
        for host_name in self.topo.hosts():
            h = self.net.get(host_name)
            h_iface = list(h.intfs.values())[0]
            link = h_iface.link

            sw_iface = link.intf1 if link.intf1 != h_iface else link.intf2
            # phony IP to lie to the host about
            switch_id = extract_id(sw_iface.node.name)
            sw_ip = '10.0.%d.254' % switch_id

            # Ensure each host's interface name is unique, or else
            # mininet cannot shutdown gracefully
            h.defaultIntf().rename('%s-eth0' % host_name)
            # static arp entries and default routes
            h.cmd('arp -i %s -s %s %s' % (h_iface.name, sw_ip, sw_iface.mac))
            print('arp -i %s -s %s %s' % (h_iface.name, sw_ip, sw_iface.mac))
            h.cmd('ethtool --offload %s rx off tx off' % h_iface.name)
            h.cmd('ip route add %s dev %s' % (sw_ip, h_iface.name))
            h.setDefaultRoute("via %s" % sw_ip)


    def do_net_cli(self):
        """ Starts up the mininet CLI and prints some helpful output.

            Assumes:
                - A mininet instance is stored as self.net and self.net.start() has
                  been called.
        """
        for s in self.net.switches:
            s.describe()
        for h in self.net.hosts:
            h.describe()
        self.logger("Starting mininet CLI")
        # Generate a message that will be printed by the Mininet CLI to make
        # interacting with the simple switch a little easier.
        print('')
        print('======================================================================')
        print('Welcome to the BMV2 Mininet CLI!')
        print('======================================================================')
        print('Your P4 program is installed into the BMV2 software switch')
        print('and your initial runtime configuration is loaded. You can interact')
        print('with the network using the mininet CLI below.')
        print('')
        if self.switch_json:
            print('To inspect or change the switch configuration, connect to')
            print('its CLI from your host operating system using this command:')
            print('  simple_switch_CLI --thrift-port <switch thrift port>')
            print('')
        print('To view a switch log, run this command from your host OS:')
        print('  tail -f %s/<switchname>.log' %  self.log_dir)
        print('')
        print('To view the switch output pcap, check the pcap files in %s:' % self.pcap_dir)
        print(' for example run:  sudo tcpdump -xxx -r s1-eth1.pcap')
        print('')
        if 'grpc' in self.bmv2_exe:
            print('To view the P4Runtime requests sent to the switch, check the')
            print('corresponding txt file in %s:' % self.log_dir)
            print(' for example run:  cat %s/s1-p4runtime-requests.txt' % self.log_dir)
            print('')

        CLI(self.net)
        
