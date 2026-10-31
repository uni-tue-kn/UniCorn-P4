import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from scripts.release_changelog import promote_changelog, release_notes

ROOT = Path(__file__).resolve().parents[2]
SOURCE = '# Changelog\n\n## Unreleased — 1.2.0\n\n### Added\n\n* Keep `$HOME` and `$(touch marker)` literal.\n\n```md\n## An example heading\n```\n\n## v1.0\n\nOld history.\n'


def test_promotes_caption_and_extracts_markdown_without_old_history():
    promoted = promote_changelog(SOURCE, '1.2.0', released_on='2026-10-31')
    assert 'Unreleased' not in promoted
    assert '## 1.2.0 — 2026-10-31' in promoted
    assert '## v1.0\n\nOld history.' in promoted
    notes = release_notes(promoted, '1.2.0')
    assert notes == '### Added\n\n* Keep `$HOME` and `$(touch marker)` literal.\n\n```md\n## An example heading\n```\n'


def test_empty_next_release_does_not_reuse_previous_notes():
    first = promote_changelog(SOURCE, '1.2.0', released_on='2026-10-31')
    second = promote_changelog(first, '1.2.1', released_on='2026-11-01')
    assert release_notes(second, '1.2.1') == ''
    assert release_notes(second, '1.2.0') == release_notes(first, '1.2.0')
    assert promote_changelog(second, '1.2.1', released_on='2026-11-02') == second


def test_whitespace_only_notes_use_generated_notes_fallback():
    assert release_notes('# Changes\n\n## 1.2.0 — 2026-10-31\n\n  \n\t\n', '1.2.0') == ''


def test_bracketed_unreleased_and_version_headings_are_supported():
    text = '# Changes\n\n## [Unreleased]\n\n* Fix.\n\n## [1.0.0] - 2025-01-01\n\nOld.\n'
    promoted = promote_changelog(text, '1.1.0', released_on='2026-10-31')
    assert release_notes(promoted, '1.1.0') == '* Fix.\n'
    assert release_notes(promoted, '1.0.0') == 'Old.\n'


def test_real_extraction_cli_preserves_exact_notes(tmp_path):
    changelog, output = tmp_path / 'CHANGELOG.md', tmp_path / 'release notes.md'
    promoted = promote_changelog(SOURCE, '1.2.0', released_on='2026-10-31')
    changelog.write_text(promoted)
    subprocess.run([sys.executable, str(ROOT / 'scripts/release_changelog.py'), '--changelog', str(changelog),
                    '--version', '1.2.0', '--output', str(output)], check=True)
    assert output.read_text() == release_notes(promoted, '1.2.0')


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('notes', ['### Added\n\n* Keep `$(touch marker)` literal.\n', ''])
def test_actual_publisher_uses_changelog_file_and_handles_retries(tmp_path, existing, notes):
    commands = tmp_path / 'commands.jsonl'
    executable = tmp_path / 'gh'
    executable.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
args = sys.argv[1:]
record = {'args': args}
if '--notes-file' in args:
    record['notes'] = Path(args[args.index('--notes-file') + 1]).read_text()
with open(os.environ['FAKE_GH_LOG'], 'a') as log:
    log.write(json.dumps(record) + '\\n')
if args[:2] == ['release', 'view']:
    sys.exit(0 if os.environ['FAKE_EXISTING'] == 'true' else 1)
''')
    executable.chmod(0o755)
    notes_file, archive = tmp_path / 'release notes.md', tmp_path / 'deployment bundle.tar.gz'
    notes_file.write_text(notes)
    archive.write_bytes(b'archive fixture')
    env = {**os.environ, 'PATH': str(tmp_path) + os.pathsep + os.environ.get('PATH', ''),
           'FAKE_GH_LOG': str(commands), 'FAKE_EXISTING': str(existing).lower(),
           'VERSION': '1.2.0', 'TAG': 'v1.2.0', 'LATEST': 'true',
           'RELEASE_NOTES': str(notes_file), 'RELEASE_ARCHIVE': str(archive)}
    subprocess.run(['bash', str(ROOT / 'scripts/publish-release.sh')], env=env, cwd=tmp_path, check=True)
    calls = [json.loads(line) for line in commands.read_text().splitlines()]
    if existing:
        assert calls[-1]['args'] == ['release', 'upload', 'v1.2.0', str(archive), '--clobber']
        assert not any(call['args'][1] == 'create' for call in calls)
    else:
        assert calls[-1]['args'][:4] == ['release', 'create', 'v1.2.0', str(archive)]
        assert '--verify-tag' in calls[-1]['args']
        assert '--latest=true' in calls[-1]['args']
    body_calls = [call for call in calls if '--notes-file' in call['args']]
    if notes:
        assert len(body_calls) == 1
        assert body_calls[0]['notes'] == notes
        assert body_calls[0]['args'][1] == ('edit' if existing else 'create')
    else:
        assert not body_calls
        if not existing:
            assert '--generate-notes' in calls[-1]['args']
    assert not (tmp_path / 'marker').exists()
