"""Run one real Tofino model and bf_switchd; own their lifetime and logs."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time


def resolve_artifact(bundle, path):
    result = (bundle / path).resolve()
    if not result.is_relative_to(bundle) or not result.is_file():
        raise ValueError(f"Invalid bundle artifact: {path}")
    return str(result)


def configuration(bundle, install):
    bundle = Path(bundle).resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("target") != "tofino":
        raise ValueError("A Tofino artifact bundle is required")
    profiles = [{"p4_pipeline_name": p["profile_name"],
                 "context": resolve_artifact(bundle, p["context"]),
                 "config": resolve_artifact(bundle, p["binary"]),
                 "pipe_scope": p["pipe_scope"]} for p in manifest["profiles"]]
    return {"chip_list": [{"chip_family": "tofino", "instance": 0}],
            "p4_devices": [{"device-id": 0, "p4_programs": [{
                "program-name": manifest["program_name"],
                "bfrt-config": resolve_artifact(bundle, manifest["bfrt_json"]),
                "p4_pipelines": profiles}], "agent0": str(install / "lib/libpltfm_mgr.so")}],
            "switch_options": [{"device-id": 0}]}


def check_available(bundle=None, install=None):
    """Validate the optional model install before changing a live topology."""
    install = Path(install or os.environ.get("SDE_INSTALL", "/opt/open-p4studio/install")).resolve()
    bundle = Path(bundle or os.environ.get("UNICORN_TOFINO_DEFAULT_BUNDLE", "/opt/unicorn/tofino/empty")).resolve()
    missing = [str(install / "bin" / name) for name in ("tofino-model", "bf_switchd")
               if not (install / "bin" / name).is_file() or not os.access(install / "bin" / name, os.X_OK)]
    if missing:
        raise ValueError("Tofino model runtime is unavailable; build the optional Tofino image. Missing executables: "
                         + ", ".join(missing))
    try:
        conf = configuration(bundle, install)
        if not conf["p4_devices"][0]["p4_programs"][0]["p4_pipelines"]:
            raise ValueError("no pipeline artifacts")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError(f"Tofino model default bundle is unavailable or invalid at {bundle}: {error}") from error


def device_ready(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5) as conn:
            conn.sendall(b"0")
            return conn.recv(1) == b"1"
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--device-id", type=int, default=0, choices=[0])
    parser.add_argument("--bundle", default=os.environ.get("UNICORN_TOFINO_DEFAULT_BUNDLE", "/opt/unicorn/tofino/empty"))
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--port-map", required=True)
    parser.add_argument("--bfrt-port", type=int, required=True)
    parser.add_argument("--model-port-base", type=int, required=True)
    parser.add_argument("--status-port", type=int, required=True)
    parser.add_argument("--cli-port", type=int)
    parser.add_argument("--startup-timeout", type=float, default=180)
    args = parser.parse_args()
    install = Path(os.environ.get("SDE_INSTALL", "/opt/open-p4studio/install")).resolve()
    check_available(args.bundle, install)
    work = Path(args.work_dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    # Lock the working directory so a second supervisor cannot orphan the first.
    import fcntl
    lock = (work / "supervisor.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    portmap = json.loads(Path(args.port_map).read_text())
    seen = set()
    for port in portmap["PortToIf"]:
        number = port["device_port"]
        if not isinstance(number, int) or number < 0 or number > 455 or number % 128 > 71 or number in seen:
            raise ValueError("Invalid or duplicate Tofino device port")
        if not isinstance(port["if"], str) or not port["if"] or len(port["if"]) > 15:
            raise ValueError("Invalid Linux interface name")
        seen.add(number)
    conf = work / "program.conf"
    conf.write_text(json.dumps(configuration(args.bundle, install), indent=2))
    ports = work / "ports.json"
    ports.write_text(json.dumps(portmap))
    state = {"name": args.name, "device_id": 0, "status": "starting",
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
        commands = [("model", [str(install / "bin/tofino-model"), "--no-cli", "--chip-type", "2", "-d", "1",
                      "-f", str(ports), "--p4-target-config", str(conf), "--install-dir", str(install),
                      "--tcp-port-base", str(args.model_port_base), "--log-dir", str(work)]),
                    ("switchd", [str(install / "bin/bf_switchd"), "--background", "--install-dir", str(install),
                      "--conf-file", str(conf), "--tcp-port-base", str(args.model_port_base),
                      "--bfrt-grpc-port", str(args.bfrt_port), "--status-port", str(args.status_port)])]
        for name, command in commands:
            log = (work / f"{name}.log").open("wb")
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
