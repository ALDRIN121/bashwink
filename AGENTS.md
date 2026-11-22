# Bashwink — Instructions for Coding Agents

You are working in an **existing** Bashwink repository. Never create a nested `bashwink` repository or reset existing user changes.

## Mandatory first steps

1. Confirm `pwd`, Git status, branch, existing code, and tests. Do not assume this is an empty folder.
2. Read `docs/bashwink/README.md`, `AGENT_WORKFLOW.md`, `BASHWINK_PHASE_BY_PHASE_TASK_PLAN.md`, `PHASE_GATE_CHECKLIST.md`, and `NEXT_STEPS.md`.
3. Inspect `docs/bashwink/BASHWINK_TASKS_90.csv` to identify unblocked tasks. The CSV is the canonical task-status source.
4. Verify any existing implementation against the docs; previously written prose does not prove a feature works.
5. Work on **Phase 0 first** unless documented test evidence shows its gate already passed. Stop at the phase gate.

## Architecture

- Investigate official OpenCode and Hermes Agent sources and pin upstream revisions before choosing fork depth.
- Prefer a maintainable OpenCode integration or shallow fork; do not merge competing runtimes blindly.
- Never represent proposed or unverified capabilities as implemented.
- Retain upstream license and attribution requirements; check dependencies, branding, and security.

## Safe implementation

- Preserve uncommitted changes and all existing source files.
- Do not weaken tests, bypass security, fabricate execution logs or claim success without evidence.
- Enforce scope, permissions, budgets, and untrusted-input boundaries in runtime code, not just prompts.
- Use focused tests plus integration tests; record commands and real exit codes.
- Do not push, merge remotely, deploy, publish, or perform destructive operations without authorization.

## Progress and gate protocol

- Work task by task following `docs/bashwink/AGENT_WORKFLOW.md`.
- Update canonical CSV status and `docs/bashwink/IMPLEMENTATION_STATUS.md` consistently.
- Record architecture decisions in `docs/bashwink/DECISIONS.md`.
- Record real test evidence in `docs/bashwink/TEST_EVIDENCE.md`.
- Record the next eligible task and blockers in `docs/bashwink/NEXT_STEPS.md`.
- Stop when the current phase gate has been evaluated, and report any unmet criterion accurately.

If an existing `AGENTS.md` is already present, **merge these instructions instead of replacing it**.
