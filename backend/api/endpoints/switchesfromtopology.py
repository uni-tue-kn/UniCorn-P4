from flask_restful import reqparse
from flask import jsonify, make_response, request

import json
from .Endpoint import Endpoint

from ..database.TableStates import *
from ..database.SwitchConfigs import *


class SwitchesFromTopology(Endpoint):

    def switch_exists_in_db(self, name, address, device_id):
        return db.session.query(SwitchConfigs.id).filter_by(name=name, address=address, device_id=device_id).first() is not None

    def post(self):
        
        data = request.get_json()

        if 'switch_configs' not in data:
                return jsonify({'error': 'No switch_configs key in JSON data'}), 400
        create_switches = data["create_switches"] if 'create_switches' in data else False

        switch_configs = json.loads(data['switch_configs'])
        
        # Disconnect all connected switches
        connections = self.controller.getSwitchConnections()
        for switch in connections:
            print(f"Disconnected switch {switch['device_id']}")
            self.controller.deleteSwitchConnection(switch["device_id"])
    
        # Delete switches from database
        #self.db.session.query(SwitchConfigs).delete()
        #self.db.session.commit()
        try:
            if create_switches:
            # Connect the new ones
                new_switch_configs = [SwitchConfigs(**switch) for switch in switch_configs]
                
                # Those entries are checkef for duplicates first in the database
                new_switch_configs_for_db = [SwitchConfigs(**s) for s in switch_configs if not self.switch_exists_in_db(s["name"], s["address"], s["device_id"])]
                db.session.add_all(new_switch_configs_for_db)
                self.db.session.commit()            
                
                for idx, switch in enumerate(switch_configs):
                    self.controller.addSwitchConnection(switch)
                    self.controller.switch_configs[switch["device_id"]].db_id = new_switch_configs[idx].id
                
            return make_response(jsonify(self.controller.getSwitchConnections()), 200)
            
        except Exception as e:
                return f"There was an error adding a switch: {e}", 500