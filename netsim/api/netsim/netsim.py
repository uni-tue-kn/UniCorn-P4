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
import os, json, argparse
import subprocess
from time import sleep

from .utils.p4_mininet import P4Switch, P4Host
from .utils.p4runtime_switch import P4RuntimeSwitch

from mininet.net import Mininet
from mininet.topo import Topo
from mininet.link import TCLink
from mininet.cli import CLI

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

        for link in links:
            if link['node1'][0] == 'h':
                host_links.append(link)
            elif link['node1'][0] == 's':
                switch_links.append(link)
            else:
                raise Exception("Nodes in topology.json must either start with h for host or s for switch.")

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
            host_num = int(host_name[1:])
            sw_num   = int(host_sw[1:])
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
        
        # Will be populated with dicts like d = {"dev_id": 0, "grpc_port": 50051, "name": s1} in self.run()
        self.switch_mappings = []
        
        if topo_file:
            self.run()

    def parse_topology_file(self):
        self.logger('Reading topology file.')
        with open(self.topo_file, 'r') as f:
            topo = json.load(f)
        self.hosts = topo['hosts']
        self.switches = topo['switches']
        self.links = self.parse_links(topo['links'])   

    def destroy_topology(self):
        # Cleanup mininet environment and old interfaces
        self.logger("Cleaning up old topologies")
        with open(os.devnull, 'wb') as devnull:
            subprocess.check_call(['mn', '-c'], stdout=devnull, stderr=devnull)
        # Clean up existing device id and grpc port mappings
        self.switch_mappings = []
        # Reset those mappings in the P4Switch class as well
        self.net = None
        P4Switch.device_id = 0
        P4RuntimeSwitch.next_grpc_port = 50051
        
        self.hosts = []
        self.switches = {}
        self.links = []

    def run(self):
        """ Sets up the mininet instance, programs the switches,
            and starts the mininet CLI. This is the main method to run after
            initializing the object.
        """
        # Clean up existing topologies
        self.destroy_topology()  
        
        self.parse_topology_file()
 
        self.logger("Started topology!")
        
        # Initialize mininet with the topology specified by the config
        self.create_network()
        sleep(3)
        self.switch_mappings = self.populate_switch_mappings()     
        sleep(.1)
        
        self.net.start()
        sleep(.1)

        # some programming that must happen after the net has started
        self.program_hosts()

        #self.do_net_cli()


    def parse_links(self, unparsed_links):
        """ Given a list of links descriptions of the form [node1, node2, latency, bandwidth]
            with the latency and bandwidth being optional, parses these descriptions
            into dictionaries and store them as self.links
        """
        
        def formatLatency(l):
            """ Helper method for parsing link latencies from the topology json. """
            if isinstance(l, str):
                return l
            else:
                return str(l) + "ms"
            
        links = []
        for link in unparsed_links:
            # make sure each link's endpoints are ordered alphabetically
            s, t, = link[0], link[1]
            if s > t:
                s,t = t,s

            link_dict = {'node1':s,
                        'node2':t,
                        'latency':'0ms',
                        'bandwidth':None
                        }
            
            if len(link) > 2:
                link_dict['latency'] = formatLatency(link[2])
            if len(link) > 3:
                link_dict['bandwidth'] = link[3]

            if link_dict['node1'][0] == 'h':
                assert link_dict['node2'][0] == 's', 'Hosts should be connected to switches, not ' + str(link_dict['node2'])
            links.append(link_dict)
        return links

    def populate_switch_mappings(self):
        switch_mappings = []
        for s in self.net.switches:
            d = {"dev_id": s.device_id,
                "grpc_port": s.grpc_port,
                "name": s.name}
            switch_mappings.append(d) 
        return switch_mappings

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
            host_id = int(host_name[1:])
            sw_ip = '10.0.%d.254' % host_id

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
        