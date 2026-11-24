# Known limitations — v0.1.0-alpha.1

Each entry says what is true now. Where something is unverified it says so.

## Projects the isolated VM can handle

The VM stages a **small, dependency-free Git project**. Specifically:

- You must start `bashwink` at the **root of a Git checkout** with at least one commit.
- Only **tracked, top-level** files named `*.ts`, `*.js` or `*.txt` are copied: at most 64
  files, each at most 256 KiB, UTF-8 text, no symlinks, and no names that look like
  credentials (`secrets.*`, `*token*`, `credentials.*`, `private-key.*`).
- **Everything else is invisible to the agent**: sub-directories, `package.json`, lock files,
  `.tsx`/`.py`/`.json`/`.md`, untracked and ignored files, `.env`. The approval prompt shows
  how many tracked entries are not staged.
- A project with no eligible file, more than 64, a larger file, a binary file or a tracked
  symlink with an eligible name is refused with an error; nothing is silently included.
- The VM has **no network**, so nothing can be installed or fetched. Only code that runs with
  the guest's BusyBox tools and Bun (for example `bun test` on plain TypeScript) works.

For anything larger use unrestricted mode, which has none of these protections (below).

## Limits on a session

- One session ends after about 30 minutes; work is saved and `bashwink --continue` resumes.
- At most 8 model requests per session by default (1 to 40 through
  `BASHWINK_VM_MAX_REQUESTS`). The limit counts failed requests too.
- The VM has 2 virtual CPUs and 1.5 GiB of memory.
- The guest terminal is fixed at 120×34. Resizing your window is not propagated.
- One session per project at a time. Concurrent sessions in different projects were not tested.
- Pressing Esc once may not stop a response; press Esc twice or Ctrl+C.

## Providers

CommandCode is the only provider exercised against a real endpoint. The OpenAI and Anthropic
endpoints are allowed by the relay and covered by synthetic tests only. Provider-specific
behaviour not listed in the qualification record is unverified. Rate-limit and server-error
handling was tested with synthetic upstreams, not by exhausting a live quota.

## Applying changes

- Changes are applied **one file at a time**. Each file is replaced atomically, but a
  multi-file apply is **not** one atomic transaction: if the process dies part-way, some files
  are applied and some are not until `bashwink sandbox vm-recover` completes or abandons the
  batch. Recovery was exercised by killing the process at defined points and is safe to repeat.
- **Power loss and operating-system crashes were not tested.** Do not rely on durability
  across them.
- A directory named `.bashwink-vm-apply-*` left in your project is kept on purpose when an
  apply was interrupted before its identity was recorded. Inspect it, then delete it.
- Only the files the agent added, modified or deleted among the staged ones can be applied.

## Where data lives

- A session that ends normally leaves no copy of your project in `/private/tmp`. A session
  that fails, is killed, or loses power keeps `/private/tmp/bashwink-vm-*` (your project
  files and session state, readable only by you) until you delete it or run
  `uninstall.sh --purge-state`.
- Saved sessions, approvals and evidence live in `~/.local/share/bashwink` and
  `~/.config/bashwink`. Evidence is tamper-evident (hash-chained), not tamper-proof: someone
  who can write the file can truncate it or rebuild the chain.

## Platform

- Only the macOS build named in `qualified-hosts.json` starts the VM. It was exercised on an
  M1 MacBook Air with 8 GB. **It was not qualified on a clean host**: the only machine used
  has Docker installed and had earlier development builds of Bashwink on it.
- The VM helper is signed ad hoc, not with a Developer ID, and the archive is not notarized.
  The installer removes the download quarantine flag from the installed files after it has
  verified them.
- Linux, Windows and Intel Macs are unsupported.

## Licensing

The guest and host OpenCode binaries are the stock upstream builds. They contain a
statically linked LGPL-2.1-or-later FFmpeg inside `libopentui` (see the project's FFmpeg
decision record). Distributing them to others needs the project owner's sign-off. The notices
and the relinking route are in `share/licenses/`.

## Unrestricted mode

`bashwink --unsafe-local` has the access you have: files, network, credentials. Approvals and
refusals still apply but are guard rails. Detached background processes it starts are not
guaranteed to stop when Bashwink exits. It uses the OpenCode runtime in this archive and
ignores `BASHWINK_OPENCODE_BIN`.

## Not provided

Auto-update, Windows or Linux support, signed or notarized packages, multi-project
workspaces, dependency installation inside the VM, project files beyond the supported
profile, and budget controls beyond the per-session request limit.
