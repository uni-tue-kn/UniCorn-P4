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
from threading import Event, Lock
from unicorn_version import register_version_routes

import json
from .netsim.netsim import MininetRunner


# Uses mininets Node class interfaces to open a terminal on a passed node, send commands and return output
class NodeCLI:
    def __init__(self, node, socket_ref):
        self.node = node
        self.shell = None
        self.thread = None
        self.stop_event = Event()
        self.command_lock = Lock()
        self.socket = socket_ref

        # Starts bash shell on host and registers output handler
        self.register_shell()

    def register_shell(self):
        # Ensure that shell is running on node
        if getattr(self.node, "shell", None) is None:
            self.node.startShell()

    def run_cmd(self, cmd):
        if self.stop_event.is_set():
            return
        if not self.command_lock.acquire(blocking=False):
            self.handle_output("A command is already running. Interrupt it before starting another.\n")
            return
        try:
            self.node.sendCmd(cmd)
            self.wait_output()
        finally:
            self.command_lock.release()

    # NOTE: THIS IS A MODIFIED VERSION OF p4_mininet.node.waitOutput
    # It is modified to use the following funciton instead of monitor
    # All credits belong to original authors
    def wait_output(self):
        while self.node.waiting and not self.stop_event.is_set():
            data = self.node.monitor(timeoutms=100, findPid=False)
            if data:
                self.handle_output(data)
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
        self.node.sendInt()

    def close(self):
        self.stop_event.set()
        if self.node.waiting:
            self.interrupt()

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
        with self.mn_runner.lifecycle_lock:
            # Terminal adapters do not own Mininet nodes. Stopping a node here
            # kills switch processes during terminal initialization/reload.
            for cli in self.clis.values():
                cli.close()
            self.clis = {}
            self.net = None


    def init_clis(self):
        with self.mn_runner.lifecycle_lock:
            self.close_clis()
            self.net = self.mn_runner.net
            if self.net is None:
                return
            for node in self.net.values():
                if isinstance(node, (P4Host, P4Switch)):
                    self.clis[node.name] = NodeCLI(node, self.socket)

    def handle_message(self, message):
        if not isinstance(message, dict):
            return
        target = message.get("target")
        with self.mn_runner.lifecycle_lock:
            cli = self.clis.get(target) if isinstance(target, str) else None
        if cli is None:
            self.socket.emit("response", json.dumps({"name": target,
                "data": "Terminal is unavailable. Load a topology first.\n"}))
            return
        if message.get("interrupt"):
            cli.interrupt()
        elif isinstance(message.get("cmd"), str):
            cli.run_cmd(message["cmd"])


class MininetManager:

    # TODO: Add some lock mechanism for self.mininet since it is accessed by multiple threads
    def __init__(self):

        # Init Flask
        app = Flask(__name__)
        CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
        app.config['CORS_HEADERS'] = 'application/json'
        self.app = app
        register_version_routes(app, "netsim")

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
        topology_file = None
        log_dir = "/topologies/logs"
        pcap_dir = "/topologies/pcaps"
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
        self._socketio = SocketIO(self.app, logger=True, cors_allowed_origins="*")
        self.socketio = WebsocketManager(self._socketio, self.mn_runner)

    def run(self):
        self._socketio.run(self.app, host="0.0.0.0", port=5001, allow_unsafe_werkzeug=True)
