"""Verify publishing tags without accessing a registry or changing Git state."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('current, promote', [('1.2.0', True), ('1.2.1', False)])
def test_version_tags_and_current_latest_share_the_same_images(tmp_path, current, promote):
    commands = tmp_path / 'commands.jsonl'
    output = tmp_path / 'output'
    for name in ('docker', 'git'):
        executable = tmp_path / name
        executable.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
if Path(sys.argv[0]).name == 'git':
    if sys.argv[1] == 'show': print(os.environ['CURRENT_RELEASE'])
else:
    with open(os.environ['PUBLISH_COMMANDS'], 'a') as log:
        log.write(json.dumps(sys.argv[1:]) + '\\n')
''')
        executable.chmod(0o755)
    environment = dict(os.environ, PATH=str(tmp_path) + os.pathsep + os.environ['PATH'], VERSION='1.2.0',
                       CURRENT_RELEASE=current, PUBLISH_COMMANDS=str(commands), GITHUB_OUTPUT=str(output))
    subprocess.run(['bash', str(ROOT / 'scripts/publish-images.sh')], env=environment, check=True)
    calls = [json.loads(line) for line in commands.read_text().splitlines()]
    expected = []
    for component in ('backend', 'netsim', 'frontend'):
        image = f'unituekn/unicornp4-{component}'
        expected.append(['push', f'{image}:1.2.0'])
    if promote:
        for component in ('backend', 'netsim', 'frontend'):
            image = f'unituekn/unicornp4-{component}'
            expected.append(['buildx', 'imagetools', 'create', '--tag', f'{image}:latest', f'{image}:1.2.0'])
    assert calls == expected
    assert output.read_text() == f'latest={str(promote).lower()}\n'
