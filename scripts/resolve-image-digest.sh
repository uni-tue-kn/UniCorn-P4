#!/usr/bin/env bash
# Resolve a registry tag to an immutable digest, or validate an existing digest.
set -euo pipefail

ref=${1:-${SDK_REF:-}}
[[ -n "$ref" ]] || { echo 'An SDK image reference is required' >&2; exit 2; }
docker pull "$ref" > /dev/null

if [[ "$ref" == *@sha256:* ]]; then
    digest=$ref
else
    repository=$ref
    # Strip a tag only from the final path component; preserve registry ports.
    [[ "${repository##*/}" == *:* ]] && repository=${repository%:*}
    digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" |
        awk -F@ -v repository="$repository" '$1 == repository {print; exit}')
fi

[[ "$digest" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]] || {
    echo 'Could not resolve the Tofino SDK image digest' >&2
    exit 1
}
printf '%s\n' "$digest"
