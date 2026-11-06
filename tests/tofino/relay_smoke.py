"""Check real cross-network-namespace TCP relay isolation and byte preservation."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

server_code = '''import socket
s=socket.socket();s.bind(('127.0.0.1',19001));s.listen()
while True:
 c,_=s.accept()
 while True:
  d=c.recv(65536)
  if not d:break
  c.sendall(d)
 c.close()
'''
# unshare creates a private network namespace without named /run/netns mounts.
server = subprocess.Popen(['unshare', '--net', 'python3', '-c',
    "import subprocess;subprocess.run(['ip','link','set','lo','up'],check=True);" + server_code])
relay = None
try:
    time.sleep(0.5)
    assert server.poll() is None, 'Namespace echo server failed'
    try:
        socket.create_connection(('127.0.0.1', 19001), timeout=0.2)
        raise AssertionError('Namespace server leaked into the root namespace')
    except ConnectionRefusedError:
        pass
    relay = subprocess.Popen([sys.executable, '-m', 'runtime.tofino.port_forward', '--listen', '127.0.0.1:19000',
                              '--netns-pid', str(server.pid), '--upstream', '127.0.0.1:19001'])
    time.sleep(0.5)
    with socket.create_connection(('127.0.0.1',19000), timeout=5) as client:
        payload = os.urandom(65536)
        client.sendall(payload)
        received = b''
        while len(received) < len(payload):
            received += client.recv(65536)
        assert received == payload
    print('PASS: isolated namespace listener and real TCP relay preserved 65536 bytes')
finally:
    if relay:
        relay.terminate(); relay.wait(timeout=5)
    server.terminate(); server.wait(timeout=5)
