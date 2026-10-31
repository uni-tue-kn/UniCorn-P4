"""Prepare an idempotent release commit from a successfully tested merge.

This performs local Git changes only. The release workflow separately reserves
the commit/tag with an atomic push after validating merged-PR provenance.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?")
RELEASE_FILES = {"VERSION", "frontend/package.json", "frontend/package-lock.json"}


def next_version(current):
    match = VERSION_PATTERN.fullmatch(current.strip())
    if match is None:
        raise ValueError("VERSION must contain a three-component semantic version")
    major, minor, patch, prerelease = match.groups()
    return f"{major}.{minor}.{int(patch) if prerelease else int(patch) + 1}"


def eligible_merge(pages, repository, sha):
    """GitHub commit->PR association supports merge, squash and rebase merges."""
    requests = [item for page in pages for item in page] if pages and isinstance(pages[0], list) else pages
    return any(pr.get("merged_at") and pr.get("merge_commit_sha") == sha
               and pr.get("base", {}).get("ref") == "main"
               and pr.get("base", {}).get("repo", {}).get("full_name") == repository
               for pr in requests)


def git(repo, *arguments):
    return subprocess.check_output(["git", "-C", str(repo), *arguments], text=True).strip()


def prepare(repo, tested_sha, commit=False):
    if not re.fullmatch(r"[0-9a-f]{40}", tested_sha):
        raise ValueError("Expected the full tested commit SHA")
    head = git(repo, "rev-parse", "HEAD")
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Release preparation requires a clean tracked worktree")
    source_version = git(repo, "show", f"{tested_sha}:VERSION")
    version = next_version(source_version)
    tag = f"v{version}"
    existing = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"],
                              capture_output=True, text=True)
    if existing.returncode == 0:
        reserved = existing.stdout.strip()
        message = git(repo, "show", "-s", "--format=%B", reserved)
        changed = set(git(repo, "diff", "--name-only", tested_sha, reserved).splitlines())
        if (git(repo, "show", "-s", "--format=%P", reserved) != tested_sha
                or message.splitlines()[0] != f"Release v{version}"
                or f"Release-Source: {tested_sha}" not in message.splitlines()
                or not changed.issubset(RELEASE_FILES)
                or git(repo, "show", f"{reserved}:VERSION") != version):
            raise ValueError(f"Existing {tag} does not reserve this tested source")
        if commit and head != reserved:
            subprocess.run(["git", "-C", str(repo), "checkout", "--detach", reserved], check=True)
        return {"ready": "true", "version": version, "tag": tag, "commit": reserved,
                "reused": "true", "reserve_needed": "false"}
    if head != tested_sha:
        parents = git(repo, "show", "-s", "--format=%P", head).split()
        message = git(repo, "show", "-s", "--format=%B", head)
        changed = set(git(repo, "diff", "--name-only", tested_sha, head).splitlines())
        if (parents != [tested_sha] or message.splitlines()[0] != f"Release v{version}"
                or f"Release-Source: {tested_sha}" not in message.splitlines()
                or not changed.issubset(RELEASE_FILES)
                or git(repo, "show", "HEAD:VERSION") != version):
            return {"ready": "false", "reason": "main has advanced beyond the tested merge"}
        # A previous attempt reserved this exact release; finish publishing it.
        result = {"ready": "true", "version": version, "tag": tag, "commit": head, "reused": "true", "reserve_needed": "true"}
    else:
        if git(repo, "status", "--porcelain", "--untracked-files=no"):
            raise ValueError("Release preparation requires a clean tracked worktree")
        (repo / "VERSION").write_text(version + "\n")
        for filename in ("frontend/package.json", "frontend/package-lock.json"):
            path = repo / filename
            data = json.loads(path.read_text())
            data["version"] = version
            if filename.endswith("package-lock.json"):
                data.setdefault("packages", {}).setdefault("", {})["version"] = version
            path.write_text(json.dumps(data, indent=2) + "\n")
        if not commit:
            return {"ready": "true", "version": version, "tag": tag, "commit": "", "reused": "false"}
        subprocess.run(["git", "-C", str(repo), "add", *sorted(RELEASE_FILES)], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=github-actions[bot]",
                        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                        "commit", "-m", f"Release v{version}", "-m", f"Release-Source: {tested_sha}"], check=True)
        result = {"ready": "true", "version": version, "tag": tag,
                  "commit": git(repo, "rev-parse", "HEAD"), "reused": "false", "reserve_needed": "true"}
    existing = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"],
                              capture_output=True, text=True)
    if existing.returncode == 0:
        if existing.stdout.strip() != result["commit"]:
            raise ValueError(f"Existing {tag} points to a different commit")
    elif commit:
        subprocess.run(["git", "-C", str(repo), "tag", tag, result["commit"]], check=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--tested-sha", required=True)
    parser.add_argument("--merged-prs", type=Path)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.merged_prs and not eligible_merge(json.loads(args.merged_prs.read_text()), args.repository, args.tested_sha):
        result = {"ready": "false", "reason": "tested commit is not an associated merged PR on main"}
    else:
        result = prepare(args.repo, args.tested_sha, args.commit)
    if args.output:
        with args.output.open("a") as destination:
            destination.write("".join(f"{key}={value}\n" for key, value in result.items()))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
