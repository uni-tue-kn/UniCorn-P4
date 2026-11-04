#!/usr/bin/env bash
# Verify a stable release before checking out its sources or using credentials.
set -euo pipefail
: "${TAG:?TAG must name an existing stable release}"
: "${TOFINO_SDK_IMAGE:?TOFINO_SDK_IMAGE must be an immutable SDK image digest}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
[[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    echo 'TAG must be a stable vMAJOR.MINOR.PATCH release tag' >&2; exit 1;
}
[[ "$TOFINO_SDK_IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]] || {
    echo 'TOFINO_SDK_IMAGE must include a repository and immutable @sha256 digest' >&2; exit 1;
}
git fetch origin main --tags
commit=$(git rev-parse --verify "refs/tags/$TAG^{commit}")
git merge-base --is-ancestor "$commit" origin/main
version=$(git show "$commit:VERSION")
[[ "$TAG" == "v$version" ]] || { echo 'Tag and release VERSION disagree' >&2; exit 1; }
printf 'version=%s\ncommit=%s\n' "$version" "$commit" >> "$GITHUB_OUTPUT"
