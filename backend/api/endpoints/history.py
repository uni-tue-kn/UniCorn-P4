from flask_restful import reqparse
from ..database.TableStates import *
from .Endpoint import Endpoint

   

# Former table states the user already worked with (a state includes the initialized p4 program and the table entries, that existed last time)
class HistoryStates(Endpoint):

    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True,  location = 'values', type=int)
        args = parser.parse_args()
        
        try:
            current_switch_config = self.controller.switch_configs[args['switch_id']]
        except KeyError:
            return f"Could not retrieve history for {args['switch_id']}. Try reconnecting the switch"
        current_switch_config_db_id = current_switch_config.db_id
        history_data = TableStates.query.filter(TableStates.location == 'history', TableStates.switch_config_id == current_switch_config_db_id)
        history_data = history_data.order_by(TableStates.last_init.desc())
        return extractStateData(history_data)
    
    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('state_id', required = True, type=str)
        args = parser.parse_args()
        state_to_delete = TableStates.query.filter_by(id = args['state_id']).first()
        self.db.session.delete(state_to_delete)
        self.db.session.commit()
        return 200