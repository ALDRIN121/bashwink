# Internal alpha readiness

**Supervised internal alpha: CONDITIONAL.** Use the functionality covered by `b38dd51` on trusted, disposable or backed-up projects, with an operator present and scope, commands and changes reviewed. The audited `4731eaf` shares that runtime code. The newer hosted run at `4731eaf` is incomplete because one macOS job never ran. Fresh local source-build and real-runtime checks are recorded separately. Personal development falls under the same precautions. [CI reconciliation](CI_BASELINE_RECONCILIATION.md) · [Test evidence](TEST_EVIDENCE.md).

**External developer alpha: FAIL. Public release: FAIL.** The missing BW-031 sandbox is the primary external blocker. Phase 2 receipt, protected-test and alpha-artifact criteria remain open. Unattended use lacks hard execution and spend stops. General distribution requires its own artifact and release review.

## Supported install and demonstration

Use Bun `1.4.4`, a private source checkout and a separately installed `@opencode/cli@2.3.2`. Follow the [exact install commands](ALPHA_TESTER_GUIDE.md#1-install), including the postinstall trust setting and exported runtime binary path. `build_alpha.sh` creates a relocatable Bashwink wrapper and evidence plugin. The host supplies Bun and OpenCode. A clean macOS arm64 archive install, build, `--version`, and `doctor` from an unrelated directory were exercised. Ubuntu has hosted runtime integration coverage. This audit did not repeat the full source-build procedure on Linux. Windows is outside the supported alpha scope.

Use a fresh Bashwink home and a trusted project root. `bashwink trust . --by "Your name"` records the trust decision. Bare `bashwink` launches the pinned TUI from a terminal. A bare invocation with neither stream a terminal displays help. Use the verified CommandCode route for a real-model demonstration where the operator has approved provider access and project disclosure. The preserved coding demonstration edited `calc.py`, ran its tests, and continued the session. This audit independently verified the surviving trace, unchanged test file and passing fixture without issuing a paid request. The OpenCode gateway transport has historical evidence. DeepSeek and Ollama Cloud were blocked by billing, Copilot OAuth and local Ollama remain unverified, and model switching through the TUI picker remains unverified.

## Conditions and gaps

| Severity | Condition or gap | Impact and verification | Release effect |
| --- | --- | --- | --- |
| High | ScopeFence and trust operate through the loaded evidence plugin. Shell runs with the user's permissions and inherits environment | Keep evidence on, avoid unattended runs and use supervised trusted workspaces. Validate the diff and run checks independently. See `scope.ts` and `main.ts` | BW-031 blocks external alpha |
| High | No protected-test inventory or hard budget | Retain baseline checks outside the agent's control. Operator stops unexpected or expensive work. BW-057/BW-058 and BW-075 remain open | Protected tests block Phase 2. Hard budgets are required for unattended use |
| Medium | Cancelled macOS jobs in the later hosted runs | Record baseline and individual job coverage. Keep the existing matrix and review fresh results for changed code | Conditional use of the documented baseline |
| Medium | Single writer, detectable startup gaps and incomplete evidence integrity | Isolate homes per run, verify the chain and check the actual tool/test output. Record mid-session failure as uncertain | Residual internal alpha risk |
| Medium | Provider and installation scope is narrow | Clean local source-build is fresh evidence. Archived live provider coverage is limited to one paid provider and a gateway. A separate signed artifact and dependency advisory validation still lack evidence | External distribution requires release-specific review |

The supported flow and troubleshooting are in [ALPHA_TESTER_GUIDE.md](ALPHA_TESTER_GUIDE.md). The evidence and restrictions are tracked in [ALPHA_RELEASE_CHECKLIST.md](ALPHA_RELEASE_CHECKLIST.md) and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
