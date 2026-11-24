# Quick start draft

External onboarding is blocked. These steps describe the acceptance flow for the
eventual approved archive.

1. Install the verified archive and run `bashwink doctor`.
2. Configure the qualified provider using its documented host-side credential flow.
   Keep secrets out of project files, prompts, and terminal transcripts.
3. Enter a disposable project and run `bashwink`.
4. Select the verified model and request a specific edit and a test command.
5. Inspect the requested command before approval. Review the proposed changes before
   applying them to the project. Compare the result against the original test baseline.
6. Exit, restart, and use `--continue` or `--session` to reopen the same conversation.
   Inspect the run evidence.

The exact provider ID, credential steps, and model names must come from the real
provider acceptance run. [Release readiness](RELEASE_READINESS.md)
