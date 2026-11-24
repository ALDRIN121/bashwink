# Root cause of the intermittent guest-TUI boundary fixture failure

**Verdict: a test-harness observation defect, not an isolation defect.** No assertion was weakened,
removed or retried until green; the fixture's approval step now uses a signal that cannot be
repainted away.

## Symptom

`fixtures/native-offline/vm-boundary.py --opencode-inputs` (the legacy single-prompt guest-TUI
fixture) failed with `VM owner exited with 0` at roughly one run in ten. Before the fix it was seen
failing 5 times in 29 runs, and a negative control (below) failed 2 times in 40.

## Mechanism (from a captured failing run)

In the failing capture OpenCode raised **two** permission dialogs. Its own state events show it:
`OSC 7501 state=blocked:kind=permission` at byte offsets 26,497 and 32,839, with a working state in
between. The text `Allow once` appears **once** in the whole byte stream (offset 30,438), belonging to
the first dialog.

A terminal UI repaints only the cells that changed. The second dialog has the same option row as the
first, so no new `Allow once` bytes are written. The fixture approved a tool only after seeing
`Allow once` after that tool's marker; for the second tool (the shell command) it never did, never
sent Enter, and the guest's own 28-second execution deadline ended the session with
`execution deadline expired`. A person looking at the screen sees the dialog throughout; only a
byte-stream reader loses it, and only when the repaint happens not to include the option row.

## Isolation defect or harness defect?

| Question | Answer |
| --- | --- |
| Did the shell tool run in failing runs? | No. It was never approved, so `sh check.sh` never executed and no `BW_VM_OPENCODE_PASS` was written. The fixture's host-side assertions (exact disk contents after the VM stopped) were therefore never evaluated, not failed. |
| Did any isolation observation fail in any run? | No. In every passing run the host read the exact stage contents after the VM stopped and the protected host files were unchanged. |
| Startup ordering, VM readiness, plugin registration, tool-server readiness, permission-policy activation | The dialogs were raised in every failing run: the policy was active and the TUI ready. |
| Timeout behaviour | The 28 s guest deadline is correct; it fired because the approval never came. It was not raised or retried. |
| Process termination, resource exhaustion, cross-run contamination | Each run uses a fresh disk and boot. Failures were not correlated with prior runs except two adjacent failures in the negative control, consistent with a repaint-timing pattern, not state carried over. |

## Fix

`fixtures/native-offline/run.py` gains `permission_dialogs()` and `DialogApprover`, which count dialogs
from OpenCode's state events and answer each once. The two guest-TUI fixtures
(`vm-boundary.py`, `vm_project_acceptance.py`) use it. All host-observed assertions are unchanged.
`test_permission_dialogs.py` pins the failing situation (two dialogs, one `Allow once`) from the real
event sequence, and the same function reports 2 dialogs and 1 `Allow once` on the real failing
capture.

## Evidence

| Run set | Result |
| --- | --- |
| Original text-based detection, various reruns before the fix | 5 failures in 29 runs |
| New detection, 40 independent boots of one built image | **40 passed, 0 failed** |
| Original logic restored (`--approval-detection text`) on the same driver and image, 40 boots | **2 failed, 38 passed**: same symptom, same message |
| New detection inside the exact-candidate run | recorded in the RC2 qualification results |

Statistics are modest and are not the argument: the mechanism was demonstrated directly in a
failing capture, and the control shows the old logic still fails on the same image.

## Not changed

`fixtures/native-offline/run.py`'s cursor-based approval for the Seatbelt-era fixtures was not
touched; those fixtures are development experiments, not part of the release.
