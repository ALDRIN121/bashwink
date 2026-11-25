# Known limitations: 0.2.0-alpha.2 (standalone Node 22+ alpha)

## Security model

- **Standard mode is not an OS sandbox.** Approved commands run with your user permissions. Bashwink enforces workspace trust, path scope boundaries, symlink escape blocking, `.git` write denial, diff previews, command confirmations, env scrubbing, and literal secret redaction in `evidence.jsonl`, but an approved command can still read or modify anything your OS user can access.
- Untrusted repository context (`README.md`, `AGENTS.md`, workspace config files) and `ContextProvider` chunks are tagged in nonce-escaped `<trust_zone>` delimiters and never override `trust.json`, `permissions.json`, or `BoundaryContext`.
- `TestGuard` detects deleted test blocks, `.skip`/`.only`, reduced/trivial assertions, weakened `package.json` scripts, and shell-tampered protected test hashes, blocking auto-approval — though an interactive human user can still explicitly override with `once`.
- Shell argument inspection covers standalone tokens, `--flag=path`, short-flag attached values (`-f~/.aws/credentials`), and `~/` credential roots (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`), which remains best-effort lexical checking rather than kernel sandboxing.
- The hash chain (`evidence.jsonl`) detects in-place corruption or reordering, not malicious rewriting by the same OS user.
- `bashwink --sandbox` is not shipped in the standalone package and fails closed with exit code 3.

## Platforms

- **Verified target:** **macOS Apple Silicon (`darwin-arm64`)** on Node.js `v22.13.0+` / `v22.23.2` — including 39 unit/widget/PTY tests, 12/12 real PTY adversarial + lifecycle E2E scenarios, install lifecycle checks, and zero-`vendor/`/`node_modules/`/`bun` independence checks.
- **UNVERIFIED:** `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-*-musl`, and `win32-x64` have not been executed locally or in live Phase 2 CI runners for this build, and no live paid-provider session has been executed against the Phase 2 build yet (scripted/loopback mock HTTP + real PTY only).

## Product scope

- Foreground single-task terminal loop with 4 fixed built-in tools (`list_files`, `read_file`, `edit_file`, `run_command`).
- Speaks OpenAI-compatible Chat Completions and Anthropic native Messages framing over HTTPS (hosted) or loopback HTTP/HTTPS (local); does not manage background daemons, multi-agent workers, or MCP servers in the standalone alpha.
- Per-task defaults: 20 model requests max (`DEFAULT_TASK_BUDGETS`), 120s command timeout, and stop after 3 identical failure or no-progress loop turns (configurable via `--max-*` or `BASHWINK_MAX_*`). Cost limits require an explicit declared price in config; omitted provider `usage` triggers character-based token/cost estimation labeled `costEstimated: true`.
