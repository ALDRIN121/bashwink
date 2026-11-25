# Supported providers: 0.1.0-alpha.1 standard package

Inference, streaming and tool calls are done by the pinned OpenCode runtime; Bashwink only configures it
(`bashwink auth add`, `model use`, `auth check`) and never stores a key.

| Provider route | Status | Evidence |
| --- | --- | --- |
| Any OpenAI-compatible or Anthropic-compatible endpoint declared with `auth add` (`--env` or `--key-file`) | **configuration PASS; live conversation PASS for CommandCode on macOS arm64 only (see below)**; other providers NOT_RUN | live: `release/standard/0.1.0-alpha.1-npm-rc2/live-macos-arm64/` |
| OpenAI chat-completions protocol (`--model id:openai`), streaming and tool calls, against a **scripted stand-in** (not a model) | **PASS** on the installed package on hosted macOS 15 arm64, Ubuntu x64 and Windows Server 2025 x64 runners and on the developer's Mac | `fixtures/release/npm_qual.py` (coding task, tool results returned, session continuation, model switch, limits, cancellation) |
| Anthropic messages protocol (`--model id:anthropic`), the declared protocol of the CommandCode example model `claude-sonnet-5` | **PASS live on macOS arm64** (`claude-sonnet-5` through CommandCode: authentication, a coding task with the test passing independently, session continuation); NOT_RUN on Windows and Linux. The scripted stand-in still speaks only the OpenAI protocol | `fixtures/release/npm_live.py`, 19/19 |
| The runtime's built-in model catalogue with the provider's usual environment variable | NOT_RUN | not exercised |
| CommandCode (`https://api.commandcode.ai/provider/v1`) | **PASS live on macOS arm64** with `claude-sonnet-5` (Anthropic protocol) and `gpt-6.1-sol` (OpenAI protocol), 2026-11-25, bounded to 40 requests and 300,000 tokens; `--key-file` only. NOT_RUN on Windows and Linux. The earlier RC1 attempt with a deliberately invalid key (401, 0 tokens) proved reachability and rejection only | `release/standard/0.1.0-alpha.1-npm-rc2/live-macos-arm64/live.json` |
| Local or self-hosted servers | NOT_RUN | |

One provider route (CommandCode, both wire protocols) now has a recorded successful live session on this package, on one Mac, for one small task. That proves the plumbing, not model quality, rate-limit or outage
behaviour, cost, or any other provider. The scripted results prove how Bashwink and the pinned runtime behave around *a* model. Treat every other provider as **unverified**; cost is shown as unknown until a price is declared
(`auth add --price`), which the live run confirmed (`cost: unknown`, never `$0`).

Tester guidance: use your own key with a spending limit set at the provider. Bashwink stops runaway work (300 requests and
5 retries per launch by default, optional token and dollar limits) and prints a usage summary, but the limits are **not a
hard spending ceiling** and a dollar limit needs a declared price (`auth add --price`). If a provider reports no usage,
tokens and cost are shown as unknown. The token limit does not count cached tokens (F-26): a live run reported 668 counted input tokens against 43,391 cache reads.
