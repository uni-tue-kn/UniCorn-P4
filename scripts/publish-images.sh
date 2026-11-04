#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?VERSION must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

# The optional workflow publishes a separate family after native validation.
case "${IMAGE_FAMILY:-standard}" in
    standard) components=(backend netsim frontend) ;;
    tofino) components=(backend-tofino netsim-tofino compiler-tofino frontend-tofino) ;;
    *) echo 'IMAGE_FAMILY must be standard or tofino' >&2; exit 1 ;;
esac
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    echo 'VERSION must be a stable semantic version' >&2; exit 1;
}

for component in "${components[@]}"; do
    docker push "unituekn/unicornp4-$component:$VERSION"
done

# Retrying an older release must not move latest backwards.
git fetch origin main
current=$(git show origin/main:VERSION)
latest=$(python3 -c 'import sys; parse=lambda s:tuple(map(int,s.split("-")[0].split("."))); print("true" if parse(sys.argv[1]) >= parse(sys.argv[2]) else "false")' "$VERSION" "$current")
if [[ "$latest" == true ]]; then
    for component in "${components[@]}"; do
        docker buildx imagetools create --tag "unituekn/unicornp4-$component:latest" "unituekn/unicornp4-$component:$VERSION"
    done
fi
echo "latest=$latest" >> "$GITHUB_OUTPUT"
