"""Compile a TNA source into a portable BFRT pipeline bundle."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import signal


def compile_program(source, output, name=None, timeout=300, architecture="tofino"):
    source, output = Path(source).resolve(), Path(output).resolve()
    name = name or source.stem
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name):
        raise ValueError("Program name must be a P4 identifier, at most 64 characters")
    if architecture not in ("tofino", "tofino2"):
        raise ValueError("Architecture must be tofino or tofino2")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    install = Path(os.environ.get("SDE_INSTALL", "/opt/open-p4studio/install"))
    compiler = os.environ.get("UNICORN_TOFINO_COMPILER", str(install / "bin/bf-p4c"))
    command = [compiler, "--target", architecture, "--arch", "tna" if architecture == "tofino" else "t2na", "--std", "p4-16",
                    "--program-name", name, "-o", str(output), str(source)]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                          start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            # p4c's driver can spawn a preprocessor and backend. Terminate the
            # entire build before releasing the worker's compilation lock.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command, stdout, stderr)
    compiler_manifest = output / "manifest.json"
    if compiler_manifest.exists():
        compiler_manifest.rename(output / "compiler-manifest.json")
    if (output / "bfrt.json").is_file():
        (output / "bfrt.json").rename(output / "bf-rt.json")
    profiles = []
    for context in sorted(output.glob("*/context.json")):
        binary = context.parent / ("tofino.bin" if architecture == "tofino" else "tofino2.bin")
        if not binary.is_file():
            raise ValueError(f"Missing compiler artifact {binary}")
        profiles.append({"profile_name": context.parent.name,
                         "context": str(context.relative_to(output)),
                         "binary": str(binary.relative_to(output)),
                         "pipe_scope": [0]})
    if not profiles or not (output / "bf-rt.json").is_file():
        raise ValueError("Compiler did not produce BFRT metadata and a Tofino pipeline")
    if len(profiles) != 1:
        raise ValueError("Only one pipeline is supported per UniCorn switch")
    manifest = {"target": "tofino", "architecture": architecture, "program_name": name, "bfrt_json": "bf-rt.json",
                "profiles": profiles}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(source, output / "source.p4")
    return manifest, command, stdout, stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--name")
    parser.add_argument("--architecture", choices=("tofino", "tofino2"), default="tofino")
    args = parser.parse_args()
    manifest, command, stdout, stderr = compile_program(args.source, args.output, args.name, architecture=args.architecture)
    print(stdout, end="")
    import sys
    print(stderr, end="", file=sys.stderr)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
