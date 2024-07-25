import json
from flask_restful import reqparse
from ..database.TableStates import *
from .Endpoint import Endpoint


# TODO: all endpoints should have the same __init__, add custom class?
class Decoding(Endpoint):

    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True,  location = 'values', type=int)
        parser.add_argument('state_id', required = False,  location = 'values', type=int)
        args = parser.parse_args()
        if args['state_id'] is not None:
            state_data = TableStates.query.filter_by(id = args['state_id']).first()
            return state_data.decoding
        else:
            return self.controller.getInitialDecoding(args['switch_id'])

    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('state_id', required = True, type=int)
        parser.add_argument('decoding', required = True, type=str)
        args = parser.parse_args()
        state_to_edit = TableStates.query.filter_by(id = args['state_id']).first()
        decoding_dict = json.loads(args['decoding'])
        state_to_edit.decoding = decoding_dict
        flag_modified(state_to_edit, "decoding")
        self.db.session.add(state_to_edit)
        self.db.session.commit()