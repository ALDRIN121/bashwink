# Alpha tester guide (standalone 0.2.0-alpha.2)

## 1. Install and check

**Requirements:** Node.js `>=22.13.0` and npm `>=10`.

From a source checkout:

```sh
npm run install:local
```

Or from a verified release tarball:

```sh
npm install -g ./bashwink-0.2.0-alpha.2.tgz
bashwink --version      # bashwink 0.2.0-alpha.2
bashwink doctor
```

Verify a tarball against `SHA256SUMS` before installing (`shasum -a 256` on macOS/Linux or `Get-FileHash -Algorithm SHA256` on PowerShell).

## 2. Explicit setup before coding

On first launch (`bashwink`), Bashwink starts with **no provider or model selected** — ambient environment keys like `OPENAI_API_KEY` or configs from OpenCode, Hermes, or Pi never select a provider or trigger requests.

Follow the prompts to choose:
1. Endpoint type: Hosted (`https://`) or Local loopback (`http://127.0.0.1:...`, `http://localhost:...`, or `http://[::1]:...`).
2. Model ID (e.g. `gpt-4o-mini` or a local model name).
3. Credential mode: None, Environment variable name, or Key file path (prefer key file when possible).

Zero network requests are sent during setup. Cancelling writes no partial profile. Use `bashwink setup` anytime to change configuration.

## 3. Complete a coding task (with Proof & Guardrails)

Inside any project folder, run `bashwink`. Confirm workspace trust (`y` to enable edit/command approvals, or keep read-only mode), then type a task. Bashwink:
- captures an immutable Git/filesystem baseline and hashes protected test files + `package.json`,
- lists/reads relevant files while isolating untrusted repo/context text inside nonce-tagged `<trust_zone>` delimiters,
- shows a unified diff before asking `Apply this change? [y/N]` — if `TestGuard` detects deleted tests, `.skip`, `.only`, weakened assertions, or neutered `package.json` test scripts, it forces an explicit manual decision (`Always allow` and auto-modes are blocked),
- asks `Run this command? [y/N]` with a host-access warning before running a command (blocking compound-arg / `~/` credential path escapes upfront), and
- reports `Claim` (`verified`, `done_unverified`, or `inconclusive` via `ClaimGuard`), changed files, actual exit codes (`pass`/`fail`/`not_run`), and `evidence.jsonl` / `runs/*.json` paths.

## 4. IntentLock contracts, budgets, evidence & cleanup

- **IntentLock contracts:**
  - `bashwink contract new --objective "..." --allow sum.js --forbid sum.test.js --max-files 1 --criterion c1:"tests pass":"node --test sum.test.js"`
  - `bashwink contract approve --by "<your-name>"`
  - `bashwink contract show` / `bashwink contract revise --reason "..."`
  - Launch with `bashwink --require-contract` to enforce contract approval before any model call.
- **Pre-request budgets:** `--max-requests <n>`, `--max-tokens <n>`, `--max-cost-usd <amt>`, `--max-time-ms <ms>` (or `BASHWINK_MAX_*` env vars). Stops cleanly before launching a paid call past budget, and stops repeated identical failure/no-progress loops while preserving edits.
- **Proof & Evidence:**
  - `bashwink proof show [runId]` and `bashwink proof verify [runId|file]`
  - `bashwink evidence verify`
  - `bashwink evidence export [--run <id>] [--out <file>] [--format json|md]`
  - `bashwink evidence purge --ttl-days <n>` (purges old `runs/*.json` & `sessions/*.json` while preserving `evidence.jsonl` and contracts).
- `Ctrl+C` cancels the active request/command, terminates child processes, and persists the run outcome as `cancelled`.
- `npm uninstall -g bashwink` removes the CLI while preserving settings and evidence under your Bashwink config/data directory.
