# Bashwink — Known Limitations

**Applies to:** the v0.1 alpha candidate, working tree at the time of writing.
**Read this before trusting any claim Bashwink makes about itself.**

Each entry states what is true, what the consequence is, and whether a workaround exists. Where
an item is a deliberate trade-off it says so; where it is simply unfinished it says that instead.
Nothing here is softened, because an alpha tester who discovers a limitation the docs hid has
been misled twice — once by the tool and once by its documents.

---

## 1. Tool policy and host access

BW-059 checks recognized reads, writes, patches and shell requests when the evidence plugin
loads an active scope policy. It resolves known path targets physically. Untrusted workspaces
deny recognized writes and shell calls under this policy.

- Permitted shells and their descendants run with the invoking user's filesystem, environment
  and network access. Working-directory and argument checks only see the parsed request.
  The `unconstrained` event describes that residual access.
- Unknown tools or unrecognized argument shapes can pass the hook. `BASHWINK_EVIDENCE=off`
  removes the plugin and its ScopeFence hook. A missing policy also leaves the hook without
  scope to enforce, and a policy-write failure produces a warning.
- Forbidding the recognized shell tool in an approved contract reduces available execution.
  It does not establish an OS boundary. BW-018 remains open for broader command-path controls.

Supervised use requires a trusted workspace, evidence collection on, and independent review
of the diff and checks. External alpha is blocked on OS containment. The [BW-031 plan](BW-031_IMPLEMENTATION_PLAN.md)
recommends a Docker-first adapter and a controlled host provider relay. It remains a proposal.

---

## 2. Verified providers — one paid, one gateway

| Provider | Transport | Status |
| --- | --- | --- |
| CommandCode (`api.commandcode.ai`) | Anthropic Messages + OpenAI chat | **Verified end to end** — completions, tool calls, file edits, tests, model attribution |
| OpenCode gateway (`opencode/*`) | runtime-internal | **Verified** — but this is the runtime's own free catalogue, **not** a credential you configured |
| DeepSeek | — | **Not tested:** HTTP 402, insufficient balance |
| Ollama Cloud | — | **Not tested:** HTTP 402 |
| GitHub Copilot | device OAuth | **Not tested:** needs an interactive device flow |
| Local Ollama | — | **Not tested:** no daemon running |

**Consequence.** Multi-provider support is implemented and exercised across two wire protocols
on one provider, but "works with many providers" is **not** a verified claim. If your provider is
not in the first row, you are the first person to try it.

**Workaround.** `bashwink auth add` accepts any OpenAI-chat or Anthropic-Messages compatible
endpoint. `bashwink auth check <id>` tells you whether the credential resolves before you spend a
session finding out.

---

## 3. Windows is untested

**What is true.** Every verification run — local and CI — is macOS arm64 and Linux. CI has both
legs; Windows has none.

**Consequence.** Path containment is separator-aware (`/a/bc` is not inside `/a/b`), but the
Windows-specific behaviours are unexercised: drive letters, UNC paths, case-insensitive
filesystems, and whether `realpath` resolves junctions the way it resolves symlinks. A fence bug
on Windows would be a **security** bug, not a cosmetic one.

**Workaround.** None. Do not run the alpha on Windows expecting the fence to hold.

---

## 4. Installation is a build, not a package

**What is true.** `scripts/build_alpha.sh` produces a relocatable directory
(`bin/bashwink`, `lib/bashwink.js`, `lib/evidence/`) that runs outside the source checkout. This
is the supported path and it is verified.

**What is not true.** `npm install -g bashwink` does not work, and `bun add` of the packed
tarballs fails. `@bashwink/evidence` is `private: true` with a `workspace:*` dependency, so it
cannot resolve from a registry at all.

**Consequence.** Alpha testers need a checkout, Bun 1.4.4, and the pinned runtime. That is a
developer audience, not a user audience.

**Workaround.** Follow [ALPHA_TESTER_GUIDE.md](ALPHA_TESTER_GUIDE.md) for the separate pinned runtime and exported binary path.

**Binary distribution.** There is no signed binary, no checksum manifest, and no notarisation.
Code signing and macOS notarization have no alpha artifact evidence.

---

## 5. Evidence integrity: tamper-evident, not tamper-proof

**What the chain verifies.** The entries present are consistent with their predecessor hashes.
It detects inconsistent edits, interior deletions and reordering.

**What it cannot prove.** That nothing was removed from the **end**. Anyone who can write to the
log can truncate it and the remaining prefix still verifies. And anyone with write access can
recompute an entirely consistent chain from scratch.

**What it does not cover.** The runtime's own logs, the SQLite database, and the working tree are
not chained. Bashwink's evidence is about what the agent *did*, not a proof about the repository.

**Consequence.** Treat the log as a high-quality audit trail, not as cryptographic proof of
authorship. If you need attested evidence, that is ProofPack (BW-060), which is unstarted.

---

## 6. Cost and runaway protection are absent

**What is true.** `session.usage.updated` events carry token counts and cost, and the evidence log
records them.

**What is not true.** Nothing stops a run. There is no budget, no turn ceiling, and no
no-progress detector. A model that loops will loop until you interrupt it.

**Consequence.** The first unattended run can be expensive. BudgetPilot is BW-075 and is
unstarted.

**Workaround.** Watch the first runs, and prefer `--standalone` so a single Ctrl-C ends it.

---

## 7. Test integrity is not protected

**What is true.** A TaskContract requires every declared check to have a passing observation
before a task can be marked `verified`, and the gate is enforced in the store as well as the CLI.

**What is not true.** Nothing stops the agent from **editing the test** so it passes. TestGuard
(BW-058) and the immutable baseline (BW-057) are unstarted.

**Consequence.** "Tests pass" can mean "the tests were changed". Every claim in
`TEST_EVIDENCE.md` about fixtures passing was produced by a human running them, not by the agent
under test — but a user's own runs are not protected this way.

---

## 8. Concurrency and sessions

- **One writer per evidence log.** There is no locking; two runs against the same
  `BASHWINK_HOME` can interleave. Sessions are per-directory in the runtime, and Bashwink does
  not add a second layer.
- **A killed session leaves the runtime's managed service behind**, holding its port; the next
  launch then fails during start-up. Bashwink now reads the runtime's log and reports this with
  the PID and how to clear it, rather than blaming the evidence plugin — but it cannot prevent
  it.
- **`--session` resumes across a model switch** and that is verified; concurrent sessions sharing
  one model map is handled per session, not per process.

---

## 9. Model and authentication coverage

- **No model aliases, fallback chains, or auxiliary-model routing.** Deliberate: each multiplies
  the model-attribution surface, and an automatic fallback would change which model made a change
  without the evidence saying so.
- **Wire protocol must be stated per model** when a provider serves more than one (e.g.
  `--model claude-sonnet-5:anthropic`). A provider-level package applies to every model, so a
  mixed provider must not have one. Getting this wrong fails at the first request, not at
  start-up.
- **OAuth-only providers (GitHub Copilot, and similar) are not supported by `bashwink auth`.**
  They require the runtime's own interactive login, and Bashwink does not wrap it.
- **`model list` reports the config, not the live catalogue.** `bashwink models` asks the
  runtime, and needs a server. The distinction is deliberate; a stale list presented as the
  catalogue would be an unverified claim.
- **No local-model runtime is bundled.** Ollama and vLLM work only through a
  provider that speaks one of the two supported protocols.

---

## 10. An unrecognised subcommand is forwarded to the runtime

`bashwink <typo>` passes the word to the runtime, which treats it as a directory and fails with
`chdir ... -> 'frobnicate'`. Bashwink now reports that honestly — "the runtime exited 1 before any
evidence was written, so no work is known to have happened" — and exits 1. It is still a poor
error, and there is no `sessions` subcommand (the runtime spells it `session`), so a user looking
for session management will hit this.

## 11. What the fence does not manage

- **Workspace trust controls the loaded tool policy.** `bashwink trust <dir> --by "Your name"`
  records trust for a reviewed directory. The active plugin refuses recognized writes and shell
  in an untrusted workspace.
- **`allowedPaths` from a contract are resolved relative to the run's working directory.** A run
  started from a subdirectory therefore fences that subdirectory's interpretation of the same
  paths. Start runs from the repository root.
- **The policy is written once per run.** A mid-run edit to `data/scope.json` does not change
  what the running plugin enforces — it read the policy at setup — but it will change the *next*
  run. Treat that file as part of the run's inputs, not as state.
