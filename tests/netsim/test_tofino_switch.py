import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from netsim.api.netsim.utils.tofino_switch import TofinoSwitch


def switch():
    instance = object.__new__(TofinoSwitch)
    instance.name = 's2'
    instance.device_id = 5
    instance.grpc_port = 51052
    instance.model_port_base = 18016
    instance.status_port = 17001
    instance.bundle = '/bundles/empty'
    instance.log_file = '/dev/null'
    instance.startup_timeout = .1
    instance.cmd = Mock()
    instance.forwarder = None
    instance.start_forwarder = Mock()
    instance.process = None
    instance.work_dir = None
    instance.progress = Mock()
    instance.intfs = {1: SimpleNamespace(name='s2-eth1', IP=lambda: ''),
                      0: SimpleNamespace(name='lo', IP=lambda: '127.0.0.1'),
                      3: SimpleNamespace(name='s2-eth3', IP=lambda: '')}
    return instance


def test_model_ports_are_zero_based_and_skip_loopback():
    assert switch().port_mapping() == {'PortToIf': [
        {'device_port': 0, 'if': 's2-eth1'}, {'device_port': 2, 'if': 's2-eth3'}]}
    with pytest.raises(ValueError, match='1..64'):
        switch().device_port(65)


def test_each_switch_owns_a_supervisor_and_private_state(monkeypatch):
    instance = switch()
    process = Mock()
    process.poll.return_value = None
    popen = Mock(return_value=process)
    instance.popen = popen
    instance.read_state = Mock(return_value={'status': 'ready'})
    instance.start([])
    arguments = popen.call_args.args[0]
    assert arguments[arguments.index('--device-id') + 1] == '0'
    assert arguments[arguments.index('--bfrt-port') + 1] == '51052'
    path = Path(arguments[arguments.index('--port-map') + 1])
    assert json.loads(path.read_text()) == instance.port_mapping()
    instance.stop(deleteIntfs=False)
    process.terminate.assert_called_once()
    process.wait.assert_called_once_with(timeout=25)
    assert not path.exists()
    assert instance.device_id == 5


def test_failed_start_reaps_owned_supervisor(monkeypatch):
    instance = switch()
    process = Mock()
    process.poll.return_value = None
    instance.popen = Mock(return_value=process)
    instance.read_state = Mock(return_value={'status': 'failed', 'error': 'model startup failed'})
    with pytest.raises(RuntimeError, match='model startup failed'):
        instance.start([])
    process.terminate.assert_called_once()
    assert instance.process is None
    assert instance.work_dir is None


def test_tofino_always_uses_a_private_network_namespace(monkeypatch):
    initialize = Mock()
    monkeypatch.setattr('netsim.api.netsim.utils.tofino_switch.Switch.__init__', initialize)
    instance = TofinoSwitch('s1', device_id=8, inNamespace=False)
    assert initialize.call_args.kwargs['inNamespace'] is True
    assert instance.device_id == 8
    assert instance.runtime_device_id == 0
