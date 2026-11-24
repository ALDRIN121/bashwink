#!/usr/bin/env python3
"""Unrestricted (host) mode of the release archive, driven through real PTYs.

    python3 fixtures/release/release_unrestricted.py <archive-dir> --out report.json

Checks that host execution needs a typed acknowledgment, is labelled everywhere, and keeps
the existing approvals and denials. A local mock model asks for one shell command that
writes a canary file, so "did the host command run?" is observed on the host filesystem.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "native-offline"))
from recovery import terminal  # noqa: E402
from run import wait_for  # noqa: E402
from screen import screen_text  # noqa: E402

PHRASE = "I accept host access"
results = []


def check(name, ok, detail=""):
    results.append({"check": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"{'PASS' if ok else 'FAIL':5} {name}" + (f" — {detail}" if detail else ""), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="bw-unrestricted-")).resolve()
    try:
        return run_checks(args, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_checks(args, work):
    home = work / "home"
    home.mkdir()
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "TERM": "xterm-256color"}
    archive = next(args.archive_dir.glob("*.tar.gz"))
    with tarfile.open(archive) as bundle:
        bundle.extractall(work, filter="tar")
    subprocess.run([next(work.glob("bashwink-*-macos-arm64")) / "install.sh"], env=env, check=True, capture_output=True)
    bw = home / ".local/bin/bashwink"
    project = work / "project"
    project.mkdir()
    (project / "a.ts").write_text("export const a = 1\n")
    ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
    subprocess.run(["git", "init", "-q", "."], cwd=project, env=ge, check=True)
    subprocess.run(["git", "add", "a.ts"], cwd=project, env=ge, check=True)
    subprocess.run(["git", "commit", "-qm", "i"], cwd=project, env=ge, check=True)
    import socket
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    env["BW_MOCK_KEY"] = "mock-not-a-secret"
    added = subprocess.run([bw, "auth", "add", "mock", "--base-url", f"http://127.0.0.1:{port}/v1", "--env", "BW_MOCK_KEY",
                            "--model", "mock-tool-model:openai"], cwd=project, env=env, capture_output=True, text=True)
    assert added.returncode == 0, added.stderr
    used = subprocess.run([bw, "model", "use", "mock/mock-tool-model"], cwd=project, env=env, capture_output=True, text=True)
    assert used.returncode == 0, used.stderr
    runs = home / ".local/share/bashwink/runs"
    canary = project / ".bw-shell-canary"

    # Wrong answers start nothing.
    for answer in (b"yes\r", b"\r", b"i accept host access\r"):
        with terminal([bw, "--unsafe-local"], project, env) as (_, master, contains, finish, capture):
            assert wait_for(lambda: contains("type exactly"), 20)
            shown = bytes(capture).decode(errors="replace")
            os.write(master, answer)
            finish(3)
        check(f"wrong acknowledgment {answer!r} starts nothing",
              "same access you have" in shown and "Ask anything" not in bytes(capture).decode(errors="replace") and not runs.exists())

    # Correct phrase: labelled, TUI renders with the bundled pinned runtime, run recorded.
    mock = subprocess.Popen([sys.executable, HERE.parents[0] / "mock_provider.py", "--port", str(port), "--scenario", "canary"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        with terminal([bw, "--unsafe-local"], project, env) as (pid, master, contains, finish, capture):
            assert wait_for(lambda: contains("type exactly"), 20)
            os.write(master, PHRASE.encode() + b"\r")
            ready = wait_for(lambda: contains("Ask anything"), 40)
            text = bytes(capture).decode(errors="replace")
            check("typed acknowledgment starts host mode and the TUI", ready)
            if not ready:
                import re
                print(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)[-900:])
            check("mode is labelled before the TUI", "UNRESTRICTED HOST ACCESS" in text)
            check("mode is shown inside the TUI", wait_for(lambda: contains("Bashwink · UNRESTRICTED"), 15))
            time.sleep(22)
            contains("")
            check("persistent indicator on the home screen after the toast period",
                  "[UNSAFE LOCAL MODE]" in screen_text(bytes(capture)))
            # Untrusted workspace: the existing policy refuses shell.
            time.sleep(1)
            os.write(master, b"run the shell probe")
            time.sleep(0.3)
            os.write(master, b"\r")
            time.sleep(10)
            contains("")
            check("persistent indicator in the session view", "[UNSAFE LOCAL MODE]" in screen_text(bytes(capture)))
            check("untrusted workspace: shell is denied and nothing ran on the host", not canary.exists())
            os.kill(pid, 15)
            finish(130)
        records = sorted(runs.glob("*.json"))
        record = json.loads(records[-1].read_text()) if records else {}
        mode = record.get("execution", {}).get("backend", {}).get("mode")
        check("run record names the execution mode", mode == "unrestricted-host", str(mode))
        check("evidence booted in host mode", record.get("evidence") == "recorded", str(record.get("evidence")))

        # Trusted workspace: shell asks first. Decline, then approve.
        subprocess.run([bw, "trust", str(project), "--by", "tester"], cwd=project, env=env, check=True, capture_output=True)
        for decision, key, expect_canary in (("decline", b"\x1b", False), ("approve", b"\r", True)):
            if canary.exists():
                canary.unlink()
            with terminal([bw, "--unsafe-local"], project, env) as (pid, master, contains, finish, capture):
                assert wait_for(lambda: contains("type exactly"), 20)
                os.write(master, PHRASE.encode() + b"\r")
                assert wait_for(lambda: contains("Ask anything"), 40)
                time.sleep(1)
                os.write(master, b"run the shell probe")
                time.sleep(0.3)
                os.write(master, b"\r")
                asked = wait_for(lambda: contains("Allow once"), 30)
                check(f"trusted workspace ({decision}): shell asks for approval first", asked and not canary.exists())
                time.sleep(1)
                os.write(master, key if decision == "decline" else b"\r")
                wait_for(lambda: canary.exists() or contains("shell permission probe is complete"), 20 if expect_canary else 6)
                if canary.exists() != expect_canary:
                    import re
                    print(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", bytes(capture).decode(errors="replace"))[-300:])
                    ev = home / ".local/share/bashwink/evidence/evidence.jsonl"
                    for line in ev.read_text().splitlines()[-8:]:
                        row = json.loads(line)
                        print("EVIDENCE", row.get("phase"), row.get("tool"), json.dumps(row.get("payload"))[:300])
                check(f"trusted workspace ({decision}): host command {'ran' if expect_canary else 'did not run'} only as decided",
                      canary.exists() == expect_canary)
                os.kill(pid, 15)
                finish(130)
    finally:
        mock.terminate()
    args.out.write_text(json.dumps(results, indent=2) + "\n")
    return 0 if all(r["verdict"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
