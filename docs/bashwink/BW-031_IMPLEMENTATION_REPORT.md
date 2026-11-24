# BW-031 native sandbox milestone

**Status** PARTIAL. Installed macOS offline TUI coding works for the disposable
mock fixture. The server and TUI both run inside Seatbelt. The admitted profile supports
in-process file edits. Shell-capable native startup is refused. Native admission for general projects
remains unavailable. The earlier diagnostic source milestone was `368f81173a5c39efc65ae020ac23f4333a682763`.
The installed CLI can execute the offline default-deny macOS Seatbelt probe. The probe
tests a disposable workload and optionally starts the staged native OpenCode binary with
`--version`. The probe remains available as a separate diagnostic.

## Run the milestone

From the Bashwink source checkout, use Bun 1.4.4 and an absolute path to the real,
trusted OpenCode v2.3.2 Mach-O binary. The package manager’s JavaScript shim is unsuitable
for this check.

```sh
workspace="$(mktemp -d)"
./scripts/build_alpha.sh "$workspace/install"
mkdir "$workspace/project"
cd "$workspace/project"
BASHWINK_OPENCODE_BIN=/absolute/path/to/opencode \
  "$workspace/install/bin/bashwink" sandbox probe
```

The probe emits a run ID, platform, architecture, kernel, launcher and optional runtime
SHA-256, the policy template SHA-256, phase and scoped verdicts. A missing explicit
runtime records its check as NOT_RUN. Invalid inputs, a failed kernel control, or a
missing platform/helper return a nonzero exit. The process uses a private scratch HOME
and XDG directories, a clean environment, explicit trusted system read rules and a
fixed `/usr/bin/sandbox-exec` launch. The staged executable is excluded from guest write
rights. Probe inputs and outputs are synthetic. No user project file is imported or changed.

`BASHWINK_BACKEND=native bashwink run …` refuses admission before spawning OpenCode.
Ordinary Bashwink remains on the existing permission-controlled host backend in this
milestone. It has unrestricted host access for commands allowed by policy. The native-first
switch and separately acknowledged local restart are outstanding.

## Source delivered

| File | Change |
| --- | --- |
| `packages/bw-cli/src/native-sandbox.ts` | Default-deny Seatbelt profile, temporary workspace, bounded probe invocations and OS observations |
| `packages/bw-cli/src/main.ts`, `packages/bw-cli/src/help.ts` | Installed probe command and documented mode boundaries |
| `packages/bw-cli/src/execution-backend.ts` | Explicit native-required coding refusal before runtime resolution |
| `packages/bw-cli/test/native-sandbox.test.ts` | Command-shape and native-required startup regression tests |
| `scripts/verify_native_release.py`, `scripts/test_native_release_gate.py` | Executable qualification gate and unit controls |
| `docs/bashwink/NATIVE_SANDBOX_QUALIFICATION.json` | Required release controls plus observed milestone evidence |

## Run the offline TUI

Use the installed CLI and the pinned native OpenCode v2.3.2 executable. The repeatable
qualification entry point starts a controlling PTY and its own offline fixture provider.

```sh
python3 fixtures/native-offline/run.py /absolute/path/to/bashwink \
  /absolute/path/to/native/opencode --output /absolute/path/to/disposable-results
```

The harness calls `bashwink sandbox offline <mock-port> --stage-file`. The command checks the fixture's
health marker, checks the pinned version in confinement and prepares a new private
workspace. It ignores project configuration and installs only Bashwink's packaged policy
plugin. OpenCode's owned server has a stdio lease and a single IPv4 loopback listener.
Its outbound grant is the fixture provider's specific TCP port. The TUI can reach only
its separately authenticated, workspace-scoped admission endpoint. Terminal ioctl access
targets its inherited PTY. The app retains private fixture state for observation and never
exports edits to the caller's checkout. Use this command only for the controlled fixture.

The host verified a durable session associated with the tool evidence.
Security of a production terminal boundary remains unqualified. [Recorded evidence](TEST_EVIDENCE.md).

## Recover and export a staged file

From the host directory containing the regular text file `task.txt`, start
`bashwink sandbox offline <mock-port> --stage-file`. This explicitly stages a copy of
that one file. The recovery profile denies process creation and shell execution. It also
checks the shell refusal through Seatbelt before starting OpenCode. A bare offline
invocation is refused before runtime startup. Historical shell-profile probes require
an explicitly supplied historical installation and the harness's `--baseline-shell` flag.
A shell-enabled stage cannot be reopened or exported.

Use the printed stage root with
`bashwink sandbox offline <mock-port> --stage <root> --continue` or replace
`--continue` with `--session <id>`. The launcher checks the registered stage directories,
policy and runtime/plugin fingerprint, saved session ownership, and the saved evidence
prefix. It then requires fresh attestation from the owned server and confirms the saved
session again over its authenticated API before starting the TUI.

From the original host directory run `bashwink sandbox export <root>`. The command
previews the bounded text change and waits for the exact word `apply` on a terminal.
It checks the original directory, file identity, timestamps, mode and SHA-256 base,
then uses a single same-directory atomic exchange. It verifies the displaced file and
retains it if a concurrent mutation makes recovery ambiguous. This fixture supports
one file and preserves ordinary permission bits. General project import, extended
file metadata, and atomic transactions across files remain unqualified.

If the exporter is interrupted, run `bashwink sandbox recover-export <root>` from
the original host directory. An intent binds the approved digest, prepared inode,
original destination and stage lock before exchange. The host records a durable
receipt only after it verifies the exact installed file and displaced base. Recovery
checks that same state under the stage lock, preserves ambiguous files and never
repeats the exchange. A missing intent, replaced destination or divergent content
keeps the stage quarantined. The receipt is host-side and leaves the session evidence
chain intact. Tests cover process interruption on the recorded macOS build. Power-loss
resilience and multi-file transactions remain unqualified.

## Workload lifetime and interruption

The historical shell fixture produced a disowned writer with parent PID 1 and a process
group and session distinct from the launcher. It survived normal TUI and server
shutdown and could still write to staging. The protected host canary remained
unchanged. Apple's launchd teardown targets the job's process group, so that behavior
cannot establish cleanup for this workload. Shell-capable supervision remains unqualified.
[Apple launchd manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).

The host acquires a private stage lock. Both owned OpenCode processes inherit the same
lock and must retain it after exec. A host-side descriptor inspection verifies the
staged executable and the lock inode before the admission endpoint accepts tool
requests. Shutdown closes admission before stopping the owned processes. Seatbelt
denied both fork and spawn in the active file-only profile. The comparison profile
allowed a disposable child to create a new session and a nested process.

After launcher death, run `bashwink sandbox recover <root>` from the host. Recovery
requires competing exclusive lock acquisition and a saved proof binding the
stage, lock, and profile. It checks the evidence prefix and retires recognized
readiness files and the activation interlock. It never sends signals to persisted
process IDs. A live writer, incomplete activation proof, corrupt evidence or
unreconciled export keeps the stage closed. Export takes the same lock and still
requires a separate reviewed apply. [Test evidence](TEST_EVIDENCE.md).

## macOS shell containment decision

Keep the current file-only profile available and develop shell execution as an
explicit, Docker-free Apple Virtualization.framework backend. The VM should be
owned by one trusted host process and contain the complete pinned Linux OpenCode
runtime, including tool code and subprocesses. Use a private staged disk, omit
shared directories and network devices, and make terminal and provider access
separate host interfaces. A future provider relay may use a narrow authenticated
virtio socket with checks on provider, operation, data size and request budget.
Provider credentials and approval remain on the host. The VM and relay must refuse
startup on an unsupported host or failed attestation.
[Apple Virtualization](https://developer.apple.com/documentation/virtualization/vzvirtualmachine) · [Apple virtio sockets](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdevice).

| Option | Boundary and failure behavior | Installation, portability and maintenance |
| --- | --- | --- |
| Seatbelt with stronger host supervision | Filesystem and network restrictions can survive shell dispatch. A detached host process escaped the available process-group cleanup. FD ownership and process observers cannot establish shell quiescence if code can close descriptors or reparent. | The system helper is already present on the test Mac and adds little startup cost. It is deprecated. Maintaining stronger tracking without a demonstrated OS-owned workload boundary would add security-critical complexity. |
| Apple Virtualization.framework | VM stop targets the guest CPU and devices irrespective of guest process groups. A private disk and no host shares exclude the host filesystem. A NIC-free VM needs a separately authenticated host relay. VM-owner death must be qualified separately from host CLI death when they use distinct processes. | Apple system framework requires an entitled signed helper and a guest kernel/userland. No third-party runtime daemon or user-managed VM is required by the proposed backend. Apple documents Linux guests for both CPU families. The fixture qualifies only Apple silicon on the tested build. Boot is a separate cost and interactive latency is unmeasured. Bashwink would own guest updates, signing, and image notices. |
| Apple Containerization | The package uses a Linux VM per workload and offers OCI image handling. The CLI also has a host service and default network. Deployment would have to prove owner-death handling, network refusal and credential separation with the selected integration. | Apache-2.0 library. Current macOS build targets Apple silicon and macOS 26 or later with Xcode 26. The CLI requires a separate installation. Upstream advertises fast starts. Bashwink has no measurements. Embedding the library adds an upstream Swift dependency and guest kernel maintenance. |
| Docker-backed execution | Docker Desktop runs Linux containers in a VM. Files and credentials remain exposed if bind mounted. Use an isolated backend with networking disabled and no Docker socket in the guest. A daemon can outlive the Bashwink launcher, so abrupt-death cleanup needs its own proof. | Separate engine installation and startup with Docker Desktop subscription terms on macOS. Useful as an optional backend. Startup and PTY latency depend on engine and image state, and were unmeasured. |
| File-only Seatbelt | The existing no-fork profile has verified filesystem controls, single-file reviewed export, and safe retirement under the inherited lock. Shell is disabled at admission. | No daemon or guest image. Installed real offline TUI verified on one macOS arm64 build. The narrow profile remains the lowest-maintenance verified mode. |

[Apple Containerization and license](https://github.com/apple/containerization) ·
[Apple container CLI and requirements](https://github.com/apple/container) ·
[Docker Desktop host boundary](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/) ·
[Docker Desktop licensing](https://docs.docker.com/subscription-billing/desktop-license/) ·
[Docker none network driver](https://docs.docker.com/engine/network/drivers/none/).

The disposable `fixtures/native-offline/vm-boundary.py` uses Apple Virtualization
directly with a pinned Alpine test kernel and userland. It has no Bashwink CLI
integration or provider relay. The guest inputs are fetched from the official Alpine
archive and checked against the fixture digests. They are supplied outside the
checkout and outside Bashwink packaging. Review guest component licenses and source
obligations before distributing a product image.
[Pinned Alpine archive](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/aarch64/) · [Executed evidence](TEST_EVIDENCE.md).

To repeat the VM lab, place the following Alpine 3.23.8 aarch64 files in a disposable
input directory. Save `netboot-3.23.8/vmlinuz-virt` as `vmlinuz`,
`netboot-3.23.8/initramfs-virt` as `initramfs-official`, and
`alpine-minirootfs-3.23.8-aarch64.tar.gz` as `root.tar.gz`. Run
`python3 fixtures/native-offline/vm-boundary.py <input-directory>` on Apple silicon
with Apple command-line build tools. The lab signs a temporary helper with the
virtualization entitlement. It compiles and runs outside the checkout, with a synthetic
disk and without installing a service.

## Pinned OpenCode inside the VM

The release-preparation fixture boots the built Bashwink bundle and OpenCode 2.3.2
under an unprivileged guest user in the same NIC-free VM. A serial terminal drives
the real OpenCode TUI using its normal private server and policy/evidence plugin.
The guest mock produced an edit and a shell request. The host observer submitted
the shell approval, saw the streamed completion, and inspected the two exact
result files on the sealed disk after VM stop. The host parsed one bounded sector
with a fixed inventory and verified hashes without mounting a guest filesystem.
This is a fixture handoff. Production workspace import, reviewed apply, and guest
session persistence remain open.

The VM owner also watches a host-only pipe from a distinct launcher. Killing that
launcher closed the pipe and caused whole-VM stop. The host independently checked
that the private stage stopped changing, and a fresh VM reopened its retained
marker. Forced stop, VM-owner SIGKILL, Ctrl+C, and the owner timer passed the same
disk check. The VM helper and pipe are exercised in the lab. Installed CLI
admission, the provider relay, and runtime/server crash behavior for the proposed
product backend remain open. [Release evidence](TEST_EVIDENCE.md).

To reproduce the OpenCode lab, run the same VM fixture with
`--opencode-inputs <directory>`. Supply the Linux arm64 musl binaries from
`@opencode/cli-linux-arm64-musl@2.3.2` and
`@oven/bun-linux-aarch64-musl@1.4.4` as `opencode` and `bun`. Supply Alpine
3.23 arm64 `libgcc`, `libstdc++`, and `ncurses-terminfo-base` APKs as
`libgcc.apk`, `libstdc++.apk`, and `ncurses-terminfo-base.apk`. The fixture
checks each exact digest before extracting the test inputs.

## Open work in order

1. Reproduce the Ubuntu readiness failure on a disposable Ubuntu x86-64 system. Use
   Bun 1.4.4 and OpenCode v2.3.2 and run `./fixtures/runtime-health/run.sh` with the
   exact installed runtime. Record the substep from the newer readiness diagnostic and
   resolve it before qualifying Linux.
2. Run native mounts, network namespace, seccomp and lifecycle controls with the distro
   Bubblewrap on an AppArmor-enabled host. Keep the macOS deny profile small and qualify
   it on each advertised release.
3. Build a guest OpenCode PTY fixture under Virtualization.framework. Qualify the
   launcher-to-owner lifetime, sealed stage transfer and retirement proof before
   adding shell-capable CLI admission. Extend reviewed export only after qualifying
   a portable project transaction, host metadata and write conflicts.
4. Implement the narrow host provider relay with credential separation. Qualify its
   negative controls, then exercise an authorized live provider and model switching.
5. Verify detached cleanup, resource limits and clean Docker-free installs through BW-032.
   Enable native-first admission and the explicit local fallback only with the supporting
   evidence. Keep external and public release blocked.

[Qualification results](BW-032_QUALIFICATION_RESULTS.md) · [Security model](NATIVE_SANDBOX_SECURITY_MODEL.md).
