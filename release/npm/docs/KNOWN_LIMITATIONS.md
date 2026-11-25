# Known limitations: 0.2.0-alpha.1 (standalone Node 22+ alpha)

## Security model

- **Standard mode is not an OS sandbox.** Approved commands run with your user permissions. Bashwink enforces workspace trust, path scope boundaries, symlink escape blocking, `.git` write denial, diff previews, command confirmations, env scrubbing, and literal secret redaction in `evidence.jsonl`, but an approved command can still read or modify anything your OS user can access.
- Untrusted repository context and optional `ContextProvider` chunks are tagged untrusted and never elevate permissions.
- The hash chain (`evidence.jsonl`) detects in-place corruption or reordering, not malicious rewriting by the same OS user.
- `bashwink --sandbox` is not shipped in the standalone package and fails closed with exit code 3.

## Platforms

- Tested locally (on both **Node `v22.13.0`** lowest supported and `v22.23.2`) with real PTY onboarding, process-level outbound egress probe catching any external host before task submission, red->green Git fixture, declined edits, failed commands, Ctrl+C cancellation, corrupt-tarball resilience, uninstall preservation, and physical-absence checks on **macOS Apple Silicon (`darwin-arm64`)**.
- **UNVERIFIED** on `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-*-musl`, and `win32-x64` until executed on those target hosts or runners (Windows native ConPTY script `scripts/standalone/test-windows-terminal.ps1` is included in `test:standalone:e2e` and CI for `windows-latest`, not yet executed on a live Windows machine).

## Product scope

- Foreground single-task terminal loop with 4 fixed built-in tools (`list_files`, `read_file`, `edit_file`, `run_command`).
- Speaks OpenAI-compatible Chat Completions over HTTPS (hosted) or loopback HTTP/HTTPS (local); does not manage background daemons, multi-agent workers, MCP servers, or Anthropic native wire framing directly unless routed via an OpenAI-compatible gateway.
- Per-task defaults: 40 model requests max, 120s command timeout, and stop after 3 identical consecutive failures. Cost limits require an explicit declared price in config.
