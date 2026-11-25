# ADR-015: Standalone Bashwink coding alpha (replacing the OpenCode runtime wrapper)

**Status:** Accepted (owner direction, 2026-11-25; replacement plan `docs/superpowers/plans/2026-11-25-bashwink-standalone-alpha.md`).
**Reconciles / supersedes in active distribution:** `ADR-001` (OpenCode fork/wrapper strategy), `ADR-013` (npm tarball shipping OpenCode), and `ADR-017` (local-engine source build). Historical Phase 0/1/local-engine evidence stays intact as the comparison and rollback baseline.

## Baseline & Rollback Pin

- **Previous candidate commit:** `e4d675111fc93906803dd638af4d36eaf6ad91f0` (`local-engine/task-0`)
- **Previous candidate artifact:** `bashwink-0.1.0-alpha.1.tgz` (`84909090` bytes, `sha256: 347fa737d65722b0afd67c8d742456d150c7078801a77c9d9b0944551c596ea6`)
- **Active standalone prerelease version:** `0.2.0-alpha.1` (distinct from `0.1.0-alpha.1` so npm and testers can tell the standalone Node build from the legacy fork)

## Architecture Decision

1. **Bashwink owns the entire foreground runtime on Node 22+ (zero Bun, zero `@opencode/cli`, zero external daemon):** terminal UI, first-run provider setup, OpenAI-compatible chat-completions transport, single-task foreground loop, fixed 4-tool registry (`list_files`, `read_file`, `edit_file`, `run_command`), interactive confirmation, scope enforcement, evidence chain, and budget caps.
2. **Explicit setup before any provider traffic:** on an empty Bashwink profile (`standalone.json` absent or invalid), `bashwink` enters first-time setup with no provider or model selected—even if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CMD_API_KEY`, or OpenCode/Hermes/Pi configs exist on the machine. Installation, startup, and setup send zero outbound provider requests; cancelling setup writes no partial profile.
3. **Selective tested backend ports with attribution:** `pendingCalls` and `stepMessages` (from OpenCode `packages/ai/src/loop.ts` at `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, MIT, copyright Anomaly/OpenCode; plus Pi `agent-loop.ts` `b882d08f34f8a245c8d3ea8b057759e1b8b2054c` truncated-length call rejection) are ported into plain Bashwink TypeScript types with zero `@opencode/*` or `effect` dependencies and tested directly in Bashwink.
4. **Retained security & evidence modules:** Bashwink reuses its own pure modules (`packages/bw-cli/src/trust.ts`, `packages/bw-evidence/src/scope.ts`, `packages/bw-evidence/src/recorder.ts`, `packages/bw-cli/src/test-changes.ts`) at the standalone tool boundary without requiring `bun:sqlite` or OpenCode plugins.
5. **Future chat & memory integration seams:** the task loop emits typed `TaskEvent` records and accepts a `ContextProvider` (workspace-scoped, untrusted-tagged context chunks + post-run callback) decoupled from terminal rendering and HTTP transport.
6. **Legacy tree preservation until explicit authorization:** `vendor/engine/` and legacy CLI modules remain excluded from the standalone build and package dependency graph (`npm run install:local`), and will not be destructively deleted without separate user authorization after Milestone F independence tests pass.

## Task Mapping (`BASHWINK_TASKS_90.csv`)

Historical Phase 0 and Phase 1 checkmarks stay unchanged for the recorded fork substrate. Within Phase 2 (which stays open pending its gate evaluation), these active rows map onto the standalone boundary:

| Task ID | Previous fork meaning | Standalone alpha meaning |
| --- | --- | --- |
| `BW-008` / `BW-009` / `BW-010` | Thin Bun wrapper CLI + `doctor` + trust | Standalone Node 22+ `bashwink`, `setup`, `doctor`, `trust` (re-verified on standalone target) |
| `BW-014` / `BW-015` | OpenCode plugin hooks -> `evidence.jsonl` | Standalone tool loop -> `EvidenceRecorder` (`evidence.jsonl` + per-run record JSON) |
| `BW-017` | Proof-of-work terminal summary | Rendered changed files, command exits, test status disclosure at task end |
| `BW-018` / `BW-059` | Plugin `execute.before` scope fence + denials | Pre-execution scope/trust/protected-path/destructive-command checks in `tools.ts` |
| `BW-075` / `BW-076` | Server SSE ledger (`usage-guard.ts`) | Pre-request request/token/cost budget caps + identical-failure stop inside `task-loop.ts` |
| `BW-091` | `opencode.json` translation via `auth add` | Standalone `standalone.json` setup, explicit key-ref resolution, zero secret leaks |
