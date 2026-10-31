import grpc
from flask import request

from .Endpoint import Endpoint
from .resources import rpc_error
from controller.managers.MulticastManager import MulticastManager
from controller.managers.ResourceManager import integer
from controller.p4.v1 import p4runtime_pb2 as pb


class MulticastGroups(Endpoint):
    def dispatch(self, update_type=None):
        data = request.args if update_type is None else request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch = self.controller.switch_configs.get(integer(data.get('switch_id'), 'switch_id'))
            if switch is None or not switch.connected:
                return {'error': 'Switch is not connected'}, 404
            manager = MulticastManager(switch.bmv2)
            if update_type is None:
                return manager.read(data.get('multicast_group_id')), 200
            manager.write(data, update_type)
            return {'success': True}, 200
        except (ValueError, TypeError, KeyError) as error:
            return {'error': str(error)}, 400
        except grpc.RpcError as error:
            return rpc_error(error, write=update_type is not None)

    def get(self):
        return self.dispatch()

    def post(self):
        return self.dispatch(pb.Update.INSERT)

    def patch(self):
        return self.dispatch(pb.Update.MODIFY)

    def delete(self):
        return self.dispatch(pb.Update.DELETE)
