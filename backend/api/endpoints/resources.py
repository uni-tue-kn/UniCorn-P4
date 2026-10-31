"""Typed P4Runtime resource endpoints; all numeric values remain lossless."""
import grpc
from google.rpc import status_pb2
from google.protobuf.message import DecodeError
from controller.p4.v1 import p4runtime_pb2
from flask import request

from .Endpoint import Endpoint
from controller.managers.ResourceManager import integer


def rpc_error(error, write=False):
    """Translate ordinary gRPC and standard P4Runtime per-update errors."""
    codes = {grpc.StatusCode.UNIMPLEMENTED: 501, grpc.StatusCode.INVALID_ARGUMENT: 400,
             grpc.StatusCode.OUT_OF_RANGE: 400, grpc.StatusCode.NOT_FOUND: 404,
             grpc.StatusCode.ALREADY_EXISTS: 409, grpc.StatusCode.PERMISSION_DENIED: 403,
             grpc.StatusCode.UNAUTHENTICATED: 401}
    response = {"error": error.details() or str(error.code()),
                "code": error.code().name, "partial_write_possible": write}
    status = codes.get(error.code(), 503)
    for key, value in getattr(error, "trailing_metadata", lambda: ())() or ():
        if key != "grpc-status-details-bin":
            continue
        try:
            details = status_pb2.Status.FromString(value)
            errors = []
            for index, detail in enumerate(details.details):
                item = p4runtime_pb2.Error()
                if detail.Unpack(item):
                    errors.append({"index": index, "code": item.canonical_code, "message": item.message})
            failures = [item for item in errors if item["code"]]
            if failures:
                response["errors"] = errors
                response["error"] = "; ".join(f'Entry {item["index"]}: {item["message"]}' for item in failures)
                if all(item["code"] == 12 for item in errors):
                    status = 501
                    response.update(code="UNIMPLEMENTED", partial_write_possible=False)
                elif all(item["code"] == 6 for item in errors):
                    status = 409
                elif all(item["code"] == 5 for item in errors):
                    status = 404
                elif all(item["code"] in (3, 5, 11) for item in errors):
                    status = 400
        except (ValueError, TypeError, DecodeError):
            pass
    return response, status


class ResourceEndpoint(Endpoint):
    kind = None

    def dispatch(self, write=False):
        data = request.get_json(silent=True) if write else request.args
        if data is None:
            return {"error": "Expected a JSON object"}, 400
        try:
            switch_id = integer(data.get("switch_id"), "switch_id")
            switch = self.controller.switch_configs.get(switch_id)
            if switch is None:
                return {"error": "Switch is not connected"}, 404
            manager = switch.resources
            identifier = "register_id" if self.kind == "register" else "meter_id"
            resource_id = integer(data.get(identifier), identifier, minimum=1, maximum=(1 << 32) - 1)
            if write:
                if self.kind == "direct_meter":
                    manager.write_direct(resource_id, data.get("entries"))
                else:
                    manager.write(self.kind, resource_id, data.get("entries"))
                return {"success": True}, 200
            if self.kind == "direct_meter":
                return manager.read_direct(resource_id), 200
            return manager.read(self.kind, resource_id, index=data.get("index"),
                                offset=data.get("offset", 0), limit=data.get("limit", 128)), 200
        except (ValueError, KeyError, AttributeError, TypeError) as error:
            return {"error": str(error)}, 400
        except grpc.RpcError as error:
            return rpc_error(error, write)
        except RuntimeError as error:
            return {"error": str(error)}, 409

    def get(self):
        return self.dispatch()

    def patch(self):
        return self.dispatch(write=True)


class Registers(ResourceEndpoint):
    kind = "register"


class Meters(ResourceEndpoint):
    kind = "meter"


class DirectMeters(ResourceEndpoint):
    kind = "direct_meter"
