"""Component build versions and a bounded, advisory upstream update check."""

from functools import lru_cache
from importlib import metadata
import os
from pathlib import Path
import re
import subprocess
import threading
from urllib.request import Request, urlopen

UPSTREAM_VERSION_URL = "https://raw.githubusercontent.com/uni-tue-kn/UniCorn-P4/main/VERSION"
PROJECT_URL = "https://github.com/uni-tue-kn/UniCorn-P4"
_SEMVER = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")


def parse_version(value):
    match = _SEMVER.fullmatch(value.strip())
    if not match:
        raise ValueError("Invalid semantic version")
    prerelease = match.group(4)
    identifiers = prerelease.split(".") if prerelease else []
    if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in identifiers):
        raise ValueError("Invalid numeric prerelease identifier")
    # Numeric identifiers sort below non-numeric ones; a release sorts above prereleases.
    suffix = tuple((0, int(part)) if part.isdigit() else (1, part) for part in identifiers)
    return tuple(map(int, match.group(1, 2, 3))), not bool(prerelease), suffix


def local_version():
    path = Path(os.environ.get("VERSION_FILE", Path(__file__).with_name("VERSION")))
    try:
        value = path.read_text(encoding="utf-8").strip()
        parse_version(value)
        return value
    except (OSError, ValueError):
        return "unknown"


def check_update(current, opener=urlopen):
    """Never let an unavailable/malformed upstream prevent application startup."""
    result = {"status": "unavailable", "latest_version": None,
              "update_available": False, "url": PROJECT_URL}
    try:
        request = Request(UPSTREAM_VERSION_URL, headers={"User-Agent": "UniCorn-P4-update-check"})
        with opener(request, timeout=3) as response:
            raw = response.read(129)
        if len(raw) > 128:
            raise ValueError("Version response too large")
        latest = raw.decode("utf-8").strip()
        newer = parse_version(latest) > parse_version(current)
        result.update(status="checked", latest_version=latest, update_available=newer)
    except Exception:
        # Advisory metadata only; no installation or service depends on this request.
        pass
    return result


@lru_cache(maxsize=2)
def runtime_versions(component):
    result = {}
    if component == "backend":
        result["p4runtime_schema"] = "1.6.0"
    packages = ("grpcio", "protobuf", "Flask", "thrift") if component == "backend" else ("mininet", "grpcio", "protobuf", "Flask-SocketIO", "thrift")
    for package in packages:
        try:
            result[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            continue
    commands = {"p4c": ["p4c", "--version"]} if component == "backend" else {"bmv2": ["simple_switch_grpc", "--version"], "mininet": ["mn", "--version"]}
    for name, command in commands.items():
        try:
            process = subprocess.run(command, capture_output=True, text=True, timeout=3, check=True)
            result[name] = (process.stdout or process.stderr).strip()[:256]
        except (OSError, subprocess.SubprocessError):
            continue
    for name in ("PI_REV", "MININET_REV", "BMV2_VERSION", "P4C_VERSION"):
        if os.environ.get("UNICORN_" + name):
            result[name.lower()] = os.environ["UNICORN_" + name]
    if component == "netsim":
        result["register_extension"] = {
            "transport": "P4Runtime RegisterEntry / BMv2 native register storage",
            "max_bitwidth": 64,
            "types": ["bit", "int"],
            "compiled_action_lock": True,
            "wildcard_snapshot": False,
        }
    return result


def register_version_routes(app, component):
    version = local_version()
    enabled = component == "backend" and os.environ.get("UPDATE_CHECK_ENABLED", "true").lower() in ("1", "true", "yes")
    update = {"status": "checking" if enabled else "disabled", "latest_version": None,
              "update_available": False, "url": PROJECT_URL}

    def fetch():
        update.update(check_update(version))

    if enabled:
        threading.Thread(target=fetch, name="upstream-version-check", daemon=True).start()

    @app.get("/version")
    def component_version():
        return {"component": component, "version": version,
                "runtime": runtime_versions(component), "update": dict(update)}

    @app.get("/health")
    def component_health():
        return {"status": "ok", "component": component, "version": version}
