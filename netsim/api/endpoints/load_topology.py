from flask_restful import reqparse
from threading import Thread

from .Endpoint import Endpoint

# Parses a topology file and configures mininet
class LoadTopology(Endpoint):
    def post(self):

        parser = reqparse.RequestParser()
        parser.add_argument('topology_file', required = True, type=str)
        args = parser.parse_args()
                
        try:
            clear_result = self.clear_topology()
            if isinstance(clear_result, tuple) and len(clear_result) == 2 and clear_result[1] != 200:
                return clear_result
            
            self.netsim.topo_file = args.topology_file
            self.netsim.run()

            topo = {
                "hosts": self.netsim.hosts,
                "switches": self.netsim.switches,
                "links": self.netsim.links,
                "file_name": self.netsim.topo_file,
                "switches_online": self.netsim.switch_mappings
            }            

            # Initialize per-node CLIs in the background. This is not required
            # for the topology itself and should not fail the load request.
            Thread(target=self._init_clis_safe, daemon=True).start()

        except Exception as e:
            return f"Something went wrong when creating topology :( Error: {e}", 500
        return topo, 200

    def _init_clis_safe(self):
        try:
            self.ws.init_clis()
        except Exception as e:
            print(f"WARNING: Failed to initialize node CLIs after topology load: {e}")

    def delete(self):
        return self.clear_topology()

    def clear_topology(self):
        try:
            self.ws.close_clis()
            self.netsim.destroy_topology()
            self.netsim.topo_file = None
            topo = {
                "hosts": self.netsim.hosts,
                "switches": self.netsim.switches,
                "links": self.netsim.links,
                "file_name": self.netsim.topo_file
            }  
        except Exception as e:
            return f"Something went wrong when deleting topology :( Error: {e}", 500
        return topo, 200
