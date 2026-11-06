from flask import request
import grpc
from .resources import rpc_error

from .Endpoint import SwitchEndpoint as Endpoint
from controller.managers.QueueManager import QueueManager, QueueApplyError, QueueEndpointRequired
from controller.managers.ResourceManager import integer


class Queues(Endpoint):
    def dispatch(self, write=False):
        data = request.get_json(silent=True) if write else request.args.to_dict()
        if not isinstance(data, dict):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch_id = integer(data.get('switch_id'), 'switch_id')
            switch = self.controller.switch_configs.get(switch_id)
            if switch is None or not switch.connected:
                return {'error': 'Switch is not connected'}, 404
            manager = switch.manager("queues")
            port = manager.selector(data)
            if not write:
                return manager.snapshot(port), 200
            applied = manager.write(data)
            return dict(manager.snapshot(), success=True, applied=applied), 200
        except grpc.RpcError as error:
            return rpc_error(error, write=write)
        except QueueEndpointRequired as error:
            return {'error': str(error), 'code': 'THRIFT_ENDPOINT_REQUIRED', 'applied': []}, 409
        except (ValueError, TypeError) as error:
            return {'error': str(error)}, 400
        except QueueApplyError as error:
            return {**manager.snapshot(discover=False), 'error': str(error), 'code': 'UNIMPLEMENTED' if error.unsupported else 'THRIFT_ERROR',
                    'applied': error.applied, 'failed_setting': error.failed_setting,
                    'uncertain': error.uncertain}, 501 if error.unsupported else 503
        except RuntimeError as error:
            return {'error': str(error)}, 409

    def get(self):
        return self.dispatch()

    def patch(self):
        return self.dispatch(write=True)
