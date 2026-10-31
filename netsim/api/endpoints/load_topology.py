from flask_restful import reqparse

from .Endpoint import Endpoint

# Parses a topology file and configures mininet
class LoadTopology(Endpoint):
    def post(self):

        parser = reqparse.RequestParser()
        parser.add_argument('topology_file', required = True, type=str)
        args = parser.parse_args()
                
        try:
            with self.netsim.lifecycle_lock:
                candidate = self.netsim.read_topology_file(args.topology_file)
                self.ws.close_clis()
                self.netsim.topo_file = args.topology_file
                self.netsim.run(candidate=candidate)
                # Creating adapters is immediate: existing node shells already
                # run. Finish while holding the lifecycle lock so no stale
                # background initializer can attach to a later topology.
                self._init_clis_safe()
                topo = self.netsim.topology_state(include_switches_online=True)
        except (ValueError, OSError) as e:
            return {"error": f"Invalid topology: {e}"}, 400
        except Exception as e:
            self.netsim.topo_file = None
            return {"error": f"Could not create topology: {e}"}, 500
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
            with self.netsim.lifecycle_lock:
                self.ws.close_clis()
                self.netsim.destroy_topology()
                self.netsim.topo_file = None
                topo = self.netsim.topology_state()
        except Exception as e:
            return f"Something went wrong when deleting topology :( Error: {e}", 500
        return topo, 200
