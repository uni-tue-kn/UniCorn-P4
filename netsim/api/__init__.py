from .endpoints.load_topology import LoadTopology
from .endpoints.get_topology import GetTopology
from .endpoints.switchesonline import SwitchesOnline
from .netsim.netsim import MininetRunner


from flask import Flask
from flask_restful import Api
from flask_cors import CORS

from .netsim.netsim import MininetRunner

def create_app():
    app = Flask(__name__)
    CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
    app.config['CORS_HEADERS'] = 'application/json'

    # Topology will be filled from controller. 
    # TODO set default value for this?
    topology_file = None
    # TODO move this into configuration file
    log_dir = "/app/netsim/logs"
    pcap_dir = "/app/netsim/pcaps"
    quiet = False
            
    netsim = MininetRunner(topology_file, log_dir, pcap_dir, quiet)

    api = Api(app)
    
    api.add_resource(LoadTopology, '/topology/load', resource_class_kwargs={"netsim": netsim})
    api.add_resource(GetTopology, '/topology/get', resource_class_kwargs={"netsim": netsim})
    api.add_resource(SwitchesOnline, '/switches/online', resource_class_kwargs={"netsim": netsim})

    return app

