#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?VERSION must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

for component in backend netsim frontend; do
    docker push "unituekn/unicornp4-$component:$VERSION"
done

# Retrying an older release must not move latest backwards.
git fetch origin main
current=$(git show origin/main:VERSION)
latest=$(python3 -c 'import sys; parse=lambda s:tuple(map(int,s.split("-")[0].split("."))); print("true" if parse(sys.argv[1]) >= parse(sys.argv[2]) else "false")' "$VERSION" "$current")
if [[ "$latest" == true ]]; then
    for component in backend netsim frontend; do
        docker buildx imagetools create --tag "unituekn/unicornp4-$component:latest" "unituekn/unicornp4-$component:$VERSION"
    done
fi
echo "latest=$latest" >> "$GITHUB_OUTPUT"
