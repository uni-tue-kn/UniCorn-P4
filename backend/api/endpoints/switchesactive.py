from flask_restful import reqparse
from flask import jsonify, make_response
from sqlalchemy.exc import IntegrityError

import json
from .Endpoint import Endpoint
from .switch_config import normalize_adapter_config

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

        try:
            switch_config = normalize_adapter_config(json.loads(args['switch_config']))
        except (ValueError, TypeError) as error:
            return {"error": str(error)}, 400
        added_connection = False
        try:
            self.controller.addSwitchConnection(switch_config)
            added_connection = True
            new_switch = SwitchConfigs(**switch_config)
            try:
                self.db.session.add(new_switch)
                self.db.session.commit()
                self.controller.switch_configs[switch_config["device_id"]].db_id = new_switch.id
            except IntegrityError:
                self.db.session.rollback()
                existing_switch = SwitchConfigs.query.filter_by(name= new_switch.name, address = new_switch.address, device_id= new_switch.device_id).first()
                existing_switch.register_adapter_enabled = new_switch.register_adapter_enabled
                existing_switch.register_thrift_host = new_switch.register_thrift_host
                existing_switch.register_thrift_port = new_switch.register_thrift_port
                existing_switch.proto_dump_file = new_switch.proto_dump_file
                existing_switch.last_connection = datetime.utcnow()
                self.db.session.commit()
                self.controller.switch_configs[switch_config["device_id"]].db_id = existing_switch.id
        except Exception as e:
            self.db.session.rollback()
            if added_connection:
                try:
                    self.controller.deleteSwitchConnection(switch_config["device_id"])
                except Exception as close_error:
                    return {"error": f"{e}; closing failed connection: {close_error}"}, 500
            return make_response(jsonify({'error': str(e)}), 500)
            
        
    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('device_id', required = False, type=int)
        args = parser.parse_args()
        if args["device_id"] is not None:
            self.controller.deleteSwitchConnection(args['device_id'])
        else:
            self.controller.deleteAllSwitchConnections()
