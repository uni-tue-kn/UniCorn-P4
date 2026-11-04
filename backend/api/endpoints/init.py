from flask_restful import Resource, reqparse
from flask import jsonify, make_response
import grpc

from ..database.TableStates import *

from .Endpoint import Endpoint
from ..program_builds import BuildError, validate_bundle


# Initializes (new) p4 program
class Initialize(Endpoint):
    def get(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True,  location = 'values', type=int)
        args = parser.parse_args()
        
        # Get state of files loaded by controller
        try:
            initializedFiles = self.controller.getInitializedFiles(args['switch_id'])
        except KeyError:
            return {"error": f"Switch id={args['switch_id']} is not initialized"}
        # Translate state_id into readable state name
        if initializedFiles["state_id"] is not None:
           initializedState = TableStates.query.filter_by(id = initializedFiles["state_id"]).first()
           initializedFiles["state_name"] = initializedState.name if initializedState is not None else None
        return initializedFiles

    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('switch_id', required = True, type=int)
        parser.add_argument('p4_info_file', required = False, type = str)
        parser.add_argument('bmv2_file', required = False, type = str)
        parser.add_argument('program_id', required = False, type = str)
        parser.add_argument('keep_entries', required = False, type = bool)
        parser.add_argument('state_id', required = False, type = str)
        args = parser.parse_args()
        
        switch_id_arg = args['switch_id']
        p4_info_file_arg = args['p4_info_file']
        bmv2_file_arg = args['bmv2_file']
        state_id_arg = args['state_id']
        
        warning_msg = ""

        try:
            current_switch_config = self.controller.switch_configs.get(switch_id_arg)
            if current_switch_config is None:
                return {'error': 'Switch connection does not exist'}, 404
            if getattr(current_switch_config, 'read_only', False):
                return {'error': 'This switch connection is read only. The running program is discovered automatically.'}, 403
            target = getattr(current_switch_config, 'target', 'bmv2')
            reinitialized_state = None
            if state_id_arg:
                reinitialized_state = TableStates.query.filter_by(id=state_id_arg).first()
                if reinitialized_state is None:
                    return {'error': 'Saved state does not exist'}, 404
                if (reinitialized_state.target or 'bmv2') != target:
                    raise ValueError('Saved state target does not match switch target')
            program_id = args['program_id'] or (reinitialized_state.program_manifest if reinitialized_state else None)
            bundle = validate_bundle(program_id) if program_id else None
            if bundle is not None and bundle['target'] != target:
                raise ValueError('Program target does not match switch target')
            if reinitialized_state is not None:
                # A state must refer to the program that produced its entries.
                if args['program_id'] and args['program_id'] != reinitialized_state.program_manifest:
                    raise ValueError('Selected program does not match saved state')
                self.controller.initializeStoredState(switch_id_arg, reinitialized_state,
                    keep_entries=bool(args['keep_entries']), bundle=bundle)
                p4_info_file_arg, bmv2_file_arg = reinitialized_state.p4_info_file, reinitialized_state.bmv2_file
            elif bundle is not None:
                current_switch_config.initialize_bundle(bundle, bool(args['keep_entries']))
                p4_info_file_arg = bundle.get('p4info', '')
                bmv2_file_arg = bundle.get('bmv2_json', '')
            elif target == 'tofino':
                raise ValueError('Select a compiled program for this switch')
            else:
                if not p4_info_file_arg or not bmv2_file_arg:
                    raise ValueError('Select a compiled program or both compilation files')
                self.controller.initialize(switch_id = switch_id_arg, p4_info_file = p4_info_file_arg, bmv2_file = bmv2_file_arg, keep_entries = args['keep_entries'])

            current_switch_config = self.controller.switch_configs[switch_id_arg]
            current_switch_config_db_id = current_switch_config.db_id

            # state already exist and has been re-initialized
            if state_id_arg:
                reinitialized_state.last_init = datetime.utcnow()
                flag_modified(reinitialized_state, "last_init")
                self.db.session.add(reinitialized_state)
                self.db.session.commit()
                new_id = state_id_arg
                if (reinitialized_state.location == 'saved'):
                    new_state = copy_state(reinitialized_state)
                    new_state.name = reinitialized_state.name
                    new_state.switch_config_id = current_switch_config_db_id
                    self.db.session.add(new_state)
                    self.db.session.commit()
                    new_id = new_state.id

                current_switch_config.state_id = new_id
                
                # re-write the old entries to the switch
                table_entries = reinitialized_state.table_entries
                changed_tables = []
                for table in table_entries:
                    for entry in table_entries[table]:
                        try:
                            self.controller.postTableEntry(switch_id = switch_id_arg, entry = entry["switch_entry"], is_json = False)
                        except grpc.RpcError:
                            changed_tables.append(table)
                            # Skip this table
                            continue
                if changed_tables:
                    changed_tables_string = ", ".join(changed_tables)
                    warning_msg += f"MAT structure of tables {changed_tables_string} changed from saved state. Entries are not loaded."

            # state doesnt exist -> create a new one    
            else:
                # create blueprint for the table entries
                initial_table_entries = self.controller.getTableEntries(switch_id = switch_id_arg, requested_table_name = None)
                
                # get the initial decoding for the frontend-representation (default: 'numeric')
                initial_decoding = self.controller.getInitialDecoding(switch_id = switch_id_arg,
                    p4_info_file = p4_info_file_arg if target == 'bmv2' else None)

                # get the table info
                table_info = self.controller.getTableInfo(switch_id = switch_id_arg)

                # create database entry
                new_state = TableStates(p4_info_file = p4_info_file_arg, bmv2_file = bmv2_file_arg, table_entries = initial_table_entries,
                                        decoding = initial_decoding, table_info = table_info, switch_config_id = current_switch_config_db_id,
                                        target=target, program_manifest=bundle['manifest_path'] if bundle else None,
                                        program_name=bundle['program_name'] if bundle else None)

                
                # push entry to database
                self.db.session.add(new_state)
                self.db.session.commit()
                self.db.session.refresh(new_state)
                current_switch_config.state_id = new_state.id
                
        except BuildError as e:
            return {'error': str(e)}, e.status
        except ValueError as e:
            return {"error": str(e)}, 400
        except grpc.RpcError as e:
            # TODO: better error handling with json response
            return f"Failed to initialize Switch. GRPC Connection is not available: {e}", 500
        except Exception as e:
            return f"An error occured during switch initialization: {e}", 500
        
        if warning_msg:
            return warning_msg, 200
        return "", 200
        
