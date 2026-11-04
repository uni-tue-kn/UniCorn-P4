"""Apply explicit listener isolation and dependency-fetch adaptations."""
from pathlib import Path
path = Path('/opt/open-p4studio/pkgsrc/target-utils/third-party/klish/clish/shell/shell_thread.c')
source = path.read_text()
old = 'addr.sin_port = htons(9999);'
new = '''/* UniCorn: isolated listener per model, preserving upstream default. */
    const char *unicorn_cli_port = getenv("UNICORN_BFSHELL_PORT");
    addr.sin_port = htons(unicorn_cli_port ? atoi(unicorn_cli_port) : 9999);'''
if source.count(old) != 1:
    raise SystemExit('Upstream CLI listener changed; review the port isolation patch')
path.write_text(source.replace(old, new))

# The SDK disables gRPC/protobuf tests and consumes installed Abseil. Their
# nested test/analysis repositories are unused. Fetch every first-level gitlink
# at its original revision without cloning complete repository histories.
path = Path('/opt/open-p4studio/p4studio/dependencies/source/install_grpc.py')
source = path.read_text()
old = '        git_update_submodules(grpc_repository_dir)'
new = '''        execute('git -C {} submodule update --init --depth 1 --jobs 2'.format(grpc_repository_dir))'''
required = ('-DgRPC_BUILD_TESTS=OFF', '-Dprotobuf_BUILD_TESTS=OFF', '-Dprotobuf_ABSL_PROVIDER=package')
if source.count(old) != 1 or not all(option in source for option in required):
    raise SystemExit('Upstream gRPC dependency build changed; review the shallow fetch adaptation')
path.write_text(source.replace(old, new))
