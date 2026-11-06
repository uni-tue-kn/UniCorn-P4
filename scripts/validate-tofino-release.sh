#!/usr/bin/env bash
# Exercise the actual compiler, native model, and final application images.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${VERSION:?VERSION must be set}"
: "${WORKSHOP_DIR:?WORKSHOP_DIR must contain the pinned public workshop}"
compiler="${TOFINO_COMPILER_IMAGE:-unituekn/unicornp4-tofino-sdk:compiler-$VERSION}"
netsim="${TOFINO_NETSIM_IMAGE:-unituekn/unicornp4-netsim:tofino-$VERSION}"
backend="${TOFINO_BACKEND_IMAGE:-unituekn/unicornp4-backend:tofino-$VERSION}"
scope="${TOFINO_VALIDATION_SCOPE:-all}"
architecture="${TOFINO_VALIDATION_ARCHITECTURE:-all}"
[[ "$scope" == all || "$scope" == compiler || "$scope" == runtime ]] || {
    echo 'TOFINO_VALIDATION_SCOPE must be all, compiler, or runtime' >&2; exit 1;
}
[[ "$architecture" == all || "$architecture" == tofino || "$architecture" == tofino2 ]] || {
    echo 'TOFINO_VALIDATION_ARCHITECTURE must be all, tofino, or tofino2' >&2; exit 1;
}
if [[ "$scope" == compiler && "$architecture" != all ]]; then
    echo 'Compiler validation always exercises both architectures' >&2
    exit 1
fi
if [[ "$scope" == runtime && "$architecture" == all ]]; then
    echo 'Hosted runtime validation must select one architecture per runner' >&2
    exit 1
fi
mkdir -p test-results
set -o pipefail
if [[ "$scope" == all || "$scope" == compiler ]]; then
    docker run --rm --network none --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
        --security-opt no-new-privileges:true \
        -v "$PWD/tests/tofino:/tests:ro" -v "$PWD/examples/p4/tofino:/sources:ro" \
        -v "$WORKSHOP_DIR:/workshop:ro" --entrypoint bash "$compiler" \
        /tests/run_native.sh 2>&1 | tee test-results/tofino-native.log
    docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
        -v "$PWD/tests/tofino:/tests:ro" -v "$PWD/examples:/app/examples:ro" \
        --entrypoint python3 "$compiler" /tests/compiler_smoke.py
fi

[[ "$scope" != compiler ]] || exit 0

# A private namespace and fresh Docker volume avoid host ports and live state.
validation=$(mktemp -d)
name="unicorn-tofino-release-${validation##*/}"
volume="$name"
containers=()
cleanup() {
    for container in "${containers[@]}"; do
        suffix=${container##*-}
        docker logs "$container" > "test-results/tofino-release-runtime-${suffix}.log" 2>&1 || true
        docker cp "$container:/validation/run-${suffix}/." "test-results/tofino-release-runtime-${suffix}" > /dev/null 2>&1 || true
        docker rm -f "$container" > /dev/null 2>&1 || true
    done
    docker volume rm "$volume" > /dev/null 2>&1 || true
    rmdir "$validation"
}
trap cleanup EXIT
docker volume create "$volume" > /dev/null
validate_runtime() {
    local architecture=$1 suffix=$2 program=$3 container="$name-$2"
    local ingress_port=0 egress_port=1
    if [[ "$architecture" == tofino2 ]]; then ingress_port=8; egress_port=9; fi
    containers+=("$container")
    docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
        -v "$PWD/tests/tofino:/tests:ro" -v "$volume:/validation" \
        --entrypoint python3 "$compiler" -m runtime.tofino.compile /tests/structured_register.p4 \
        --output "/validation/structured-$suffix" --name "$program" --architecture "$architecture"
    if [[ "$scope" == runtime ]]; then
        # The standard hosted runner has only 14GB disk. The compiled bundle is
        # now in the volume, so discard the 5.3GB compiler before pulling the
        # finished runtime and backend images.
        docker image rm "$compiler" > /dev/null
    fi
    docker run -d --name "$container" --network none --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
        --security-opt no-new-privileges:true -v "$volume:/validation" \
        -e UNICORN_ARCHITECTURE="$architecture" -e UNICORN_BUNDLE="/validation/structured-$suffix" \
        -e UNICORN_SUFFIX="$suffix" -e UNICORN_INGRESS_PORT="$ingress_port" -e UNICORN_EGRESS_PORT="$egress_port" \
        --entrypoint bash "$netsim" -ec '
          for port in 0 1; do
            ip link add "utrelease${port}" type veth peer name "utpeer${port}"
            ip link set dev "utrelease${port}" addrgenmode none
            ip link set dev "utpeer${port}" addrgenmode none
            ip link set "utrelease${port}" up
            ip link set "utpeer${port}" up
          done
          printf '\''{"PortToIf":[{"device_port":%d,"if":"utrelease0"},{"device_port":%d,"if":"utrelease1"}]}\n'\'' \
            "$UNICORN_INGRESS_PORT" "$UNICORN_EGRESS_PORT" > "/validation/ports-${UNICORN_SUFFIX}.json"
          exec python3 -m runtime.tofino.supervisor --name "release-validation-${UNICORN_SUFFIX}" \
            --bundle "$UNICORN_BUNDLE" --architecture "$UNICORN_ARCHITECTURE" \
            --work-dir "/validation/run-${UNICORN_SUFFIX}" \
            --port-map "/validation/ports-${UNICORN_SUFFIX}.json" --bfrt-port 50052 \
            --model-port-base 18001 --status-port 17777
        ' > /dev/null
    local ready=false
    for attempt in {1..120}; do
        if docker exec "$container" python3 -c "import json; assert json.load(open('/validation/run-$suffix/state.json'))['status'] == 'ready'" > /dev/null 2>&1; then
            ready=true
            break
        fi
        if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == false ]]; then
            echo "Finished $architecture runtime model exited before becoming ready" >&2
            exit 1
        fi
        sleep 2
    done
    [[ "$ready" == true ]] || { echo "Finished $architecture runtime model did not become ready" >&2; exit 1; }
    docker run --rm --network "container:$container" --cap-drop ALL --security-opt no-new-privileges:true \
        -e PYTHONPATH=/app -e UNICORN_NATIVE_ARCHITECTURE="$architecture" -e UNICORN_NATIVE_PROGRAM="$program" \
        -v "$PWD/tests/tofino:/tests:ro" --entrypoint python3 "$backend" \
        /tests/structured_register_smoke.py
    docker logs "$container" > "test-results/tofino-release-runtime-${suffix}.log" 2>&1 || true
    docker cp "$container:/validation/run-${suffix}/." "test-results/tofino-release-runtime-${suffix}" > /dev/null 2>&1 || true
    docker rm -f "$container" > /dev/null
    local last_index=$((${#containers[@]} - 1))
    unset "containers[$last_index]"
}

if [[ "$architecture" == all || "$architecture" == tofino ]]; then
    validate_runtime tofino t1 unicorn_structured
fi
if [[ "$architecture" == all || "$architecture" == tofino2 ]]; then
    validate_runtime tofino2 t2 unicorn_structured_t2
fi
