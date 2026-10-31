#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p "${E2E_PROJECT:-unicorn-integration}" -f docker/docker-compose.test.yaml)
export E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:${E2E_UI_PORT:-3001}}"
mkdir -p test-results
cleanup() {
    "${compose[@]}" logs --no-color > test-results/containers.log 2>&1 || true
    if [[ "${E2E_KEEP_RUNNING:-false}" == "true" || "${E2E_KEEP_RUNNING:-false}" == "1" ]]; then
        echo "Isolated test stack kept running at $E2E_BASE_URL for browser inspection and screenshots."
        return
    fi
    "${compose[@]}" down --volumes --remove-orphans
}
trap cleanup EXIT
if [[ "${E2E_SKIP_BUILD:-false}" == "true" ]]; then
    "${compose[@]}" up -d --no-build
else
    "${compose[@]}" up -d --build
fi
for endpoint in http://127.0.0.1:5000/health http://127.0.0.1:5001/health; do
    ready=false
    for attempt in {1..60}; do
        if "${compose[@]}" exec -T netsim python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' "$endpoint" > /dev/null 2>&1; then ready=true; break; fi
        sleep 1
    done
    if [[ "$ready" != true ]]; then echo "Service did not become ready: $endpoint"; exit 1; fi
done
curl --retry 30 --retry-delay 1 --retry-connrefused --fail --silent "$E2E_BASE_URL" > /dev/null
"${compose[@]}" exec -T backend cp /fixtures/resources.p4 /p4/resources.p4
"${compose[@]}" exec -T backend cp /fixtures/topology.json /topologies/topology.json
"${compose[@]}" exec -T netsim python3 /fixtures/start_external_switch.py
npm --prefix tests/e2e ci
(cd tests/e2e && npm test)
