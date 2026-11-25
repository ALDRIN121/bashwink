# Bashwink 0.2.0-alpha.2 (standalone alpha)

Bashwink is an evidence-first standalone coding CLI built on Node.js 22+ with zero third-party runtime packages. This is a private alpha build for invited testers and must not be redistributed or published to npm.

**Verified target platform:** macOS Apple Silicon (`darwin-arm64`) on Node.js `>=22.13.0` and npm `>=10`. Linux, Windows (`win32-x64`), and Intel macOS (`darwin-x64`) are unverified locally in this alpha build.

## Quick start

```sh
npm install -g ./bashwink-0.2.0-alpha.2.tgz
cd my-project
bashwink
```

Or install directly from a source checkout:

```sh
npm run install:local
```

**Requirements:** Node.js `>=22.13.0` and npm `>=10` on `darwin-arm64`. Zero OpenCode, Hermes, Pi, or Bun installation is needed.

**Security & Proof Model:** Approved edits and commands run with your user permissions (**not an OS sandbox**). Bashwink enforces workspace trust (read-only until approved), diff preview before every edit, `TestGuard` integrity checks (blocking auto-approval / `Always allow` on test deletion, `.skip`, `.only`, or weakened assertions), `ScopeFence` contract boundaries, command confirmation with compound-argument (`--flag=path`, `~/`) credential protection, nonce-escaped `TrustZones`, credential scrubbing across `evidence.jsonl` / `sessions/` / `runs/`, pre-request token/cost/time caps (`BudgetPilot`), `ClaimGuard` (`verified` vs `done_unverified` / `inconclusive`), and hash-chained logs (`bashwink evidence verify`).

First checks & workflows:
- `bashwink --version` & `bashwink doctor`
- `bashwink setup` (change endpoint, model, or credentials)
- `bashwink contract new --objective "..." --allow src --criterion c1:"tests pass":"npm test"` / `approve` / `show` / `revise`
- `bashwink proof show` / `bashwink proof verify`
- `bashwink evidence verify` / `bashwink evidence export --format json|md` / `bashwink evidence purge --ttl-days <n>`
- `npm uninstall -g bashwink` (settings and evidence stay in your profile)

See `docs/ALPHA_TESTER_GUIDE.md`, `docs/KNOWN_LIMITATIONS.md`, and `docs/SECURITY.md` inside this package directory (`npm root -g`).
