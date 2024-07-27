from .endpoints.load_topology import LoadTopology
from .endpoints.get_topology import GetTopology
from .endpoints.switchesonline import SwitchesOnline
from .netsim.netsim import MininetRunner


from flask import Flask
from flask_restful import Api
from flask_socketio import SocketIO,emit
from flask_cors import CORS

from mininet.cli import CLI
from mininet.log import lg, output

from .netsim.netsim import MininetRunner
from io import StringIO
from cmd import Cmd
import logging
from select import poll
import sys

# Handler that calls function on each new line
class LoggingHook(logging.Handler):

    def __init__(self, callback):
        super().__init__()
        self.callback = callback
        self.level = logging.INFO

    # Call the supplie function with the logging content
    def emit(self, record):
        print("HOOK",record.msg)
        self.callback(record.msg)


# This is a wrapper around the mininet CLI that allows to pass single commands in
class MininetCLIWrapper(CLI):

    # NOTE: this is mostly the same as the regular CLI, some changes were made to capture the output of the CLI to a stream
    def __init__(self, network, log_hook):
        self.mn_runner = network
        self.mn = network.net
        self.locals = { 'net': network }
        self.log_hook = log_hook
        Cmd.__init__( self )

        self.inPoller = poll()
        self.inPoller.register( sys.stdin )

        # Create StringIO stream that will access the mininet logger
        self.log_stream = StringIO()
        # Logging hook that calls supplied function for each new log record
        self.handler = LoggingHook(self.forward_logging)

        # Attach stream handler to central mininet logger to capture command oputputs
        lg.addHandler(self.handler)

        # Calle needed by original CLI
        self.initReadline()

    # Execs a single command and captures the stdout
    def exec_command(self, cmd):
        # Execute given command, will call functions in parent class CLI based on passed command

        print("SELF",self.mn)
        if (self.mn is None) and (self.mn_runner.net is not None):
            self.mn = self.mn_runner.net
        else:
            output("There is no active mininet simulation. Please load a topology first!")
            return 
        try:
            self.onecmd(cmd)
        except:
            pass


    def forward_logging(self, msg):
        self.log_hook(msg)
    
# TODO: ensure that terminal is synchronized across multiple users
class WebsocketManager:

    def __init__(self, socket, mininet_runner):
        self.mn_runner = mininet_runner
        self.socket = socket
        self.index = 0
        self.cli_io = None

        # TODO: ensure that this does not cause problems with memory if programs runs for a lont time
        self.history = []

        # Register message handlers for Websocket
        self.register_handlers()

        # Spawns CLI for mininet
        self.init_cli()

    def register_handlers(self):
        self.socket.on_event('message', self.handle_message)

    def init_cli(self):
        self.cli_io = MininetCLIWrapper(self.mn_runner,self.handle_log_message)

    def handle_message(self,message):
        self.cli_io.exec_command(message)

    def handle_log_message(self, message):
        # Message is broadcasted -> to synchronize if multiple clients acess terminal at the same time
        emit("response",message,broadcast=True)

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

        # Create API endpoint
        self.create_api()

        # Create websocket for mininet terminal
        self.create_websocket()
    
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
        self.api.add_resource(LoadTopology, '/topology/load', resource_class_kwargs={"netsim": self.mn_runner})
        self.api.add_resource(GetTopology, '/topology/get', resource_class_kwargs={"netsim": self.mn_runner})
        self.api.add_resource(SwitchesOnline, '/switches/online', resource_class_kwargs={"netsim": self.mn_runner})

    def create_websocket(self):

        # TODO: this catches the "AssertionError: write() before start_respons" error, the socket still establishes
        # Handlign should be done better than this
        socketio = SocketIO(self.app,logger=True,cors_allowed_origins="*")
        self.socketio = WebsocketManager(socketio,self.mn_runner)
        
    def run(self):
        self.app.run(debug=True, host="0.0.0.0", port=5001)

        
        
        

       

