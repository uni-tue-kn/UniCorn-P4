from flask_restful import reqparse
from flask import jsonify, make_response, request

import json
import time
from .Endpoint import Endpoint

from ..database.TableStates import *
from ..database.SwitchConfigs import *


class SwitchesFromTopology(Endpoint):
    AUTOCONNECT_RETRIES = 6
    AUTOCONNECT_RETRY_DELAY_SECONDS = 0.5

    def switch_exists_in_db(self, name, address, device_id):
        return db.session.query(SwitchConfigs.id).filter_by(name=name, address=address, device_id=device_id).first() is not None

    def _switch_key(self, switch_config):
        return (switch_config["name"], switch_config["address"], switch_config["device_id"])

    def _get_or_create_switch_records(self, switch_configs):
        records = {}
        for switch in switch_configs:
            key = self._switch_key(switch)
            record = SwitchConfigs.query.filter_by(
                name=switch["name"],
                address=switch["address"],
                device_id=switch["device_id"],
            ).first()
            if record is None:
                record = SwitchConfigs(**switch)
                self.db.session.add(record)
                self.db.session.flush()
            records[key] = record
        self.db.session.commit()
        return records

    def _is_retryable_autoconnect_error(self, err):
        msg = str(err)
        return (
            "Connection refused" in msg
            or "failed to connect to all addresses" in msg
            or "grpc_status:14" in msg
        )

    def _add_switch_connection_with_retry(self, switch_config):
        last_err = None
        for attempt in range(self.AUTOCONNECT_RETRIES):
            try:
                self.controller.addSwitchConnection(switch_config)
                return
            except Exception as err:
                last_err = err
                if not self._is_retryable_autoconnect_error(err):
                    raise
                if attempt == self.AUTOCONNECT_RETRIES - 1:
                    break
                print(
                    f"Autoconnect retry {attempt + 1}/{self.AUTOCONNECT_RETRIES - 1} "
                    f"for switch {switch_config.get('name')} at {switch_config.get('address')}: {err}"
                )
                time.sleep(self.AUTOCONNECT_RETRY_DELAY_SECONDS)
        raise last_err

    def post(self):
        
        data = request.get_json()

        if data is None or 'switch_configs' not in data:
                return jsonify({'error': 'No switch_configs key in JSON data'}), 400
        create_switches = data["create_switches"] if 'create_switches' in data else False

        switch_configs = json.loads(data['switch_configs'])
        connected_device_ids = []
        
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
                switch_records = self._get_or_create_switch_records(switch_configs)
                
                for idx, switch in enumerate(switch_configs):
                    self._add_switch_connection_with_retry(switch)
                    connected_device_ids.append(switch["device_id"])
                    self.controller.switch_configs[switch["device_id"]].db_id = switch_records[self._switch_key(switch)].id
                
            return make_response(jsonify(self.controller.getSwitchConnections()), 200)
            
        except Exception as e:
                for device_id in connected_device_ids:
                    if device_id in self.controller.switch_configs:
                        self.controller.deleteSwitchConnection(device_id)
                return f"There was an error adding a switch: {e}", 500
