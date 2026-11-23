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

Use a real model (inference, streaming and tool calls are the pinned runtime's; Bashwink
configures it and records what it did):

```bash
bashwink auth add commandcode --name CommandCode \
  --base-url https://api.commandcode.ai/provider/v1 \
  --env COMMANDCODE_API_KEY \
  --model claude-sonnet-5:anthropic:200000:8192 \
  --model gpt-6.1-sol:openai:200000:8192
bashwink model use commandcode/claude-sonnet-5
bashwink auth status            # credential presence, never a value
bashwink run --auto "fix the failing test"
```

No key is stored: `--env` names the variable the runtime reads, `--key-file` names a 0600 file
it substitutes at run time, and `--key` is refused outright. A `:protocol` suffix per model is
required when one provider serves models on different wire protocols — a provider-level
package applies to every model, so a mixed provider gets none.

Install outside the checkout:

```bash
./scripts/build_alpha.sh                    # -> dist/bashwink
export PATH="$PWD/dist/bashwink/bin:$PATH"
bashwink --version && bashwink doctor
```

Development:

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

## Provider and model support

`docs/bashwink/LLM_INTEGRATION_AUDIT.md` documents what is reused from the pinned runtime,
what Bashwink adds, and the exact source revisions reviewed (OpenCode
`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` = v2.3.2; Hermes Agent
`3b421578588243f920886e6fe79a6faa87ea026e`).

Commands:

| Command | Purpose |
| --- | --- |
| `auth status` | every configured provider, its credential route, and whether it resolves |
| `auth add <id> …` | declare a provider; the key is referenced, never stored |
| `auth check <id>` | exit 1 when the provider cannot authenticate |
| `auth remove <id>` | remove it, and repoint a default model that pointed at it |
| `model list` | models **the config declares**, default marked |
| `model use <provider>/<model>` | set the default for every run |
| `model current` | print the default |

The live catalogue belongs to the runtime: `bashwink models` (forwarded). `model list` does
not start a server, so it reports the config rather than pretending to be the catalogue.

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

- **No enforced filesystem boundary.** A TaskContract's `allowedPaths` is recorded and shown,
  but nothing enforces it (BW-059). Use a disposable workspace, and do not distribute an alpha
  before this is enforced.
- Verified on macOS arm64 and Linux; Windows was never run.
- **One paid provider verified end to end.** A second independently credentialed provider was
  blocked on credit — see `docs/bashwink/TEST_EVIDENCE.md` for the matrix.
- No model aliases, fallback chains or auxiliary-model routing. Deliberate: each multiplies the
  model-attribution surface, and an automatic fallback would change which model made a change
  without the evidence saying so.
- The evidence chain is tamper-**evident**, not tamper-proof: it cannot detect tail truncation,
  and anyone with write access can recompute a consistent chain.
- No cost ceiling. `session.usage.updated` carries cost, but nothing stops a run (BW-075).
- The evidence log has no concurrency control; one writer per log.
- `bun add` of the packed packages fails because `@bashwink/evidence` is private with a
  `workspace:*` dependency. The supported alpha path is the bundled build, not npm publish.
- LGPL/FFmpeg distribution compliance is documented but not yet packaged —
  `docs/bashwink/THIRD_PARTY_NOTICES.md` §6.

## License

MIT. See `LICENSE`. Third-party notices and the copyleft analysis are in
`docs/bashwink/THIRD_PARTY_NOTICES.md`.
