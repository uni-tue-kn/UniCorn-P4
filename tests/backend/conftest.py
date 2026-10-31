from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from controller.p4.config.v1 import p4info_pb2
from controller.managers.SwitchManager import SwitchManager
from controller.managers.TableManager import TableManager
from controller.utils.helper import P4InfoHelper


@pytest.fixture
def switch():
    info = p4info_pb2.P4Info()
    for id_, name, kind, width in ((0x16000001, "Ingress.reg", "bit", 64),
                                  (0x16000002, "Ingress.signed", "int", 9)):
        register = info.registers.add(size=8)
        register.preamble.id, register.preamble.name = id_, name
        register.preamble.alias = name.split(".")[-1]
        getattr(register.type_spec.bitstring, kind).bitwidth = width
    meter = info.meters.add(size=8)
    meter.preamble.id, meter.preamble.name = 0x14000001, "Ingress.meter"
    meter.spec.unit = p4info_pb2.MeterSpec.PACKETS
    direct = info.direct_meters.add(direct_table_id=0x02000001)
    direct.preamble.id, direct.preamble.name = 0x15000001, "Ingress.direct"
    counter = info.counters.add(size=8)
    counter.preamble.id, counter.preamble.name = 0x12000001, "Ingress.counter"
    table = info.tables.add()
    table.preamble.id, table.preamble.name = 0x02000001, "Ingress.table"
    table.match_fields.add(id=1, name="key", bitwidth=16, match_type=p4info_pb2.MatchField.EXACT)
    action = info.actions.add()
    action.preamble.id, action.preamble.name = 0x01000001, "Ingress.send"
    action.params.add(id=1, name="port", bitwidth=9)
    table.action_refs.add(id=action.preamble.id)
    manager = SwitchManager(0, {})
    manager.connected = True
    manager.p4_helper = P4InfoHelper(p4_info_file=info)
    manager.bmv2 = Mock()
    manager.bmv2.ReadEntities.return_value = iter([])
    manager.tables = TableManager(manager.bmv2, manager.p4_helper)
    return manager


@pytest.fixture
def app(tmp_path, monkeypatch, switch):
    monkeypatch.setenv("DB_DIR", str(tmp_path / "test.db"))
    monkeypatch.setenv("UPDATE_CHECK_ENABLED", "false")
    from api import create_app, exampleController
    exampleController.switch_configs = {0: switch}
    app = create_app()
    app.config["TESTING"] = True
    yield app
    exampleController.switch_configs = {}


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def entry():
    return {"table_name": "Ingress.table", "match_fields": {"key": 1},
            "action_name": "Ingress.send", "action_params": {"port": 2}, "priority": None}
