"""Exercise the actual native compiler through its shared-volume HTTP worker."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def request(path, data=None):
    req = urllib.request.Request('http://127.0.0.1:18888' + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


with tempfile.TemporaryDirectory(prefix='unicorn-tofino-http-') as temporary:
    root = Path(temporary)
    env = dict(os.environ, P4_DIR=str(root))
    process = subprocess.Popen(['python3', '-m', 'runtime.tofino.compiler_service', '--port', '18888'], env=env)
    try:
        for _ in range(100):
            try:
                assert request('/health')[0] == 200
                break
            except OSError:
                time.sleep(0.05)
        assert request('/capabilities')[1]['target'] == 'tofino'
        status, body = request('/compile', {'source': '/etc/passwd', 'output': str(root / 'invalid')})
        assert status == 400 and 'under P4_DIR' in body['error'], body
        bad = root / 'invalid.p4'
        bad.write_text('this is not valid P4;')
        status, body = request('/compile', {'source': str(bad), 'output': str(root / 'bad'), 'name': 'bad'})
        assert status == 422 and body['stderr'] and body['command'], body
        source = root / 'valid.p4'
        source.write_text(Path('examples/p4/tofino/resources.p4').read_text())
        status, body = request('/compile', {'source': str(source), 'output': str(root / 'good'), 'name': 'http_smoke'})
        assert status == 200, body
        assert (root / 'good/bf-rt.json').is_file()
        assert (root / 'good/pipe/tofino.bin').is_file()
        assert body['manifest']['program_name'] == 'http_smoke'
        print('PASS: native HTTP compilation, manifest, binary, diagnostics and path confinement')
    finally:
        process.terminate()
        process.wait(timeout=10)
