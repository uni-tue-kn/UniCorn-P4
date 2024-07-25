from flask_restful import reqparse
from flask import jsonify, make_response

from .Endpoint import Endpoint

class GetTopology(Endpoint):
    def get(self):
                
        try:
            # Returns the parsed topology, not the topology file.
            # This ensures that the actually built topology is returned
            topo = {
                "hosts": self.netsim.hosts,
                "switches": self.netsim.switches,
                "links": self.netsim.links,
                "file_name": self.netsim.topo_file
            }
            return topo, 200
        except Exception as e:
            return f"Something went wrong when getting switches :( Error: {e}", 500
        
