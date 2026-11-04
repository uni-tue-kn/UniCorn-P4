"""Private shared-volume compiler worker; serialize native p4c builds."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading

COMPILE_LOCK = threading.Lock()
from .compile import compile_program


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ready", "target": "tofino"})
        elif self.path == "/capabilities":
            self.respond(200, {"target": "tofino", "architecture": "tna", "available": True})
        else:
            self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/compile":
            self.respond(404, {"error": "Not found"})
            return
        if not COMPILE_LOCK.acquire(blocking=False):
            self.respond(429, {"error": "Tofino compiler is busy", "stdout": "", "stderr": ""})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 16384:
                self.respond(413, {"error": "Invalid request size"})
                return
            request = json.loads(self.rfile.read(size))
            root = Path(os.environ.get("P4_DIR", "/p4")).resolve()
            source = Path(request["source"]).resolve()
            output = Path(request["output"]).resolve()
            if not source.is_relative_to(root) or not output.is_relative_to(root):
                raise ValueError("source and output must be under P4_DIR")
            manifest, command, stdout, stderr = compile_program(source, output, request.get("name"))
            self.respond(200, {"manifest": manifest, "command": command, "stdout": stdout, "stderr": stderr})
        except (ValueError, KeyError, TypeError) as error:
            self.respond(400, {"error": str(error), "stdout": "", "stderr": ""})
        except subprocess.CalledProcessError as error:
            self.respond(422, {"error": "Tofino compilation failed", "returncode": error.returncode,
                               "command": error.cmd, "stdout": error.stdout, "stderr": error.stderr})
        except subprocess.TimeoutExpired as error:
            self.respond(504, {"error": "Tofino compiler exceeded 300 seconds", "stdout": "", "stderr": ""})
        except Exception as error:
            self.respond(500, {"error": str(error), "stdout": "", "stderr": ""})
        finally:
            COMPILE_LOCK.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
