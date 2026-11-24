# Security — v0.1.0-alpha.1

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's private
vulnerability reporting (GitHub: *Security* → *Report a vulnerability*) and include the
version, your macOS version and build, and the steps to reproduce. Never include an API key.

## What this release is designed to do

Bashwink runs an AI agent that reads untrusted text (your repository, tool output, model
replies) and can ask to run commands. The release treats that agent as untrusted.

| Boundary | Design | Evidence recorded in the qualification record |
| --- | --- | --- |
| Where commands run | An Apple Virtualization VM with no network device and no shared folders. The agent runs as an unprivileged user in the guest. | Probed from inside the release guest with a synthetic model: only the loopback interface, no route, public and gateway fetches "Network unreachable", DNS failing, no host paths, user `nobody`, the raw stage disk unreadable and unwritable, no shared mounts. Engineering host only. |
| Your project | The agent edits a copy. Changes reach the project only through a diff you approve, applied one file at a time with host-side conflict checks. Test files are protected. | Exercised with SIGKILL at defined points, conflicting host edits, links and tampered receipts. |
| Provider key | Read on the host and used only by the host relay. The VM holds a random per-session capability that is useless elsewhere. | Key bytes were not found in guest state, terminal transcripts or usage records. |
| Provider traffic | Only approved provider hosts, public addresses, bounded request and response sizes, a deadline, and a request count per session. | Synthetic upstream tests, including failure, interruption, replay and budget cases. |
| Failure | Any inability to start the VM stops the launch before a model request. There is no fallback to host execution. | Exercised for missing, corrupt and tampered assets, an unqualified host, a missing provider, and a declined approval. |
| Install integrity | SHA-256 of the archive, a per-file manifest verified at install, and a pinned digest of the VM image checked on every launch. | Exercised, including a tampered archive and a tampered installed asset. |
| Host mode | Only `--unsafe-local`, after a typed acknowledgment, labelled in the terminal and inside the UI. | Exercised with a mock model: denial, approval prompt, decline and approve. |

## What it does not protect against

- **A hostile user or malware on your account.** The CLI, its manifest and the VM image are
  files you own; anything that can write them can replace them. The pinned digest detects
  accidental damage and tampering with the VM image, not replacement of the CLI itself.
- **Flaws in macOS, the Virtualization framework or the Linux guest kernel**, and side
  channels. No VM is a perfect boundary.
- **Your model provider.** Prompts, file contents and tool output are sent to the provider
  you configure. Do not stage files you would not send to it.
- **Unreviewed approval.** If you approve a command or apply a diff without reading it, the
  protections cannot help.
- **Unrestricted mode**, by design.
- Power loss and operating-system crashes during an apply were not tested.

## Supply chain

The archive includes unmodified upstream binaries pinned by SHA-256 in
`share/doc/inputs.lock.json`: Alpine Linux 3.23.8 kernel and userland, OpenCode 2.3.2 and Bun
1.4.4. `RELEASE_MANIFEST.json` lists their hashes and sources. No dependency audit against an
advisory database was run for this release.

## Credentials in the archive

None. The archive contains no key, token or personal path. The installer writes only under
the prefix you choose and the `bashwink` link.
