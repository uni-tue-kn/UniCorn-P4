#!/usr/bin/env bash
# Full native browser integration with disposable state and a pinned public lab.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p "${E2E_PROJECT:-unicorn-tofino-integration}" -f docker/docker-compose.test.yaml -f docker/docker-compose.tofino.test.yaml)
export E2E_UI_PORT="${E2E_UI_PORT:-3002}"
export E2E_BASE_URL="http://127.0.0.1:$E2E_UI_PORT" E2E_TOFINO=true
export E2E_TOFINO_NETSIM_CONTAINER="${E2E_PROJECT:-unicorn-tofino-integration}-netsim-1"
workshop=.cache/tofino-rbfrt-workshop
revision=336f13b0291c913c58babf74bd7b1399d4391d13
mkdir -p test-results .cache
if [[ ! -d "$workshop/.git" ]]; then git init "$workshop"; fi
if ! git -C "$workshop" cat-file -e "$revision^{commit}" 2>/dev/null; then
  git -C "$workshop" fetch --depth 1 https://github.com/n1tr0-5urf3r/tofino-rbfrt-workshop.git "$revision"
fi
cleanup() {
  "${compose[@]}" logs --no-color > test-results/tofino-containers.log 2>&1 || true
  if [[ "${E2E_KEEP_RUNNING:-false}" == true ]]; then
    echo "Isolated native test stack kept running at $E2E_BASE_URL."
  else
    "${compose[@]}" down --volumes --remove-orphans
  fi
}
trap cleanup EXIT
if [[ "${E2E_SKIP_BUILD:-false}" != true ]]; then
  docker build -f docker/backend/Dockerfile -t unicornp4-backend:local .
  docker build -f docker/netsim/Dockerfile -t unicornp4-netsim:local .
  "${compose[@]}" build "$@"
fi
"${compose[@]}" up -d --no-build
for port in 5000 5001; do
  ready=false
  for attempt in {1..60}; do
    if "${compose[@]}" exec -T netsim python3 -c 'import sys, urllib.request; urllib.request.urlopen("http://127.0.0.1:" + sys.argv[1] + "/health", timeout=2)' "$port" > /dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then echo "Test service on port $port did not become ready"; exit 1; fi
done
curl --retry 30 --retry-delay 1 --retry-connrefused --fail --silent "$E2E_BASE_URL" > /dev/null
"${compose[@]}" exec -T backend mkdir -p /p4/workshop
git -C "$workshop" archive "$revision" tofino_workshop.p4 src | "${compose[@]}" exec -T backend tar -x -C /p4/workshop
"${compose[@]}" exec -T backend cp /fixtures/resources.p4 /p4/resources.p4
npm --prefix tests/e2e ci
npm --prefix tests/e2e test -- tofino.spec.js
