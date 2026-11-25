# Supported providers: 0.1.0-alpha.1 standard package

Inference, streaming and tool calls are done by the pinned OpenCode runtime; Bashwink only configures it
(`bashwink auth add`, `model use`, `auth check`) and never stores a key.

| Provider route | Status | Evidence |
| --- | --- | --- |
| Any OpenAI-compatible or Anthropic-compatible endpoint declared with `auth add` (`--env` or `--key-file`) | **configuration PASS; live conversation NOT_RUN on the installed package** | earlier phases tested configuration and a synthetic upstream; nothing real was exercised with this package |
| OpenAI chat-completions protocol (`--model id:openai`), streaming and tool calls, against a **scripted stand-in** (not a model) | **PASS** on the installed package on hosted macOS 15 arm64, Ubuntu x64 and Windows Server 2025 x64 runners and on the developer's Mac | `fixtures/release/npm_qual.py` (coding task, tool results returned, session continuation, model switch, limits, cancellation) |
| Anthropic messages protocol (`--model id:anthropic`), the declared protocol of the CommandCode example model `claude-sonnet-5` | **NOT_RUN on the installed package**: the stand-in speaks only the OpenAI protocol, so no test has sent an Anthropic-protocol request through this package | needs a live run (`fixtures/release/npm_live.py`) |
| The runtime's built-in model catalogue with the provider's usual environment variable | NOT_RUN | not exercised |
| CommandCode | **BLOCKED**: RC1 sent one request with a deliberately invalid key and the live endpoint rejected it (401, 0 tokens), which proves reachability and rejection only. The qualification key file (`~/.config/bashwink-qual/commandcode.key`) has never been visible to the session, so no successful live completion exists | `docs/bashwink/releases/v0.1.0-alpha.1/rc2/RC2_REPORT.md` section 1 |
| Local or self-hosted servers | NOT_RUN | |

No provider is therefore "supported" in the sense of a recorded successful live session on this package. The scripted
results prove how Bashwink and the pinned runtime behave around *a* model; they say nothing about how well any real model
codes, and nothing about provider-specific behaviour (rate limits, usage reporting, cost). Until
`fixtures/release/npm_live.py` has run with a real key, treat every provider as **unverified**. That script is written and
its logic was exercised against the scripted provider with a synthetic key; it has never run live.

Tester guidance: use your own key with a spending limit set at the provider. Bashwink stops runaway work (300 requests and
5 retries per launch by default, optional token and dollar limits) and prints a usage summary, but the limits are **not a
hard spending ceiling** and a dollar limit needs a declared price (`auth add --price`). If a provider reports no usage,
tokens and cost are shown as unknown.
