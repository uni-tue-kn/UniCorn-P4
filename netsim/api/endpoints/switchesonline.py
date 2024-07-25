from flask_restful import reqparse
from flask import jsonify, make_response

from .Endpoint import Endpoint

class SwitchesOnline(Endpoint):
    def get(self):
                
        try:
            d = {"switches_online": self.netsim.switch_mappings}
            return d, 200
        except Exception as e:
            return f"Something went wrong when getting switches :( Error: {e}", 500
        
