from flask_restful import reqparse
from flask import jsonify, make_response
from ..database.TableStates import *

from .Endpoint import Endpoint


class SavedStates(Endpoint):
    def get(self):
        return extractStateData(TableStates.query.filter_by(location = 'saved').order_by(TableStates.last_init.desc()))
    
    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('state_id', required = True, type=str)
        parser.add_argument('name', required = True, type=str)
        parser.add_argument('ask_for_overwrite', required = True, type=bool)
        args = parser.parse_args()
        state_to_save = TableStates.query.filter_by(id = args['state_id']).first()

        # Check if there is already a state with the passed name => update it
        old_saved_state = TableStates.query.filter(TableStates.location == 'saved', TableStates.name == args['name']).first()
        if (old_saved_state):
            # The frontend needs to accept, that the state can be overwritten
            if args['ask_for_overwrite']:
                return "overwrite?"
            
            update_state(old_saved_state, state_to_save)
            self.db.session.add(old_saved_state)
            self.db.session.commit()
            if state_to_save.name != old_saved_state.name:
                state_to_save.name = old_saved_state.name
                flag_modified(state_to_save, "name")
            
        # Create a new one otherwise    
        else:    
            new_state = copy_state(state_to_save)
            new_state.location = 'saved'
            new_state.name = args['name']
            self.db.session.add(new_state)
            self.db.session.commit()
            state_to_save.name = args['name']
            flag_modified(state_to_save, "name")
        self.db.session.add(state_to_save)
        self.db.session.commit()
        return 200

    def patch(self):
        parser = reqparse.RequestParser()
        parser.add_argument('saved_state_id', required = True, type=str)
        parser.add_argument('name', required = False, type=str)
        args = parser.parse_args()
        state_to_edit = TableStates.query.filter_by(id = args['saved_state_id']).first()
        other_state = TableStates.query.filter(TableStates.location == 'saved', TableStates.name == args['name'], id != args['saved_state_id']).first()
        if other_state == None:
            linked_states = TableStates.query.filter_by(name = state_to_edit.name)
            for state in linked_states:
                state.name = args['name']
                flag_modified(state, "name")
                self.db.session.add(state)
                self.db.session.commit()
        else:
            return make_response(jsonify({'error': 'There already exists a state with that name!'}), 400)        

    def delete(self):
        parser = reqparse.RequestParser()
        parser.add_argument('state_id', required = True, type=str)
        args = parser.parse_args()
        state_to_delete = TableStates.query.filter_by(id = args['state_id']).first()
        linked_states = TableStates.query.filter_by(name = state_to_delete.name)
        for state in linked_states:
            state.name = None
            flag_modified(state, "name")
            self.db.session.add(state)
            self.db.session.commit()
        self.db.session.delete(state_to_delete)
        self.db.session.commit()
        return 200