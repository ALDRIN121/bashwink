# LLM Integration Audit

**Status:** complete for the current increment — priority 1 of the first private alpha.
**Date:** 2026-11-23
**Bashwink task:** BW-091 (provider configuration surface, model selection, model attribution)

Sources read for this document, with exact revisions:

| Project | Revision | Notes |
| --- | --- | --- |
| OpenCode | `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` (`release: v2.3.2`) | The pinned runtime. Every claim about runtime behaviour below was checked against this tree **and** against the built 2.3.2 binary. |
| Hermes Agent | `3b421578588243f920886e6fe79a6faa87ea026e` | Read for architectural comparison only. No Hermes code is vendored or imported. |
| Bashwink | `f8fa85a` + this increment | Branch `main`. |

The distinction that matters throughout: a claim marked **verified** was executed against
the real binary; a claim marked **read** comes from the source tree only. I have not written
"verified" anywhere that was not run.

---

## 1. OpenCode provider architecture (v2.3.2)

**Provider registry.** Providers are registered through a plugin transform pipeline, not a
static table. `packages/core/src/config/plugin/provider.ts` folds every config entry into a
`providers` map; `packages/core/src/plugin/models-dev.ts` adds the catalogue from models.dev.
Both push models into a `ProviderDomain` / `ModelDomain` that a plugin can transform
(`packages/plugin/src/promise/model.ts`, `provider.ts`). The consequence for Bashwink: the
catalogue is **dynamic**, so a wrapper cannot know the live model list without asking the
runtime (`opencode models`). Bashwink therefore does not claim to.

**Authentication.** Two layers:
1. Long-lived integrations with OAuth (`packages/core/src/plugin/provider/github-copilot.ts`
   uses a device flow) or a device/key method, stored in a credential store.
2. Per-provider `env: [...]` declarations, where each named variable is treated as a key
   (`packages/core/src/plugin/models-dev.ts:43-60`). Config text also supports
   `{env:VAR}` and `{file:path}` substitution (`packages/core/src/config/variable.ts`).

**Verified:** `{env:VAR}`, `{file:path}` and a bare `env: [...]` declaration all authenticate
against a real OpenAI-compatible endpoint. **Verified:** Bashwink never has to read the key
value — it only declares where one lives.

**Wire protocol selection.** The load-bearing discovery, and the one that cost the most time.
A provider's `package` field chooses the transport for **every model of that provider**. Model
entries may each carry their own `package`, and when they do the provider-level field must be
omitted — it is applied to all models and will mis-protocol the others.

**Verified failure:** a provider declaring `@opencode/ai/providers/openai/chat` with a Claude
model produced, at the first request:

```
Error: Model "claude-sonnet-5" must be called via /provider/v1/messages (Anthropic Messages shape).
```

Nothing failed at load time. The config validated; the provider listed; the failure arrived
one step into a session. Per-model `package` fixed it (verified: both `anthropic` and
`openai/chat` models then served on one provider id).

**Model reference.** `provider/model`, split on the **first** slash
(`packages/schema/src/model.ts:28-30`), so `commandcode/deepseek/deepseek-v4-flash` is a legal
reference. Bashwink's parser matches this.

**Streaming and tool calling.** Owned entirely by the runtime. Text arrives as
`session.text.delta` events and is rendered progressively; tools run under an
`execute.before` / `execute.after` hook pair (`packages/plugin/src/promise/tool.ts:55-78`).

**Model identity per request.** `session.step.started` carries
`model: { id, providerID, variant }`; `session.model.selected` carries the same plus
`previous`. **Verified** by loading a probe plugin into the real binary and dumping the event
stream — these shapes are observed output, not type inference. This is what makes honest
attribution possible: the wrapper knows what it asked for, the runtime knows what served it,
and only the runtime's answer is evidence.

**Errors and retries.** Retry and provider-error normalisation live in
`packages/ai/src/provider-error.ts` and the `aisdk` layer. Bashwink does not wrap them.

---

## 2. Hermes provider architecture (for contrast)

Read-only comparison; nothing here is copied.

**Provider resolution.** A configured `providers:` block plus `custom_providers:`, resolved
into a client at start-up (`agent/agent_init.py`, `agent/client_lifecycle.py`). Provider
entries carry `base_url`, `api_key`, `api_mode` and a model map — closer to Bashwink's config
than to a plugin registry, because Hermes owns its inference loop rather than delegating it.

**Model aliases and profiles.** Aliases let one logical name resolve to a concrete model, and
profiles bundle provider + model + settings. This is a genuinely useful idea Bashwink does not
have. It is **not** needed for alpha: alpha needs one model to work reliably, and an alias
layer is indirection on top of a resolution path that is currently one string.

**Fallback chains.** An ordered list tried when the primary is exhausted
(`agent/agent_init_fallback.py`, `agent_init_fallback.py:_fallback_entries`). Deliberately out
of scope: an automatic fallback silently changes which model produced a change, and the
evidence chain would then have to explain a substitution the user never asked for. If Bashwink
ever adopts this, the substitution must be an evidence event, not a retry detail.

**Auxiliary model selection.** A separate, usually cheaper model for titles, summaries and
compaction (`agent/auxiliary_client.py`, and the `auxiliary:` config block). Worth having
later for the same reason Hermes has it, but it multiplies the model-attribution surface: every
auxiliary call is another model in the evidence log. Deferred until attribution is stable.

**Context management and recovery.** Compression and session-resume machinery, aimed at
long-lived conversational sessions. Bashwink's sessions are shorter and the runtime already
compacts; nothing to adopt now.

**What is worth adopting, later, in order:**
1. **Aliases** — the one concept with a clear payoff for a user who switches between a cheap
   and an expensive model by task.
2. **Auxiliary model** — after attribution covers more than one model per run.
3. **Fallback chains** — only with the evidence-event requirement above.

**What must not be adopted:** a second inference path. Hermes owns its loop; Bashwink
deliberately does not (ADR-003), and a second engine would need its own streaming, tool-call
and retry behaviour that would drift from the pinned runtime the evidence chain is built on.

---

## 3. What Bashwink now implements

New in this increment, all in `packages/bw-cli/src/`:

| Module | Responsibility | Tests |
| --- | --- | --- |
| `providers.ts` | Protocol↔package mapping, config read/write, credential references, fingerprints, pre-flight | 40 |
| `providers-cli.ts` | `auth status\|add\|remove\|check`, `model list\|use\|current` | 26 |

Design rules these modules follow, each one bought with a reproduced failure:

1. **Write the config, never store the key.** A literal key in a config file inside a user's
   project is one `git add -A` from disclosure. `--key` is refused with that sentence; `--env`
   and `--key-file` are the supported routes. **Verified:** after a real run, the key value
   appears in no file under the install or data directories.
2. **Never report a secret.** Presence is reported as length plus a truncated SHA-256 digest —
   no prefix, no suffix. A "last four characters" habit narrows a key search. Tested by
   scanning for every 4-character window of a sentinel value.
3. **Per-model protocol is explicit.** Guessing from the provider id (as models.dev does for
   *known* providers) would work for famous providers and silently mis-route for custom ones.
   The `--model id:protocol` suffix makes it a decision the user makes once.
4. **The live catalogue is the runtime's answer.** `bashwink model list` reports what the config
   declares and says so; `bashwink models` (forwarded) answers the live question. A wrapper
   printing a stale list as if it were the catalogue would be an unverified claim.
5. **A credential failure is named before the runtime starts.** With an explicit `--model`,
   Bashwink checks the declared credential route and fails with
   `export COMMANDCODE_API_KEY=... and re-run` instead of letting the runtime say
   `Invalid 'Authorization' header or token.` after a server has started. **Verified** both
   paths.

### Model attribution in evidence

The gap this closes: evidence said a tool ran, but not **which model** asked for it. After a
mid-session switch, a log without attribution makes every prior entry ambiguous.

The plugin subscribes to `session.step.started` and `session.model.selected`, keeps a
per-session model map, and stamps each tool entry with the model that served it. Deliberate
properties:

- **Per session, not per process.** One plugin process can serve several sessions; a single
  "current model" would attribute one session's edits to another's model. Tested with two
  concurrent sessions.
- **Never backfilled.** An entry written before any model is known carries no model field. The
  configured default is *not* substituted, because the configured model and the serving model
  are different facts.
- **Switches are their own entry**, naming both models, so a change is visible even when no
  tool was called across it.
- **Bounded on the way in.** A model id is caller-supplied text. It is truncated exactly like
  any other payload — including on the path where the recorder attaches the session's model
  after sanitisation, which was a real bypass until a test caught it.

**Verified** on a real run: 14 entries, 6 tool calls, **0 unattributed**, and the export's
`## Models` table reporting `commandcode/claude-sonnet-5 | 6 calls | 1 step | switched: no`.
**Verified** across a switch: `step model=commandcode/claude-sonnet-5` followed by
`step model=commandcode/gpt-6.1-sol variant=default`.

---

## 4. Reused from OpenCode, not reimplemented

Explicitly **not** Bashwink's code, and should not become so:

- Inference, streaming, SSE handling, token accounting.
- Tool execution, permissions, snapshots, diff/undo.
- Session storage, compaction, resume.
- Provider SDK loading, retries, error normalisation.
- The model catalogue (models.dev) and OAuth flows for hosted integrations.

Bashwink's surface is: the config file the runtime reads, the credential *reference*, the
`--model` it passes through, the plugin hooks, and the evidence chain. That is the whole
increment.

---

## 5. Known compatibility limitations

1. **Protocol inference is not automatic.** For a provider models.dev does not know, the user
   must state the protocol. For a *known* provider the runtime can infer from its catalogue
   entry. Bashwink does not attempt to read models.dev to guess; a wrong guess is a runtime
   failure far from the config.
2. **Model ids are validated against the config, not the endpoint.** `bashwink model use` rejects
   a model the provider does not *declare*. It cannot know what the endpoint would accept
   without making a request, and making one at config time would be a surprise network call.
3. **The live catalogue needs a server.** `bashwink models` starts one (the runtime's own
   behaviour). Bashwink's `model list` deliberately does not.
4. **`opencode` provider works without configuration.** The runtime's built-in gateway
   (`opencode/*` models) needs no Bashwink config and was used as the second, independent
   transport in testing. It is not a substitute for a second credentialed provider.
5. **Windows unexercised.** All verification here is macOS arm64 plus Linux CI.
6. **Runtime pin.** Everything above is true of 2.3.2. The event shapes used for attribution
   are read from a probe, so a runtime bump must re-run that probe before the pin moves.

---

## 6. Alpha release risks

Ordered by what would actually hurt a first user.

1. **No OS containment (BW-031).** Since the provider increment, BW-059 added an
   `execute.before` policy for recognized tools. Permitted shell commands retain host
   access, and the policy depends on the loaded evidence plugin and scope. External alpha
   remains blocked on an enforced OS boundary. [Review and plan](BW-031_IMPLEMENTATION_PLAN.md).
2. **One verified paid provider.** `commandcode` was verified end to end. Ollama Cloud and
   DeepSeek both returned HTTP 402 (no credit); GitHub Copilot needs interactive OAuth. So the
   multi-provider claim rests on one paid provider plus the runtime's free gateway. See the
   matrix in `TEST_EVIDENCE.md` — the gateway row is **not** a second credentialed provider.
3. **Credential handling is honest but not hardened.** No keychain integration; `{env:...}` and
   a 0600 file are the routes. A world-readable key file is reported, not refused.
4. **Evidence is tamper-evident, not tamper-proof.** The chain proves entries were not edited,
   deleted or reordered in place; it cannot prove nothing was removed from the end, and anyone
   with write access can recompute a consistent chain. Stated in every verification result.
5. **No cost control.** `session.usage.updated` events carry cost, but nothing stops a run.
   BW-075 (BudgetPilot) is unstarted.
6. **First-run experience is unproven.** A new user has no provider; `doctor` tells them what
   to run, and that path is tested, but nobody outside this machine has done it.

---

## 7. Recommendation

The integration work is internally consistent and verified: configure a provider without
storing a key, select a model, switch it mid-session, run real tools against a real repository,
and read back an evidence log that names the model per call. That is a usable coding workflow.

Use the supervised internal alpha conditions in [INTERNAL_ALPHA_READINESS.md](INTERNAL_ALPHA_READINESS.md).
The external-alpha hold remains in place while BW-031 and the Phase 2 release gate are open.
