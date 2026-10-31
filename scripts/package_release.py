"""Build the download-ready UniCorn-P4.tar.gz deployment asset.

Inputs come from Git HEAD's explicit allowlist. Live databases, generated
logs, packet captures, and untracked local files cannot enter the archive.
Use --compiler-image to compile every complete sample with the release p4c.
"""
import argparse
import gzip
import io
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile


def git_bytes(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def compose(version):
    return f'''services:
  unicornp4-backend:
    image: unituekn/unicornp4-backend:{version}
    network_mode: host
    volumes:
      - ./p4-files:/p4
      - ./database:/database
      - ./topologies:/topologies
    environment:
      P4_DIR: /p4/
      TOPO_DIR: /topologies
      UPDATE_CHECK_ENABLED: ${{UPDATE_CHECK_ENABLED:-true}}
  unicornp4-netsim:
    image: unituekn/unicornp4-netsim:{version}
    network_mode: host
    privileged: true
    cap_add: [NET_ADMIN]
    volumes:
      - ./topologies:/topologies
  unicornp4-frontend:
    image: unituekn/unicornp4-frontend:{version}
    depends_on: [unicornp4-backend]
    ports: ["3000:3000"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      BACKEND_URL: http://host.docker.internal:5000
      NETSIM_URL: http://host.docker.internal:5001
'''


def package(repo, output, compiler_image=None, compiled_dir=None):
    tracked = git_bytes(repo, "ls-tree", "-r", "--name-only", "HEAD").decode().splitlines()
    version = git_bytes(repo, "show", "HEAD:VERSION").decode().strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Deployment assets require a stable release VERSION")
    files = {"VERSION": (version + "\n").encode(), "docker-compose.yaml": compose(version).encode(),
             "database/.empty": b""}
    for path in tracked:
        local = PurePosixPath(path)
        destination = None
        if local.parts[:2] == ("docker", "p4-files") and (path.endswith('.p4') or path.endswith('.json') or path.endswith('.p4info.txt')):
            destination = str(PurePosixPath(*local.parts[1:]))
        elif local.parts[:2] == ("docker", "topologies") and len(local.parts) == 3 and path.endswith('.json'):
            destination = str(PurePosixPath(*local.parts[1:]))
        elif path in ("README.md", "LICENSE", "logo.png", "CHANGELOG.md", "docs/usage.md", "runtime/README.md"):
            destination = path
        elif local.parts[:2] == ("docs", "screenshots") and len(local.parts) == 3 and path.endswith('.png'):
            destination = path
        elif path == "tests/fixtures/resources.p4":
            destination = "p4-files/resources/resources.p4"
        elif path == "tests/fixtures/topology.json":
            destination = "topologies/resources.json"
        elif local.parts[:2] == ("examples", "p4") and path.endswith('.p4'):
            destination = str(PurePosixPath('p4-files', *local.parts[2:]))
        elif local.parts[:2] == ("examples", "networks") and len(local.parts) == 3 and (path.endswith('.zip') or local.name == 'README.md'):
            destination = path
        if destination:
            files[destination] = git_bytes(repo, "show", f"HEAD:{path}")
            if destination == "examples/networks/README.md":
                files[destination] = files[destination].replace(b"(../p4/", b"(../../p4-files/")
    quickstart = (f"# UniCorn-P4 {version} deployment\n\n"
        "Extract this archive, enter the UniCorn-P4 directory, then run:\n\n"
        "```sh\ndocker compose pull\ndocker compose up -d\n```\n\n"
        "Open http://localhost:3000. All images are pinned to this release. "
        "P4 sources and compiled examples are in p4-files/; sample topologies "
        "are in topologies/. The database starts empty. Mininet requires Linux "
        "and the privileged container configured in docker-compose.yaml.\n\n"
        "The following repository documentation also describes development "
        "checkouts, whose docker/ subdirectory corresponds to this archive's root.\n\n---\n\n")
    files['README.md'] = quickstart.encode() + files.get('README.md', b'')
    units = [path for path, data in files.items() if path.startswith('p4-files/') and path.endswith('.p4')
             and re.search(rb'\bV1Switch\s*\(', data)]
    if not units:
        raise ValueError("No complete v1model P4 sample is tracked")
    with tempfile.TemporaryDirectory(prefix="unicorn-release-") as directory:
        staging = Path(directory)
        for path, data in files.items():
            target = staging / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if compiler_image:
            # One isolated compiler invocation per complete P4 sample. Included
            # fragments remain available in their original relative paths.
            for unit in units:
                source = "/samples/" + unit
                parent = str(PurePosixPath(source).parent)
                subprocess.run(["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                    "--entrypoint", "p4c", "-v", f"{staging}:/samples", compiler_image,
                    source, "--target", "bmv2", "--arch", "v1model",
                    "--p4runtime-files", source[:-3] + ".p4info.txt", "-o", parent], check=True)
        for unit in units:
            for suffix in (".json", ".p4info.txt"):
                generated = unit[:-3] + suffix
                if compiled_dir:
                    candidate = compiled_dir / generated
                else:
                    candidate = staging / generated
                if not candidate.is_file():
                    raise ValueError(f"Missing compiled sample {generated}; supply --compiler-image or --compiled-dir")
                files[generated] = candidate.read_bytes()
    epoch = int(git_bytes(repo, "show", "-s", "--format=%ct", "HEAD"))
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as destination, gzip.GzipFile(fileobj=destination, mode="wb", filename="", mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name in ("UniCorn-P4", "UniCorn-P4/database", "UniCorn-P4/p4-files", "UniCorn-P4/topologies"):
                info = tarfile.TarInfo(name)
                info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, epoch
                archive.addfile(info)
            for path, data in sorted(files.items()):
                info = tarfile.TarInfo("UniCorn-P4/" + path)
                info.size, info.mode, info.mtime = len(data), 0o644, epoch
                archive.addfile(info, io.BytesIO(data))
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--compiler-image")
    group.add_argument("--compiled-dir", type=Path)
    args = parser.parse_args()
    print(package(args.repo, args.output, args.compiler_image, args.compiled_dir))


if __name__ == "__main__":
    main()
