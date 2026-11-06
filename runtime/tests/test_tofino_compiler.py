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
    def compile(*_args, **_kwargs):
        assert service.COMPILE_LOCK.locked()
        return {}, [], '', ''
    monkeypatch.setattr(service, 'compile_program', compile)
    instance.do_POST()
    assert instance.respond.call_args.args[0] == 200
    assert not service.COMPILE_LOCK.locked()


def test_tofino2_compile_selects_t2na_and_manifest_artifacts(tmp_path, monkeypatch):
    source = tmp_path / 'main.p4'
    source.write_text('#include <t2na.p4>')
    def popen(command, **_kwargs):
        output = Path(command[command.index('-o') + 1])
        pipe = output / 'pipe'
        pipe.mkdir(parents=True)
        (output / 'bfrt.json').write_text('{"tables": []}')
        (pipe / 'context.json').write_text('{}')
        (pipe / 'tofino2.bin').write_bytes(b't2 pipeline')
        class Process:
            returncode = 0
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def communicate(self, **_kwargs): return '', ''
        return Process()
    monkeypatch.setattr('runtime.tofino.compile.subprocess.Popen', popen)
    manifest, command, *_ = compile_program(source, tmp_path / 'build', architecture='tofino2')
    assert command[command.index('--target') + 1] == 'tofino2'
    assert command[command.index('--arch') + 1] == 't2na'
    assert manifest['architecture'] == 'tofino2'
    assert manifest['profiles'][0]['binary'] == 'pipe/tofino2.bin'


def test_supervisor_configuration_selects_tofino2(tmp_path):
    from runtime.tofino.supervisor import configuration
    bundle = tmp_path / 'bundle'
    (bundle / 'pipe').mkdir(parents=True)
    (bundle / 'manifest.json').write_text(json.dumps({
        'target': 'tofino', 'architecture': 'tofino2', 'program_name': 't2', 'bfrt_json': 'bf-rt.json',
        'profiles': [{'profile_name': 'pipe', 'context': 'pipe/context.json',
                      'binary': 'pipe/tofino2.bin', 'pipe_scope': [0]}]}))
    for name in ('bf-rt.json', 'pipe/context.json', 'pipe/tofino2.bin'):
        (bundle / name).write_text('{}')
    assert configuration(bundle, tmp_path / 'sde')['chip_list'][0]['chip_family'] == 'tofino2'
    with pytest.raises(ValueError, match='architecture does not match'):
        configuration(bundle, tmp_path / 'sde', 'tofino')


def test_default_bundle_preserves_legacy_tofino1_override(monkeypatch):
    from runtime.tofino.supervisor import default_bundle
    monkeypatch.setenv('UNICORN_TOFINO_DEFAULT_BUNDLE', '/legacy/t1')
    assert default_bundle('tofino') == '/legacy/t1'
    assert default_bundle('tofino2') == '/opt/unicorn/tofino/empty-tofino2'
    monkeypatch.setenv('UNICORN_TOFINO_DEFAULT_BUNDLE_TOFINO', '/generation/t1')
    monkeypatch.setenv('UNICORN_TOFINO_DEFAULT_BUNDLE_TOFINO2', '/generation/t2')
    assert default_bundle('tofino') == '/generation/t1'
    assert default_bundle('tofino2') == '/generation/t2'


def test_port_maps_use_generation_specific_front_panel_ranges():
    from runtime.tofino.supervisor import validate_portmap
    assert validate_portmap({'PortToIf': [{'device_port': 0, 'if': 't1p0'}]}, 'tofino')
    assert validate_portmap({'PortToIf': [{'device_port': 8, 'if': 't2p0'}]}, 'tofino2')
    with pytest.raises(ValueError, match='expected 8..71'):
        validate_portmap({'PortToIf': [{'device_port': 0, 'if': 't2p0'}]}, 'tofino2')
    with pytest.raises(ValueError, match='expected 0..63'):
        validate_portmap({'PortToIf': [{'device_port': 64, 'if': 't1p64'}]}, 'tofino')


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
            try:
                process_state = state.read_text().split()[2]
            except (FileNotFoundError, ProcessLookupError):
                # A successfully reaped child can disappear at any point while
                # procfs opens or reads its transient status entry.
                break
            if process_state == 'Z':
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
