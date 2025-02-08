from .endpoints.load_topology import LoadTopology
from .endpoints.get_topology import GetTopology
from .endpoints.switchesonline import SwitchesOnline
from .endpoints.logs import LogFile
from .netsim.netsim import MininetRunner
from .netsim.utils.p4_mininet import P4Host, P4Switch


from flask import Flask
from flask_restful import Api
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from threading import Event, Thread

import json
from .netsim.netsim import MininetRunner


# Uses mininets Node class interfaces to open a terminal on a passed node, send commands and return output
class NodeCLI:
    def __init__(self, node, socket_ref):
        self.node = node
        self.shell = None
        self.thread = None
        self.stop_event = Event()
        self.socket = socket_ref

        # Starts bash shell on host and registers output handler
        self.register_shell()

    def register_shell(self):
        # Ensure that shell is running on node
        self.node.startShell()

    def run_cmd(self, cmd):
        # Runs command, does not wait for output
        print("Starting command '{}' on host {}".format(cmd,self.node.name))
        self.node.sendCmd(cmd)
        self.wait_output()
        print("Finished command '{}' on host {}".format(cmd,self.node.name))

    # NOTE: THIS IS A MODIFIED VERSION OF p4_mininet.node.waitOutput
    # It is modified to use the following funciton instead of monitor
    # All credits belong to original authors
    def wait_output(self):
        while self.node.waiting:
            data = self.node.monitor( findPid=False )
            self.handle_output( data )
        # Command finished, all data has already been emitted over WS
        
        return 

    def handle_output(self, data):
        # Send data over websocket to clients
        json_obj = {
            "name": self.node.name,
            "data": data
        }
        # TODO: each node should use their own channel, not just response
        self.socket.emit("response", json.dumps(json_obj))

    def interrupt(self):
        self.node.sendInt();

# TODO: ensure that terminal is synchronized across multiple users
class WebsocketManager:

    def __init__(self, socket, mininet_runner):
        self.mn_runner = mininet_runner
        self.net = mininet_runner.net
        self.socket = socket
        self.index = 0
        self.clis = {}

        # TODO: ensure that this does not cause problems with memory if programs runs for a lont time
        self.history = []

        # Register message handlers for Websocket
        self.register_handlers()

    def register_handlers(self):
        self.socket.on_event('message', self.handle_message)

    def close_clis(self):
        # Stop CLIs that are still running
        for name, cli in self.clis.items():
            cli.node.stop() 

        # Delete old dictionary
        self.clis = {}
        self.net = None


    def init_clis(self):
        self.close_clis()

        if self.net is None:
            if self.mn_runner.net is not None:
                self.net = self.mn_runner.net
            else:
                print("ERROR, no topology loaded")

        # Iterate over all nodes in network
        for node in self.net.values():
            # Check if node is a Host machine
            if isinstance(node, P4Host) or isinstance(node, P4Switch):
                # Create CLI instance for host
                self.clis[node.name] = NodeCLI(node, self.socket)

    def handle_message(self, message):

        target = message["target"]

        if ("interrupt" in message):
            self.clis[target].interrupt()
        else:
            self.clis[target].run_cmd(message["cmd"])


class MininetManager:

    # TODO: Add some lock mechanism for self.mininet since it is accessed by multiple threads
    def __init__(self):

        # Init Flask
        app = Flask(__name__)
        CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
        app.config['CORS_HEADERS'] = 'application/json'
        self.app = app

        self.index = 0

        # Reference to Mininet simulation runner
        self.mn_runner = None
        self.socketio = None

        # Create Mininet runner
        self.init_mininet()

        # Create websocket for mininet terminal
        self.create_websocket()

        # Create API endpoint, uses websocket reference so has to be called last
        self.create_api()

    def init_mininet(self):
        # Topology will be filled from controller.
        # TODO set default value for this?
        topology_file = None
        # TODO move this into configuration file
        log_dir = "/app/netsim/logs"
        pcap_dir = "/app/netsim/pcaps"
        quiet = False

        self.mn_runner = MininetRunner(topology_file, log_dir, pcap_dir, quiet)

    def create_api(self):
        self.api = Api(self.app)
        self.api.add_resource(LoadTopology, '/topology/load', resource_class_kwargs={
                              "netsim": self.mn_runner, "ws": self.socketio})
        self.api.add_resource(GetTopology, '/topology/get', resource_class_kwargs={
                              "netsim": self.mn_runner, "ws": self.socketio})
        self.api.add_resource(SwitchesOnline, '/switches/online',
                              resource_class_kwargs={"netsim": self.mn_runner, "ws": self.socketio})
        self.api.add_resource(LogFile, '/topology/logs',
                                resource_class_kwargs={"netsim": self.mn_runner, "ws": self.socketio})

    def create_websocket(self):

        # TODO: this catches the "AssertionError: write() before start_respons" error, the socket still establishes
        # Handlign should be done better than this
        socketio = SocketIO(self.app, logger=True, cors_allowed_origins="*")
        self.socketio = WebsocketManager(socketio, self.mn_runner)

    def run(self):
        self.app.run(debug=True, host="0.0.0.0", port=5001)
