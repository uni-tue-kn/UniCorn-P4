#!/usr/bin/env bash
# Run inside the official compiler image with NET_ADMIN/NET_RAW and read-only
# /tests (this directory), /sources (examples), optional /workshop source mount.
set -Eeuo pipefail
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="${SDE_INSTALL}/lib/python3.10/site-packages:${SDE_INSTALL}/lib/python3.10/site-packages/tofino:${PYTHONPATH:-}"
export LD_LIBRARY_PATH="${SDE_INSTALL}/lib:${LD_LIBRARY_PATH:-}"
TEST_ROOT=$(mktemp -d /tmp/unicorn-tofino-native.XXXXXX)
SUPERVISOR_PID=
stop_supervisor() {
  if [[ -n "${SUPERVISOR_PID}" ]]; then
    kill -TERM "${SUPERVISOR_PID}" 2>/dev/null || true
    wait "${SUPERVISOR_PID}" 2>/dev/null || true
  fi
}
cleanup() {
  stop_supervisor
  for port in 0 1; do
    ip link del "utmodel${port}" 2>/dev/null || true
  done
  rm -rf "${TEST_ROOT}"
}
failure() {
  local result=$?
  for log in "${TEST_ROOT}"/*-run/model.log "${TEST_ROOT}"/*-run/switchd.log; do
    if [[ -f "${log}" ]]; then
      printf 'Native diagnostics: %s\n' "${log}" >&2
      tail -n 80 "${log}" >&2
    fi
  done
  return "${result}"
}
trap failure ERR
trap cleanup EXIT
for port in 0 1; do
  ip link add "utmodel${port}" type veth peer name "uttest${port}"
  ip link set dev "utmodel${port}" addrgenmode none
  ip link set dev "uttest${port}" addrgenmode none
  ip link set "utmodel${port}" up
  ip link set "uttest${port}" up
done
printf '%s\n' '{"PortToIf":[{"device_port":0,"if":"utmodel0"},{"device_port":1,"if":"utmodel1"}]}' > "${TEST_ROOT}/ports.json"
run_program() {
  local source_path=$1 program_name=$2 test_script=$3
  python3 -m runtime.tofino.compile "${source_path}" --output "${TEST_ROOT}/${program_name}" --name "${program_name}"
  python3 -m runtime.tofino.supervisor --name "${program_name}" --bundle "${TEST_ROOT}/${program_name}" \
    --work-dir "${TEST_ROOT}/${program_name}-run" --port-map "${TEST_ROOT}/ports.json" \
    --bfrt-port 50052 --model-port-base 18001 --status-port 17777 &
  SUPERVISOR_PID=$!
  python3 - "${TEST_ROOT}/${program_name}-run/state.json" <<'PY'
import json, pathlib, sys, time
state = pathlib.Path(sys.argv[1])
for _ in range(1200):
    if state.exists():
        value = json.loads(state.read_text())
        if value['status'] == 'ready':
            break
        if value['status'] == 'error':
            raise SystemExit(value)
    time.sleep(0.2)
else:
    raise SystemExit('Native model initialization timed out')
PY
  python3 "/tests/${test_script}"
  stop_supervisor
  SUPERVISOR_PID=
}
run_program /sources/resources.p4 unicorn_resources native_smoke.py
if [[ -f /workshop/tofino_workshop.p4 ]]; then
  run_program /workshop/tofino_workshop.p4 tofino_workshop workshop_smoke.py
fi
run_program /tests/structured_register.p4 unicorn_structured structured_register_sdk_smoke.py
printf 'PASS: native compiler/model/driver lifecycle smoke\n'
