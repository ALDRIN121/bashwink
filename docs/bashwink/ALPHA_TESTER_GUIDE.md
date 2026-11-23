# Bashwink — Alpha Tester Guide

For the first small group of developers. Read `KNOWN_LIMITATIONS.md` first; it is short and it
will save you a bad afternoon.

**What Bashwink is:** a thin, evidence-first launcher over a pinned OpenCode runtime. Inference,
streaming, tool calls and the TUI are the runtime's. Bashwink adds provider configuration without
storing keys, model selection and switching, a path fence on tool calls, and a hash-chained
record of what the agent did.

**What it is not:** a sandbox, a installer, or a multi-provider guarantee.

---

## 1. Install

There is no package registry install. `npm install -g bashwink` will fail — `@bashwink/evidence`
is private and cannot resolve. The supported path is a build from a checkout.

```bash
git clone https://github.com/ALDRIN121/bashwink.git
cd bashwink

# Pinned toolchain. Bun 1.4.4 is what the suite is verified under.
bun --version          # must be 1.4.4

# The runtime Bashwink wraps — exact version, not "latest".
bun add @opencode/cli@2.3.2

# Build a relocatable install into dist/bashwink
./scripts/build_alpha.sh

# Put it on PATH
export PATH="$PWD/dist/bashwink/bin:$PATH"
bashwink --version     # -> bashwink 0.1.0
```

`build_alpha.sh` produces a directory you can move anywhere:

```
dist/bashwink/
  bin/bashwink          launcher
  lib/bashwink.js       the CLI, bundled
  lib/version.json      version + build id
  lib/evidence/         the evidence/fence plugin, as source the runtime loads
```

To install elsewhere, copy that directory and add its `bin` to `PATH`. Nothing inside it refers
back to the checkout — verified by grepping the build for source paths.

**Uninstall:** delete the directory and remove it from `PATH`. Then, if you want the state gone
too, delete `~/.bashwink` (or whatever `BASHWINK_HOME` you set). Nothing is installed outside
those two locations.

---

## 2. Point it at a model

You need one of:

- an **OpenAI-chat** or **Anthropic-Messages** compatible endpoint with an API key, or
- the runtime's built-in free catalogue (`opencode/*` models), which needs no configuration.

Configure a provider — the key is never written to disk:

```bash
bashwink auth add myprovider \
  --name "My Provider" \
  --base-url https://api.example.com/v1 \
  --env MY_API_KEY \
  --model claude-sonnet-5:anthropic:200000:8192 \
  --model gpt-6.1-sol:openai:200000:8192

export MY_API_KEY=...          # the runtime reads this variable
bashwink auth status           # presence, length, fingerprint — never the value
bashwink model use myprovider/claude-sonnet-5
```

The `id:protocol:context:output` suffix matters. `:anthropic` and `:openai` are the two supported
wire protocols. If your provider serves models on different protocols, give each model its own —
a provider-level protocol would be applied to all of them and would fail at the first request.

Prefer a key file over an environment variable?

```bash
printf '%s' "$MY_API_KEY" > ~/.keys/myprovider
chmod 600 ~/.keys/myprovider          # Bashwink warns if it is group/world readable
bashwink auth add myprovider --key-file ~/.keys/myprovider ...
```

`bashwink auth add --key <literal>` is **refused**: a literal key in a config file is one
`git add -A` from disclosure.

---

## 3. First run

```bash
cd ~/code/some-project
bashwink doctor            # everything it needs, and a fix for each warning
bashwink trust .           # REQUIRED before the agent may write or run commands here
bashwink                   # interactive TUI in this directory
```

`bashwink` with no arguments starts the interactive session in the current directory. The
workspace and the active model are shown in the TUI's status bar. Works in Git and non-Git
directories. Bare `bashwink` with output piped prints help instead, because a TUI cannot render
into a pipe.

Non-interactive:

```bash
bashwink run --auto "fix the failing test in src/calc.py"
bashwink run --auto --model myprovider/gpt-6.1-sol "explain this repository"
```

### Trust is a real switch, not a prompt

An untrusted workspace refuses **every** file write and **every** shell command, regardless of
what the model asks for. `bashwink trust .` is what allows them, and it is recorded with your
attribution. Do not trust a directory you have not read.

---

## 4. The fence

If the current plan has an approved contract, its `allowedPaths` becomes an enforced policy:

```bash
bashwink plan new "fix the arithmetic bug" --files=src/calc.py
bashwink contract new --allow src --forbid test_calc.py --max-files 5 \
  --negative "must not modify the test file"
bashwink contract show
bashwink contract approve --by "you"
bashwink run --auto "fix the bug in src/calc.py"
```

Now only `src/` is writable. A write to `../anything`, `/anything`, or through a symlink is
refused before the tool runs, and the refusal is recorded:

```
DENIED write | 'tests/a.ts' resolves to /repo/tests/a.ts, which is outside this task's
             allowed paths (/repo/src).
```

Reads and the shell's working directory stay at the repo root — narrowing those blinded the agent
and made `pytest` impossible when this was first tried.

**What the fence does not do:** it does not stop a shell command from writing through an
interpreter. Every permitted shell call is recorded as `unconstrained` for exactly that reason.
If you need a hard boundary for a task, forbid `shell` in the contract:

```bash
bashwink contract new --allow src --forbid shell ...
```

Then only file tools run, and those are path-bounded.

---

## 5. Reading what happened

```bash
bashwink evidence status              # recent runs: exit code, evidence state, plugin
bashwink evidence export              # markdown: checks, tool events, models used
bashwink evidence export --json       # machine-readable
bashwink run packages/bw-evidence/src/cli.ts verify <log>    # verify the hash chain
```

The evidence log is `$BASHWINK_HOME/data/evidence/evidence.jsonl`. Each tool call appears as a
`before`/`after` pair, attributed to the model that served it. Denials appear as `denied`.
Shell calls appear as `unconstrained`.

**Exit codes:** `0` success · `1` refused or a check failed · `2` usage · `3` the evidence plugin
did not initialise (the run is **unverified**, not successful) · `127` runtime not found.

---

## 6. Reporting a problem

Please include:

```bash
bashwink --version
bashwink doctor
bashwink evidence status
```

and the relevant part of `$BASHWINK_HOME/opencode/log/opencode.log`. **Do not** paste API keys;
`bashwink auth status` prints only a fingerprint, and that is enough for a bug report.

Useful things to know about what you are testing:

- The runtime is pinned to 2.3.2. A bug that reproduces upstream is upstream's, and worth
  reporting there too.
- If a launch fails with a message about a managed service port, a previous session is still
  holding it. Exit the other session, or `kill <pid>` as the message suggests.
- A session that dies mid-run may leave a stale service behind; the next launch reports it rather
  than hanging.

---

## 7. What to expect at this stage

| Area | State |
| --- | --- |
| Real coding tasks (read, edit, run tests) | Works; verified on three tasks |
| Model selection and mid-session switching | Works; verified across two wire protocols |
| Model attribution in evidence | Works; 0 unattributed calls in the verified runs |
| Path fence for file tools | Works; traversal, absolute and symlink escapes refused |
| Shell containment | **Guardrail only** — recorded, not prevented |
| Trust gate | Enforced |
| Windows | Untested |
| Cost ceilings | Not implemented |
| Test-integrity protection | Not implemented |
| Package-manager install | Not available |

If something in the last four rows matters to you, say so — that ordering is a choice, and it is
worth revisiting.
