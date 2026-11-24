# Alpha tester guide

This guide takes you from a fresh install to a reviewed change in your project.

## 1. Check the install

```sh
bashwink --version
bashwink doctor
```

`doctor` should show `Execution mode: ISOLATED VM`, `Host: macOS … arm64`, and `VM assets:
… match the pinned manifest`. A red line names what to fix. Before you add a provider the
`Model provider` line is red; that is expected.

## 2. Connect a model provider

Bashwink talks to the provider from your Mac, not from inside the VM. The VM never sees your
key. This alpha supports **CommandCode** (the only provider exercised end to end). Requests
may also be sent to the OpenAI or Anthropic endpoints through the same relay, but those have
not been tested live.

Put the key in a file only you can read, then declare the provider and pick a model:

```sh
umask 077
printf '%s\n' 'YOUR-KEY-HERE' > ~/.config/bashwink-commandcode.key

bashwink auth add commandcode \
  --base-url https://api.commandcode.ai/provider/v1 \
  --key-file ~/.config/bashwink-commandcode.key \
  --model claude-sonnet-5:anthropic --model gpt-6.1-sol:openai
bashwink model use commandcode/claude-sonnet-5
bashwink auth check commandcode
```

To use an environment variable instead of a file, replace `--key-file …` with
`--env COMMANDCODE_API_KEY` and export that variable in the terminal where you run
`bashwink`. Run `bashwink doctor` again: every line should be green or an expected warning.

Each session may make at most **8 model requests**. Raise it for one launch with
`BASHWINK_VM_MAX_REQUESTS=20 bashwink` (1 to 40). When the limit is reached the relay refuses
further requests and the session cannot continue until you start a new one. The usage line
printed when the session ends shows how many requests it used.

## 3. Start a session

```sh
cd /path/to/your/project        # must be the root of a Git checkout
bashwink
```

1. **Approve the project.** The first launch lists the files that will be copied into the VM
   and the provider that will receive their content. Answer `y` to continue or anything else
   to stop; declining starts nothing.
2. The VM starts (about five seconds on the test Mac) and the terminal UI opens. A banner
   before it and a short notice in the UI say `ISOLATED VM`, and a line `[SANDBOXED VM]` stays on
   screen for the whole session (on the home screen and beside the prompt).
3. Ask for a change in plain language. The agent edits its copy of your files. Shell commands
   such as `bun test` ask for your approval each time (`Allow once`).
4. Leave the UI with Ctrl+D on an empty prompt. Your work is saved.

A session ends on its own after about 30 minutes, with your work saved. Resume with
`bashwink --continue`.

## 4. Review and apply

Nothing changes in your project until you do this:

```sh
bashwink sandbox vm-review
```

It prints a diff of every added, modified and deleted file. Type `apply` to write them, or
anything else to stop. To apply only some files: `bashwink sandbox vm-review one.ts two.ts`.
Files are written one at a time, and a file changed on your Mac since the session started is
refused rather than overwritten.

Test files (`*.test.*`, `*.spec.*`, `test-*`) are protected: if the agent changed one, the
session is rejected. Run the tests you protected in a fresh VM with:

```sh
bashwink sandbox vm-verify
```

## 5. Continue later

```sh
bashwink --continue                 # the most recent session of this project
bashwink --session ses_…            # a specific one (printed when a session is saved)
```

Sessions are tied to the project, the provider and its list of declared models. Switching
between models you declared with `bashwink model use` is fine. Adding or removing a declared
model, or changing the provider, makes that project's saved sessions refuse to open: revert
the change, or review and apply what you want to keep and then delete that project's saved
state under `~/.local/share/bashwink/vm-projects/`.

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| `the isolated VM cannot start: macOS … is not a qualified host` | Your macOS build is not on the qualified list. Do not work around it; report the version and build. |
| `VM asset … integrity check failed` or `missing` | Reinstall from the archive (`./install.sh`). Launches refuse to start until the check passes. |
| `no model is selected` / `credential is missing` | Section 2. `bashwink doctor` shows which. |
| `… has not been approved` | Launch `bashwink` once in an interactive terminal and approve, or `bashwink trust <dir> --by "your name"`. |
| `reviewed apply is interrupted. Run bashwink sandbox vm-recover first` | Run `bashwink sandbox vm-recover`. It finishes or abandons the interrupted apply safely and can be repeated. A directory named `.bashwink-vm-apply-*` in your project is kept for inspection. |
| `VM owner exited with status N; stage retained` | The VM did not finish. The partial session is kept in a `/private/tmp/bashwink-vm-*` directory that Bashwink recorded. `bashwink sandbox stages` lists it; start again, and once you no longer need it, `bashwink sandbox stages --purge` removes the idle ones. Report the status and your `bashwink doctor` output. |
| A session reached the request limit | Start a new session, or raise `BASHWINK_VM_MAX_REQUESTS` (at most 40). |
| The UI looks garbled | Make the terminal at least 120×34. |
| Esc once does not stop a response | Press Esc twice, or Ctrl+C. |

Every refused launch is appended to `~/.local/share/bashwink/startup-failures.jsonl` (cause
and time, no credentials).

## Unrestricted mode (trusted projects only)

`bashwink --unsafe-local` runs the agent **directly on your Mac** with your files, network
and credentials. It exists for projects the VM cannot handle. It needs you to type
`I accept host access` after reading the risks, every time. Plain `bashwink` never starts it,
and no environment variable or setting can. Shell commands still ask first, and writes
outside the approved scope are still refused, but these are guard rails, not a sandbox: a
prompt-injected instruction that you approve runs with your full access. The terminal shows
`UNRESTRICTED HOST ACCESS` before the UI and in a notice inside it, and a line
`[UNSAFE LOCAL MODE]` stays on screen for the whole session.

## Reporting problems

Open an issue on the Bashwink repository. Include: the output of `bashwink --version` and
`bashwink doctor`, your macOS version and build, the last lines of
`~/.local/share/bashwink/startup-failures.jsonl`, and what you were doing. **Never paste an
API key.** `doctor` prints credential fingerprints, never values, and is safe to paste. For a
suspected security problem follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
