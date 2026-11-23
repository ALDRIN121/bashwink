#!/usr/bin/env bash
#
# Runtime-health fixture: the evidence plugin must be *proven* to load, and a run that fails
# to record must not look successful.
#
# This exists because Phase 1's plugin staging could fail silently. The probe behind the fix
# ran the real OpenCode v2.3.2 binary against three broken plugins:
#
#   - an entry that throws at import  -> exit 0, empty log, one WARN in OpenCode's own log
#   - a directory with no entry       -> exit 0, empty log, *no log line at all*
#   - a module with the wrong export  -> exit 0, empty log
#
# Each case below reproduces one of those against the real binary, through the wrapper, and
# asserts the wrapper now refuses to call it success. The plugin package is placed in a
# throwaway install tree so the real `packages/bw-evidence` is never modified.
#
# Usage: ./fixtures/runtime-health/run.sh
# Requires an OpenCode runtime (BASHWINK_OPENCODE_BIN or `opencode` on PATH), like BW-014.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2
REPO="$PWD"
BUN="${BUN:-bun}"
PORT="${PORT:-8129}"
MOCK="fixtures/mock_provider.py"
pass=0
fail=0
skip=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail + 1)); }
note() { printf 'SKIP  %s\n' "$1"; skip=$((skip + 1)); }

if [ -z "${BASHWINK_OPENCODE_BIN:-}" ] && ! command -v opencode >/dev/null 2>&1; then
  note "no OpenCode runtime available; this fixture needs the real binary"
  echo
  echo "passed: $pass  failed: $fail  skipped: $skip"
  exit 0
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; kill "${mock_pid:-}" 2>/dev/null; }
trap cleanup EXIT

export BASHWINK_HOME="$WORK/home"
mkdir -p "$BASHWINK_HOME/data" "$BASHWINK_HOME/config" "$WORK/project"
echo '{"$schema":"https://opencode.ai/config.json"}' > "$WORK/project/opencode.json"
cp fixtures/opencode.json "$WORK/project/opencode.json"
sed -i.bak "s/8117/$PORT/" "$WORK/project/opencode.json" && rm -f "$WORK/project/opencode.json.bak"

python3 "$MOCK" --port "$PORT" --scenario ok --log "$WORK/mock.jsonl" > "$WORK/mock.out" 2>&1 &
mock_pid=$!
for _ in $(seq 1 50); do
  python3 - "$PORT" <<'PY' 2>/dev/null && break
import socket,sys
s=socket.socket(); s.settimeout(.2)
try: s.connect(("127.0.0.1",int(sys.argv[1])))
except OSError: sys.exit(1)
sys.exit(0)
PY
  sleep 0.2
done

echo "=== 0. workspace + fresh install tree helper ==="
"$BUN" run packages/bw-cli/src/bin.ts trust "$WORK/project" --by fixture >/dev/null 2>&1
# Build an install tree whose REPO_ROOT is $WORK/<name> rather than this repository, so the
# broken plugin is the one the wrapper stages. The CLI code itself is copied unchanged.
make_tree() {
  local name="$1" variant="$2"
  local tree="$WORK/$name"
  mkdir -p "$tree/packages/bw-cli" "$tree/packages/bw-cli/node_modules/@bashwink"
  cp -R packages/bw-cli/src "$tree/packages/bw-cli/src"
  cp packages/bw-cli/package.json packages/bw-cli/tsconfig.json "$tree/packages/bw-cli/"
  ln -s "$REPO/packages/bw-evidence" "$tree/packages/bw-cli/node_modules/@bashwink/evidence"
  ln -s "$REPO/node_modules" "$tree/node_modules"
  case "$variant" in
    healthy)
      ln -s "$REPO/packages/bw-evidence" "$tree/packages/bw-evidence" ;;
    import-throws)
      cp -R "$REPO/packages/bw-evidence" "$tree/packages/bw-evidence"
      printf 'throw new Error("runtime-health fixture: import boom")\n' \
        > "$tree/packages/bw-evidence/src/index.ts" ;;
    no-entry)
      cp -R "$REPO/packages/bw-evidence" "$tree/packages/bw-evidence"
      python3 - "$tree/packages/bw-evidence/package.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data.pop("exports", None)
json.dump(data, open(path, "w"), indent=2)
PY
      ;;
    *)
      echo "unknown variant $variant" >&2; return 2 ;;
  esac
  printf '%s\n' "$tree"
}

run_agent() {
  local tree="$1" out="$2" err="$3"
  ( cd "$WORK/project" && \
    "$BUN" run "$tree/packages/bw-cli/src/bin.ts" \
      run --standalone --model bashwink-mock/mock-tool-model "List the files" \
      > "$out" 2> "$err" )
  printf '%s' "$?"
}

latest_record() {
  python3 - "$BASHWINK_HOME/data/runs" <<'PY'
import json, os, sys
directory = sys.argv[1]
try:
    files = [os.path.join(directory, f) for f in os.listdir(directory) if f.endswith(".json")]
except FileNotFoundError:
    files = []
files.sort(key=os.path.getmtime)
print(open(files[-1]).read() if files else "{}")
PY
}

record_field() {
  latest_record | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"
}


echo
echo "=== 1. a healthy plugin boots, and the run says evidence=recorded ==="
TREE=$(make_tree healthy healthy)
rc=$(run_agent "$TREE" "$WORK/ok.out" "$WORK/ok.err")
echo "      wrapper exit code: $rc"
if [ "$rc" -eq 0 ]; then ok "healthy run exits 0"; else bad "healthy run exited $rc"; sed 's/^/      /' "$WORK/ok.err"; fi
if grep -q '"phase":"boot"' "$BASHWINK_HOME/data/evidence/evidence.jsonl" 2>/dev/null; then
  ok "the plugin wrote a boot entry into the hash-chained log"
else
  bad "no boot entry: the plugin's initialisation is not evidenced"
fi
if [ "$(record_field evidence)" = "recorded" ]; then
  ok "run record reports evidence=recorded"
else
  bad "run record reports evidence=$(record_field evidence), expected recorded"
fi
if [ "$(record_field expected)" = "True" ]; then
  ok "the run expected evidence (so absence would be detectable)"
else
  bad "run record does not expect evidence"
fi

echo
echo "=== 2. a plugin that throws at import cannot look like a successful run ==="
TREE=$(make_tree throwing import-throws)
rc=$(run_agent "$TREE" "$WORK/boom.out" "$WORK/boom.err")
echo "      wrapper exit code: $rc"
if [ "$rc" -eq 3 ]; then
  ok "wrapper exits 3 instead of passing the child's 0 through"
else
  bad "wrapper exited $rc; a broken plugin was reported as success"
fi
if grep -q "evidence plugin did not initialise" "$WORK/boom.err"; then
  ok "stderr names the failure"
else
  bad "stderr does not name the failure"
fi
if grep -q "NOT verified" "$WORK/boom.err"; then
  ok "stderr states that the run is not verified"
else
  bad "stderr does not state the consequence"
fi
if [ "$(record_field evidence)" = "missing" ]; then
  ok "the run record persists evidence=missing"
else
  bad "run record reports evidence=$(record_field evidence), expected missing"
fi
"$BUN" run packages/bw-cli/src/bin.ts evidence status > "$WORK/status.out" 2>&1
status_rc=$?
if [ "$status_rc" -eq 3 ] && grep -q "NOT verified" "$WORK/status.out"; then
  ok "evidence status exits 3 and lists the unverified run"
else
  bad "evidence status exited $status_rc and did not report the unverified run"
  sed 's/^/      /' "$WORK/status.out"
fi
"$BUN" run packages/bw-cli/src/bin.ts doctor > "$WORK/doctor.out" 2>&1 || true
if grep -q "✗ Last recorded run" "$WORK/doctor.out"; then
  ok "doctor fails the last-run check with the runtime log path"
else
  bad "doctor did not surface the failed run"
  sed 's/^/      /' "$WORK/doctor.out"
fi

echo
echo "=== 3. a plugin directory the runtime would drop is refused before the runtime starts ==="
TREE=$(make_tree noentry no-entry)
before_lines=$(wc -l < "$BASHWINK_HOME/data/evidence/evidence.jsonl" 2>/dev/null || true)
before_lines=${before_lines:-0}
rc=$(run_agent "$TREE" "$WORK/noentry.out" "$WORK/noentry.err")
after_lines=$(wc -l < "$BASHWINK_HOME/data/evidence/evidence.jsonl" 2>/dev/null || true)
after_lines=${after_lines:-0}
echo "      wrapper exit code: $rc"
if [ "$rc" -eq 3 ]; then ok "staging refuses an unresolvable plugin"; else bad "staging accepted an unresolvable plugin (exit $rc)"; fi
if grep -q "no resolvable server entry" "$WORK/noentry.err"; then
  ok "the diagnostic explains what resolution failed"
else
  bad "the diagnostic does not explain the resolution failure"
  sed 's/^/      /' "$WORK/noentry.err"
fi
if [ "$before_lines" -eq "$after_lines" ]; then
  ok "the runtime never started, so no unverifiable work happened"
else
  bad "the runtime ran despite an unresolvable plugin ($before_lines -> $after_lines entries)"
fi

echo
echo "=== 4. explicit optional mode is allowed, and is recorded as unverified ==="
TREE=$(make_tree optional import-throws)
rc=$(BASHWINK_EVIDENCE=off run_agent "$TREE" "$WORK/off.out" "$WORK/off.err")
echo "      wrapper exit code: $rc"
if [ "$rc" -eq 0 ]; then ok "BASHWINK_EVIDENCE=off returns the child's exit code"; else bad "optional mode exited $rc"; fi
if grep -q "evidence collection is OFF" "$WORK/off.err"; then
  ok "the wrapper announces that the run is unverified"
else
  bad "optional mode ran without a warning"
  sed 's/^/      /' "$WORK/off.err"
fi
if [ "$(record_field evidence)" = "disabled" ]; then
  ok "the run record distinguishes disabled from missing"
else
  bad "run record reports evidence=$(record_field evidence), expected disabled"
fi

echo
echo "=== 5. the evidence chain is still intact after all of the above ==="
if [ -f "$BASHWINK_HOME/data/evidence/evidence.jsonl" ]; then
  if "$BUN" run packages/bw-evidence/src/cli.ts verify "$BASHWINK_HOME/data/evidence/evidence.jsonl" > "$WORK/verify.out" 2>&1; then
    ok "hash chain verifies"
  else
    bad "hash chain does not verify"
    sed 's/^/      /' "$WORK/verify.out"
  fi
fi

echo
echo "passed: $pass  failed: $fail  skipped: $skip"
[ "$fail" -eq 0 ] || exit 1
exit 0
