from .endpoints import *
from .database import db

from flask import Flask
from flask_restful import Resource, Api, reqparse
from flask_cors import CORS

from controller.controller import Controller
exampleController = Controller()

def create_app():
    app = Flask(__name__)
    CORS(app, methods=["GET", "POST", "DELETE", "PATCH", "OPTIONS"])
    app.config['CORS_HEADERS'] = 'application/json'
    # TODO error handling for non-existing database file
    #app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:////app/api/database/p4db.db'
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///../api/database/p4db.db'
    db.init_app(app)

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

    return app

