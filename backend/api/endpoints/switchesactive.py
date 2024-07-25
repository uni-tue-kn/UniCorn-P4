from flask_restful import reqparse
from flask import jsonify, make_response
from sqlalchemy.exc import IntegrityError

import json
from .Endpoint import Endpoint

from ..database.TableStates import *
from ..database.SwitchConfigs import *


class SwitchesActive(Endpoint):
    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = False,  location = 'values', type=int)
        args = parser.parse_args()
        connections = self.controller.getSwitchConnections()
        current_switch_connected = self.controller.switch_configs.get(args["switch_id"]) is not None
        return {
            "connections": connections,
            "current_switch_connected": current_switch_connected
        }
    
    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_config', required = True, type=str)
        args = parser.parse_args()

        switch_config = json.loads(args['switch_config'])
        try:
            self.controller.addSwitchConnection(switch_config)
            new_switch = SwitchConfigs(**switch_config)
            try:
                self.db.session.add(new_switch)
                self.db.session.commit()
                self.controller.switch_configs[switch_config["device_id"]].db_id = new_switch.id
            except IntegrityError:
                self.db.session.rollback()
                print("Entry in SwitchConfigs already exists")
                existing_switch = SwitchConfigs.query.filter_by(name= new_switch.name, address = new_switch.address, device_id= new_switch.device_id).first()
                self.controller.switch_configs[switch_config["device_id"]].db_id = existing_switch.id
        except Exception as e:
                return make_response(jsonify({'error': str(e)}), 500)
            
        
    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('device_id', required = True, type=int)
        args = parser.parse_args()
        self.controller.deleteSwitchConnection(args['device_id'])
        




