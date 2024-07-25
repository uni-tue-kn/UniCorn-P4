from flask_restful import Resource

class Endpoint(Resource):
    def __init__(self,db,controller):
        self.controller = controller
        self.db = db
        super().__init__()