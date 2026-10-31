from .endpoints import *
from .database import db
from .database.migrations import migrate_switch_adapter_fields

from flask import Flask
from flask_restful import Resource, Api, reqparse
from flask_cors import CORS
import os
from unicorn_version import register_version_routes

from controller.controller import Controller
exampleController = Controller()

def create_app():
    app = Flask(__name__)
    register_version_routes(app, "backend")
    CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
    app.config['CORS_HEADERS'] = 'application/json'
    
    db_file = os.environ.get('DB_DIR', "/database/p4db.db")
    
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_file}'
    db.init_app(app)
    
    with app.app_context():
        db.create_all()
        migrate_switch_adapter_fields(db.engine)

    api = Api(app)
    
    api.add_resource(HistoryStates, '/history', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(SavedStates, '/saved', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Decoding, '/decoding', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Tables, '/tables', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Initialize, '/init', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(FileNames, '/p4files', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Compile, '/compile', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(P4Source, '/p4src', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(SwitchesActive, '/switches/active', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(SwitchesKnown, '/switches/known', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(SwitchesFromTopology, '/switches/from_topology', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Topologies,'/topologies', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(CounterValue,'/counters', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(DirectCounters, '/direct-counters', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Mirrors, '/mirrors', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Queues, '/queues', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(MulticastGroups, '/multicast-groups', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(Digests, '/digests', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(DigestEvents, '/digest-events', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(NetworkExport, '/network/export', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(NetworkImport, '/network/import', resource_class_kwargs={"db": db, "controller": exampleController})
    api.add_resource(NetworkDeploy, '/network/import/deploy', resource_class_kwargs={"db": db, "controller": exampleController})
    for resource, route in ((Registers, '/registers'), (Meters, '/meters'), (DirectMeters, '/direct-meters')):
        api.add_resource(resource, route, resource_class_kwargs={"db": db, "controller": exampleController})

    return app

