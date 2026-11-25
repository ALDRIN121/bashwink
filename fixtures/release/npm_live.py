#!/usr/bin/env python3
"""Live-provider qualification of the INSTALLED Bashwink npm package. Bounded, paid, and never prints the key.

    python3 fixtures/release/npm_live.py <bashwink-0.1.0-alpha.1.tgz> --key-file ~/.config/bashwink-qual/commandcode.key \
        [--base-url https://api.commandcode.ai/provider/v1] [--model claude-sonnet-5:anthropic] [--switch-model gpt-6.1-sol:openai] \
        [--max-requests 40] [--out report.json]

What it does, in a disposable Git project under a path with spaces and non-ASCII characters, through the installed command:
authentication (`auth check`), a real coding task (read, edit, run the project's test) with the diff and the test result
verified independently, streaming (output arrives progressively; timings are reported, not judged), a usage summary,
session continuation, an optional model switch, cancellation with leak detection, and a search of everything Bashwink
wrote for the key's value.

The key: used only as `--key-file <path>`. Its permissions are checked first (POSIX: must not be readable by group/others).
Its value is read into memory solely to search for it afterwards; it is never printed, logged, passed as an argument,
mounted anywhere or written to the report. Spend is bounded by BASHWINK_MAX_REQUESTS and BASHWINK_MAX_TOKENS.
Results are labelled live and name the provider and model. A check that cannot run is NOT_RUN, never PASS.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import npm_qual as q  # noqa: E402  (the same harness classes, no mock)
from npm_qual import check, clean, results  # noqa: E402

CODING_FILES = q.CODING_FILES
PROMPT = ("The test in this folder fails. Run `node test.js` to see it, fix the bug in sum.js, and run the test again. "
          "Change only what is needed.")


class Live(q.Scenario):
    """A scenario against a real provider: same profile/project layout and helpers, no scripted mock."""

    def __init__(self, qual, key_file: Path, base_url: str, models: list[str]):
        super().__init__(qual, "live", {}, files=CODING_FILES)
        self.key_path, self.base_url, self.model_specs = key_file, base_url, models

    def __enter__(self):
        for rel, text in CODING_FILES.items():
            (self.project / rel).write_text(text, encoding="utf-8", newline="\n")
        for step in (["init", "-q", "."], ["config", "user.name", "qual"], ["config", "user.email", "qual@bashwink.invalid"],
                     ["config", "core.autocrlf", "false"], ["add", "-A"], ["commit", "-q", "-m", "baseline"]):
            subprocess.run(["git", *step], cwd=self.project, check=True, capture_output=True)
        added = self.bw("auth", "add", "live", "--base-url", self.base_url, "--key-file", str(self.key_path),
                        *[a for m in self.model_specs for a in ("--model", f"{m.split(':')[0]}:{(m.split(':') + ['openai'])[1]}:200000:8192")])
        check("live: provider declared with --key-file (the config holds a path, never the key)", added.returncode == 0, clean(added.stdout + added.stderr)[-160:])
        self.bw("model", "use", f"live/{self.model_specs[0].split(':')[0]}")
        self.bw("trust", str(self.project), "--by", "qual")
        return self

    def __exit__(self, *_):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tarball", nargs="?", type=Path)
    parser.add_argument("--prefix", type=Path)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--base-url", default="https://api.commandcode.ai/provider/v1")
    parser.add_argument("--model", default="claude-sonnet-5:anthropic", help="id[:protocol]")
    parser.add_argument("--switch-model", default="", help="a second id[:protocol] on the same provider")
    parser.add_argument("--max-requests", type=int, default=40)
    parser.add_argument("--max-tokens", type=int, default=300_000)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if not args.tarball and not args.prefix:
        parser.error("give a tarball or --prefix")

    key_path = args.key_file.expanduser()
    if not key_path.is_file() or key_path.stat().st_size == 0:
        check("live: the key file exists and is not empty", None, "NOT_RUN: the key file is not visible to this process (nothing was read)")
        return finish(args)
    if os.name != "nt" and key_path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        check("live: the key file is private (mode 600)", False, "refusing to use a key file readable by group or others; chmod 600 it")
        return finish(args)
    check("live: the key file exists, is non-empty and is private", True)
    key = key_path.read_bytes().strip()  # held in memory only, to search for leaks afterwards

    root = Path(tempfile.mkdtemp(prefix="Bashwink Live ü 用户 ")).resolve()
    try:
        prefix = args.prefix.resolve() if args.prefix else root / "npm prefix"
        qual = q.Qual(prefix, root)
        if not args.prefix:
            prefix.mkdir()
            env = {**os.environ, "HOME": str(root), "USERPROFILE": str(root), "npm_config_cache": str(root / "npm-cache")}
            done = subprocess.run([q.NPM, "install", "-g", "--prefix", str(prefix), "--no-audit", "--no-fund", str(args.tarball.resolve())], env=env, capture_output=True, text=True)
            check("live: npm install -g <tarball>", done.returncode == 0)
            if done.returncode:
                return finish(args)
        limits = {"BASHWINK_MAX_REQUESTS": str(args.max_requests), "BASHWINK_MAX_TOKENS": str(args.max_tokens)}
        models = [args.model] + ([args.switch_model] if args.switch_model else [])
        with Live(qual, key_path, args.base_url, models) as c:
            auth = c.bw("auth", "check", "live")
            check("live: authentication succeeds against the real endpoint (auth check)", auth.returncode == 0, clean(auth.stdout + auth.stderr).strip()[:160])
            if auth.returncode:
                return finish(args)
            before = subprocess.run(["node", "test.js"], cwd=c.project, capture_output=True, text=True).returncode
            check("live: the project fails its test before the run", before != 0)

            proc = subprocess.Popen([qual.command, "run", "--auto", PROMPT], cwd=c.project, env={**c.env, **limits}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            started, arrivals, chunks = time.monotonic(), [], []
            while True:
                line = proc.stdout.readline()
                if not line and proc.poll() is not None:
                    break
                if line:
                    arrivals.append(time.monotonic() - started)
                    chunks.append(line)
            out = clean("".join(chunks))
            total = time.monotonic() - started
            check("live: the coding run finishes (exit 0)", proc.returncode == 0, f"exit {proc.returncode} in {total:.0f}s")
            check("live: output arrived progressively (observed, not judged)", len(arrivals) >= 3, f"{len(arrivals)} lines; first after {arrivals[0]:.1f}s, last after {arrivals[-1]:.1f}s" if arrivals else "no output")
            diff = subprocess.run(["git", "diff", "--no-color"], cwd=c.project, capture_output=True, text=True, encoding="utf-8").stdout
            status = subprocess.run(["git", "status", "--porcelain"], cwd=c.project, capture_output=True, text=True).stdout.strip().splitlines()
            after = subprocess.run(["node", "test.js"], cwd=c.project, capture_output=True, text=True)
            check("live: the project's test passes afterwards (run independently of the model's claim)", after.returncode == 0 and "tests passed" in after.stdout)
            check("live: the diff touches only sum.js and does not edit the test", len(status) == 1 and status[0].endswith("sum.js") and "test.js" not in diff, str(status))
            check("live: a usage summary was printed", re.search(r"Usage: \d+ model requests? of \d+ allowed", out) is not None)
            ev = c.evidence()
            tools = {e["call"].get("tool") for e in ev if e["phase"] == "after"}
            check("live: evidence recorded real tool calls attributed to the model", bool(tools) and any((e["payload"].get("model") or {}).get("id") for e in ev if e["phase"] == "model"), str(sorted(t for t in tools if t)))
            check("live: the evidence chain verifies", c.verify_chain()[0])

            session = re.search(r"ses_[A-Za-z0-9]+", clean(c.bw("session", "list").stdout))
            if session:
                follow = c.bw("run", "--session", session.group(0), "Which file did you change? Answer with the file name only.", extra_env=limits)
                check("live: a continued session remembers the earlier work", "sum.js" in c.output(follow), f"exit {follow.returncode}")
                if args.switch_model:
                    other = c.bw("run", "--session", session.group(0), "--model", f"live/{args.switch_model.split(':')[0]}", "Say OK.", extra_env=limits)
                    seen = {(e["payload"].get("model") or {}).get("id") for e in c.evidence() if e["phase"] == "model"}
                    check("live: switching model within a session works and evidence attributes both models", other.returncode == 0 and len(seen) >= 2, str(seen))
            else:
                check("live: session continuation", None, "no session id was listed")

            before_procs = q.processes()
            slow = subprocess.Popen([qual.command, "run", "--auto", "Write a 400-line essay about version control into essay.txt, then read it back."], cwd=c.project, env={**c.env, **limits},
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}))
            time.sleep(6)
            if os.name == "nt":
                import signal as _s
                slow.send_signal(_s.CTRL_BREAK_EVENT)
            else:
                import signal as _s
                os.killpg(slow.pid, _s.SIGINT)
            try:
                slow.wait(30)
                ended = True
            except subprocess.TimeoutExpired:
                slow.kill()
                ended = False
            time.sleep(2)
            check("live: cancelling a running session ends it promptly", ended)
            check("live: no runtime or CLI process is left behind after cancelling", not {p: n for p, n in q.processes().items() if p not in before_procs})

            check("live: the key value is in no file under the profile or project and not in any output", not c.leaked(key.decode(errors="ignore")) and key.decode(errors="ignore") not in out, "searched without printing")
            records = c.run_records()
            check("live: every run record is finalized with usage and evidence", bool(records) and all(r.get("endedAt") for r in records), f"{len(records)} records")
        return finish(args, {"provider": args.base_url, "models": models, "limits": limits})
    finally:
        shutil.rmtree(root, ignore_errors=True)


def finish(args, extra: dict | None = None) -> int:
    summary = {v: sum(r["verdict"] == v for r in results) for v in ("PASS", "FAIL", "NOT_RUN")}
    print(f"\n{summary['PASS']} passed, {summary['FAIL']} failed, {summary['NOT_RUN']} not run")
    if args.out:
        args.out.write_text(json.dumps({"kind": "live provider (real model)", "platform": sys.platform, "summary": summary, **(extra or {}), "checks": results}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0 if summary["FAIL"] == 0 and summary["PASS"] > 0 and summary["NOT_RUN"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
