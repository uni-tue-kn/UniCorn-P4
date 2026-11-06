#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?VERSION must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

# The optional workflow publishes a separate family after native validation.
case "${IMAGE_FAMILY:-standard}" in
    standard)
        versioned=("unituekn/unicornp4-backend:$VERSION" "unituekn/unicornp4-netsim:$VERSION" "unituekn/unicornp4-frontend:$VERSION")
        promoted=("unituekn/unicornp4-backend:latest" "unituekn/unicornp4-netsim:latest" "unituekn/unicornp4-frontend:latest")
        ;;
    tofino)
        versioned=("unituekn/unicornp4-backend:tofino-$VERSION" "unituekn/unicornp4-netsim:tofino-$VERSION" "unituekn/unicornp4-tofino-sdk:compiler-$VERSION")
        promoted=("unituekn/unicornp4-backend:tofino-latest" "unituekn/unicornp4-netsim:tofino-latest" "unituekn/unicornp4-tofino-sdk:compiler-latest")
        ;;
    *) echo 'IMAGE_FAMILY must be standard or tofino' >&2; exit 1 ;;
esac
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    echo 'VERSION must be a stable semantic version' >&2; exit 1;
}

for image in "${versioned[@]}"; do
    docker push "$image"
done

# Retrying an older release must not move latest backwards.
git fetch origin main
current=$(git show origin/main:VERSION)
latest=$(python3 -c 'import sys; parse=lambda s:tuple(map(int,s.split("-")[0].split("."))); print("true" if parse(sys.argv[1]) >= parse(sys.argv[2]) else "false")' "$VERSION" "$current")
if [[ "$latest" == true ]]; then
    for index in "${!versioned[@]}"; do
        docker buildx imagetools create --tag "${promoted[$index]}" "${versioned[$index]}"
    done
fi
echo "latest=$latest" >> "$GITHUB_OUTPUT"
