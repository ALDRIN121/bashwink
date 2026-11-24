# Bashwink v0.1.0-alpha.1

An evidence-first coding agent. In this release the agent works inside a virtual machine
on a **copy** of your project, and your project changes only when you review and apply the
result.

> **Alpha, macOS Apple Silicon only.** Read [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
> first: this alpha stages only small Git projects of top-level `.ts`, `.js` and `.txt`
> files, and the VM has no network, so it cannot install dependencies.

## Requirements

| | |
| --- | --- |
| Mac | Apple Silicon (M-series). Intel Macs are unsupported. |
| macOS | Only builds listed in `qualified-hosts.json` start the VM. This release lists macOS 27.0.1 (build 26A434). Any other build installs but refuses to start the VM. |
| Memory | The VM takes 1.5 GiB of guest memory plus overhead. The whole workload measured about 0.9 GB while idle on an 8 GB Mac. |
| Disk | About 714 MB installed, plus saved sessions. The archive is about 334 MB. |
| Git | `/usr/bin/git` must work (installed with the Xcode Command Line Tools). Projects must be Git checkouts. |
| Terminal | 120 columns by 34 rows or larger. |
| Provider | A CommandCode API key (see the tester guide). |
| Not needed | Docker, Podman, Homebrew, Node, Bun, Xcode, administrator rights. |

## Install

Download the archive and `SHA256SUMS` into the same folder, then:

```sh
shasum -a 256 -c SHA256SUMS          # must print: bashwink-0.1.0-alpha.1-macos-arm64.tar.gz: OK
tar -xzf bashwink-0.1.0-alpha.1-macos-arm64.tar.gz
cd bashwink-0.1.0-alpha.1-macos-arm64
./install.sh
```

The installer verifies every file against `MANIFEST.sha256`, copies the release to
`~/.local/opt/bashwink/0.1.0-alpha.1`, links `~/.local/bin/bashwink`, and edits nothing else.
If `~/.local/bin` is not on your `PATH`, it tells you how to add it. Compare the checksum
against the value published with the release through a channel you trust; a checksum that
arrives with the archive proves only that the download was not corrupted.

## Start

```sh
cd /path/to/your/project      # the root of a Git checkout
bashwink
```

The first launch in a project shows what will be copied and asks you to approve it. Run
`bashwink doctor` first if anything looks wrong: it checks the host, the VM image and your
provider, and names what to fix. If the VM cannot start, Bashwink says why and stops before
any model request. It never falls back to running on your Mac.

First-time setup, reviewing and applying changes, and resuming a session are in
[ALPHA_TESTER_GUIDE.md](ALPHA_TESTER_GUIDE.md).

## Uninstall

```sh
~/.local/opt/bashwink/0.1.0-alpha.1/uninstall.sh                 # removes the program
~/.local/opt/bashwink/0.1.0-alpha.1/uninstall.sh --purge-state   # also deletes sessions, evidence, approvals, settings
```

Your projects are never touched. Without `--purge-state` your saved sessions, evidence and
provider settings stay in `~/.config/bashwink` and `~/.local/share/bashwink`.

`--purge-state` lists what it will delete and asks you to type `delete`. It removes VM stage
directories **only if this installation recorded them, they are still the directories it
recorded, and no session is using them**. It never deletes something because its name looks like
a Bashwink directory: stages from other installations, older builds or other tools are reported
and kept. `bashwink sandbox stages` shows what is recorded and what would be removed; add
`--purge` to remove the idle ones without uninstalling.

## Other documents

[RELEASE_NOTES.md](RELEASE_NOTES.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) ·
[SECURITY.md](SECURITY.md) · `share/licenses/` (Bashwink licence and third-party notices) ·
`RELEASE_MANIFEST.json` (versions, hashes, sizes, sources of every component).

Reporting problems: see the end of the tester guide.
