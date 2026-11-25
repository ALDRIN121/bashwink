# Security notes for testers

- Treat this alpha as software that can run commands as you. Use a disposable or backed-up repository.
- Never put a production key, a customer's data or a repository you cannot restore into an alpha session.
- Bashwink never writes your provider key to its config; it reads the named environment variable or key file when it runs.
  Key files and credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, and Windows `%APPDATA%\npmrc` / `%LOCALAPPDATA%\GitCredentialManager`) are blocked from `read_file`, `edit_file`, and recognized shell path/compound-flag arguments (`--flag=...`, `-f~/...`). That shell check is
  best-effort, not a sandbox: a command you approve that builds a path indirectly could still read the file. With an **environment variable**, Bashwink removes secret-named variables (`SECRET_ENV_PATTERN`) from shell commands it runs and masks declared credential values per recorder instance across `evidence.jsonl`, `sessions/*.json`, `runs/*.json`, and terminal previews; other tools you run yourself in the same environment can still see ambient env vars, so a key file is the safer choice. On Windows, file permissions are not checked by Bashwink; keep the key file in your user profile.
- Untrusted repository documents and retrieved context blocks are wrapped in nonce-escaped `<trust_zone>` delimiters; workspace `standalone.json` or `opencode.json` files cannot grant workspace trust or alter permission mode.
- Use `bashwink evidence export` for consent-driven redacted exports and `bashwink evidence purge --ttl-days <n>` to prune expired session/run artifacts without altering `evidence.jsonl` or `contracts/`.
- Set a spending limit at your provider. Bashwink's own `--max-requests` / `--max-tokens` / `--max-cost-usd` / `--max-time-ms` checks apply before every main and smart-guardian request, but in-flight calls and unpriced/approximated provider bills mean provider billing remains authoritative.
- Report a vulnerability privately to the person who sent you this package. Do not post details publicly.
- You do not need to turn off any operating-system protection (Gatekeeper, SmartScreen, antivirus, firewall) to use
  this package, and you should not. If something asks you to, stop and report it.
