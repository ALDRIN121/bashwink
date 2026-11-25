# Bashwink 0.2.0-alpha.1 (standalone alpha)

Bashwink is an evidence-first standalone coding CLI built on Node.js 22+ with zero third-party runtime packages. This is a private alpha build for invited testers and must not be redistributed or published to npm.

## Quick start

```sh
npm install -g ./bashwink-0.2.0-alpha.1.tgz
cd my-project
bashwink
```

Or install directly from a source checkout:

```sh
npm run install:local
```

**Requirements:** Node.js >= 22.13.0 and npm >= 10. Zero OpenCode, Hermes, Pi, or Bun installation is needed.

**Security model:** Approved edits and commands run with your user permissions (**not an OS sandbox**). Bashwink enforces workspace trust (read-only until approved), diff preview before every edit, command confirmation before every command, path scope checks (blocking symlinks outside the workspace, `.git`, and credential stores), credential scrubbing, and a hash-chained log (`bashwink evidence verify`).

First checks:
- `bashwink --version`
- `bashwink doctor`
- `bashwink setup` (change endpoint, model, or credentials later)
- `npm uninstall -g bashwink` (settings and evidence stay in your profile)

See `docs/ALPHA_TESTER_GUIDE.md` and `docs/KNOWN_LIMITATIONS.md` inside this package directory (`npm root -g`).
