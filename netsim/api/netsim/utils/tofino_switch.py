"""Mininet lifecycle for one isolated Tofino model and driver supervisor."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from time import monotonic, sleep

from mininet.node import Switch
from runtime.tofino.supervisor import default_bundle

from .p4_mininet import P4Switch


class TofinoSwitch(P4Switch):
    target = 'tofino'

    def __init__(self, name, device_id=0, grpc_port=51051, model_port_base=18000,
                 status_port=17000, bundle=None, architecture='tofino', startup_timeout=None,
                 progress=None, log_file=None, **kwargs):
        # Reuse the generic P4 node identity for terminal discovery. BMv2's
        # constructor and global port counters do not apply to this target.
        kwargs['inNamespace'] = True
        Switch.__init__(self, name, **kwargs)
        self.device_id = device_id
        self.runtime_device_id = 0
        # switchd listens on this deterministic port inside the switch's
        # private network namespace. The public relay receives a collision-free
        # ephemeral host port once the model is ready.
        self.bfrt_port = grpc_port
        self.grpc_port = None
        self.thrift_port = None
        self.model_port_base = model_port_base
        self.status_port = status_port
        if architecture not in ('tofino', 'tofino2'):
            raise ValueError('Tofino architecture must be tofino or tofino2')
        self.architecture = architecture
        self.bundle = bundle or default_bundle(architecture)
        self.startup_timeout = float(startup_timeout or os.environ.get('TOFINO_START_TIMEOUT', '240'))
        self.progress = progress
        self.log_file = log_file or f'/tmp/p4s.{name}.log'
        self.process = None
        self.forwarder = None
        self.work_dir = None
        self.target_options = {'client_id': 0, 'pipe_id': 0, 'architecture': architecture}

    def device_port(self, port):
        if not 1 <= port <= 64:
            raise ValueError('Tofino model supports topology ports 1..64 on pipe 0')
        # Tofino 2 reserves local device ports 0..7. Its first front-panel
        # model port is 8; Tofino 1 starts at 0.
        return port - 1 + (8 if self.architecture == 'tofino2' else 0)

    def port_mapping(self):
        return {'PortToIf': [
            {'device_port': self.device_port(port), 'if': intf.name}
            for port, intf in sorted(self.intfs.items()) if not intf.IP()
        ]}

    def start(self, controllers):
        self.cmd('ip link set lo up')
        # Each deployment owns a fresh aggregate log; stop() retains only the
        # bounded tail of this deployment's native diagnostics.
        Path(self.log_file).write_text('')
        self.work_dir = tempfile.TemporaryDirectory(prefix=f'unicorn-tofino-{self.name}-')
        work = Path(self.work_dir.name)
        port_map = work / 'ports.json'
        port_map.write_text(json.dumps(self.port_mapping()))
        command = [sys.executable, '-m', 'runtime.tofino.supervisor',
                   '--name', self.name, '--device-id', '0', '--bundle', self.bundle,
                   '--architecture', self.architecture,
                   '--work-dir', str(work), '--port-map', str(port_map),
                   '--bfrt-port', str(self.bfrt_port), '--model-port-base', str(self.model_port_base),
                   '--status-port', str(self.status_port),
                   '--switch-log', self.log_file,
                   '--startup-timeout', str(self.startup_timeout)]
        try:
            with open(self.log_file, 'a') as output:
                self.process = self.popen(command, stdout=output, stderr=subprocess.STDOUT)
            deadline = monotonic() + self.startup_timeout
            while monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError(f'Tofino switch {self.name} exited during startup; see switch log')
                state = self.read_state()
                if self.progress:
                    self.progress(self.name, state.get('status', 'starting'))
                if state.get('status') == 'ready':
                    self.start_forwarder()
                    return
                if state.get('status') in ('failed', 'error'):
                    raise RuntimeError(f'Tofino switch {self.name} failed: {state.get("error", "see switch log")}')
                sleep(.5)
            raise RuntimeError(f'Tofino switch {self.name} did not become ready within {self.startup_timeout:g}s')
        except Exception:
            self.stop(deleteIntfs=False)
            raise

    def start_forwarder(self):
        ready = Path(self.work_dir.name) / 'forwarder.ready'
        ready.unlink(missing_ok=True)
        with open(self.log_file, 'a') as output:
            self.forwarder = subprocess.Popen([
                sys.executable, '-m', 'runtime.tofino.port_forward',
                '--listen', '127.0.0.1:0',
                '--netns-pid', str(self.pid),
                '--upstream', f'127.0.0.1:{self.bfrt_port}',
                '--ready-file', str(ready),
            ], stdout=output, stderr=subprocess.STDOUT)
        deadline = monotonic() + 10
        while monotonic() < deadline:
            if self.forwarder.poll() is not None:
                raise RuntimeError(f'Control endpoint for {self.name} exited; see switch log')
            try:
                endpoint = json.loads(ready.read_text())
                if (endpoint.get('pid') == self.forwarder.pid
                        and endpoint.get('host') == '127.0.0.1'
                        and isinstance(endpoint.get('port'), int)
                        and 1 <= endpoint['port'] <= 65535):
                    self.grpc_port = endpoint['port']
                    return
            except (OSError, ValueError, TypeError, AttributeError):
                pass
            sleep(.1)
        raise RuntimeError(f'Control endpoint for {self.name} did not become ready')

    def read_state(self):
        try:
            return json.loads((Path(self.work_dir.name) / 'state.json').read_text())
        except (OSError, ValueError):
            return {}

    def stop(self, deleteIntfs=True):
        if self.forwarder is not None:
            self.forwarder.terminate()
            try:
                self.forwarder.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.forwarder.kill()
                self.forwarder.wait(timeout=5)
            self.forwarder = None
        # Never advertise a relay endpoint after its listener has stopped.
        self.grpc_port = None
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
        if self.work_dir is not None:
            # Keep diagnostics after ephemeral process/configuration files are
            # removed. Logs remain available through the regular switch log API.
            with open(self.log_file, 'a') as output:
                for name in ('model.log', 'switchd.log'):
                    path = Path(self.work_dir.name) / name
                    if path.is_file():
                        with path.open('rb') as source:
                            source.seek(0, 2)
                            source.seek(max(0, source.tell() - 32768))
                            output.write(f'\n[{name}]\n' + source.read().decode(errors='replace'))
            self.work_dir.cleanup()
            self.work_dir = None
        if deleteIntfs:
            self.deleteIntfs()

    def describe(self):
        print(f'{self.name} -> control endpoint: 127.0.0.1:{self.grpc_port}')
