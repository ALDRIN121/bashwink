# Bashwink standalone coding alpha — design and implementation plan

**Status** — proposed replacement architecture for the coding agent to implement. Baseline: Bashwink commit `e4d675111fc93906803dd638af4d36eaf6ad91f0` on `local-engine/task-0`. The November 25 local-engine plan describes the previous fork. Use this document for the standalone alpha.

**Outcome** — an invited tester installs one Bashwink package, opens a terminal in a project, types `bashwink`, gives it a task, reviews a proposed change or command, and sees what happened. Bashwink owns every step from the first keystroke to the final exit code. One developer or coding agent implements the milestones in sequence. The shipped application runs one agent on one foreground task.

## 1. What went wrong and what to keep

The old plan solved an installation problem. It preserved the upstream application as the engine. The npm launcher selects a manifest, the native backend starts a private OpenCode server and starts its client against that server, and the upstream home route renders its own logo. Bashwink's real contributions include workspace trust, evidence, policy and installer work. The operator's observation follows directly from this call path. Renaming the binary or replacing the logo would still leave upstream in control of the task. [Launcher](../../../release/npm/bin/bashwink.js) · [Execution backend](../../../packages/bw-cli/src/execution-backend.ts) · [Private server](../../../packages/bw-cli/src/private-server.ts) · [Home screen at the baseline](https://github.com/ALDRIN121/bashwink/blob/e4d675111fc93906803dd638af4d36eaf6ad91f0/vendor/engine/packages/tui/src/routes/home.tsx)

| Current asset | Decision for the standalone package |
| --- | --- |
| Bashwink trust decisions, physical workspace path checks, redaction, evidence hash and verifier, test-file change reporting | Retain narrowly scoped Bashwink code and its behavioral tests after checking actual imports. Call it directly at the new tool boundary. A trusted workspace still requires confirmation for each proposed change and command in this alpha. |
| Bashwink provider config, command parsers, usage protection | Reuse credential-reference parsing, validation and relevant tests. Write the provider transport and budget enforcement for the foreground loop. Existing provider translation emits OpenCode configuration and the existing usage guard has server-specific behavior. |
| Task database, contracts, run management, optional VM, existing fixtures | Preserve historical data and gates. Port only behavior needed for the first task. The existing store imports `bun:sqlite`. The new task loop can run in memory and write an evidence log without taking on that store. Adapt installed-product fixtures to the new public contract. |
| OpenCode TUI, CLI, private client/server, bundled engine, plugin host, model catalog/gateway, native PTY and OpenTUI builds | Retire from the new source-build, package, and execution paths. Keep the baseline commit as the comparison and recovery point. Remove obsolete tracked code only after the dependency audit, replacement tests, and explicit approval for the removal. |
| Hermes Agent | Reference for the turn loop and tool dispatch. Zero Hermes code or services are required in the proposed alpha. |

## 2. OpenCode and Hermes — what to learn, what to write

These comparisons use the official repositories at the revisions inspected. They concern the code paths relevant to a single coding task.

| Question | OpenCode v2.3.2 · `c0ad18b` | Hermes Agent v0.23.1 · `3b42157` | Bashwink decision |
| --- | --- | --- | --- |
| How does a model turn become work? | The AI loop pairs completed calls with results by ID and builds the next model request. Its session runner also coordinates storage, events, plugins and background work. | The conversation loop prepares a request, normalizes the response, dispatches tools and finalizes the turn. Its outer loop also handles compression, retries and hooks. | Implement a bounded TypeScript loop. Send one request at a time, validate complete calls, execute approved calls sequentially, append results by ID and stop on a final answer or error. |
| How does a provider fit? | The compatible-chat adapter selects a protocol, endpoint and framing. | Chat-completion helpers accumulate streamed tool arguments before materializing calls. Other protocols have dedicated adapters. | Write one Bashwink adapter for the OpenAI-compatible chat-completions wire format. Begin with complete responses to keep partial JSON away from tools. Show progress and allow cancellation while waiting. Streaming and a second protocol are later decisions. |
| How are tools selected and approved? | Typed tool calls feed a dispatcher. The session runner is coupled to services including the plugin host and persistent terminal. | A registry exposes and dispatches tools. The executor supports sequential and concurrent work, with separate command approval code. | Implement a fixed table of local tools, strict argument validation, policy evaluation and explicit user decisions. The model can only request an operation. Bashwink decides whether it may run. |
| Who owns the experience? | OpenCode supplies its terminal routes, logo and client lifecycle. | Hermes has its own CLI, toolsets, delegation and optional integrations. | Write an original Bashwink terminal interaction using Node terminal primitives. Omit upstream UI, prompts, control commands, plugin discovery, delegation, background jobs, memory services and gateways. |

**OpenCode sources.** [AI loop](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/ai/src/loop.ts) · [Session runner](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/core/src/session/runner/llm.ts) · [Provider route](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/ai/src/protocols/openai-compatible-chat.ts)

**Hermes sources.** [Conversation loop](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/conversation_loop.py) · [Tool registry](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/registry.py) · [Tool executor](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/tool_executor.py) · [Tool-call assembly](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/chat_completion_helpers_tool_calls.py)

**Reuse rule.** The selected design needs zero upstream application packages. Both pinned repositories carry MIT notices. If a later task benefits from a specific upstream leaf function, record its path, revision, license, transitive imports, regression test, and the reason to port it. Review that exception before adding it. A function that brings either runtime, UI, registry, or application state along with it fails the selection criterion. Standard libraries and small general-purpose packages can be used on their own merits. Keep applicable attribution for any retained code.

## 3. Alpha experience and boundaries

Proposed first run in an ordinary terminal, showing illustrative wording:

```text
Bashwink
Project  ~/work/example

What would you like to change?
> Fix the failing addition test.

Read     src/sum.js, test/sum.test.js
Edit     src/sum.js
         - return a - b
         + return a + b
Apply this change? [y/N]

Run      node --test     in ~/work/example
Run this command? [y/N]

Changed  src/sum.js
Tests    node --test exited 0
```

Open immediately with zero credentials. When the first task needs a model, guide the user through endpoint, model and a credential reference, then continue the same task. Show the destination before sending project content. Store the endpoint and model under the Bashwink profile and accept a key via a named environment variable or user-owned key file. Handle keyless localhost endpoints. Use HTTPS for remote endpoints, allow HTTP for explicit loopback, and prevent credential forwarding on redirects. Keep keys out of the transcript, evidence, command environment and package. No upstream login, gateway, model discovery, mandatory wizard at each launch, or silent provider substitution. The current project has a scripted chat-completions fixture and an earlier live example using that protocol. Both must be rerun against the replacement to claim support. [Current provider evidence](../../bashwink/SUPPORTED_PROVIDERS.md)

**Built-in tools.** Ship `list_files`, `read_file`, `edit_file` (create or change one text file with a preview), and `run_command` (executable, argument array and working directory). Project dependency installation, when requested, is a visible, separately confirmed command, for example a project-local npm install. Show the packages, working directory and script/network implications. No automatic tool downloads. A tool marketplace, third-party agent plugins, global installs by the model, interactive shell sessions, autonomous subagents, remote workers, and scheduled jobs are outside this alpha.

**Command boundary.** Approved commands run with the user's host permissions. A native process can read inherited user-accessible files or invoke other programs. Scope checks constrain Bashwink file tools; they do not sandbox arbitrary programs. Show this at approval. Never turn a model response, repo instruction, or command output into consent. Retain existing hard denials where applicable.

**Design choices for the implementer.** Use TypeScript on Node 22+ and npm on all three operating systems. Use Node's fetch, streams, child processes and terminal/readline support. Keep alpha presentation line-oriented and interactive. Use an explicit model ID, one provider at a time, and no separate daemon. A task keeps context until completion or cancellation. Cross-session resume, multiple provider protocols, VM isolation and old advanced commands stay on the legacy release until deliberately reintroduced. These are scope choices for this proposal, not existing capabilities of the replacement.

## 4. Implementation order

Work in the existing repository on a rewrite branch starting from the identified baseline or its reviewed descendant. Do not nest a Git repo. Implement the tasks sequentially, with one coding agent. Every milestone ends in a runnable check. Preserve failing reproducers, record commands and actual exit codes, and fix the cause before claiming each check passed.

### A. Establish the replacement boundary

- [ ] Reconcile the repository guidance that currently prefers a shallow fork with the owner's standalone direction. Record the revised product scope in the architecture decision and task tracker before using historical phase evidence to schedule new work.
- [ ] Read `AGENTS.md` and its canonical phase/status documents. Inspect the task CSV, working tree and current branch. The old Phase 0/1 evidence covered the fork. Phase 2 remains open. Map applicable rows including BW-018, BW-055, BW-059, BW-075 and BW-091 to the new boundary; keep historical results identifiable. Record the replacement decision and its implications for ADR-001 and the old installer ADR. Evaluate and stop at the repository's phase gate when reached.
- [ ] Inventory actual dependencies from `release/npm/bin/bashwink.js`, `packages/bw-cli/src/bin.ts`, the Bashwink evidence workspace, root manifests, locks, build scripts and workflows. For each item record retain, adapt, isolate or retire. Pin the previous candidate and package digest for rollback. Decide which historical CLI commands need an explicit migration message; avoid forwarding unknown input to the old binary.
- [ ] Create the new entry point as an isolated build target in the same repo. Suggested location: `packages/bw-cli/src/standalone/`. Put the first integration test beside the target. Assert a fresh process draws a Bashwink task prompt while the fixture environment contains no engine manifest, upstream binary, provider key, or server. Capture the failing result against the old path before implementing.

### B. Deliver the terminal and one model exchange

- [ ] Implement `terminal.ts` and `provider.ts` under the standalone target. Keep UI input/output independent from the state machine. Handle non-TTY invocation with concise help or a documented `--help`, EOF and Ctrl+C cleanly. Preserve ordinary terminal scrollback. Render untrusted model or command text as text, including control characters. Write original visible copy, help and model instructions.
- [ ] Implement `complete(messages, tools, signal)` for the chosen chat-completions endpoint, returning final text or validated tool requests and optional usage. Test with a local fake server for correct URL and model, tool schemas, cancellation, 401, rate limiting, timeout, malformed data and lost connections. Bound request time and output size. Keep configuration in a user-owned Bashwink profile, outside the project; project files cannot replace the endpoint or credential.
- [ ] Run a real terminal test from a Git repository and from a plain directory. With an empty profile, reach the task prompt offline. Enter a task, select a local scripted provider through the UI, see its reply, resize, cancel and exit. Run `--version` and `--help` through the same entry point.

### C. Implement the task loop and built-in tools

- [ ] Add `task-loop.ts` and `tools.ts`. Keep tool schemas and dispatch in one fixed registry. Each result carries call ID, status and bounded output. Start with at most 20 provider requests per task, one active command and a two-minute default command timeout. Treat limits as product defaults. End with a clear reason on exhaustion, repeated identical failures, or cancellation.
- [ ] Handle unknown tools, duplicate IDs, malformed arguments, truncated responses and tool batches. Execute calls in order. Reject ambiguous calls before any side effect. A denied call returns a denial to the model. Repeated or uncertain writes and commands require a new human decision. Never automatically replay an operation after a crash or a lost response.
- [ ] List and read bounded text inside the selected workspace. Show each edit as a diff, bind approval to the paths and original content, recheck before applying and preserve line endings and executable mode. Refuse stale input or ambiguous replacements. Use safe same-directory temporary writes when replacing a file. A declined edit leaves the file intact.
- [ ] Bind command approval to the exact executable, args, working directory and project. Use argv-based execution and a deliberately small child environment. Handle native executables and Windows package-manager shims explicitly. Never interpolate model text into a shell command. Exercise Windows quoting, spaces, Unicode, missing programs, failures, output truncation, timeouts and termination of the spawned process tree. Deliver actual exit code or signal and bounded stdout/stderr to the loop.
- [ ] Drive a red-to-green fixture through the installed-style command. A real test starts red, the scripted model reads the file and proposes a change, the user approves, the command runs, and an independent rerun passes. Assert the exact changed files. Run the inverse case where the test still fails and verify the final screen reports it. Record model commentary separately from observed command results.

### D. Restore Bashwink safeguards and preserve user data

- [ ] Make trust visible at first use. Start a new project in read-only mode, explain what trusting its directory allows, and require the user to grant trust before enabling edits or commands. Trust alone never approves a specific action. Enforce the request and output-token limits before sending a model request. For a paid live qualification run, use a known price and an explicit budget, reserve the maximum cost before each request, and stop if the bound cannot be established.
- [ ] Evaluate `packages/bw-cli/src/trust.ts`, `packages/bw-evidence/src/scope.ts` and `recorder.ts` directly. Bring across relevant tests. Extract pure pieces when an import would pull the old plugin into the product. Keep protected config, credentials, evidence, Git internals, path escapes and symlink/junction escapes outside writable tool scope. Test both allowed and denied operations in trusted and untrusted workspaces. Bind decisions to canonical paths and recheck before mutation.
- [ ] Write a minimal run record with task outcome, files changed, action decisions and command results. Redact secrets before recording or displaying errors. If a required action cannot be recorded, stop before executing it. A failure after execution must report an uncertain outcome and must never repeat that action automatically. Test partial writes, cancellation and parallel CLI instances using distinct run IDs.
- [ ] Preserve legacy profile content and audit-chain hashes. Use a versioned standalone config. If offering import, preview supported provider settings and import references only on consent. Treat prior trust as unconfirmed; leave incompatible protocols and session databases intact. Test upgrade and rollback using disposable copies of an existing profile. A cancelled upgrade must keep the earlier CLI usable.

### E. Make the tester path one install and one command

- [ ] Replace the normal build and bin paths with the new application. Target the same commands on Windows PowerShell, macOS and Linux: from a clean checkout run `npm run install:local`; then from a fresh terminal in any project run `bashwink`. Implement and document that npm script. It should install locked build dependencies, compile, pack, smoke-test the exact tarball, and install it into the normal user npm prefix. Derive paths from the package and quote platform paths. Print actionable PATH guidance when the prefix is absent. Test the Windows PowerShell shim with the normal user policy and document the actual prerequisite if needed.
- [ ] Keep the artifact a portable JS npm package with a Node entry point. The source installer should need Node/npm plus the checkout. Exclude optional legacy workspaces from the lock, normal install and build. Verify no Bun, Python, Rust, Zig, native PTY, no-FFmpeg rebuild, or old local engine cache is needed. An invited tester holding the resulting tarball should also be able to use `npm install -g <tarball>`. Test `npm uninstall -g bashwink` and record retained user data. Private publication is a distinct owner decision.
- [ ] Update root and package READMEs, runtime prerequisites, support matrix, package files, notices and CI jobs. Verify the standard workflow from a clean clone with spaces in its path on a user account. Choose a distinct prerelease version before distribution so npm and testers can distinguish the standalone build from the fork. Tie the tag, tarball digest and evidence to the same commit.

### F. Prove independence, qualify platforms and retire the fork

- [ ] **Physical absence test.** In a disposable clean checkout omit the entire `vendor/engine` tree, previous build products and caches. Remove OpenCode, Hermes and Bun from the test PATH. Build using the documented tester command, then install the tarball in a separate directory with an empty user profile. Inspect package contents, dependency origins and the process tree. Exercise first run and a coding task with a loopback provider and upstream hosts blocked. Require zero attempts to call upstream services. Use controls that fail the audit when an upstream dependency or request is deliberately introduced.
- [ ] **Original experience test.** Capture what the installed tester actually sees in a terminal: home, provider setup, task input, edit preview, approval, test result, cancellation and help. Exercise the UI manually as well as through terminal automation. Check for inherited logos, welcome strings, command palettes and hidden upstream commands. Credits in licenses are expected. Confirm the command runs a foreground Bashwink process with only the user-approved coding commands as workload children. UI snapshots alone cannot prove ownership; pair them with the physical absence test.
- [ ] **Platform matrix.** Test Windows 11 x64 in PowerShell/Windows Terminal, macOS ARM64 and Intel, and Linux x64 and ARM64 on the advertised glibc and musl targets. For each row collect clean install, bare launch, onboarding, edit plus command, deny/cancel, failed upgrade, reinstall and uninstall. Record OS and arch, Node/npm, commit, package digest, exact commands and exit codes. Label hosted versus desktop and native versus emulated results. Where a host is unavailable, supply its executable CI job or manual recipe and mark the row unverified. A workflow definition is not a passing run.
- [ ] **Provider qualification.** Run deterministic fixtures with zero external model costs. Separately run one small real coding task with an authorized tool-capable model and cost cap before claiming that provider works. A working mock verifies protocol behavior; list live providers and platforms only where observed. Never package credentials.
- [ ] **Retirement.** Inventory all remaining references to the old engine in active manifests, locks, scripts, fixtures, CI, docs and runtime defaults. Move baseline-only tests off the default build graph while retaining historical evidence. After the replacement passes and reviewed removal is authorized, remove unneeded upstream source, builds and obsolete package paths in a dedicated commit. Retain credits for anything still shipped. Test recovery by reinstalling the recorded prior package with a backup of its own profile. Keep branch changes, hosted test runs, merging and distribution within the user's authorization.

## 5. Handoff and release evidence

**Verification commands to implement.** Keep the npm scripts platform-neutral. Each script must propagate a failing assertion or subprocess exit code to CI. The following names are deliverables of the rewrite.

| Command | What constitutes a pass |
| --- | --- |
| `npm run test:standalone` | Unit and fake-provider tests pass for validation, tool-result IDs, denial, budgets, cancellation, redaction and errors. A failed test command cannot appear as a successful check. |
| `npm run test:standalone:install` | A disposable prefix installs the exact tarball, finds the command in a new shell, runs it, replaces the package, rejects a broken replacement and uninstalls while preserving user data. |
| `npm run test:standalone:e2e` | Terminal interaction plus the red-to-green coding fixture pass using the installed executable, an empty profile and a scripted provider. Retain a transcript, diff, independent test result and evidence verification. |
| `npm run test:standalone:independence` | A fresh build and packaged E2E pass with both upstream applications absent. The planted dependency and network controls each trip the audit. |

**First deliverable:** a reviewer can type `bashwink`, see a Bashwink task prompt, and complete a text exchange with a scripted model on a machine that has never installed either upstream application. **Alpha deliverable:** the same user can approve an edit and a test command, see the exact result, interrupt the task, and uninstall. Finishing this plan requires evidence for each claimed platform; the existing fork's green runs are useful comparison data.

Report one row per OS/architecture/libc with install, launch, coding, cancellation, upgrade/recovery and uninstall. Use PASS, FAIL or UNVERIFIED with links. Include the candidate SHA and tarball hash, the observed process/dependency audit, scripted versus live provider results, the exact user commands and a short blocker list. Update the repository's canonical evidence and status files as work actually passes. Keep the existing release gates truthful if the product scope changes.

**Prompt for the coding agent**

> Read AGENTS.md and docs/superpowers/plans/2026-11-25-bashwink-standalone-alpha.md in the existing Bashwink repository. Use this standalone plan as the implementation direction. Execute it sequentially yourself. Start at A and deliver the Bashwink-owned task prompt and one provider exchange before expanding the tool set. Write the UI, provider adapter, single-agent loop and built-in tools for Bashwink. Preserve the specified Bashwink safety behavior. Work through the installed command and prove that a user can complete a task with both upstream applications absent. Fix blockers, record actual results per platform and stop at applicable repository gates. Report the exact install, launch and uninstall commands. Seek explicit authorization for destructive retirement, remote pushes, merges or distribution.
