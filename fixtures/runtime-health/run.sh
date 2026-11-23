#!/usr/bin/env bash
# Exercise execution readiness against the pinned OpenCode binary and an owned loopback model.
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO="$PWD"
BUN="${BUN:-bun}"
RUNTIME="${BASHWINK_OPENCODE_BIN:-$(command -v opencode || true)}"
if [ -z "$RUNTIME" ]; then
  echo "SKIP  no OpenCode binary available; readiness requires the real runtime"
  exit 0
fi

WORK="$(mktemp -d)"
cleanup() {
  touch "$WORK/release-provider" "$WORK/release-setup" 2>/dev/null || true
  for pid in "${agent_pid:-}" "${managed_pid:-}" "${mock_pid:-}"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

export BASHWINK_HOME="$WORK/home"
export BASHWINK_OPENCODE_BIN="$RUNTIME"
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
mkdir -p "$BASHWINK_HOME" "$WORK/project" "$WORK/user"
export HOME="$WORK/user"
touch "$WORK/release-provider" "$WORK/mock.jsonl"
python3 fixtures/mock_provider.py --port 0 --scenario ok --log "$WORK/mock.jsonl" \
  --response-gate "$WORK/release-provider" > "$WORK/mock.out" 2>&1 &
mock_pid=$!

wait_for() {
  for _ in $(seq 1 160); do
    if "$@"; then return 0; fi
    sleep 0.05
  done
  return 1
}
mock_ready() { grep -q '^\[mock\] listening' "$WORK/mock.out"; }
wait_for mock_ready
port=$(sed -n 's/^\[mock\] listening on http:\/\/127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' "$WORK/mock.out")
sed "s/127.0.0.1:8117/127.0.0.1:$port/" fixtures/opencode.json > "$WORK/project/opencode.json"
"$BUN" run packages/bw-cli/src/bin.ts trust "$WORK/project" --by fixture >/dev/null

make_tree() {
  local variant="$1" tree="$WORK/$1"
  mkdir -p "$tree/packages"
  mkdir -p "$tree/packages/bw-cli/node_modules/@bashwink"
  ln -s "$REPO/packages/bw-evidence" "$tree/packages/bw-cli/node_modules/@bashwink/evidence"
  cp -R "$REPO/packages/bw-cli/src" "$tree/packages/bw-cli/src"
  cp "$REPO/packages/bw-cli/package.json" "$tree/packages/bw-cli/"
  ln -s "$REPO/node_modules" "$tree/node_modules"
  mkdir -p "$tree/packages/bw-evidence"
  cp -R "$REPO/packages/bw-evidence/src" "$tree/packages/bw-evidence/src"
  cp "$REPO/packages/bw-evidence/package.json" "$tree/packages/bw-evidence/"

  local entry="$tree/packages/bw-evidence/src/index.ts"
  case "$variant" in
    healthy) ;;
    missing)
      rm "$entry" ;;
    import-error)
      printf '%s\n' 'throw new Error("readiness fixture: import boom")' > "$entry" ;;
    wrong-export)
      printf '%s\n' 'export default { wrong: true }' > "$entry" ;;
    setup-error)
      printf '%s\n' 'export default { id: "bashwink-evidence", setup() { throw new Error("readiness fixture: setup boom") } }' > "$entry" ;;
    delayed|crash)
      mv "$entry" "${entry%/*}/original.ts"
      cat > "$entry" <<'TS'
import { existsSync, writeFileSync } from "node:fs"
import original from "./original.js"

export default {
  ...original,
  async setup(ctx: Parameters<typeof original.setup>[0]) {
    const fixture = process.env.BW_FIXTURE_STATE!
    if (process.env.BW_FIXTURE_VARIANT === "delayed") {
      writeFileSync(`${fixture}/setup-started`, "")
      while (!existsSync(`${fixture}/release-setup`)) await Bun.sleep(25)
    }
    const cleanup = await original.setup(ctx)
    if (process.env.BW_FIXTURE_VARIANT === "crash") {
      const timer = setInterval(() => {
        if (existsSync(`${fixture}/request-crash`)) process.exit(86)
      }, 25)
      timer.unref()
    }
    return cleanup
  },
}
TS
      ;;
    *) return 2 ;;
  esac
  printf '%s\n' "$tree"
}

# Prevent inherit of a real run deadline or an OpenCode connection from the developer's shell.
unset BASHWINK_TIMEOUT_MS OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD
run_agent() {
  local variant="$1"
  shift
  cd "$WORK/project" || exit 2
  exec env BW_FIXTURE_STATE="$WORK" BW_FIXTURE_VARIANT="$variant" "$BUN" run \
    "$WORK/$variant/packages/bw-cli/src/bin.ts" run --standalone --auto \
    --model bashwink-mock/mock-tool-model "$@" "Run the harmless fixture tool"
}

calls() { wc -l < "$WORK/mock.jsonl" | tr -d ' '; }
tool_calls() { grep -c '"phase":"before"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" || true; }
latest_outcome() {
  python3 - "$BASHWINK_HOME/data/runs" <<'PY'
import json, pathlib, sys
files = sorted(pathlib.Path(sys.argv[1]).glob("*.json"), key=lambda p: p.stat().st_mtime_ns)
print(json.loads(files[-1].read_text())["execution"]["outcome"])
PY
}

for variant in healthy missing import-error wrong-export setup-error delayed crash; do
  make_tree "$variant" >/dev/null
done

# Register a genuine managed service under the same XDG roots. The wrapper must neither
# stop it nor use it when the owned server cannot activate policy.
XDG_CONFIG_HOME="$WORK" XDG_DATA_HOME="$BASHWINK_HOME" XDG_STATE_HOME="$BASHWINK_HOME" \
  XDG_CACHE_HOME="$BASHWINK_HOME" OPENCODE_CONFIG_DIR="$BASHWINK_HOME" \
  "$RUNTIME" serve --service --port 0 > "$WORK/managed.out" 2>&1 &
managed_pid=$!
managed_ready() {
  python3 - "$BASHWINK_HOME/opencode/service.json" "$managed_pid" <<'PY'
import json, pathlib, sys
try:
    assert json.loads(pathlib.Path(sys.argv[1]).read_text())["pid"] == int(sys.argv[2])
except (OSError, KeyError, ValueError, AssertionError):
    sys.exit(1)
PY
}
if ! wait_for managed_ready; then
  cat "$WORK/managed.out" >&2
  echo "FAIL  managed service failed to register" >&2
  exit 1
fi

(run_agent healthy) > "$WORK/healthy.out" 2> "$WORK/healthy.err" || {
  cat "$WORK/healthy.err" >&2
  exit 1
}
test "$(tool_calls)" = 1
grep -q 'bw-mock-ok' "$WORK/healthy.out"
managed_ready
kill -0 "$managed_pid"
echo "PASS  positive control dispatched a real shell through the owned server; unrelated managed server stayed registered"

mkdir -p "$WORK/other"
foreign=$(python3 - "$BASHWINK_HOME/opencode/service.json" "$WORK/other" <<'PY_SESSION'
import base64, json, pathlib, sys, urllib.request
info = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert info["url"].startswith("http://127.0.0.1:")
password = base64.b64encode(("opencode:" + info["password"]).encode()).decode()
request = urllib.request.Request(info["url"] + "/api/session", method="POST", headers={
    "authorization": "Basic " + password, "content-type": "application/json",
}, data=json.dumps({"title": "Other workspace fixture", "location": {"directory": str(pathlib.Path(sys.argv[2]).resolve())}}).encode())
with urllib.request.urlopen(request, timeout=5) as response:
    created = json.load(response)["data"]
assert created["location"]["directory"] == str(pathlib.Path(sys.argv[2]).resolve())
print(created["id"])
PY_SESSION
)
before=$(calls)
rc=0
(run_agent healthy --session "$foreign") > "$WORK/foreign.out" 2> "$WORK/foreign.err" || rc=$?
test "$rc" -ne 0
test "$(calls)" = "$before"
echo "PASS  a saved session in another workspace received no prompt or tool call"

# The successful run intentionally left concrete, valid boot evidence in the same home.
# Every negative case must still refuse admission, rather than reusing that evidence.
for variant in missing import-error wrong-export setup-error; do
  before=$(calls)
  tools_before=$(tool_calls)
  rc=0
  (run_agent "$variant") > "$WORK/$variant.out" 2> "$WORK/$variant.err" || rc=$?
  if [ "$rc" -ne 3 ] || [ "$(calls)" != "$before" ] || [ "$(tool_calls)" != "$tools_before" ]; then
    cat "$WORK/$variant.err" >&2
    echo "FAIL  $variant exit=$rc provider calls $before -> $(calls)" >&2
    exit 1
  fi
  grep -Eq 'required policy plugin .* (stage|activate|ready)|required policy plugin cannot be staged' "$WORK/$variant.err"
  if [ "$variant" != missing ]; then test "$(latest_outcome)" = readiness-failed; fi
  echo "PASS  $variant refused with exit 3 and no provider request or tool dispatch despite prior boot evidence"
done
managed_ready
kill -0 "$managed_pid"

before=$(calls)
rc=0
(BASHWINK_EVIDENCE=off run_agent healthy) > "$WORK/off.out" 2> "$WORK/off.err" || rc=$?
test "$rc" = 3
test "$(calls)" = "$before"
echo "PASS  readiness cannot be disabled"

(run_agent delayed) > "$WORK/cancel.out" 2> "$WORK/cancel.err" &
agent_pid=$!
wait_for test -f "$WORK/setup-started"
kill -TERM "$agent_pid"
rc=0
wait "$agent_pid" || rc=$?
agent_pid=""
test "$rc" = 130
test "$(latest_outcome)" = cancelled
test "$(calls)" = "$before"
test -z "$(find "$BASHWINK_HOME/data/scopes" -name '.readiness-*' -type d -print)"
rm "$WORK/setup-started"
echo "PASS  cancellation during readiness launched no client and cleaned up the lease"

(run_agent delayed) > "$WORK/delayed.out" 2> "$WORK/delayed.err" &
agent_pid=$!
wait_for test -f "$WORK/setup-started"
sleep 0.2
test "$(calls)" = "$before"
touch "$WORK/release-setup"
wait "$agent_pid" || { cat "$WORK/delayed.err" >&2; exit 1; }
agent_pid=""
test "$(calls)" -gt "$before"
grep -q 'bw-mock-ok' "$WORK/delayed.out"
echo "PASS  delayed activation admitted no provider request until the hooks registered"

before=$(calls)
tools_before=$(tool_calls)
rm "$WORK/release-provider"
(run_agent crash) > "$WORK/crash.out" 2> "$WORK/crash.err" &
agent_pid=$!
requested() { [ "$(calls)" -gt "$before" ]; }
wait_for requested
touch "$WORK/request-crash"
rc=0
wait "$agent_pid" || rc=$?
agent_pid=""
touch "$WORK/release-provider"
test "$rc" = 3
test "$(latest_outcome)" = readiness-failed
test "$(tool_calls)" = "$tools_before"
grep -q 'private OpenCode server stopped' "$WORK/crash.err"
echo "PASS  server crash after admission closed the client without dispatching a tool"

"$BUN" run packages/bw-evidence/src/cli.ts verify "$BASHWINK_HOME/data/evidence/evidence.jsonl"
echo "PASS  evidence chain verifies across readiness failures"
