# Release notes — v0.1.0-alpha.1 (release candidate)

**Platform:** macOS on Apple Silicon only, restricted to the macOS builds in
`qualified-hosts.json` (this release: 27.0.1, build 26A434). Linux, Windows and Intel Macs
are unsupported and are not tested.

**Status:** a local release candidate. It has not been published. The checks that would
make it suitable for external testers are not all complete; see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and the qualification record in the repository.

## What this release is

- `bashwink` starts an isolated Linux virtual machine (Apple Virtualization framework, no
  network device, no shared folders) and runs the pinned OpenCode 2.3.2 agent inside it on a
  copy of your Git project.
- Your project changes only after you review a diff and type `apply`.
- Model requests go through a host-side relay that holds your key, allows only the approved
  provider hosts, enforces a per-session request limit, and never gives the key to the VM.
- If the VM cannot start, Bashwink stops before any model request or tool call, says why,
  records the failure, and never runs the agent on your Mac instead.
- `bashwink --unsafe-local` is a separate, explicitly acknowledged mode that runs on your
  Mac with your access. Its state is labelled in the terminal and inside the UI.

## Changes from the previous development builds

- The release build selects the VM by default and ignores the old environment switches that
  chose a backend or a provider (`BASHWINK_BACKEND`, `BASHWINK_VM_PROVIDER`). The provider is
  the one that owns your selected model.
- A self-contained archive: CLI, Bun, OpenCode, the VM kernel and image, the VM helper, the
  provider relay, the evidence plugin, installer, uninstaller, notices and manifest.
  Nothing is read from a source checkout.
- First-launch workspace approval that lists the files and the receiving provider.
- A VM image integrity check on every launch, pinned to the digest this CLI was built with.
- The host qualification check (macOS build) on every launch.
- Sessions can run for about 30 minutes (previously about 100 seconds), and work is saved if
  the time limit ends the session.
- The temporary VM stage directory is removed after a session's checkpoint is saved.
- The execution mode is shown before the UI, inside it, in `bashwink doctor`, and in run
  records.
- Evidence plugin now also contributes the in-UI mode notice.

## Verified in this candidate

See the qualification record for commands, exit codes and the host used. Summary:
installation from the archive with a fresh home and scrubbed environment; the VM project
workflow (edit, review, apply, protected tests, resume) against the release image using a
synthetic provider; unrestricted-mode acknowledgment and its preserved approvals; refusal
paths (missing, corrupt or tampered assets, unqualified host, missing provider, declined
approval); and the full unit and integration suite.

## Not verified

- A clean Apple Silicon host without Docker: not available during qualification. All runs
  were on the engineering Mac, which has Docker installed.
- Hosted CI for the candidate commit.
- Live-provider runs of the release archive (coding, model switching, cancellation) unless
  stated in the qualification record.
- macOS builds other than 27.0.1 (26A434).

## Components

Versions, hashes, sizes and licences of every component are in `RELEASE_MANIFEST.json` and
`share/licenses/THIRD_PARTY_NOTICES.txt`. Bashwink is MIT licensed.
