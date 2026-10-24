#!/usr/bin/env bash
# Runs every test suite in order and prints one summary at the end.
#
# The suites are ordered cheapest first, so a broken unit test fails in seconds
# rather than after a browser has been launched.
#
#   ./scripts/run-all-tests.sh                 everything except the soak test
#   SUITE=unit ./scripts/run-all-tests.sh      one suite only
#   SOAK_MINUTES=30 ./scripts/run-all-tests.sh add the soak test to the run
#
# --test-force-exit is on every suite. These tests spawn ffmpeg, Xvfb and
# Chromium, and one unref'd timer left behind would otherwise hold the runner
# open forever after the tests themselves had passed.
#
# Exit code is non-zero if anything failed.

set -uo pipefail
cd "$(dirname "$0")/.."

SUITE="${SUITE:-all}"
RUN_SOAK="${SOAK_MINUTES:-}"

declare -a NAMES=()
declare -a RESULTS=()
declare -a DETAILS=()

run_suite() {
  local name="$1"
  shift
  echo
  echo "=============================================================="
  echo "  $name"
  echo "=============================================================="
  local out
  local code=0
  out=$("$@" 2>&1) || code=$?
  echo "$out" | tail -n 40
  local pass fail skipped
  pass=$(echo "$out" | grep -E '^# pass ' | tail -1 | awk '{print $3}')
  fail=$(echo "$out" | grep -E '^# fail ' | tail -1 | awk '{print $3}')
  skipped=$(echo "$out" | grep -E '^# skipped ' | tail -1 | awk '{print $3}')
  NAMES+=("$name")
  if [ "$code" -eq 0 ]; then
    RESULTS+=("PASS")
  else
    RESULTS+=("FAIL")
  fi
  DETAILS+=("passed ${pass:-0}, failed ${fail:-0}, skipped ${skipped:-0}")
  return "$code"
}

OVERALL=0

if [ "$SUITE" = "all" ] || [ "$SUITE" = "unit" ]; then
  run_suite "unit" node --test --test-force-exit test/unit/ || OVERALL=1
fi

if [ "$SUITE" = "all" ] || [ "$SUITE" = "integration" ]; then
  run_suite "integration" node --test --test-force-exit test/integration/ || OVERALL=1
fi

if [ "$SUITE" = "all" ] || [ "$SUITE" = "e2e" ]; then
  run_suite "e2e" node --test --test-force-exit test/e2e/ || OVERALL=1
fi

if [ "$SUITE" = "all" ] || [ "$SUITE" = "chaos" ]; then
  run_suite "chaos" node --test --test-force-exit test/chaos/ || OVERALL=1
fi

if [ "$SUITE" = "soak" ] || [ -n "$RUN_SOAK" ]; then
  SOAK_MINUTES="${SOAK_MINUTES:-30}"
  export SOAK_MINUTES
  run_suite "soak (${SOAK_MINUTES} minutes)" node --test --test-force-exit test/soak.test.js || OVERALL=1
fi

echo
echo "=============================================================="
echo "  summary"
echo "=============================================================="
for i in "${!NAMES[@]}"; do
  printf '  %-28s %-6s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DETAILS[$i]}"
done
echo

if [ "$OVERALL" -ne 0 ]; then
  echo "One or more suites failed."
else
  echo "All suites passed."
fi
exit "$OVERALL"
