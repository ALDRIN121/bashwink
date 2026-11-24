#!/usr/bin/env bash
# Local exact-candidate verification. This is NOT hosted CI: it runs on one machine, and the
# report says so. Every step's real exit code and log are kept.
#
#   scripts/verify_candidate.sh <candidate-sha> <archive-dir> <out-dir> [<input-cache>]
#
# <archive-dir> holds the release .tar.gz and SHA256SUMS built from <candidate-sha>.
# <input-cache> is the builder's input cache (default ~/.cache/bashwink-release-inputs); the
# VM boundary fixtures reuse its pinned Alpine and runtime inputs. PYTHON may name a Python
# with PySquashfsImage for the relay fixture. Needs about 6 GiB of free disk.
set -uo pipefail

SHA="${1:?candidate sha}"; ARCHIVE="${2:?archive dir}"; OUT="${3:?output dir}"
CACHE="${4:-$HOME/.cache/bashwink-release-inputs}"; PYTHON="${PYTHON:-python3}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\texit\tlog\n' > "$SUMMARY"

# HEAD may be the candidate or a later commit that changes only documentation and this
# harness. Anything else means the code under test is not the declared candidate.
git merge-base --is-ancestor "$SHA" HEAD || { echo "HEAD does not descend from $SHA" >&2; exit 2; }
changed="$(git diff --name-only "$SHA" HEAD | grep -v -E '^(docs/bashwink/|README\.md$|scripts/verify_candidate\.sh$|fixtures/release/)' || true)"
[ -z "$changed" ] || { echo "code differs from the candidate:" >&2; echo "$changed" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 2; }
echo "candidate $SHA; verified tree $(git rev-parse HEAD); files changed since candidate: $(git diff --name-only "$SHA" HEAD | wc -l)"
command -v bun >/dev/null && [ "$(bun --version)" = "1.4.4" ] || { echo "pinned Bun 1.4.4 required" >&2; exit 2; }

step() {
  local name="$1"; shift
  local log="$OUT/$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '-').log"
  { echo "# $name"; echo "# command: $*"; echo "# started: $(date -u +%FT%TZ)"; } > "$log"
  "$@" >> "$log" 2>&1
  local code=$?
  echo "# exit: $code" >> "$log"
  printf '%s\t%s\t%s\n' "$name" "$code" "$(basename "$log")" | tee -a "$SUMMARY"
}

free_kib=$(df -k "${TMPDIR:-/tmp}" | awk 'NR==2 {print $4}')
[ "$free_kib" -gt 6000000 ] || { echo "need about 6 GiB free; have $((free_kib / 1024)) MiB" >&2; exit 2; }
TMP_X="$(mktemp -d)"
trap 'rm -rf "$TMP_X"' EXIT
tar -xzf "$ARCHIVE"/*.tar.gz -C "$TMP_X"
# Pinned inputs under the names the VM boundary fixtures expect.
FIX="$TMP_X/fixture-inputs"; mkdir "$FIX"
ln -s "$CACHE/alpine__vmlinuz-virt" "$FIX/vmlinuz"; ln -s "$CACHE/alpine__minirootfs" "$FIX/root.tar.gz"
ln -s "$CACHE/alpine__initramfs-virt" "$FIX/initramfs-official"; ln -s "$CACHE/alpine__modloop-virt" "$FIX/modloop-virt"
for n in libgcc libstdc++ ncurses-terminfo-base socat readline libncursesw; do ln -s "$CACHE/alpine__$n.apk" "$FIX/$n.apk"; done
tar -xzOf "$CACHE/guest__opencode.tgz" package/bin/opencode > "$FIX/opencode"; chmod +x "$FIX/opencode"
tar -xzOf "$CACHE/guest__bun.tgz" package/bin/bun > "$FIX/bun"; chmod +x "$FIX/bun"
RELEASE_DIR="$(echo "$TMP_X"/bashwink-*-macos-arm64)"
export BASHWINK_OPENCODE_BIN="$RELEASE_DIR/libexec/opencode"

step "unit and integration tests (bun test packages)" bun test packages
step "guest project program tests" bun test fixtures/native-offline/vm-project-guest.test.ts
step "typecheck" bun run typecheck
step "oxlint" bun run lint
step "format check" bun run format
step "lint negative controls" bun run lint:gate
step "documentation audit" python3 scripts/verify_bashwink_docs.py
step "register summary check" python3 scripts/generate_status_summary.py --check
step "license scope" python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json
step "native gate tests" python3 scripts/test_native_release_gate.py
step "alpha gate tests" python3 scripts/test_alpha_release_gate.py
step "runtime health fixture (pinned runtime)" ./fixtures/runtime-health/run.sh
step "tool lifecycle fixture (pinned runtime)" ./fixtures/tool-lifecycle/run.sh
step "contract fixture (pinned runtime)" ./fixtures/contract/run.sh
step "idempotent resume fixture (pinned runtime)" ./fixtures/idempotent-resume/run.sh
step "development-build interactive entry PTY" ./fixtures/interactive-entry/run.sh
step "VM boundary fixture: forced stop, owner SIGKILL, launcher SIGKILL, SIGINT, timer" "$PYTHON" fixtures/native-offline/vm-boundary.py "$FIX"
step "VM boundary fixture: real OpenCode TUI in the guest" "$PYTHON" fixtures/native-offline/vm-boundary.py "$FIX" --opencode-inputs "$FIX"
step "VM boundary fixture: project sessions, relay, apply recovery (fixture image)" "$PYTHON" fixtures/native-offline/vm-boundary.py "$FIX" --project-cli --opencode-inputs "$FIX" --relay-inputs "$FIX"
step "release: first-run, install, approval, TUI, uninstall (PTY)" python3 fixtures/release/release_first_run.py "$ARCHIVE" --out "$OUT/first-run.json"
step "release: unrestricted mode (PTY)" python3 fixtures/release/release_unrestricted.py "$ARCHIVE" --out "$OUT/unrestricted.json"
step "release image: project acceptance with SIGKILL, recovery, apply, verify (PTY)" python3 fixtures/release/vm-acceptance.py "$RELEASE_DIR"
step "release image: in-guest egress probe" python3 fixtures/release/vm_egress_probe.py "$RELEASE_DIR"
step "release gate validator (expected to refuse)" python3 scripts/verify_alpha_release.py --revision "$SHA"

echo; column -t -s $'\t' "$SUMMARY"
