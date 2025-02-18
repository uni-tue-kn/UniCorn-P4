from flask_restful import reqparse
from flask import jsonify, make_response
import json
import grpc

from .Endpoint import Endpoint
from ..database.TableStates import *

# Operations on the currently initialized p4 program 
class Tables(Endpoint):
    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, location = 'values', type=int)
        parser.add_argument('table_name', required = True, location = 'values', type=str)
        args = parser.parse_args()

        try:
            # TODO: old code assumes that return of this is a list if a name is passed
            # However, the new implementation always returns a dict
            # This fix works, but does not look that good for now
            frontend_entries = self.controller.getTableEntries(args['switch_id'], args['table_name'])
            frontend_entries = frontend_entries[args['table_name']]

            # database
            current_switch_config = self.controller.switch_configs[args['switch_id']]
            state_id = current_switch_config.state_id
            if state_id is not None:
                state_to_edit = TableStates.query.filter_by(id = state_id).first()
                state_to_edit.table_entries[args['table_name']] = [
                    {k: v for k, v in e.items() if k != "id" } 
                    for e in frontend_entries
                    ]
                flag_modified(state_to_edit, "table_entries")
                self.db.session.add(state_to_edit)
                self.db.session.commit()

            try:
                # Try to retrieve direct counter values, if there are any. 
                direct_counters = current_switch_config.get_loaded_config()["direct_counters"]
                if direct_counters:
                    table_id = current_switch_config.p4_helper.get_tables_id(args['table_name'])
                    if any(entry.get("table_id") == table_id for entry in direct_counters.values()):
                        # Merge them by index to each entry
                        counter_values = self.controller.switch_configs[args['switch_id']].get_direct_counter_values(table_id=table_id)['entries']
                        frontend_entries = [{**b_obj, "counters": {"packets": a_obj["packets"], "bytes": a_obj["bytes"]}} for a_obj, b_obj in zip(counter_values, frontend_entries)]
                
            except Exception as e:
                print(e)
            return frontend_entries, 200
        except grpc.RpcError as e:
            return self.returnGrpcError(e)
        except Exception as e:
            return make_response(jsonify({'error': str(e)}), 500)
            

    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, type=int)
        parser.add_argument('entry', required = True, type=str)
        args = parser.parse_args()
        try:
            self.controller.postTableEntry(args['switch_id'], entry = args['entry'])
        except grpc.RpcError as e:
            return self.returnGrpcError(e)
        except Exception as e:
            return make_response(jsonify({'error': str(e)}), 500)

    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, type=int)
        parser.add_argument('entry', required = True, type=str)
        args = parser.parse_args()
        try:
            self.controller.removeTableEntry(args['switch_id'], entry = args['entry'])
        except grpc.RpcError as e:
            return self.returnGrpcError
        except Exception as e:
            return make_response(jsonify({'error': e}), 500)

    def patch(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, type=int)
        # Old Table Entry:
        parser.add_argument('old', required = True, type=str)
        # New Table Entry:
        parser.add_argument('new', required = True, type=str)
        args = parser.parse_args()
        old = json.loads(args['old'])
        new = json.loads(args['new'])

        # entry list
        if isinstance(old, list):
            try:
                self.controller.updateTableEntries(args['switch_id'], old_entries_list = old, new_entries_list = new)
            # TODO: better Error, this should be thrown by the controller function
            except Exception as error:
                self.restoreTableEntries(args['switch_id'])
                return make_response(jsonify({'error': (error.e + " The entry, that caused the error is marked red."), 'id': error.id}), 500)
        
        # single entry
        else:
            try:
                self.controller.patchTableEntry(args['switch_id'], old_entry_dict = old, new_entry_dict = new)
            except grpc.RpcError as e:
                self.restoreTableEntries(args['switch_id'])
                return self.returnGrpcError(e)
                
            except Exception as e:
                self.restoreTableEntries(args['switch_id'])
                return make_response(jsonify({'error': str(e)}), 500) 


    # Table entries should be restored, if an error comes up during patch
    def restoreTableEntries(self,switch_id):
        current_state = TableStates.query.filter_by(id = self.controller.switch_configs[switch_id].state_id).first()
        if (current_state is not None):
            self.controller.initialize(switch_id, p4_info_file = current_state.p4_info_file, bmv2_file = current_state.bmv2_file, keep_entries = False)
            # re-write the old entries to the switch
            table_entries = current_state.table_entries
            for table in table_entries:
                for entry in table_entries[table]:
                    self.controller.postTableEntry(switch_id, entry = entry["switch_entry"], is_json = False)

    def returnGrpcError(self,e):
        if e.details() == "":
            return make_response(jsonify({'error': str(e.code()) + ": " + "An unknown grpc error occurred. Maybe the entry you tried to write has the same match values as an existing entry."}), 500)
        else:
            return make_response(jsonify({'error': str(e.code()) + ": " + e.debug_error_string()}), 500)

