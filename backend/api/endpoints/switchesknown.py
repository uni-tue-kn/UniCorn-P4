from flask_restful import reqparse
from flask import jsonify, make_response
import json

from .Endpoint import Endpoint

from ..database.TableStates import *
from ..database.SwitchConfigs import *


class SwitchesKnown(Endpoint):
    def get(self):
        connections = self.controller.getSwitchConnections()
        db_id_list = [connection_dict["db_id"] for connection_dict in connections]
        switches = SwitchConfigs.query.filter(~SwitchConfigs.id.in_(db_id_list)).order_by(SwitchConfigs.name)
        return extractSwitchData(switches)
    
    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('db_id', required = True, type=int)
        args = parser.parse_args()
            
        db_config = SwitchConfigs.query.filter_by(id = args['db_id']).first()
        switch_config = {
            "name": db_config.name,
            "address": db_config.address,
            "device_id": db_config.device_id,
            "proto_dump_file": db_config.proto_dump_file
        }
        try:
            self.controller.addSwitchConnection(switch_config)
            self.controller.switch_configs[switch_config["device_id"]].db_id = args['db_id']
            return db_config.device_id
        except Exception as e:
            return make_response(jsonify({'error': str(e)}), 500)
            
    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('db_id', required = True, type=int)
        args = parser.parse_args()
        switch_to_delete = SwitchConfigs.query.filter_by(id = args['db_id']).first()
        self.db.session.delete(switch_to_delete)
        self.db.session.commit()

    def patch(self):
        parser = reqparse.RequestParser()
        parser.add_argument('db_id', required = True, type=int)
        parser.add_argument('switch_config', required = True, type=str)
        args = parser.parse_args()
        switch_to_edit = SwitchConfigs.query.filter_by(id = args['db_id']).first()
        new_switch_config = json.loads(args['switch_config'])
        switch_to_edit.name = new_switch_config["name"]
        switch_to_edit.address = new_switch_config["address"]
        switch_to_edit.device_id = new_switch_config["device_id"]
        switch_to_edit.proto_dump_file = new_switch_config["proto_dump_file"]
        flag_modified(switch_to_edit, "name")
        flag_modified(switch_to_edit, "address")
        flag_modified(switch_to_edit, "device_id")
        flag_modified(switch_to_edit, "proto_dump_file")
        self.db.session.add(switch_to_edit)
        self.db.session.commit()