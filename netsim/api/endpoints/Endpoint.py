from flask_restful import Resource

class Endpoint(Resource):
    def __init__(self, netsim):
        self.netsim = netsim
        super().__init__()