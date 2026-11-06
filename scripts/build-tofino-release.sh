#!/usr/bin/env bash
# Finished optional images built on the same release's published standard bases.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VERSION:?VERSION must be set}"
: "${TOFINO_SDK_IMAGE:?TOFINO_SDK_IMAGE must be set}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || exit 1
[[ "$TOFINO_SDK_IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$(cat VERSION)" == "$VERSION" ]] || { echo 'Checkout VERSION differs from release' >&2; exit 1; }
backend="unituekn/unicornp4-backend:$VERSION"
netsim="unituekn/unicornp4-netsim:$VERSION"
docker pull "$backend"
docker pull "$netsim"
docker pull "$TOFINO_SDK_IMAGE"
for target in compiler runtime backend; do
    case "$target" in
        compiler) image="unituekn/unicornp4-tofino-sdk:compiler-$VERSION" ;;
        runtime) image="unituekn/unicornp4-netsim:tofino-$VERSION" ;;
        backend) image="unituekn/unicornp4-backend:tofino-$VERSION" ;;
    esac
    # The docker driver sees the bases just pulled into the local image store;
    # a docker-container builder would try resolving local-only tags remotely.
    docker buildx build --builder default --load -f docker/tofino/Dockerfile \
        --target "$target" --build-arg "SDK_IMAGE=$TOFINO_SDK_IMAGE" \
        --build-arg "BACKEND_IMAGE=$backend" --build-arg "NETSIM_IMAGE=$netsim" \
        -t "$image" .
done
