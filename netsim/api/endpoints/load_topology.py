from flask_restful import reqparse

from .Endpoint import Endpoint

# Parses a topology file and configures mininet
class LoadTopology(Endpoint):
    def post(self):

        parser = reqparse.RequestParser()
        parser.add_argument('topology_file', required = True, type=str)
        args = parser.parse_args()
                
        try:
            # TODO make this async so that frontend does not block?
            self.netsim.topo_file = args.topology_file
            self.netsim.run()
            
            topo = {
                "hosts": self.netsim.hosts,
                "switches": self.netsim.switches,
                "links": self.netsim.links,
                "file_name": self.netsim.topo_file
            }            
        except Exception as e:
            return f"Something went wrong when creating topology :( Error: {e}", 500
        return topo, 200

    def delete(self):
        try:
            self.netsim.destroy_topology()
            topo = {
                "hosts": self.netsim.hosts,
                "switches": self.netsim.switches,
                "links": self.netsim.links,
                "file_name": self.netsim.topo_file
            }  
        except Exception as e:
            return f"Something went wrong when deleting topology :( Error: {e}", 500
        return topo, 200