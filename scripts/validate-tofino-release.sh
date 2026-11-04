#!/usr/bin/env bash
# Exercise the actual compiler, native model, and final application images.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VERSION:?VERSION must be set}"
: "${WORKSHOP_DIR:?WORKSHOP_DIR must contain the pinned public workshop}"
compiler="${TOFINO_COMPILER_IMAGE:-unituekn/unicornp4-compiler-tofino:$VERSION}"
netsim="${TOFINO_NETSIM_IMAGE:-unituekn/unicornp4-netsim-tofino:$VERSION}"
backend="${TOFINO_BACKEND_IMAGE:-unituekn/unicornp4-backend-tofino:$VERSION}"
mkdir -p test-results
set -o pipefail
docker run --rm --network none --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
    --security-opt no-new-privileges:true \
    -v "$PWD/tests/tofino:/tests:ro" -v "$PWD/examples/p4/tofino:/sources:ro" \
    -v "$WORKSHOP_DIR:/workshop:ro" --entrypoint bash "$compiler" \
    /tests/run_native.sh 2>&1 | tee test-results/tofino-native.log
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$PWD/tests/tofino:/tests:ro" -v "$PWD/examples:/app/examples:ro" \
    --entrypoint python3 "$compiler" /tests/compiler_smoke.py

# A private namespace and fresh Docker volume avoid host ports and live state.
validation=$(mktemp -d)
name="unicorn-tofino-release-${validation##*/}"
volume="$name"
cleanup() {
    docker logs "$name" > test-results/tofino-release-runtime.log 2>&1 || true
    docker cp "$name:/validation/run/." test-results/tofino-release-runtime > /dev/null 2>&1 || true
    docker rm -f "$name" > /dev/null 2>&1 || true
    docker volume rm "$volume" > /dev/null 2>&1 || true
    rmdir "$validation"
}
trap cleanup EXIT
docker volume create "$volume" > /dev/null
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$PWD/tests/tofino:/tests:ro" -v "$volume:/validation" \
    --entrypoint python3 "$compiler" -m runtime.tofino.compile /tests/structured_register.p4 \
    --output /validation/structured --name unicorn_structured
docker run -d --name "$name" --network none --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
    --security-opt no-new-privileges:true -v "$volume:/validation" \
    --entrypoint bash "$netsim" -ec '
      for port in 0 1; do
        ip link add "utrelease${port}" type veth peer name "utpeer${port}"
        ip link set dev "utrelease${port}" addrgenmode none
        ip link set dev "utpeer${port}" addrgenmode none
        ip link set "utrelease${port}" up
        ip link set "utpeer${port}" up
      done
      printf "%s\n" '\''{"PortToIf":[{"device_port":0,"if":"utrelease0"},{"device_port":1,"if":"utrelease1"}]}'\'' > /validation/ports.json
      exec python3 -m runtime.tofino.supervisor --name release-validation \
        --bundle /validation/structured --work-dir /validation/run \
        --port-map /validation/ports.json --bfrt-port 50052 \
        --model-port-base 18001 --status-port 17777
    ' > /dev/null
ready=false
for attempt in {1..120}; do
    if docker exec "$name" python3 -c 'import json; assert json.load(open("/validation/run/state.json"))["status"] == "ready"' > /dev/null 2>&1; then
        ready=true
        break
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" == false ]]; then
        echo 'Finished runtime model exited before becoming ready' >&2
        exit 1
    fi
    sleep 2
done
[[ "$ready" == true ]] || { echo 'Finished runtime model did not become ready' >&2; exit 1; }
docker run --rm --network "container:$name" --cap-drop ALL --security-opt no-new-privileges:true \
    -e PYTHONPATH=/app -v "$PWD/tests/tofino:/tests:ro" --entrypoint python3 "$backend" \
    /tests/structured_register_smoke.py
