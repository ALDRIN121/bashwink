# Alpha tester guide (standalone 0.2.0-alpha.1)

## 1. Install and check

**Requirements:** Node.js `>=22.13.0` and npm `>=10`.

From a source checkout:

```sh
npm run install:local
```

Or from a verified release tarball:

```sh
npm install -g ./bashwink-0.2.0-alpha.1.tgz
bashwink --version      # bashwink 0.2.0-alpha.1
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

## 3. Complete a coding task

Inside any project folder, run `bashwink`. Confirm workspace trust (`y` to enable edit/command approvals, or keep read-only mode), then type a task. Bashwink:
- lists/reads relevant files,
- shows a unified diff before asking `Apply this change? [y/N]`,
- asks `Run this command? [y/N]` with a host-access warning before running a command, and
- reports changed files, actual exit codes, and `evidence.jsonl` location.

## 4. Check evidence, cancel, or remove

- `bashwink evidence verify` verifies the hash chain (`evidence.jsonl`).
- `Ctrl+C` cancels the active request/command, terminates child processes, and persists the run outcome as `cancelled`.
- `npm uninstall -g bashwink` removes the CLI while preserving settings and evidence under your Bashwink config/data directory.
