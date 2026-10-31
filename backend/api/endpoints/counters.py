"""Counter reads and explicitly scoped zero resets through P4Runtime."""
import grpc
from flask import request

from .Endpoint import Endpoint
from .resources import rpc_error
from controller.managers.CounterManager import CounterManager
from controller.managers.ResourceManager import integer


class CounterValue(Endpoint):
    def dispatch(self, write=False):
        data = request.get_json(silent=True) if write else request.args
        if data is None or not hasattr(data, 'get'):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch_id = integer(data.get('switch_id'), 'switch_id')
            switch = self.controller.switch_configs.get(switch_id)
            if switch is None:
                return {'error': 'Switch is not connected'}, 404
            counter_id = integer(data.get('counter_id'), 'counter_id', minimum=1, maximum=(1 << 32) - 1)
            resource = switch.resources.definition('counters', counter_id)
            index = data.get('index')
            if index is not None:
                index = integer(index, 'index', maximum=resource.size - 1)
            if write:
                if data.get('reset') is not True:
                    raise ValueError('reset must be true; only zero resets are supported')
                count = CounterManager(switch).reset(counter_id, index)
                return {'success': True, 'counter_id': counter_id, 'reset_count': count}, 200
            return switch.get_counter_values(counter_id=counter_id, index=index), 200
        except (ValueError, KeyError, AttributeError, TypeError) as error:
            return {'error': str(error)}, 400
        except grpc.RpcError as error:
            return rpc_error(error, write)
        except RuntimeError as error:
            return {'error': str(error)}, 409

    def get(self):
        return self.dispatch()

    def patch(self):
        return self.dispatch(write=True)


class DirectCounters(Endpoint):
    def patch(self):
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'Expected a JSON object'}, 400
        try:
            switch_id = integer(data.get('switch_id'), 'switch_id')
            switch = self.controller.switch_configs.get(switch_id)
            if switch is None:
                return {'error': 'Switch is not connected'}, 404
            if data.get('reset') is not True:
                raise ValueError('reset must be true; only zero resets are supported')
            table_id = integer(data.get('table_id'), 'table_id', minimum=1, maximum=(1 << 32) - 1)
            count = CounterManager(switch).reset_direct(table_id, data.get('table_entry'))
            return {'success': True, 'table_id': table_id, 'reset_count': count}, 200
        except (ValueError, KeyError, AttributeError, TypeError) as error:
            return {'error': str(error)}, 400
        except grpc.RpcError as error:
            return rpc_error(error, write=True)
        except RuntimeError as error:
            return {'error': str(error)}, 409
