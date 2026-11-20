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
    # A merge without hand-written notes still gets its own version marker
    # instead of reusing the previous release's history.
    start = entries[0][0] if entries else len(text)
    return text[:start].rstrip() + '\n\n' + heading + '\n' + text[start:]


def add_unreleased_entries(text, section, entries):
    """Append bullet entries to `### section` of the pending release, once each."""
    present = set(text.splitlines())
    entries = [entry for entry in dict.fromkeys(entries) if entry.strip() and entry not in present]
    if not entries:
        return text
    block = ''.join(entry + '\n' for entry in entries)
    entries_found = sections(text)
    pending = [entry for entry in entries_found if re.match(r'^\[?Unreleased\]?(?=\s|$)', entry[3], re.I)]
    if len(pending) > 1:
        raise ValueError('Changelog contains ambiguous release sections')
    if not pending:
        start = entries_found[0][0] if entries_found else len(text)
        return text[:start].rstrip() + f'\n\n## Unreleased\n\n### {section}\n\n' + block + '\n' + text[start:]
    _start, body, end, _title = pending[0]
    content = text[body:end]
    heading = re.search(r'^### ' + re.escape(section) + r'[ \t]*$', content, re.M)
    if heading is None:
        content = content.rstrip('\r\n') + f'\n\n### {section}\n\n' + block + '\n'
    else:
        following = re.search(r'^#{1,3} ', content[heading.end():], re.M)
        stop = heading.end() + following.start() if following else len(content)
        content = content[:stop].rstrip('\r\n') + '\n' + block + '\n' + content[stop:]
    return text[:body] + content + text[end:]


def dependency_entries(merged_prs, promoted_commits):
    """Changelog bullets for Dependabot PRs whose merge commits are being promoted."""
    promoted = set(promoted_commits)
    return [f"* {pr['title'].strip()} (#{pr['number']})"
            for pr in sorted(merged_prs, key=lambda pr: pr['number'])
            if (pr.get('mergeCommit') or {}).get('oid') in promoted]


def release_notes(text, version):
    matches = [entry for entry in sections(text) if version_section(entry[3], version)]
    if len(matches) != 1:
        raise ValueError(f'Expected one changelog section for {version}')
    _start, body, end, _title = matches[0]
    notes = text[body:end].strip('\r\n')
    return notes + '\n' if notes.strip() else ''


def release_document(text, version):
    notes = release_notes(text, version)
    instructions = '''## How to run

Download and extract **UniCorn-P4.tar.gz**, then enter its `UniCorn-P4/` folder.
Requires Linux and Docker with Compose v2.

```sh
docker compose up -d
```

For optional Tofino models on Linux x64:

```sh
docker compose -f docker-compose.yaml -f docker-compose.tofino.yaml up -d
```

Open **http://localhost:3000**. Images are downloaded automatically.
'''
    return instructions + ('\n## Changes\n\n' + notes if notes else '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--changelog', type=Path, default=Path('CHANGELOG.md'))
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(release_document(args.changelog.read_text(), args.version))


if __name__ == '__main__':
    main()
