"""Run one real Tofino model and bf_switchd; own their lifetime and logs."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def default_bundle(architecture):
    """Resolve per-generation defaults while preserving the Tofino 1 setting."""
    if architecture not in ("tofino", "tofino2"):
        raise ValueError("Tofino architecture must be tofino or tofino2")
    configured = os.environ.get("UNICORN_TOFINO_DEFAULT_BUNDLE_" + architecture.upper())
    if architecture == "tofino":
        configured = configured or os.environ.get("UNICORN_TOFINO_DEFAULT_BUNDLE")
    return configured or "/opt/unicorn/tofino/empty" + ("-tofino2" if architecture == "tofino2" else "")


def resolve_artifact(bundle, path):
    result = (bundle / path).resolve()
    if not result.is_relative_to(bundle) or not result.is_file():
        raise ValueError(f"Invalid bundle artifact: {path}")
    return str(result)


def configuration(bundle, install, architecture=None):
    bundle = Path(bundle).resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("target") != "tofino":
        raise ValueError("A Tofino artifact bundle is required")
    architecture = architecture or manifest.get("architecture", "tofino")
    if architecture not in ("tofino", "tofino2") or manifest.get("architecture", "tofino") != architecture:
        raise ValueError("Pipeline architecture does not match the selected Tofino model")
    profiles = [{"p4_pipeline_name": p["profile_name"],
                 "context": resolve_artifact(bundle, p["context"]),
                 "config": resolve_artifact(bundle, p["binary"]),
                 "pipe_scope": p["pipe_scope"]} for p in manifest["profiles"]]
    return {"chip_list": [{"chip_family": architecture, "instance": 0}],
            "p4_devices": [{"device-id": 0, "p4_programs": [{
                "program-name": manifest["program_name"],
                "bfrt-config": resolve_artifact(bundle, manifest["bfrt_json"]),
                "p4_pipelines": profiles}], "agent0": str(install / "lib/libpltfm_mgr.so")}],
            "switch_options": [{"device-id": 0}]}


def check_available(bundle=None, install=None, architecture="tofino"):
    """Validate the optional model install before changing a live topology."""
    install = Path(install or os.environ.get("SDE_INSTALL", "/opt/open-p4studio/install")).resolve()
    bundle = Path(bundle or default_bundle(architecture)).resolve()
    missing = [str(install / "bin" / name) for name in ("tofino-model", "bf_switchd")
               if not (install / "bin" / name).is_file() or not os.access(install / "bin" / name, os.X_OK)]
    if missing:
        raise ValueError("Tofino model runtime is unavailable; build the optional Tofino image. Missing executables: "
                         + ", ".join(missing))
    try:
        conf = configuration(bundle, install, architecture)
        if not conf["p4_devices"][0]["p4_programs"][0]["p4_pipelines"]:
            raise ValueError("no pipeline artifacts")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError(f"Tofino model default bundle is unavailable or invalid at {bundle}: {error}") from error


def validate_portmap(portmap, architecture):
    """Validate the single-pipe front-panel range for the selected model."""
    minimum, maximum = (0, 63) if architecture == "tofino" else (8, 71)
    seen = set()
    for port in portmap["PortToIf"]:
        number = port["device_port"]
        if not isinstance(number, int) or not minimum <= number <= maximum or number in seen:
            raise ValueError(f"Invalid or duplicate {architecture} device port; expected {minimum}..{maximum}")
        if not isinstance(port["if"], str) or not port["if"] or len(port["if"]) > 15:
            raise ValueError("Invalid Linux interface name")
        seen.add(number)
    return portmap


def device_ready(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5) as conn:
            conn.sendall(b"0")
            return conn.recv(1) == b"1"
    except OSError:
        return False


def trim_log(path, limit=8 * 1024 * 1024):
    """Keep recent diagnostics while append-mode writers retain their handles."""
    try:
        with Path(path).open("r+b") as log:
            if log.seek(0, os.SEEK_END) <= limit:
                return
            log.seek(-limit // 2, os.SEEK_END)
            tail = log.read()
            log.seek(0)
            log.write(tail)
            log.truncate()
    except OSError:
        # A missing or unwritable log must not stop forwarding.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--device-id", type=int, default=0, choices=[0])
    parser.add_argument("--architecture", choices=["tofino", "tofino2"], default="tofino")
    parser.add_argument("--bundle")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--port-map", required=True)
    parser.add_argument("--bfrt-port", type=int, required=True)
    parser.add_argument("--model-port-base", type=int, required=True)
    parser.add_argument("--status-port", type=int, required=True)
    parser.add_argument("--cli-port", type=int)
    parser.add_argument("--startup-timeout", type=float, default=180)
    parser.add_argument("--switch-log")
    args = parser.parse_args()
    install = Path(os.environ.get("SDE_INSTALL", "/opt/open-p4studio/install")).resolve()
    if args.bundle is None:
        args.bundle = default_bundle(args.architecture)
    check_available(args.bundle, install, args.architecture)
    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    # Lock the working directory so a second supervisor cannot orphan the first.
    import fcntl
    lock = (work / "supervisor.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    portmap = validate_portmap(json.loads(Path(args.port_map).read_text()), args.architecture)
    conf = work / "program.conf"
    conf.write_text(json.dumps(configuration(args.bundle, install, args.architecture), indent=2))
    ports = work / "ports.json"
    ports.write_text(json.dumps(portmap))
    state = {"name": args.name, "device_id": 0, "architecture": args.architecture, "status": "starting",
             "bfrt_endpoint": f"127.0.0.1:{args.bfrt_port}",
             "model_port_base": args.model_port_base, "status_port": args.status_port,
             "supervisor_pid": os.getpid()}
    def publish():
        temporary = work / "state.json.tmp"
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(work / "state.json")
    stopping = False
    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    env = dict(os.environ)
    env["SDE_INSTALL"] = str(install)
    env["LD_LIBRARY_PATH"] = ":".join([str(install / "lib"), str(install / "lib64"), env.get("LD_LIBRARY_PATH", "")])
    embedded_python = install.parent / "python"
    if (embedded_python / "lib/python3.10").is_dir():
        env["PYTHONHOME"] = str(embedded_python)
    preload = os.environ.get("UNICORN_TOFINO_MODEL_DMA_PRELOAD")
    if preload:
        env["LD_PRELOAD"] = preload
    env["UNICORN_TOFINO_MODEL_DMA"] = "1"
    env["UNICORN_BFSHELL_PORT"] = str(args.cli_port or args.model_port_base + 4)
    processes, logs = [], []
    publish()
    try:
        chip_type = "2" if args.architecture == "tofino" else "5"
        commands = [("model", [str(install / "bin/tofino-model"), "--no-cli", "--chip-type", chip_type, "-d", "1",
                      "-f", str(ports), "--p4-target-config", str(conf), "--install-dir", str(install),
                      "--tcp-port-base", str(args.model_port_base), "--log-dir", str(work)]),
                    ("switchd", [str(install / "bin/bf_switchd"), "--background", "--install-dir", str(install),
                      "--conf-file", str(conf), "--tcp-port-base", str(args.model_port_base),
                      "--bfrt-grpc-port", str(args.bfrt_port), "--status-port", str(args.status_port)])]
        for name, command in commands:
            log = (work / f"{name}.log").open("ab")
            logs.append(log)
            proc = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(proc)
            state[f"{name}_pid"] = proc.pid
            publish()
            if name == "model":
                # Do not probe the model register socket: it accepts exactly its driver.
                time.sleep(0.5)
        deadline = time.monotonic() + args.startup_timeout
        next_log_check = 0
        while not stopping:
            for proc in processes:
                if proc.poll() is not None:
                    raise RuntimeError(f"Native process {proc.pid} exited ({proc.returncode}); inspect {work}")
            if state["status"] == "starting":
                if device_ready(args.status_port):
                    state["status"] = "ready"
                    publish()
                elif time.monotonic() > deadline:
                    raise TimeoutError(f"Tofino initialization exceeded {args.startup_timeout}s; inspect {work}")
            if time.monotonic() >= next_log_check:
                for path in (work / "model.log", work / "switchd.log", args.switch_log):
                    if path:
                        trim_log(path)
                next_log_check = time.monotonic() + 1
            time.sleep(0.2)
    except Exception as error:
        state.update(status="error", error=str(error))
        publish()
        raise
    finally:
        for proc in reversed(processes):
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        for proc in reversed(processes):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        for log in logs:
            log.close()
        if state["status"] != "error":
            state["status"] = "stopped"
            publish()


if __name__ == "__main__":
    main()
