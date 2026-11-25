#!/usr/bin/env python3
"""A scripted OpenAI-compatible provider for qualifying the INSTALLED npm package without a paid key.

    python3 script_provider.py --port 0 --script steps.json --log requests.jsonl --port-file port.txt

It plays a fixed script, one step per chat-completions request, so a run is reproducible and the
agent's own loop (tool calls, tool results, retries, cancellation, model switching) is exercised by the
real runtime. It is NOT a model: it proves how Bashwink and the pinned runtime behave around a model, and
says nothing about how well any real model codes. Results from it are labelled "mock provider", never "live".

Script file: {"steps": [step, ...], "after": "last" | "text"}  (default "last": the final step repeats)

Steps (the first key that matches wins):
  {"tool": "shell" | ["shell","bash"], "arguments": {...}}   call the first listed tool the client offered
  {"text": "..."}                                            final assistant message
  {"error": 429, "message": "..."}                           HTTP error (optionally "retry_after": seconds)
  {"hang": seconds}                                          send the headers and one chunk, then stall
Any step may carry "usage": {"prompt": N, "completion": M}; default is 100 prompt / 20 completion tokens.
A tool step whose tool is not offered answers with a text message naming the missing tool, and the log
records it, so a test can tell "the runtime refused to offer it" from "the model never asked".

The log (JSON lines) holds, per request: index, path, model, tool names offered, message count, the roles
sequence, the text of the last tool result (bounded), and whether an Authorization header was present.
The header VALUE is never written anywhere.
"""
from __future__ import annotations

import argparse
import json
import select
import socket
import sys
import threading
import socketserver
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"script": {"steps": [{"text": "script not loaded"}], "after": "last"}, "log": None, "lock": threading.Lock(), "count": 0}


def record(event: dict) -> None:
    event["ts"] = round(time.time(), 3)
    if STATE["log"]:
        with STATE["lock"], open(STATE["log"], "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def chunk(model: str, delta: dict, finish=None, usage=None) -> dict:
    out = {"id": f"chatcmpl-{uuid.uuid4().hex[:24]}", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
           "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if usage is None else []}
    if usage is not None:
        out["usage"] = usage
    return out


def last_user_text(messages: list) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(content)[:160]
    return ""


def last_tool_text(messages: list) -> str:
    for message in reversed(messages):
        if message.get("role") == "tool":
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(content)[:600]
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        return

    def _json(self, status: int, payload: dict, headers: dict | None = None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        record({"event": "get", "path": self.path})
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": "script-model", "object": "model"}]})
        self._json(200, {"ok": True, "service": "bashwink-script-provider"})

    def _sse_open(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

    def _sse(self, payload: dict) -> None:
        self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
        self.wfile.flush()

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON"}})
        model = request.get("model", "script-model")
        messages = request.get("messages", [])
        offered = [t.get("function", {}).get("name") for t in request.get("tools", []) if isinstance(t, dict)]
        steps = STATE["script"]["steps"]
        # A request that offers no tools is an auxiliary call (the runtime's session-title generation). It gets a
        # fixed answer and does not consume a script step, but it is still logged: it is a real billable request.
        auxiliary = not offered
        with STATE["lock"]:
            if auxiliary:
                index = -1
            else:
                index = STATE["count"]
                STATE["count"] += 1
        if auxiliary:
            step = {"text": "Scripted session", "usage": {"prompt": 30, "completion": 4}}
        elif index < len(steps):
            step = steps[index]
        elif STATE["script"].get("after", "last") == "last":
            step = steps[-1]
        else:
            step = {"text": "script exhausted"}
        record({"event": "request", "index": index, "path": self.path, "model": model, "tools": offered, "messages": len(messages),
                "roles": [m.get("role") for m in messages][-8:], "last_tool_result": last_tool_text(messages), "last_user": last_user_text(messages),
                "tool_params": {t.get("function", {}).get("name"): sorted((t.get("function", {}).get("parameters", {}) or {}).get("properties", {})) for t in request.get("tools", []) if isinstance(t, dict)},
                "authorization_present": bool(self.headers.get("Authorization") or self.headers.get("x-api-key")),
                "auxiliary": auxiliary, "step": next(iter(step))})
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": f"no route {self.path}"}})

        if "error" in step:
            headers = {"retry-after": str(step["retry_after"])} if "retry_after" in step else {}
            return self._json(int(step["error"]), {"error": {"message": step.get("message", "scripted error"), "type": "scripted"}}, headers)

        usage = step.get("usage", {"prompt": 100, "completion": 20})
        usage_chunk = {"prompt_tokens": usage["prompt"], "completion_tokens": usage["completion"], "total_tokens": usage["prompt"] + usage["completion"]}
        self._sse_open()
        self._sse(chunk(model, {"role": "assistant", "content": ""}))
        try:
            if "hang" in step:
                self._sse(chunk(model, {"content": "working"}))
                # Hold the stream open, and notice the moment the client goes away: that is how a test proves that a
                # cancelled run stopped its model request instead of leaving it running (and billing).
                deadline = time.time() + float(step["hang"])
                while time.time() < deadline:
                    ready, _, _ = select.select([self.connection], [], [], 0.2)
                    if ready:
                        try:
                            gone = self.connection.recv(1, socket.MSG_PEEK) == b""
                        except OSError:
                            gone = True
                        if gone:
                            record({"event": "client_disconnected", "index": index})
                            return
                return
            if "tool" in step:
                names = step["tool"] if isinstance(step["tool"], list) else [step["tool"]]
                chosen = next((n for n in names if n in offered), None)
                if chosen is None:
                    record({"event": "tool_not_offered", "index": index, "wanted": names, "offered": offered})
                    self._sse(chunk(model, {"content": f"tool unavailable: {'/'.join(names)}"}))
                    self._sse(chunk(model, {}, "stop"))
                else:
                    call_id = f"call_{uuid.uuid4().hex[:20]}"
                    self._sse(chunk(model, {"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                                            "function": {"name": chosen, "arguments": json.dumps(step.get("arguments", {}))}}]}))
                    self._sse(chunk(model, {}, "tool_calls"))
            else:
                self._sse(chunk(model, {"content": step.get("text", "")}))
                self._sse(chunk(model, {}, "stop"))
            self._sse(chunk(model, {}, usage=usage_chunk))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            record({"event": "client_disconnected", "index": index})
        self.close_connection = True


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), a reverse-DNS lookup that stalls for many seconds on some hosted macOS
        # runners, so the port file was never written in time. Nothing here needs the host name.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[0], self.server_address[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--script", required=True)
    parser.add_argument("--log")
    parser.add_argument("--port-file")
    args = parser.parse_args()
    with open(args.script, encoding="utf-8") as handle:
        STATE["script"] = json.load(handle)
    STATE["log"] = args.log
    server = Server(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    if args.port_file:
        with open(args.port_file, "w", encoding="utf-8") as handle:
            handle.write(str(server.server_port))
    print(f"script provider on 127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
