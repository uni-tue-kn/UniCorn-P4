import grpc
from flask import request

from .Endpoint import Endpoint
from .resources import rpc_error
from controller.managers.DigestManager import DigestManager
from controller.managers.ResourceManager import integer
from controller.p4.v1 import p4runtime_pb2 as pb


class Digests(Endpoint):
    def dispatch(self, update_type=None):
        data = request.args if update_type is None else request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch = self.controller.switch_configs.get(integer(data.get('switch_id'), 'switch_id'))
            if switch is None or not switch.connected:
                return {'error': 'Switch is not connected'}, 404
            manager = DigestManager(switch)
            if update_type is None:
                return manager.read(data.get('digest_id', data.get('resource_id'))), 200
            manager.write(data, update_type)
            return {'success': True}, 200
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            return {'error': str(error)}, 400
        except RuntimeError as error:
            return {'error': str(error)}, 409
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


class DigestEvents(Endpoint):
    def dispatch(self, clear=False):
        data = request.get_json(silent=True) if clear else request.args
        if not isinstance(data, dict):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch = self.controller.switch_configs.get(integer(data.get('switch_id'), 'switch_id'))
            if switch is None or not switch.connected:
                return {'error': 'Switch is not connected'}, 404
            manager = DigestManager(switch)
            if clear:
                identifier = manager.identifier(data['digest_id']) if data.get('digest_id') is not None else None
                switch.bmv2.ClearDigestEvents(identifier)
                return {'success': True}, 200
            return manager.events(data.get('digest_id'), data.get('after', 0), data.get('limit', 50)), 200
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            return {'error': str(error)}, 400
        except RuntimeError as error:
            return {'error': str(error)}, 409

    def get(self):
        return self.dispatch()

    def delete(self):
        return self.dispatch(clear=True)
