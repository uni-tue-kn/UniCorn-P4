from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import UniqueConstraint
from datetime import datetime
from . import db


# create db model
class SwitchConfigs(db.Model):
    __tablename__ = "SwitchConfigs"
    #__bind_key__ = 'switch_configs'

    id = db.Column(db.Integer, primary_key = True)
    name = db.Column(db.String, nullable = False)
    address = db.Column(db.String, nullable = False)
    device_id = db.Column(db.Integer, nullable = False)
    proto_dump_file = db.Column(db.String, nullable = True)
    register_adapter_enabled = db.Column(db.Boolean, nullable=False, default=False, server_default="0")
    register_thrift_host = db.Column(db.String, nullable=True)
    register_thrift_port = db.Column(db.Integer, nullable=True)
    date_created = db.Column(db.DateTime, default = datetime.utcnow)
    last_connection = db.Column(db.DateTime, default = datetime.utcnow)
    
    # Combination of Name+Address+Device_ID has to be unique
    __table_args__ = (UniqueConstraint('name', 'address', 'device_id', name='uix_1'),)
    
    history = db.relationship('TableStates', backref='switch_config', lazy=True)

    def __repr__(self):
        return '<Name %r>' % self.id


# Helper functions
def extractSwitchData(query):
    data = []
    for switch in query:
        switchDict = {}
        switchDict['id'] = switch.id
        switchDict['name'] = switch.name
        switchDict['address'] = switch.address
        switchDict['device_id'] = switch.device_id
        switchDict['proto_dump_file'] = switch.proto_dump_file
        switchDict['register_adapter_enabled'] = switch.register_adapter_enabled
        switchDict['register_thrift_host'] = switch.register_thrift_host
        switchDict['register_thrift_port'] = switch.register_thrift_port
        switchDict['date_created'] = switch.date_created.isoformat()
        switchDict['last_connection'] = switch.last_connection.isoformat()
        data.append(switchDict)
    return data
