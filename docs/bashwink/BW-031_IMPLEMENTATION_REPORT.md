# BW-031 native sandbox milestone

**Status** PARTIAL. Installed macOS offline TUI coding works for the disposable
mock fixture. The server and TUI both run inside Seatbelt. The fixture can edit its staged
workspace and records real file and shell tools. Native admission for general projects
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

The harness calls `bashwink sandbox offline <mock-port>`. The command checks the fixture's
health marker, checks the pinned version in confinement and prepares a new private
workspace. It ignores project configuration and installs only Bashwink's packaged policy
plugin. OpenCode's owned server has a stdio lease and a single IPv4 loopback listener.
Its outbound grant is the fixture provider's specific TCP port. The TUI can reach only
its separately authenticated, workspace-scoped admission endpoint. Terminal ioctl access
targets its inherited PTY. The app retains private fixture state for observation and never
exports edits to the caller's checkout. Use this command only for the controlled fixture.

The host verified a durable session associated with the tool evidence. Restart and import
of retained session state still need a trusted reopening path. The abrupt launcher case
left a stale readiness file even though neither directly owned child was alive when
observed. Detached descendants and security of a production terminal boundary remain
unqualified. [Recorded evidence](TEST_EVIDENCE.md).

## Open work in order

1. Reproduce the Ubuntu readiness failure on a disposable Ubuntu x86-64 system. Use
   Bun 1.4.4 and OpenCode v2.3.2 and run `./fixtures/runtime-health/run.sh` with the
   exact installed runtime. Record the substep from the newer readiness diagnostic and
   resolve it before qualifying Linux.
2. Run native mounts, network namespace, seccomp and lifecycle controls with the distro
   Bubblewrap on an AppArmor-enabled host. Keep the macOS deny profile small and qualify
   it on each advertised release.
3. Extend the proven fixture workload with trusted reopening of staged sessions, reviewed
   import and detached-descendant observation. Keep the first prompt gated on fresh
   workload and plugin identity.
4. Implement the narrow host provider relay with credential separation. Qualify its
   negative controls, then exercise an authorized live provider and model switching.
5. Verify detached cleanup, resource limits and clean Docker-free installs through BW-032.
   Enable native-first admission and the explicit local fallback only with the supporting
   evidence. Keep external and public release blocked.

[Qualification results](BW-032_QUALIFICATION_RESULTS.md) · [Security model](NATIVE_SANDBOX_SECURITY_MODEL.md).
