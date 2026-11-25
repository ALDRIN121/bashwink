# Standalone Alpha Dependency & Artifact Inventory

**Baseline inspected:** commit `2817dfc` (descended from `e4d675111fc93906803dd638af4d36eaf6ad91f0`, previous package `bashwink-0.1.0-alpha.1.tgz` `sha256: 347fa737d65722b0afd67c8d742456d150c7078801a77c9d9b0944551c596ea6`).

| Path / Asset | Classification | Rationale & Action |
| --- | --- | --- |
| `packages/bw-evidence/src/recorder.ts` | **Retain (reused)** | Zero third-party deps (`node:crypto`, `node:fs`, `node:path`). Direct reuse for append-only hash-chained `evidence.jsonl` and redaction. |
| `packages/bw-evidence/src/scope.ts` | **Retain & extend** | Zero third-party deps. Reuse `physicalPath`, `contains`, `makePolicy`, `evaluate`; extend for standalone `.git`, config, credential-file, and evidence-dir protection. |
| `packages/bw-cli/src/trust.ts` | **Retain (reused)** | Zero third-party deps. Reuse `readTrust`, `writeTrust`, `grantTrust`, `revokeTrust`, `isTrusted`, `canonicalWorkspace`, `evaluateCall`. |
| `packages/bw-cli/src/test-changes.ts` | **Retain (reused)** | Reuse `isTestPath` for test-file change disclosure. |
| `packages/bw-cli/src/paths.ts` | **Adapt (subset)** | Reuse `paths()`, `homeDirectory()`, `ensurePaths()` (zero deps); exclude OpenCode plugin staging in standalone runtime. |
| `packages/bw-cli/src/providers.ts` | **Adapt (reference parser)** | Reuse `{env:VAR}` / `{file:PATH}` parsing, `fingerprint()`, safe key-file permission warnings without OpenCode config schema coupling. |
| `packages/bw-cli/src/standalone/` | **New (core alpha)** | Isolated standalone Node 22+ implementation (`types.ts`, `config.ts`, `provider.ts`, `tools.ts`, `task-loop.ts`, `terminal.ts`, `index.ts`). |
| `release/npm/bin/bashwink.js` | **Replace for standalone** | Replace Bun/OpenCode manifest launcher with direct Node 22+ entrypoint executing standalone `lib/bashwink.js` (zero external runtime lookup). |
| `release/npm/package.json` | **Adapt** | Bump prerelease version to `0.2.0-alpha.1`, set `engines.node >= 22`, drop `"bun": "1.4.4"` dependency (`dependencies: {}`). |
| `package.json` (root) | **Adapt** | Add `install:local`, `test:standalone`, `test:standalone:install`, `test:standalone:e2e`, `test:standalone:independence`; keep standalone build/test free of Bun and `@opencode/*`. |
| `packages/bw-cli/src/{bin,main,execution-backend,private-server,native-sandbox,native-offline,runtime,engine-manifest,commands,store,contract}.ts` | **Isolate / Legacy CLI** | Excluded from standalone build/package. Commands removed from standalone CLI (`run`, `plan`, `contract`, `resume`, `--sandbox`, `auth`) return explicit standalone migration messages rather than forwarding to an old OpenCode binary. |
| `packages/bw-evidence/src/{index,tui,tui-mode,cli}.ts` | **Isolate / Legacy plugin** | `@opencode/plugin` OpenCode hook entrypoints excluded from standalone package; `verify` logic comes directly from `recorder.ts`. |
| `vendor/engine/**`, `scripts/{build_local_engine,fetch_native_inputs,import_local_engine,record_engine_patch}.py` | **Retire from build/package (keep tracked until approved removal)** | Never touched by `npm run install:local` or `test:standalone*`; removal deferred until Milestone F passes and owner authorizes destructive deletion. |
| `.github/workflows/verify.yml` | **Adapt** | Add/switch `npm-package` & standalone verification jobs to Node 22+ (`npm run test:standalone*`) across `ubuntu-latest`, `macos-15`, `windows-latest`. |

## Historical CLI Surface Migration Table

| Legacy invocation | Standalone behavior | Exit code |
| --- | --- | --- |
| `bashwink` | Interactive setup if unconfigured; otherwise saved model/destination header + trust check + prompt | `0` (`130` on interrupt) |
| `bashwink setup` | Reconfigure endpoint, model, and credential reference (cancelling preserves saved profile) | `0` |
| `bashwink --version` / `-v` | Prints `bashwink 0.2.0-alpha.1` | `0` |
| `bashwink --help` / `-h` | Concise standalone usage and exit code table | `0` |
| `bashwink doctor` | Checks Node 22+, `standalone.json`, credential ref (never printing values), trust, evidence log | `0` / `1` |
| `bashwink trust [dir] [--by name]` | Grants or inspects workspace trust | `0` / `2` |
| `bashwink evidence verify` | Verifies hash-chained `evidence.jsonl` cleanly | `0` / `1` |
| `bashwink --sandbox` | Fails closed cleanly: isolated VM is not part of standalone alpha | `3` |
| `bashwink run / plan / contract / resume / <unknown>` | Refuses forwarding to external runtime; prints explicit standalone migration guidance | `2` |
