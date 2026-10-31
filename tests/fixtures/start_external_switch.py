"""Start a stock PI endpoint for explicit external-adapter integration tests."""
from pathlib import Path
import socket
import subprocess
import time

for port in (55051, 59090):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', port))

log = Path('/tmp/unicorn-external-switch.log')
with log.open('w') as output:
    process = subprocess.Popen([
        'simple_switch_grpc', '--device-id', '42', '--thrift-port', '59090',
        '--no-p4', '--', '--grpc-server-addr', '127.0.0.1:55051',
    ], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    for attempt in range(100):
        if process.poll() is not None:
            raise RuntimeError(log.read_text())
        with socket.socket() as client:
            if client.connect_ex(('127.0.0.1', 55051)) == 0:
                print('Stock external PI endpoint ready on 55051, device 42')
                break
        time.sleep(0.1)
    else:
        process.terminate()
        raise RuntimeError('Stock external PI endpoint did not become ready')
