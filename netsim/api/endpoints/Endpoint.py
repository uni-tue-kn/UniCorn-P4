from flask_restful import Resource

class Endpoint(Resource):
    def __init__(self, netsim,ws):
        self.netsim = netsim
        self.ws = ws
        super().__init__()