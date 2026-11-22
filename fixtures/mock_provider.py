#!/usr/bin/env python3
"""Deterministic OpenAI-compatible mock provider for Bashwink Phase 0 verification.

Serves just enough of the chat-completions streaming protocol for OpenCode to run a
real agent turn with a real tool call, with no API key and no network egress.

The script is a state machine: the first request asks the model to call the `bash`
tool; once it sees the tool result in the conversation, it answers with a final
message. That fixed shape is what makes the run reproducible across machines.

Usage:
    python3 mock_provider.py --port 8117 [--log /tmp/mock-provider.jsonl]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The exact command the model "chooses". Chosen because it is read-only, has no
# network dependency, and its output is stable.
TOOL_COMMAND = "printf 'bw-mock-fail\\n'; exit 7"
FINAL_TEXT = "Tool call completed; the command printed bw-mock-ok."

# OpenCode exposes its shell runner as `shell`; code-mode exposes it as `execute`.
# The mock prefers these in order so it works in both agent shapes, and falls back to
# whatever single tool the client advertised.
PREFERRED_TOOLS = ("shell", "execute", "bash")

LOG_PATH: str | None = None


def log(event: dict) -> None:
    event["ts"] = time.time()
    line = json.dumps(event, ensure_ascii=False)
    if LOG_PATH:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    print(f"[mock] {line}", flush=True)


def sse(handler: BaseHTTPRequestHandler, chunks: list[dict]) -> None:
    """Write OpenAI-style server-sent events and terminate the stream."""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "close")
    handler.end_headers()
    for chunk in chunks:
        handler.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        handler.wfile.flush()
    handler.wfile.write(b"data:")
    handler.wfile.flush()
    handler.close_connection = True


def base_chunk(model: str, delta: dict, finish: str | None = None) -> dict:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def has_tool_result(messages: list[dict]) -> bool:
    for message in messages:
        if message.get("role") == "tool":
            return True
    return False


def tool_arguments_present(messages: list[dict]) -> bool:
    """True once any assistant message carries a tool_calls entry."""
    for message in messages:
        if message.get("tool_calls"):
            return True
    return False


def choose_tool(tools: list[dict]) -> str | None:
    """Pick the shell-capable tool the client actually advertised.

    OpenCode names it `shell`; code-mode names it `execute`. Choosing from the offered
    list (instead of hardcoding a name) keeps the mock honest: it can only call a tool
    the agent really exposed, which is what makes the smoke test meaningful.
    """
    offered = {t.get("function", {}).get("name") for t in tools if isinstance(t, dict)}
    for name in PREFERRED_TOOLS:
        if name in offered:
            return name
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter stderr
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "mock-tool-model", "object": "model"}]})
            return
        if self.path.rstrip("/") in ("", "/healthz"):
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": {"message": f"no route {self.path}"}})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            request = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": {"message": "invalid JSON"}})
            return

        model = request.get("model", "mock-tool-model")
        messages = request.get("messages", [])
        tools = request.get("tools", [])
        log(
            {
                "event": "request",
                "path": self.path,
                "model": model,
                "stream": bool(request.get("stream")),
                "message_count": len(messages),
                "tool_names": [t.get("function", {}).get("name") for t in tools],
                "has_tool_result": has_tool_result(messages),
            }
        )

        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": {"message": f"no route {self.path}"}})
            return

        # Phase 1: ask for a tool call, but only once. If the client already ran the
        # tool (a tool result is in the conversation), answer finally instead.
        if not has_tool_result(messages) and not tool_arguments_present(messages):
            chosen = choose_tool(tools)
            if chosen is None:
                log({"event": "respond_final_no_tools"})
                sse(self, [base_chunk(model, {"role": "assistant", "content": ""}), base_chunk(model, {"content": FINAL_TEXT}), base_chunk(model, {}, "stop")])
                return
            call_id = f"call_{uuid.uuid4().hex[:20]}"
            chunks = [
                base_chunk(model, {"role": "assistant", "content": ""}),
                base_chunk(
                    model,
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": chosen,
                                    "arguments": json.dumps({"command": TOOL_COMMAND}),
                                },
                            }
                        ]
                    },
                ),
                base_chunk(model, {}, "tool_calls"),
            ]
            log({"event": "respond_tool_call", "call_id": call_id, "tool": chosen, "command": TOOL_COMMAND})
            sse(self, chunks)
            return

        # Phase 2: final answer.
        chunks = [
            base_chunk(model, {"role": "assistant", "content": ""}),
            base_chunk(model, {"content": FINAL_TEXT}),
            base_chunk(model, {}, "stop"),
        ]
        log({"event": "respond_final"})
        sse(self, chunks)


def main() -> int:
    global LOG_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8117)
    parser.add_argument("--log", default=None)
    args = parser.parse_args()
    LOG_PATH = args.log
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mock] listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
