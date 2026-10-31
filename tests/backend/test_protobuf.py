"""All bundled bindings must import with the pinned native protobuf runtime."""
import importlib

import pytest


@pytest.mark.parametrize("module", [
    "config.v1.p4info_pb2", "config.v1.p4types_pb2", "v1.p4data_pb2",
    "v1.p4runtime_pb2", "v1.p4runtime_pb2_grpc", "tmp.p4config_pb2",
    "server.v1.config_pb2", "server.v1.config_pb2_grpc",
    "bm.dataplane_interface_pb2", "bm.dataplane_interface_pb2_grpc",
])
def test_generated_binding_import(module):
    assert importlib.import_module("controller.p4." + module)
