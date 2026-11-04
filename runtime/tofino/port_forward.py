"""Expose a loopback BFRT listener across a Mininet network namespace."""
import argparse
import ctypes
import os
import signal
import socket
import threading


def endpoint(value):
    host, port = value.rsplit(':', 1)
    return host, int(port)


def relay(client, target_fd, upstream):
    server = None
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.setns(target_fd, 0x40000000) != 0:  # CLONE_NEWNET
            raise OSError(ctypes.get_errno(), 'setns failed')
        server = socket.create_connection(upstream, timeout=10)
        server.settimeout(None)
        # Two blocking pumps preserve flow control without unbounded buffering.
        def pump(source, destination):
            try:
                source.setblocking(True)
                destination.setblocking(True)
                while True:
                    data = source.recv(65536)
                    if not data:
                        break
                    destination.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    destination.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
        thread = threading.Thread(target=pump, args=(client, server), daemon=True)
        thread.start()
        pump(server, client)
        thread.join(timeout=1)
    except OSError as error:
        print(f'BFRT namespace relay failed: {error}', flush=True)
    finally:
        client.close()
        if server:
            server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--listen', required=True)
    parser.add_argument('--netns-pid', required=True, type=int)
    parser.add_argument('--upstream', required=True)
    args = parser.parse_args()
    target_fd = os.open(f'/proc/{args.netns_pid}/ns/net', os.O_RDONLY)
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(endpoint(args.listen))
    listener.listen(64)
    listener.settimeout(0.5)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    print(f'BFRT relay ready at {args.listen}', flush=True)
    try:
        while not stop.is_set():
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            threading.Thread(target=relay, args=(client, target_fd, endpoint(args.upstream)), daemon=True).start()
    finally:
        listener.close()
        os.close(target_fd)


if __name__ == '__main__':
    main()
