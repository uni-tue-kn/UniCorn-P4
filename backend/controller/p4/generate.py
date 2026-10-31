"""Reproduce Python bindings: python backend/controller/p4/generate.py [--fetch].

Install backend/requirements-dev.txt first. --fetch refreshes vendored official
v1.6.0 P4Runtime sources; ordinary regeneration needs no network.
"""
import argparse
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent
FILES = ["p4/config/v1/p4types.proto", "p4/config/v1/p4info.proto",
         "p4/v1/p4data.proto", "p4/v1/p4runtime.proto"]
UPSTREAM = "https://raw.githubusercontent.com/p4lang/p4runtime/v1.6.0/proto/"
EXTRA_SOURCES = {
    "p4/server/v1/config.proto": "https://raw.githubusercontent.com/p4lang/PI/701b9992ca925c90420a0cb31a4fa812f4a4f2f4/proto/p4/server/v1/config.proto",
    "p4/tmp/p4config.proto": "https://raw.githubusercontent.com/p4lang/PI/701b9992ca925c90420a0cb31a4fa812f4a4f2f4/proto/p4/tmp/p4config.proto",
    "p4/bm/dataplane_interface.proto": "https://raw.githubusercontent.com/p4lang/behavioral-model/1.15.7/services/p4/bm/dataplane_interface.proto",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args()
    if args.fetch:
        sources = {filename: UPSTREAM + filename for filename in FILES}
        sources.update(EXTRA_SOURCES)
        for filename, url in sources.items():
            destination = ROOT / "protos" / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(url, timeout=30) as response:
                destination.write_bytes(response.read())
    import grpc_tools
    import google.rpc
    include = Path(grpc_tools.__file__).parent / "_proto"
    google_include = Path(next(iter(google.rpc.__path__))).parents[1]
    # Emit under a temporary p4/ root then rewrite only generated imports to
    # this application's controller.p4 namespace.
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run([sys.executable, "-m", "grpc_tools.protoc",
                        f"-I{ROOT / 'protos'}", f"-I{include}", f"-I{google_include}",
                        f"--python_out={directory}", f"--grpc_python_out={directory}",
                        *FILES, *EXTRA_SOURCES], check=True)
        for source in (Path(directory) / "p4").rglob("*.py"):
            destination = ROOT / source.relative_to(Path(directory) / "p4")
            destination.parent.mkdir(parents=True, exist_ok=True)
            text = re.sub(r"^from p4([.\w]*) import", r"from controller.p4\1 import",
                          source.read_text(), flags=re.MULTILINE)
            destination.write_text(text)


if __name__ == "__main__":
    main()
