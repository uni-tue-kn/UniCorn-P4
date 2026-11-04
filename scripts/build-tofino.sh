#!/usr/bin/env bash
# Build matching standard bases before adding the optional native SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep locally built bases visible to all three optional targets.
export BUILDX_BUILDER=default
docker build -f docker/backend/Dockerfile -t unicornp4-backend:local .
docker build -f docker/netsim/Dockerfile -t unicornp4-netsim:local .
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.tofino.yaml build "$@"
