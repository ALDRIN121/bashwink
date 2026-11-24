# Acceptance tester guide

Use this guide for supervised pre-release acceptance on a disposable project. Inviting
external testers requires a passing release gate and owner approval.

Install the exact archive on a fresh Apple Silicon account. Record the macOS build,
archive checksum, commit, enabled backend, policy digest, and runtime version. Start
from an ordinary shell with no source checkout on PATH.

Run one realistic coding change through plain `bashwink` using the verified provider.
Observe the in-process edit and a separately approved shell/test command. Independently
compare the resulting diff and test baseline, check the protected host canaries, and
verify that the workload cannot write after retirement. Reopen the conversation, verify
the evidence, and uninstall. Record missing or aborted checks explicitly.

[Acceptance results](ACCEPTANCE_RESULTS.md) · [Privacy and feedback](FEEDBACK_GUIDE.md)
