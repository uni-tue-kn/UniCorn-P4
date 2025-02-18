from ..database.TableStates import *
from .Endpoint import Endpoint
from flask import jsonify, make_response
from flask_restful import reqparse


# Returns counter values in the P4 program
class CounterValue(Endpoint):
    
    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, location = 'values', type=int)
        parser.add_argument('counter_id', required = True, location = 'values', type=int)
        parser.add_argument('index', required = False, location = 'values', type=int)
        args = parser.parse_args()

        try:
            counter_values = self.controller.switch_configs[args['switch_id']].get_counter_values(counter_id=args.counter_id)
            return make_response(jsonify({'data': str(counter_values)}), 200)            
        except Exception as e:
            return make_response(jsonify({'error': e, 'data': ''}), 500)            