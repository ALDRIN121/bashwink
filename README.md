# Bashwink

An evidence-first coding agent: it records what it actually did — commands, exit codes and
outputs, hash-chained and independently verifiable — instead of reporting what it claims to
have done.

**Status:** Phase 0 and Phase 1 are complete and gate-passed with hosted CI evidence. Phase 2
is in progress — BW-055 (TaskContract / IntentLock data plane) is implemented; the Phase 2 gate
has not been evaluated. See `docs/bashwink/IMPLEMENTATION_STATUS.md` and
`docs/bashwink/NEXT_STEPS.md`.

## Layout

```
bashwink/
  packages/bw-evidence/     OpenCode plugin + recorder: append-only, hash-chained evidence log
  packages/bw-cli/          `bashwink` wrapper, plan/contract/evidence commands, doctor
  fixtures/                 Deterministic Git fixtures, real-runtime proofs, local mock provider
  scripts/                  Documentation verifier, upstream sync report, release gates
  docs/bashwink/            Requirements, ADRs, phase plan, status and evidence registers
  .github/workflows/        CI: verify (lint, docs, tests, fixtures, runtime health)
```

The pinned OpenCode foundation is **not** vendored here. It lives beside this repository at
`~/Developer/bashwink-upstream/opencode` and is consumed by exact version.

## Quick start

```bash
bun install
bun run test                          # full suite (pinned Bun 1.4.4)
./fixtures/create_fixtures.sh         # build the deterministic Git fixtures
./fixtures/reset.sh --check           # prove they are at baseline

bun run packages/bw-cli/src/bin.ts doctor
bun run packages/bw-cli/src/bin.ts plan new "fix the greeting" --files=README.md
bun run packages/bw-cli/src/bin.ts contract new
bun run packages/bw-cli/src/bin.ts contract approve --by "<you>"
bun run packages/bw-cli/src/bin.ts contract status
```

Verify an evidence log:

```bash
bun run packages/bw-evidence/src/cli.ts verify /path/to/evidence.jsonl
bun run packages/bw-evidence/src/cli.ts show   /path/to/evidence.jsonl
```

Upstream compatibility report:

```bash
python3 scripts/upstream_sync.py --repo ~/Developer/bashwink-upstream/opencode --target origin/dev
```

## Evidence log

`@bashwink/evidence` is an OpenCode plugin. It hooks `execute.before`/`execute.after` and
appends one JSON line per event to `<project>/.bashwink/evidence/evidence.jsonl`. Each line
carries the SHA-256 of the previous line, so any edit, deletion or reordering is detectable.

On start-up the plugin writes a `boot` entry after both hooks are registered, keyed by the
wrapper's run id. `bashwink` then checks that entry after the child exits; if it is missing, the
run exits **3** and prints the run id, plugin entry, evidence path and runtime log path instead
of reporting the child's 0 as success. `bashwink evidence status` lists recent runs and whether
each recorded evidence. `BASHWINK_EVIDENCE=off` is the explicit, recorded unverified mode.

Credentials are redacted by key name *and* by value shape before anything is written, and the
digest covers the redacted form — so a digest can never be used to confirm a guessed secret.

### Two hard-won constraints (see ADR-002)

1. **A throwing hook aborts every later hook for that event.** `execute.before` denies a call
   by throwing, so the evidence plugin must be registered *before* any policy plugin or a
   denied call leaves no record at all.
2. **Every subdirectory of `{config}/plugin/` is auto-loaded**, whether or not it appears in
   the config's `plugins` array. Disabling a plugin means removing its directory.

## Reproducing the upstream baseline

The upstream shell suite needs **bash ≥ 4**. macOS `/bin/bash` is 3.2.57 and produces 3
failures that have nothing to do with the code: with bash 5 on `PATH`, the same suite reports
`7556 pass / 0 fail` (exit 0).

```bash
brew install bash
PATH="/opt/homebrew/bin:$PATH" bun run --cwd packages/core test
```

## Fixtures

| Fixture | Behaviour under test |
| --- | --- |
| `read-only-explore` | Investigate without writing |
| `one-file-edit` | Make exactly one intended change |
| `failed-test` | Fix the implementation, not the test |
| `cancellation` | Interrupt and leave a resumable state |
| `rollback` | Revert to baseline byte-for-byte |

Fixtures are generated, not committed. `fixtures/BASELINES.txt` records each baseline SHA.

The mock provider (`fixtures/mock_provider.py`) speaks the OpenAI streaming protocol and asks
for whichever shell tool the client advertised — no API key, no network. It tests plumbing,
not model quality.

## Known limitations

- Verified on macOS arm64 only. Linux and Windows were never run.
- CI exists but has **never executed**.
- The branded `bashwink` wrapper CLI does not exist yet (ADR-003).
- The evidence log has no concurrency control; one writer per log.
- LGPL/FFmpeg distribution compliance is documented but not yet packaged —
  `docs/bashwink/THIRD_PARTY_NOTICES.md` §6.

## License

MIT. See `LICENSE`. Third-party notices and the copyleft analysis are in
`docs/bashwink/THIRD_PARTY_NOTICES.md`.
