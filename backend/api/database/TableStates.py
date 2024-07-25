from sqlalchemy.orm.attributes import flag_modified
from datetime import datetime

from . import db
from .SwitchConfigs import SwitchConfigs

# create db model
class TableStates(db.Model):
    __tablename__ = "TableStates"
    #__bind_key__ = 'table_states'

    id = db.Column(db.Integer, primary_key = True)
    p4_info_file = db.Column(db.String, nullable = False)
    bmv2_file = db.Column(db.String, nullable = False)
    table_entries = db.Column(db.JSON, default = {})
    decoding = db.Column(db.JSON, default = {})
    table_info = db.Column(db.JSON, default = {})
    date_created = db.Column(db.DateTime, default = datetime.utcnow)
    last_init = db.Column(db.DateTime, default = datetime.utcnow)
    location = db.Column(db.String, nullable = False, default = 'history')
    initial_state_id = db.Column(db.Integer, default = None)
    name = db.Column(db.String, default = None)
    switch_config_id = db.Column(db.Integer, db.ForeignKey('SwitchConfigs.id'))

    def __repr__(self):
        return '<Name %r>' % self.id


# Helper functions
def extractStateData(query):
    data = []
    for state in query:
        stateDict = {}
        stateDict['id'] = state.id
        stateDict['p4_info_file'] = state.p4_info_file
        stateDict['bmv2_file'] = state.bmv2_file
        stateDict['table_entries'] = state.table_entries
        stateDict['decoding'] = state.decoding
        stateDict['table_info'] = state.table_info
        stateDict['date_created'] = state.date_created.isoformat()
        stateDict['last_init'] = state.last_init.isoformat()
        stateDict['location'] = state.location
        stateDict['initial_state_id'] = state.initial_state_id
        stateDict['name'] = state.name
        data.append(stateDict)
    return data

def copy_state(state_to_copy):
    # Create a new instance of the TableStates model class
    new_state = TableStates()
    
    # Copy the values from the existing row to the new row
    new_state.p4_info_file = state_to_copy.p4_info_file
    new_state.bmv2_file = state_to_copy.bmv2_file
    new_state.table_entries = state_to_copy.table_entries
    new_state.decoding = state_to_copy.decoding
    new_state.table_info = state_to_copy.table_info
    new_state.last_init = state_to_copy.last_init
    return new_state

def update_state(state_to_update, updated_state):
    state_to_update.table_entries = updated_state.table_entries
    state_to_update.decoding = updated_state.decoding
    flag_modified(state_to_update, "table_entries")
    flag_modified(state_to_update, "decoding")