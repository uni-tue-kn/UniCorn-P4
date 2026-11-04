import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from unittest.mock import Mock

import pytest

from runtime.tofino.compile import compile_program
from runtime.tofino import compiler_service as service


def handler(body):
    instance = object.__new__(service.Handler)
    instance.path = '/compile'
    instance.headers = {'Content-Length': str(len(body))}
    instance.rfile = io.BytesIO(body)
    instance.respond = Mock()
    return instance


def test_body_read_does_not_occupy_the_compiler():
    instance = handler(b'{}')
    observed = []
    instance.rfile = Mock(read=lambda size: observed.append(service.COMPILE_LOCK.locked()) or b'{}')
    instance.do_POST()
    assert observed == [False]
    assert not service.COMPILE_LOCK.locked()


def test_slow_request_is_rejected_without_blocking_other_compiles():
    instance = handler(b'{}')
    instance.rfile = Mock(read=Mock(side_effect=TimeoutError('slow body')))
    instance.do_POST()
    assert instance.respond.call_args.args[0] == 408
    assert not service.COMPILE_LOCK.locked()


def test_only_the_compilation_holds_the_lock(tmp_path, monkeypatch):
    monkeypatch.setenv('P4_DIR', str(tmp_path))
    instance = handler(json.dumps({'source': str(tmp_path / 'main.p4'), 'output': str(tmp_path / 'output')}).encode())
    def compile(*_args):
        assert service.COMPILE_LOCK.locked()
        return {}, [], '', ''
    monkeypatch.setattr(service, 'compile_program', compile)
    instance.do_POST()
    assert instance.respond.call_args.args[0] == 200
    assert not service.COMPILE_LOCK.locked()


@pytest.mark.skipif(sys.platform != 'linux', reason='Native compiler process groups require Linux')
def test_timeout_terminates_the_driver_and_its_children(tmp_path, monkeypatch):
    compiler = tmp_path / 'compiler'
    pidfile = tmp_path / 'child.pid'
    compiler.write_text(f'#!{sys.executable}\n' + '''import os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
Path(os.environ['UNICORN_TEST_CHILD_PID_FILE']).write_text(str(child.pid))
time.sleep(60)
''')
    compiler.chmod(0o755)
    source = tmp_path / 'main.p4'
    source.write_text('// timeout fixture')
    monkeypatch.setenv('UNICORN_TOFINO_COMPILER', str(compiler))
    monkeypatch.setenv('UNICORN_TEST_CHILD_PID_FILE', str(pidfile))
    child = None
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            compile_program(source, tmp_path / 'output', timeout=.3)
        child = int(pidfile.read_text())
        state = Path(f'/proc/{child}/stat')
        for _ in range(50):
            if not state.exists() or state.read_text().split()[2] == 'Z':
                break
            time.sleep(.01)
        else:
            pytest.fail('Compiler child survived the timeout')
    finally:
        if child is None and pidfile.exists():
            child = int(pidfile.read_text())
        if child is not None:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
