# Bashwink

An evidence-first coding agent: it records what it actually did — commands, exit codes and
outputs, hash-chained and independently verifiable — instead of reporting what it claims to
have done.

**Status:** Standalone alpha **`v0.2.0-alpha.1`** ([ADR-015](docs/bashwink/ADR-015-STANDALONE-CODING-ALPHA.md)) runs purely on Node.js 22+ and npm without OpenCode, Hermes, Pi, or Bun. Phase 0 and Phase 1 are gate-passed for the historical OpenCode substrate; the Phase 2 gate remains open. See [implementation status](docs/bashwink/IMPLEMENTATION_STATUS.md), [supported platforms](docs/bashwink/SUPPORTED_PLATFORMS.md), and [next steps](docs/bashwink/NEXT_STEPS.md).

## v0.2.0-alpha.1 quick start (standalone checkout install)

### 1. Prerequisites

Install only:

- **Node.js >= 22.13.0** and **npm >= 10** (`https://nodejs.org/`)
- **Git** (recommended for workspace repositories and diff inspection)

No external OpenCode, Hermes, Pi, Bun, Python, Rust, or Zig installation is required.

### 2. Install

From the repository root (same command on macOS, Linux, and Windows PowerShell):

```sh
npm run install:local
```

This transpiles the zero-dependency standalone bundle using Node.js >=22.13.0, audits the tarball (verifying zero third-party or upstream runtime dependencies), builds `build/standalone/bashwink-0.2.0-alpha.1.tgz`, and installs `bashwink` globally via `npm install -g`.

Verify the installation:

```sh
bashwink --version
bashwink doctor
```

### 3. Configure and launch `bashwink`

Open a fresh terminal inside any project directory and type:

```sh
bashwink
```

On a clean profile (`standalone.json` absent), Bashwink starts in first-time setup with no provider or model selected (ignoring `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CMD_API_KEY`, or OpenCode/Hermes/Pi configs). Choose a hosted (`https://`) or local (`127.0.0.1` / `localhost` / `::1`) OpenAI-compatible endpoint, model ID, and credential mode (None, environment variable name, or key file path), then confirm saving.

Zero outbound network requests are sent during install, startup, or setup. Cancelling setup writes no partial profile. Use `bashwink setup` later to update or switch providers.

### 4. Complete your first coding task

After accepting workspace trust (`y` to permit edits/commands; `N` for read-only mode), type a prompt such as `fix the failing test`. Bashwink exposes four built-in tools (`list_files`, `read_file`, `edit_file`, `run_command`), previews diffs before edits, asks before running commands (warning that approved commands run with host access, not an OS sandbox), records a hash-chained evidence log (`bashwink evidence verify`), and reports changed files and actual command exit codes.

### 5. Uninstall

```sh
npm uninstall -g bashwink
```

This removes the `bashwink` command while preserving your configuration, trust decisions, run records, and evidence logs under `~/.config/bashwink` and `~/.local/share/bashwink` (or `%APPDATA%/bashwink` on Windows, unless overridden with `BASHWINK_HOME`).

### Verification commands

```sh
npm run test:standalone               # Unit and task-loop tests (Node 22+)
npm run test:standalone:install       # Tarball install, space path, upgrade, corrupt-tarball, uninstall
npm run test:standalone:e2e           # Installed PTY onboarding, zero-request check, red->green, decline, Ctrl+C (macOS/Linux)
npm run test:standalone:independence  # Clean clone without vendor/, node_modules/, OpenCode, Hermes, Pi, or Bun
```

The earlier fork-based `0.1.0-alpha.1` build artifacts remain pinned as the rollback baseline in [ADR-015](docs/bashwink/ADR-015-STANDALONE-CODING-ALPHA.md).

## Layout

```
bashwink/
  packages/bw-evidence/     OpenCode plugin + recorder: append-only, hash-chained evidence log
  packages/bw-cli/          `bashwink` wrapper, plan/contract/evidence commands, doctor
  vendor/engine/            Vendored OpenCode engine (v2.3.2) + process-daemon PTY helper
  fixtures/                 Deterministic Git fixtures, real-runtime proofs, local mock provider
  scripts/                  Build, local-engine provenance, documentation verifier, release gates
  docs/bashwink/            Requirements, ADRs, phase plan, status and evidence registers
  .github/workflows/        CI: verify (lint, docs, tests, fixtures, runtime health, npm-package)
```

The pinned OpenCode engine is vendored under `vendor/engine/` at v2.3.2 (`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`) and built locally with its `process-daemon` PTY helper and an FFmpeg-free OpenTUI rebuild — no external OpenCode install or hosted service is needed.

## Local development quick start

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

Build the internal development version from the checkout and install the pinned OpenCode
runtime separately. Approved local commands run with host access. Follow the
[internal installation guide](docs/bashwink/ALPHA_TESTER_GUIDE.md#1-install)
for Bun 1.4.4, OpenCode 2.3.2, the runtime binary path and the wrapper build. Use the
[readiness decision](docs/bashwink/INTERNAL_ALPHA_READINESS.md) to select a trusted alpha workspace.

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
| `auth check <id>` | check that the configured credential resolves locally |
| `auth remove <id>` | remove it, and repoint a default model that pointed at it |
| `model list` | models **the config declares**, default marked |
| `model use <provider>/<model>` | set the default for every run |
| `model current` | print the default |

The live catalogue belongs to the runtime: `bashwink models` (forwarded). `model list` does
not start a server, so it reports the config rather than pretending to be the catalogue.

## Evidence log

`@bashwink/evidence` is an OpenCode plugin. It hooks `execute.before`/`execute.after` and
appends one JSON line per event under Bashwink’s data root at `evidence/evidence.jsonl`. The
data root is `$BASHWINK_HOME/data` when overridden, and otherwise uses the XDG data directory.
The chain detects inconsistent changes within the retained entries. An omitted suffix can still verify, and a writer can recompute the chain.

On start-up the plugin writes a `boot` entry after both hooks are registered, keyed by the
wrapper's run id. `bashwink` then checks that entry after the child exits; if it is missing, the
run exits **3** and prints the run id, plugin entry, evidence path and runtime log path instead
of reporting the child's 0 as success. `bashwink evidence status` lists recent runs and whether
each recorded evidence. The wrapper gates client launch on policy readiness from its owned
OpenCode server. The former `BASHWINK_EVIDENCE=off` switch is refused.

Evidence redaction matches known credential keys and value patterns before hashing.
Unrecognized formats can still appear in recorded output.

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
for the available shell tool over a local loopback endpoint with no API key. It tests the
runtime and tool lifecycle.

## Known limitations

- **Tool-level scope only.** BW-059 enforces `allowedPaths` at the loaded plugin for
  recognized file calls. Permitted shells inherit host access. OS containment is required
  before external alpha (BW-031).
- **One paid provider verified end to end.** A second independently credentialed provider was
  blocked on credit — see `docs/bashwink/TEST_EVIDENCE.md` for the matrix.
- No model aliases, fallback chains or auxiliary-model routing. Deliberate: each multiplies the
  model-attribution surface, and an automatic fallback would change which model made a change
  without the evidence saying so.
- The evidence chain is tamper-**evident**, not tamper-proof: it cannot detect tail truncation,
  and anyone with write access can recompute a consistent chain.
- The standard candidate stops work when usage limits are reached, but a request already in flight
  can exceed the threshold. Token limits exclude cached reads and writes. Set a spending limit
  with your provider. [Usage evidence](docs/bashwink/FINAL_ALPHA_QUALIFICATION_REPORT.md)
- The evidence log has no concurrency control; one writer per log.
- LGPL/FFmpeg distribution compliance is documented but not yet packaged —
  `docs/bashwink/THIRD_PARTY_NOTICES.md` §6.

## License

MIT. See `LICENSE`. Third-party notices and the copyleft analysis are in
`docs/bashwink/THIRD_PARTY_NOTICES.md`.
