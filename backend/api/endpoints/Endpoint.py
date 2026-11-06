from flask_restful import Resource
from flask import request
from contextlib import nullcontext

class Endpoint(Resource):
    def __init__(self,db,controller):
        self.controller = controller
        self.db = db
        super().__init__()


class SwitchEndpoint(Endpoint):
    def dispatch_request(self, *args, **kwargs):
        data = request.get_json(silent=True)
        data = data if isinstance(data, dict) and 'switch_id' in data else request.values
        try:
            identifier = int(data.get('switch_id')) if data else None
        except (TypeError, ValueError, AttributeError):
            identifier = None
        # Only snapshot the reference under the global lock. Waiting for a
        # pipeline load must not block polling or operations on other switches.
        with getattr(self.controller, 'connections_lock', None) or nullcontext():
            switch = getattr(self.controller, 'switch_configs', {}).get(identifier)
        lock = getattr(switch, 'operation_lock', None) if getattr(switch, 'target', None) == 'tofino' else None
        with lock if lock is not None else nullcontext():
            # Do not reacquire connections_lock here: deletion may hold it
            # while waiting for this target. Dict lookup is an atomic snapshot.
            if lock is not None and self.controller.switch_configs.get(identifier) is not switch:
                return {'error': 'Switch connection changed; refresh and retry'}, 409
            return super().dispatch_request(*args, **kwargs)
