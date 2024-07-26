from .endpoints.load_topology import LoadTopology
from .endpoints.get_topology import GetTopology
from .endpoints.switchesonline import SwitchesOnline
from .netsim.netsim import MininetRunner


from flask import Flask
from flask_restful import Api
from flask_socketio import SocketIO,emit
from flask_cors import CORS

from .netsim.netsim import MininetRunner

# TODO: ensure that terminal is synchronized across multiple users
class WebsocketManager:

    def __init__(self, socket, mininet_runner):
        self.mininet = mininet_runner
        self.socket = socket

        self.socket.on("message",self.handle_message)

    def run(self):
        self.socket

    


class MininetManager:

    # TODO: Add some lock mechanism for self.mininet since it is accessed by multiple threads
    def __init__(self):

        # Init Flask
        app = Flask(__name__)
        CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
        app.config['CORS_HEADERS'] = 'application/json'
        self.app = app

        # Reference to Mininet simulation runner
        self.netsim = None
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

        self.netsim = MininetRunner(topology_file, log_dir, pcap_dir, quiet)

    def create_api(self):
        self.api = Api(self.app)
        self.api.add_resource(LoadTopology, '/topology/load', resource_class_kwargs={"netsim": self.netsim})
        self.api.add_resource(GetTopology, '/topology/get', resource_class_kwargs={"netsim": self.netsim})
        self.api.add_resource(SwitchesOnline, '/switches/online', resource_class_kwargs={"netsim": self.netsim})

    def create_websocket(self):
        

        # TODO: this catches the "AssertionError: write() before start_respons" error, the socket still establishes
        # Handlign should be done better than this
        try:
            socketio = SocketIO(self.app,logger=True, engineio_logger=True, cors_allowed_origins="*")
        except:
            pass

        @socketio.on('message')
        def handle_message(message):
            emit("response","TEST")

    def run(self):
        self.app.run(debug=True, host="0.0.0.0", port=5001)

        
        
        

       

