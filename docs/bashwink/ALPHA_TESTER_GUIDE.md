# Bashwink — Alpha Tester Guide

For the first small group of developers. Read `KNOWN_LIMITATIONS.md` first; it is short and it
will save you a bad afternoon.

**What Bashwink is:** a thin, evidence-first launcher over a pinned OpenCode runtime. Inference,
streaming, tool calls and the TUI are the runtime's. Bashwink adds provider configuration without
storing keys, model selection and switching, a path fence on tool calls, and a hash-chained
record of what the agent did.

This alpha is a source build for supervised use in trusted workspaces. Shells retain host access, and live provider evidence covers one paid provider plus the runtime gateway.

---

## 1. Install

The supported alpha install builds the source from a private checkout. Use Bun 1.4.4. The
following procedure was exercised on macOS arm64. Hosted Ubuntu checks cover the pinned
runtime. Windows is unsupported.

```bash
git clone https://github.com/ALDRIN121/bashwink.git
cd bashwink
git rev-parse --short HEAD       # audited b38dd51 baseline, or 4731eaf with identical runtime code
bun --version                    # 1.4.4
bun install --frozen-lockfile

# Keep the public runtime separate from the Bashwink workspace.
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/bashwink-runtime.XXXXXXXX")"
(
  cd "$runtime_dir"
  printf '%s\n' '{"name":"bashwink-alpha-runtime","private":true,"trustedDependencies":["@opencode/cli"]}' > package.json
  bun add @opencode/cli@2.3.2
)
export BASHWINK_OPENCODE_BIN="$runtime_dir/node_modules/.bin/opencode"
test -x "$BASHWINK_OPENCODE_BIN"
version_home="$(mktemp -d)"
XDG_DATA_HOME="$version_home" "$BASHWINK_OPENCODE_BIN" --version  # opencode v2.3.2

./scripts/build_alpha.sh
export PATH="$PWD/dist/bashwink/bin:$PATH"
bashwink --version
bashwink doctor
```

Choose a persistent directory for the separate runtime if the install should survive temporary
directory cleanup. Update `BASHWINK_OPENCODE_BIN` if you relocate it. The trust declaration
lets Bun run the OpenCode postinstall that places the platform executable. The wrapper
resolves this variable before consulting the working directory or PATH. Check the executable's
own version in a disposable XDG home. `doctor` labels the expected pin based on resolution and
may report warnings while exiting successfully.

The built directory contains `bin/bashwink`, `lib/bashwink.js`, `lib/version.json` and
`lib/evidence/`. Move that directory as a unit. Keep Bun and the separately installed
OpenCode binary available. To uninstall, remove the wrapper directory, its PATH entry, the
separate runtime if it was dedicated to Bashwink, and any Bashwink XDG state you choose to discard.

---

## 2. Point it at a model

You need one of:

- an **OpenAI-chat** or **Anthropic-Messages** compatible endpoint with an API key, or
- the runtime gateway (`opencode/*` models), if an available model is exposed by the pinned runtime.

Configure a provider by reference. The Bashwink config stores the reference instead of a literal key.

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
bashwink trust . --by "Your name"   # records operator approval for this workspace
bashwink                   # interactive TUI in this directory
```

`bashwink` with no arguments starts the interactive session in the current directory. The
workspace and the active model are shown in the TUI's status bar. Works in Git and non-Git
directories. Bare `bashwink` prints help when neither stdin nor stdout is a terminal.

Non-interactive:

```bash
bashwink run --auto "fix the failing test in src/calc.py"
bashwink run --auto --model myprovider/gpt-6.1-sol "explain this repository"
```

With the evidence plugin loaded and the policy present, an untrusted workspace refuses
recognized write and shell calls. Trust a workspace only after reviewing its files and expected
commands. Leave evidence collection enabled and supervise this alpha.

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

On the foundation working tree, risky native tool actions request approval by default. Shell
access is disabled when a contract narrows paths or commands. An allowed shell still runs with
the invoking user's access and is recorded as `unconstrained`.
For a task that does not need the recognized shell tool, set `constraints.forbiddenCommands` to
`["shell"]` in a reviewed contract specification and approve that contract. The `--forbid`
flag concerns paths. Other tool surfaces and host execution remain outside the fence.

---

## 5. Reading what happened

```bash
bashwink evidence status              # recent runs: exit code, evidence state, plugin
bashwink evidence export              # markdown: checks, tool events, models used
bashwink evidence export --json       # machine-readable
bun run packages/bw-evidence/src/cli.ts verify /path/to/evidence.jsonl  # from the source checkout
```

When `BASHWINK_HOME` is set, the log is `$BASHWINK_HOME/data/evidence/evidence.jsonl`.
The default uses `$XDG_DATA_HOME/bashwink/evidence` or `~/.local/share/bashwink/evidence`.
Match tool call IDs across `before`, `after` and `denied` records, and check whether model
attribution was reported. Allowed shell calls are recorded as `unconstrained` when the fence
applies.

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
- The foundation launcher starts a private standalone service. `bashwink backend` reports the
  local mode. Set `BASHWINK_TIMEOUT_MS` for an optional runtime deadline. Detached children
  may outlive the wrapper. [Backend behavior](BW-030_EXECUTION_BACKEND_DESIGN.md).

---

## 7. What to expect at this stage

| Area | State |
| --- | --- |
| Real coding tasks (read, edit, run tests) | Works; verified on three tasks |
| Model selection and switching | Verified across invocations and two wire protocols. TUI picker switching remains untested |
| Model attribution in evidence | Works; 0 unattributed calls in the verified runs |
| Path fence for file tools | Works; traversal, absolute and symlink escapes refused |
| Shell containment | **Guardrail only** — recorded, not prevented |
| Trust gate | Covers recognized writes and shell when policy and evidence plugin are loaded |
| Windows | Untested |
| Cost ceilings | Not implemented |
| Test-integrity protection | Not implemented |
| Package-manager install | Not available |

If something in the last four rows matters to you, say so — that ordering is a choice, and it is
worth revisiting.
