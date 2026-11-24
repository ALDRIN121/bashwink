# Supervised tester guide

External alpha remains blocked. There is no qualified release archive or supported
clean installation. The current VM evidence comes from a locally assembled macOS
Apple Silicon fixture on macOS 27.0.1 build 26A434. Do not distribute it as a release.

A normal development build does not include the VM assets. With no VM assets or
explicit VM selection, plain `bashwink` starts the permission-controlled local runtime
with host access. It is not an isolated coding session. Selecting the VM without its
assets fails closed.

For a locally provisioned relay-enabled VM fixture, use a disposable Git project and
configure an authorized provider without putting a key in the command or repository:

```sh
bashwink auth add commandcode \
  --base-url https://api.commandcode.ai/provider/v1 \
  --env COMMANDCODE_API_KEY \
  --model claude-sonnet-5:anthropic:200000:1024
bashwink model use commandcode/claude-sonnet-5
export BASHWINK_VM_PROVIDER=commandcode
cd /path/to/disposable-project
bashwink
```

The variable must be available to the host process. Keep its value out of logs,
terminal captures and feedback. In the TUI, approve only the actions intended for the
fixture. Press Escape twice to interrupt an active model response. Ctrl+C was also
observed to close an active provider connection in a local test.

Exit and run `bashwink --continue` to reopen a saved session. Run
`bashwink sandbox vm-review` to inspect staged changes and explicitly type `apply`
to apply the reviewed selection. Run `bashwink sandbox vm-verify` for the protected
fixture tests. The project profile currently accepts bounded top-level tracked text
files. Review and apply are not an atomic multi-file transaction.

If recovery reports an unidentified staging directory, leave it in place for
inspection. The early recovery path records the abandoned apply and does not delete
that directory. Host conflicts and ambiguous state remain closed for review.

[Acceptance results](ACCEPTANCE_RESULTS.md) · [Privacy and feedback](FEEDBACK_GUIDE.md)
