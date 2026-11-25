# Alpha tester guide (standard mode)

## 1. Install and check

```sh
npm install -g ./bashwink-0.1.0-alpha.1.tgz
bashwink --version      # bashwink 0.1.0-alpha.1
bashwink doctor         # green or expected warnings; a red line names the fix
```

`doctor` before you add a provider reports a warning for models and credentials. That is expected.

Verify the file you were sent: the checksum in `SHA256SUMS` must equal the output of `shasum -a 256 <file>` (macOS,
Linux) or `Get-FileHash <file>` (Windows PowerShell). Do not install a file whose checksum differs.

## 2. Connect a model

Bashwink does not store keys. Put your key in an environment variable, or in a file only you can read, and declare the
provider once:

```sh
bashwink auth add myprovider --base-url https://api.example.com/v1 --env MY_API_KEY --model my-model:openai
bashwink model use myprovider/my-model
bashwink auth check myprovider
```

Providers that the runtime already knows (for example those listed by its own catalogue) also work with their usual
environment variable. See `SUPPORTED_PROVIDERS.md` in the repository documents for what has and has not been tested.
**Do not use a key you cannot afford to lose; set a spending limit at your provider.** Prefer `--key-file <path>` to
`--env`: the model's file tools cannot read a key file and Bashwink removes an `--env` key from shell commands' environment,
but no shell check is a sandbox (see SECURITY.md). On Windows keep the key file in your user profile.

Bashwink stops runaway work (300 model requests and 5 retries of one failing request per launch, by default) and prints
requests, tokens and an estimated cost when a session ends. Add a price to see a cost and to use a dollar limit:
`bashwink auth add ... --model my-model:openai --price my-model=3:15` (US dollars per million tokens, input:output).
Without a price the cost is shown as unknown. Limits: `BASHWINK_MAX_REQUESTS`, `BASHWINK_MAX_RETRIES`,
`BASHWINK_MAX_TOKENS`, `BASHWINK_MAX_COST_USD` (`bashwink --help` lists them). They are not a hard spending ceiling.

## 3. Work

```sh
cd my-project        # a Git repository, with your work committed
bashwink
```

On the first launch in a folder Bashwink asks whether to **trust** it. Trusting allows shell commands and writes in
that folder, each still subject to an approval. Declining is allowed: the session is read-only. A line at the bottom of
the screen, `[STANDARD - native, not a sandbox]`, stays on screen for the whole session.

You will be asked before a shell command runs. Read the command. Approving it runs it as you.

## 4. What is recorded

Each run writes a record and an append-only, hash-chained evidence log under your data directory (`bashwink doctor`
prints the path). `bashwink evidence status` shows whether evidence was recorded for the last run. The chain detects
accidental loss and edits inside the file. It is **not tamper-proof**: the same user account can rewrite or delete it,
and nothing here is a signed or externally witnessed attestation.

## 5. If something goes wrong

- `bashwink doctor` first. Attach its output to a report; it contains no keys.
- Ctrl+C ends a session. The run record is finalized on interrupt and termination signals.
- Undo with Git (`git diff`, `git restore`). Bashwink edits your working tree directly in this mode.
- Bugs and surprises: write down the command, what you expected and what happened. Do not paste keys or private code.

## 6. Remove

```sh
npm uninstall -g bashwink
```

This removes the program only. Settings, trust decisions, run records and evidence stay, so you can inspect them. To
delete them, remove the config and data directories that `bashwink --help` prints (or the directory you set with
`BASHWINK_HOME`) yourself, after checking they hold nothing you want.

Do not disable your operating system's security protections to use Bashwink. It does not need that.
