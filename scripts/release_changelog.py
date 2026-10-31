"""Promote changelog headings and extract the notes for one stable release."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re


def sections(text):
    headers, fence, offset = [], None, 0
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)', line)
        if marker:
            token, suffix = marker.groups()
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence) and not suffix.strip():
                fence = None
        elif fence is None and line.startswith('## '):
            headers.append((offset, offset + len(line), line[3:].strip()))
        offset += len(line)
    return [(start, body, headers[index + 1][0] if index + 1 < len(headers) else len(text), title)
            for index, (start, body, title) in enumerate(headers)]


def version_section(title, version):
    return re.match(r'^\[?v?' + re.escape(version) + r'\]?(?=\s|$)', title) is not None


def promote_changelog(text, version, released_on=None):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Changelog promotion requires a stable release version')
    entries = sections(text)
    pending = [entry for entry in entries if re.match(r'^\[?Unreleased\]?(?=\s|$)', entry[3], re.I)]
    existing = [entry for entry in entries if version_section(entry[3], version)]
    if len(pending) > 1 or len(existing) > 1 or (pending and existing):
        raise ValueError('Changelog contains ambiguous release sections')
    if existing:
        return text
    date = released_on or datetime.now(timezone.utc).date().isoformat()
    heading = f'## {version} — {date}\n'
    if pending:
        start, body, _end, _title = pending[0]
        return text[:start] + heading + text[body:]
    # A merge without hand-written notes still gets its own version marker;
    # publication falls back to GitHub-generated notes instead of reusing history.
    start = entries[0][0] if entries else len(text)
    return text[:start].rstrip() + '\n\n' + heading + '\n' + text[start:]


def release_notes(text, version):
    matches = [entry for entry in sections(text) if version_section(entry[3], version)]
    if len(matches) != 1:
        raise ValueError(f'Expected one changelog section for {version}')
    _start, body, end, _title = matches[0]
    notes = text[body:end].strip('\r\n')
    return notes + '\n' if notes.strip() else ''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--changelog', type=Path, default=Path('CHANGELOG.md'))
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(release_notes(args.changelog.read_text(), args.version))


if __name__ == '__main__':
    main()
