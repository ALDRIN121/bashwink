# Supported providers: 0.1.0-alpha.1 standard package

Inference, streaming and tool calls are done by the pinned OpenCode runtime; Bashwink only configures it
(`bashwink auth add`, `model use`, `auth check`) and never stores a key.

| Provider route | Status | Evidence |
| --- | --- | --- |
| Any OpenAI-compatible or Anthropic-compatible endpoint declared with `auth add` (`--env` or `--key-file`) | **configuration PASS; live conversation NOT_RUN on the installed package** | earlier phases tested configuration and a synthetic upstream; nothing real was exercised with this package |
| The runtime's built-in model catalogue with the provider's usual environment variable | NOT_RUN | not exercised |
| CommandCode | **BLOCKED**: RC1 sent one request with a deliberately invalid key and the live endpoint rejected it (401, 0 tokens), which proves reachability and rejection only. The qualification key file (`~/.config/bashwink-qual/commandcode.key`) has never been visible to the session, so no successful live completion exists | `docs/bashwink/releases/v0.1.0-alpha.1/rc2/RC2_REPORT.md` section 1 |
| Local or self-hosted servers | NOT_RUN | |

No provider is therefore "supported" in the sense of a recorded successful live session on this package. Until
`fixtures/release/live.py` (written, never run) or an equivalent has run with a real key, treat every provider as
**unverified**. Tester guidance: use your own key with a spending limit set at the provider. Bashwink does not yet show
a running cost or enforce a spend cap.
