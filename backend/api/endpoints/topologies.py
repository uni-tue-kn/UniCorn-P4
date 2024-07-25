import json.scanner
from flask_restful import reqparse
from ..database.TableStates import *
from .Endpoint import Endpoint
import json

import glob


class Topologies(Endpoint):

    def get(self):

        # TODO: move this to a configuration file
        topo_dir = "/netsim/"

        # Req Parameters:
        # - name: Name of topologies to fetch. If emtpy, return list of available topologies
        parser = reqparse.RequestParser()
        parser.add_argument('name', required = False,  location = 'values', type=str)
        args = parser.parse_args()

        # Get all JSON files in Mininet Dir
        topologies = glob.glob(topo_dir+'**/*.json', recursive=True)
        # Remove the root directory from every entry for easier handling by user
        topologies = [path.replace(topo_dir,"") for path in topologies]

        # If name arg is set, return queried topology. Else return list of topologies
        topology_name = args["name"]
        if topology_name is not None:
            # Check if passed argument is valid topology name
            if topology_name in topologies:
                # Do not use topology_name directly to load a file form system to prevent exploits
                # Rather get corresponding index in local file list
                index = topologies.index(topology_name)
                # Load topology from JSON file
                topology = None
                with open(topo_dir + topologies[index],"r",encoding="utf-8") as infile:
                    topology = json.load(infile)
                
                # Handle failed file load, this should not happen.
                if topology is None:
                    return 500

                return {topology_name: topology}
            else:
                raise Exception("Invalid topology requested!")
            
        else:
            # Return dictionary for frontend
            return {"topologies": topologies}

