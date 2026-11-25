# ADR-014: Keep future engines and a later Rust port possible, and build neither now

**Status:** Accepted as direction only (owner direction, 2026-11-25). **Related:** ADR-002, ADR-003, ADR-013.

## Context

The owner wants the option to add other engines later (an alternative execution engine, a memory engine, another
inference runtime) and possibly to move parts to Rust. Nothing of that is in scope for the private alpha.

## Decision

**Build none of it.** No Chat Memory Engine, no Rust migration, no "Bashwink 2.0". Instead, keep the four seams that
already exist narrow and documented, and do not add coupling that would close them.

| Seam | Where | Today | Keeps open |
| --- | --- | --- | --- |
| Execution backend | `execution-backend.ts` (`standard-native`, `isolated-vm`) | two backends behind one result type | another execution engine |
| Runtime binary | launcher passes `BASHWINK_OPENCODE_BIN`; resolver refuses PATH discovery | exact-pinned OpenCode | a different or newer runtime, one resolver change |
| Runtime protocol | `serve --stdio`, `/api/*` (OpenAPI at `/openapi.json`), `/api/event` SSE | used only by `private-server.ts`, `session-admission.ts`, `usage-guard.ts` | a non-TypeScript wrapper |
| Evidence format | versioned (`v: 1`), canonical JSON lines, SHA-256 chain | written by `@bashwink/evidence` | another writer or verifier |

## Is a later Rust migration practical? Partly, and the line is clear.

Measured on this tree: about 9,300 lines of wrapper CLI on the standard path, 1,800 lines of evidence plugin, and
about 6,200 lines that are VM-only.

- **The wrapper is portable.** Its dealings with the runtime are process management, HTTP and SSE against a documented
  local API, environment variables and JSON files. Nothing in it needs TypeScript, and the contract is tested at the
  process boundary (`fixtures/release/npm_qual.py` drives only the installed command).
- **The plugin is not portable while OpenCode is the runtime.** It is loaded by OpenCode's JavaScript plugin host and
  imports `@opencode/plugin`; only four source files touch that SDK. It stays TypeScript as long as the runtime does.
- **Pure logic is language-neutral by construction:** the scope policy, the usage ledger and the evidence chain take
  plain data in and return plain verdicts, with fixtures that a port could reuse as its conformance suite.

So a Rust wrapper around the same pinned runtime and the same plugin is a realistic later step; replacing the runtime
or the plugin host is not, and nothing here pretends otherwise. Not verified: that a Rust port reaches parity in
effort or startup time. No Rust code was written to test it.

## Consequences

Review rule for new work: a change that makes the plugin SDK, the `/api` surface or the evidence format reachable from
more files needs a stated reason. The ADRs for any future engine start from the seam table above.
