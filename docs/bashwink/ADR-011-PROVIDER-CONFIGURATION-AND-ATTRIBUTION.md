# ADR-011 — Provider configuration, model selection and attribution

**Status:** accepted (2026-11-23)
**Supersedes:** nothing. Extends ADR-003 (thin wrapper over the pinned runtime) and ADR-006
(fixtures and mock provider).

## Context

Alpha needs a real model. That raised three questions the existing ADRs did not answer:

1. Where does provider configuration live, and who writes it?
2. How does a user choose and switch a model?
3. How does the evidence chain say **which model** produced a change?

The temptation was to add a provider client. That would be a second inference engine: its own
streaming, tool-call handling, retries and error normalisation, all drifting from the pinned
runtime the evidence chain is built on. ADR-003 already forbids that, so the question became
what the *wrapper* should own.

## Decision

**The runtime performs inference; the wrapper owns configuration, selection and attribution.**

Specifically:

1. **Provider config is written by the wrapper, read by the runtime.** `bashwink auth add`
   writes `<config>/opencode.json`, which is the file the runtime already reads through
   `OPENCODE_CONFIG_DIR`. No new config format, no new loader.

2. **A key is never stored.** `--env VAR` declares a variable; `--key-file PATH` declares a
   file the runtime substitutes as `{file:...}` at run time. `--key` is refused with the reason
   ("one `git add -A` from disclosure"). `auth status` reports presence as length plus a
   truncated SHA-256 — never a prefix or suffix, because a "last four characters" habit narrows
   a key search.

3. **Wire protocol is per model, stated explicitly.** A provider's `package` applies to *every*
   model it declares, so a mixed provider carries per-model packages and **no** provider-level
   one. `--model id:anthropic` is how a user states it. Inference from the provider id was
   rejected: it works for famous providers and silently mis-routes custom ones, and the failure
   is a request-time error far from the config.

4. **`model list` reports the config, not the catalogue.** The live catalogue needs a server;
   printing a stale list as if it were the catalogue would be an unverified claim. `bashwink
   models` (forwarded) answers the live question.

5. **Attribution comes from the runtime's events, per session.** The plugin subscribes to
   `session.step.started` and `session.model.selected`, keeps a per-session model map, and
   stamps each tool entry. An entry written before a model is known carries **no** model field —
   the configured default is never substituted, because "what I asked for" and "what served it"
   are different facts. A switch is its own chain entry naming both models.

## Consequences

**Good**

- The config is the runtime's own, so a user can edit it, and `bashwink` stays a thin launcher.
- A credential failure is caught before a server starts, with the variable named.
- Evidence can answer "which model made this edit?", including after a mid-session switch.
- No second inference path exists to drift.

**Costs and accepted limitations**

- Mixed-protocol providers require the user to state the protocol. Accepted: a wrong guess is a
  distant runtime failure, and a correct statement is one flag.
- `model use` validates against the config, not the endpoint: an unknown-but-valid model is
  rejected until it is declared. Accepted: validating against the endpoint would make an
  unexpected network call at config time.
- Event shapes are read from a probe of the real binary. **A runtime bump must re-run that
  probe before the pin moves** — recorded in `LLM_INTEGRATION_AUDIT.md`.
- Attribution degrades silently if the runtime stops emitting those events: entries simply have
  no model, and the export adds a limitation saying so. That is deliberate — a missing
  attribution is honest, a fabricated one is not.

## Alternatives rejected

- **A Bashwink provider client** — a second inference engine; violates ADR-003.
- **An OAuth credential store of our own** — the runtime already has integration flows; a second
  store doubles the places a token can leak from.
- **Inferring protocol from `models.dev`** — correct for catalogued providers, silently wrong for
  custom ones, and the failure surfaces at request time.
- **Filling attribution from the configured model** — would make every entry look attributed and
  silently mis-attribute work after a switch. This is the failure mode the design exists to
  avoid.
