"""Release guards and native distribution commands without Docker or a registry."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest

from scripts.package_release import compose, tofino_compose

ROOT = Path(__file__).resolve().parents[2]
SDK = 'unituekn/unicornp4-tofino-sdk@sha256:' + 'a' * 64
PUBLIC_SDK = ('ghcr.io/n1tr0-5urf3r/open-p4studio@sha256:'
              '1431aaa7183f30191c16fda9880dc916b3e73fc2db14e93dc45177a48291412c')


def test_prebuilt_sdk_and_release_defaults_match_verified_source_pair():
    dockerfile = (ROOT / 'docker/tofino/Dockerfile').read_text()
    defaults = dict(re.findall(r'^ARG (\w+)=(.+)$', dockerfile, re.MULTILINE))
    assert defaults['SDK_IMAGE'] == PUBLIC_SDK
    assert defaults['OPEN_P4STUDIO_REV'] == 'caf41f60aab293e32ccdb85e292433acdb1849b1'
    assert defaults['P4C_REV'] == '17ade03c106793ef0d3cd15a3f789de2760ed486'
    workflow = (ROOT / '.github/workflows/tofino-release.yml').read_text()
    sdk_input = workflow.split('      sdk_image:\n', 1)[1].split('\npermissions:', 1)[0]
    assert f'        default: {PUBLIC_SDK}\n' in sdk_input
    source_ci = (ROOT / '.github/workflows/tofino.yml').read_text()
    assert 'SDK_IMAGE=build\n' in source_ci
    assert 'OPEN_P4STUDIO_REV=6d8b203700e3ca0f1208418072f88dc4a6a597e8\n' in source_ci
    assert 'P4C_REV=ff5070480d76cd171df54051404f118d005fbf5e\n' in source_ci


@pytest.mark.parametrize('base,override,services', [
    ('docker-compose.yaml', 'docker-compose.tofino.yaml',
     ('unicornp4-backend', 'unicornp4-netsim', 'unicornp4-compiler')),
    ('docker-compose.test.yaml', 'docker-compose.tofino.test.yaml',
     ('backend', 'netsim', 'compiler')),
])
@pytest.mark.parametrize('sdk', [None, SDK])
def test_source_compose_uses_public_sdk_by_default_and_accepts_override(base, override, services, sdk):
    if not shutil.which('docker'):
        pytest.skip('Compose configuration check requires the Docker CLI')
    environment = dict(os.environ)
    environment.pop('TOFINO_SDK_IMAGE', None)
    if sdk:
        environment['TOFINO_SDK_IMAGE'] = sdk
    result = subprocess.run([
        'docker', 'compose', '--env-file', '/dev/null',
        '-f', str(ROOT / 'docker' / base), '-f', str(ROOT / 'docker' / override),
        'config', '--format', 'json',
    ], env=environment, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    configured = json.loads(result.stdout)['services']
    for service in services:
        assert configured[service]['build']['args']['SDK_IMAGE'] == (sdk or PUBLIC_SDK)


@pytest.fixture
def shell(tmp_path):
    tools = tmp_path / 'bin'
    tools.mkdir()
    commands = tmp_path / 'commands.jsonl'
    for name in ('docker', 'git'):
        executable = tools / name
        executable.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ['COMMANDS'], 'a') as log:
    log.write(json.dumps([name, *args]) + '\\n')
if name == 'git':
    if args[0] == 'rev-parse': print('b' * 40)
    if args[0] == 'show': print(os.environ.get('CURRENT_VERSION', '1.2.0'))
    if args[0] == 'merge-base' and os.environ.get('NOT_ON_MAIN'): sys.exit(1)
if name == 'docker' and os.environ.get('FAIL_NATIVE') and '/tests/run_native.sh' in args:
    sys.exit(7)
if name == 'docker' and os.environ.get('FAIL_RUNTIME'):
    if args[0] == 'exec': sys.exit(1)
    if args[0] == 'inspect': print('false')
''')
        executable.chmod(0o755)
    environment = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                       COMMANDS=str(commands), VERSION='1.2.0', TAG='v1.2.0',
                       TOFINO_SDK_IMAGE=SDK, GITHUB_OUTPUT=str(tmp_path / 'output'),
                       WORKSHOP_DIR=str(tmp_path))
    # Helpers run from their own checkout; isolate all generated results.
    checkout = tmp_path / 'checkout'
    (checkout / 'scripts').mkdir(parents=True)
    (checkout / 'VERSION').write_text('1.2.0\n')
    for path in ROOT.glob('scripts/*tofino*release.sh'):
        shutil.copyfile(path, checkout / 'scripts' / path.name)
    return checkout, environment, commands


def run(shell, script, **overrides):
    checkout, environment, _ = shell
    path = checkout / 'scripts' / script
    if not path.exists():
        path = ROOT / 'scripts' / script
    return subprocess.run(['bash', str(path)], cwd=checkout,
                          env=dict(environment, **overrides), capture_output=True, text=True)


def calls(shell):
    path = shell[2]
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def test_guard_requires_stable_matching_tag_on_main_and_immutable_sdk(shell):
    result = run(shell, 'prepare-tofino-release.sh')
    assert result.returncode == 0, result.stderr
    assert Path(shell[1]['GITHUB_OUTPUT']).read_text() == 'version=1.2.0\ncommit=' + 'b' * 40 + '\n'
    assert ['git', 'merge-base', '--is-ancestor', 'b' * 40, 'origin/main'] in calls(shell)


@pytest.mark.parametrize('overrides', [
    {'TAG': 'main'}, {'TAG': 'v01.2.0'}, {'TAG': 'v1.2.0-rc.1'},
    {'TAG': 'v1.2.0;touch /tmp/no'}, {'TOFINO_SDK_IMAGE': 'sdk:latest'},
    {'TOFINO_SDK_IMAGE': 'sha256:' + 'a' * 64},
    {'TOFINO_SDK_IMAGE': 'sdk@sha256:' + 'a' * 63},
])
def test_invalid_inputs_fail_before_git_or_docker(shell, overrides):
    assert run(shell, 'prepare-tofino-release.sh', **overrides).returncode != 0
    assert calls(shell) == []


@pytest.mark.parametrize('overrides', [{'NOT_ON_MAIN': 'true'}, {'CURRENT_VERSION': '1.2.1'}])
def test_untrusted_or_mismatched_release_is_rejected(shell, overrides):
    assert run(shell, 'prepare-tofino-release.sh', **overrides).returncode != 0
    assert not Path(shell[1]['GITHUB_OUTPUT']).exists()


def test_optional_builds_reuse_pinned_sdk_and_matching_versioned_bases(shell):
    result = run(shell, 'build-tofino-release.sh')
    assert result.returncode == 0, result.stderr
    recorded = calls(shell)
    assert recorded[:4] == [['docker', 'pull', image] for image in (
        'unituekn/unicornp4-backend:1.2.0', 'unituekn/unicornp4-netsim:1.2.0', 'unituekn/unicornp4-frontend:1.2.0', SDK)]
    assert recorded[-1] == ['docker', 'tag', 'unituekn/unicornp4-frontend:1.2.0', 'unituekn/unicornp4-frontend-tofino:1.2.0']
    for call, target, component in zip(recorded[4:-1], ('compiler', 'runtime', 'backend'), ('compiler', 'netsim', 'backend')):
        assert call[:6] == ['docker', 'buildx', 'build', '--builder', 'default', '--load']
        assert call[call.index('--target') + 1] == target
        assert f'SDK_IMAGE={SDK}' in call
        assert 'BACKEND_IMAGE=unituekn/unicornp4-backend:1.2.0' in call
        assert 'NETSIM_IMAGE=unituekn/unicornp4-netsim:1.2.0' in call
        assert f'unituekn/unicornp4-{component}-tofino:1.2.0' in call
        assert '--push' not in call


def test_build_rejects_mismatched_checkout_before_docker(shell):
    assert run(shell, 'build-tofino-release.sh', VERSION='1.2.1').returncode != 0
    assert calls(shell) == []


@pytest.mark.parametrize('current,promote', [('1.2.0', True), ('1.2.1', False)])
def test_tofino_tags_follow_standard_no_downgrade_policy(shell, current, promote):
    result = run(shell, 'publish-images.sh', IMAGE_FAMILY='tofino', CURRENT_VERSION=current)
    assert result.returncode == 0, result.stderr
    recorded = [call for call in calls(shell) if call[0] == 'docker']
    images = [f'unituekn/unicornp4-{component}-tofino' for component in ('backend', 'netsim', 'compiler', 'frontend')]
    expected = [['docker', 'push', f'{image}:1.2.0'] for image in images]
    if promote:
        expected += [['docker', 'buildx', 'imagetools', 'create', '--tag', f'{image}:latest', f'{image}:1.2.0'] for image in images]
    assert recorded == expected
    assert Path(shell[1]['GITHUB_OUTPUT']).read_text() == f'latest={str(promote).lower()}\n'


def test_native_gate_exercises_final_images_and_cleans_private_state(shell):
    result = run(shell, 'validate-tofino-release.sh')
    assert result.returncode == 0, result.stderr
    recorded = calls(shell)
    native = next(call for call in recorded if '/tests/run_native.sh' in call)
    assert 'unituekn/unicornp4-compiler-tofino:1.2.0' in native
    assert native[native.index('--network') + 1] == 'none'
    runtime = next(call for call in recorded if 'unituekn/unicornp4-netsim-tofino:1.2.0' in call)
    name = runtime[runtime.index('--name') + 1]
    adapter = next(call for call in recorded if '/tests/structured_register_smoke.py' in call)
    assert 'unituekn/unicornp4-backend-tofino:1.2.0' in adapter
    assert adapter[adapter.index('--network') + 1] == f'container:{name}'
    assert ['docker', 'rm', '-f', name] in recorded
    assert ['docker', 'volume', 'rm', name] in recorded
    assert not any('--publish' in call or '--privileged' in call or 'host' in call for call in recorded)


def test_native_failure_stops_before_testing_application_images(shell):
    assert run(shell, 'validate-tofino-release.sh', FAIL_NATIVE='true').returncode != 0
    assert len(calls(shell)) == 1


def test_exited_runtime_fails_fast_and_cleans_disposable_state(shell):
    result = run(shell, 'validate-tofino-release.sh', FAIL_RUNTIME='true')
    assert result.returncode != 0
    assert 'exited before becoming ready' in result.stderr
    recorded = calls(shell)
    runtime = next(call for call in recorded if 'unituekn/unicornp4-netsim-tofino:1.2.0' in call)
    name = runtime[runtime.index('--name') + 1]
    assert ['docker', 'rm', '-f', name] in recorded
    assert ['docker', 'volume', 'rm', name] in recorded
    assert not any('/tests/structured_register_smoke.py' in call for call in recorded)


def test_workflow_requires_trusted_ref_and_native_validation_before_login():
    workflow = (ROOT / '.github/workflows/tofino-release.yml').read_text()
    assert "    if: github.ref == 'refs/heads/main'\n" in workflow
    # Each step is independent YAML at this indentation. Avoid adding a YAML
    # runtime dependency to the ordinary Python test environment.
    steps = workflow.split('\n      - ')
    validation = next(i for i, step in enumerate(steps) if 'run: bash scripts/validate-tofino-release.sh' in step)
    login = next(i for i, step in enumerate(steps) if 'uses: docker/login-action@' in step)
    publish = next(i for i, step in enumerate(steps) if 'run: bash scripts/publish-images.sh' in step)
    assert validation < login < publish
    assert all('        if:' not in steps[i] for i in (validation, login, publish))
    assert '          IMAGE_FAMILY: tofino' in steps[publish]


def test_download_compose_can_merge_without_sources_or_builds(tmp_path):
    if not shutil.which('docker'):
        pytest.skip('Compose configuration check requires the Docker CLI')
    standard, optional = tmp_path / 'docker-compose.yaml', tmp_path / 'docker-compose.tofino.yaml'
    standard.write_text(compose())
    optional.write_text(tofino_compose())
    result = subprocess.run(['docker', 'compose', '-f', str(standard), '-f', str(optional), 'config', '--format', 'json'],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)['services']
    assert len(services) == 4
    for service in services.values():
        assert 'build' not in service
        assert service['image'].endswith(':latest')
    assert services['unicornp4-compiler']['network_mode'] == 'host'
    assert services['unicornp4-compiler']['command'][-3:] == ['127.0.0.1', '--port', '8080']
    assert services['unicornp4-backend']['environment']['P4_DIR'] == '/p4/'
    assert services['unicornp4-backend']['environment']['TOFINO_COMPILER_URL'] == 'http://127.0.0.1:8080'
