#!/usr/bin/env python3
"""Exercise the installed offline command through a controlling PTY and a real local mock."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]


def wait_for(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.025)
    return None


def run(installed, runtime, output, lifecycle):
    output.mkdir(parents=True, exist_ok=True)
    log_path = output / "mock.jsonl"
    mock_output = output / "mock.log"
    mock = None
    pid = None
    master = None
    stage = None
    related = set()
    guard = None
    captured = bytearray()
    with mock_output.open("wb") as log:
        mock = subprocess.Popen([
            sys.executable, str(ROOT / "fixtures/mock_provider.py"),
            "--port", "0", "--scenario", "native-offline", "--log", str(log_path),
        ], stdout=log, stderr=subprocess.STDOUT)
        try:
            match = wait_for(lambda: re.search(rb"listening on http://127\.0\.0\.1:(\d+)", mock_output.read_bytes()), 5)
            assert match, "controlled mock did not listen"
            port = match.group(1).decode()
            pid, master = pty.fork()
            if pid == 0:
                os.chdir(output)
                argv = [str(installed), "sandbox", "offline", port]
                env = {
                    "PATH": os.environ["PATH"], "TERM": "xterm-256color",
                    "HOME": str(output), "BASHWINK_OPENCODE_BIN": str(runtime if lifecycle != "startup" else "/bin/cat"),
                }
                if lifecycle == "timeout":
                    env["BASHWINK_TIMEOUT_MS"] = "7000"
                os.execve(str(installed), argv, env)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 120, 0, 0))

            def poll_pty():
                if select.select([master], [], [], 0.08)[0]:
                    try:
                        captured.extend(os.read(master, 65536))
                    except OSError as ex:
                        if ex.errno != errno.EIO:
                            raise

            def finished():
                poll_pty()
                waited, status = os.waitpid(pid, os.WNOHANG)
                return (waited, status) if waited else None

            def alive(child):
                try:
                    os.kill(child, 0)
                    return True
                except ProcessLookupError:
                    return False

            if lifecycle == "startup":
                result = wait_for(finished, 10)
                assert result, "startup failure timed out"
                pid = None
                assert os.waitstatus_to_exitcode(result[1]) == 3
                assert not log_path.exists()
                assert b"did not report the pinned OpenCode version" in captured
                print("PASS: startup failure refused the wrong executable before TUI or provider prompt")
                return

            def stage_root():
                poll_pty()
                line = re.search(rb"Bashwink offline fixture workspace: (/private/tmp/bashwink-offline-[a-zA-Z0-9]+/work)", captured)
                return Path(os.fsdecode(line.group(1))).parent if line else None

            stage = wait_for(stage_root, 5)
            assert stage, "offline startup did not report its staging root"
            canary = stage / "protected-canary"
            canary.write_text("protected synthetic fixture\n")
            identity = canary.stat().st_ino
            fingerprint = hashlib.sha256(canary.read_bytes()).hexdigest()
            guard = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            guard.bind(("127.0.0.1", 0))
            guard.listen(1)
            with socket.create_connection(guard.getsockname(), timeout=1):
                guard.accept()[0].close()
            (stage / "work/kernel-check.sh").write_text(
                "#!/bin/sh\n"
                "printf 'shell ran\\n' > .bw-shell-canary\n"
                "( printf 'unexpected write\\n' > ../protected-canary ) 2> kernel-denial.txt\n"
                "test $? -ne 0 || exit 1\n"
                f"nc -z -v -w 1 127.0.0.1 {guard.getsockname()[1]} 2> network-denial.txt\n"
                "test $? -ne 0\n"
            )

            def tui():
                poll_pty()
                return b"\x1b[?1049h" in captured and b"Ask anything" in captured

            assert wait_for(tui), "OpenCode TUI did not render"
            lease = next((stage / "scratch/scopes").glob(".readiness-*/ready.json"))
            server_pid = json.loads(lease.read_text())["pid"]
            children = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid="], text=True)
            related = {int(child) for child, parent in (line.split() for line in children.splitlines()) if int(parent) == pid}
            assert server_pid in related and len(related) == 2
            if lifecycle in {"ctrl-c", "server-crash", "abrupt", "timeout"}:
                expected = {"ctrl-c": 0, "server-crash": 3, "abrupt": -9, "timeout": 124}[lifecycle]
                if lifecycle == "ctrl-c":
                    os.write(master, b"\x03")
                elif lifecycle == "server-crash":
                    os.kill(server_pid, signal.SIGKILL)
                elif lifecycle == "abrupt":
                    os.kill(pid, signal.SIGKILL)
                result = wait_for(finished, 10)
                assert result, f"launcher did not exit for {lifecycle}"
                pid = None
                actual = os.waitstatus_to_exitcode(result[1])
                assert actual == expected, (lifecycle, actual, expected)
                wait_for(lambda: not any(alive(child) for child in related), 3)
                survivors = ["server" if child == server_pid else "client" for child in related if alive(child)]
                if lifecycle == "abrupt":
                    print(f"OBSERVED: abrupt launcher exit {actual}, owned survivors {survivors}, lease exists {lease.exists()}")
                else:
                    assert not survivors and not lease.exists(), (survivors, lease.exists())
                    print(f"PASS: {lifecycle} exit {actual}, both owned children gone and readiness lease removed")
                return
            os.write(master, b"Run the offline coding check")
            time.sleep(0.2)
            os.write(master, b"\r")

            def request_seen():
                poll_pty()
                return log_path.exists() and '"event": "request"' in log_path.read_text()

            assert wait_for(request_seen, 15), "TUI prompt did not reach the fixture provider"

            approval_cursor = 0
            def complete():
                nonlocal approval_cursor
                poll_pty()
                if b"Allow once" in captured[approval_cursor:]:
                    approval_cursor = len(captured)
                    os.write(master, b"\r")
                return (stage / "work/kernel-denial.txt").exists()

            assert wait_for(complete, 15), "file edit or approved shell did not complete"
            assert (stage / "work/task.txt").read_text() == "Bashwink offline edit\n"
            assert (stage / "work/.bw-shell-canary").read_text() == "shell ran\n"
            assert wait_for(lambda: "Operation not permitted" in (stage / "work/kernel-denial.txt").read_text(), 5), "no Seatbelt denial from inside the actual shell child"
            assert canary.stat().st_ino == identity
            assert hashlib.sha256(canary.read_bytes()).hexdigest() == fingerprint
            evidence_path = stage / "scratch/evidence/evidence.jsonl"
            def proved():
                poll_pty()
                rows = [json.loads(line) for line in evidence_path.read_text().splitlines()]
                return rows if sum(row.get("phase") == "after" for row in rows) >= 2 else None
            rows = wait_for(proved, 5)
            assert rows
            assert any(row.get("phase") == "boot" for row in rows)
            assert {row["call"]["tool"] for row in rows if row["phase"] == "after"} == {"write", "shell"}
            assert any(row["phase"] == "denied" and row["call"]["tool"] == "write" for row in rows)
            assert any(row["phase"] == "boot" and f"location={stage / 'work'}" in row["payload"]["note"] for row in rows)
            assert "Operation not permitted" in (stage / "work/network-denial.txt").read_text()
            guard.setblocking(False)
            try:
                guard.accept()[0].close()
                raise AssertionError("the confined shell reached the unrelated listener")
            except BlockingIOError:
                pass
            print("PASS: installed TUI submitted a prompt, recorded boot, wrote an in-process edit and ran a shell child")
            print("PASS: ScopeFence refused the in-process write to the protected sibling")
            print("PASS: OS denied shell child write and unrelated loopback connection; outside canaries unchanged")

            def final_response():
                poll_pty()
                return b"Offline fixture completed its file and shell checks." in captured

            assert wait_for(final_response, 5), "mock final response did not reach the TUI"
            os.write(master, b"\x04")

            result = wait_for(finished, 8)
            assert result, "normal TUI exit timed out"
            pid = None
            assert os.waitstatus_to_exitcode(result[1]) == 0
            assert not lease.parent.exists()
            for child in related:
                try:
                    os.kill(child, 0)
                except ProcessLookupError:
                    continue
                raise AssertionError(f"owned process {child} survived normal exit")
            related.clear()
            print("PASS: normal TUI exit 0, both owned children gone and readiness lease removed")
            db_path = stage / "scratch/data/opencode/opencode.db"
            with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
                sessions = db.execute("SELECT id, directory FROM session_v2").fetchall()
                assert len(sessions) == 1 and sessions[0][1] == str(stage / "work")
                assert any(row["call"]["sessionID"] == sessions[0][0] for row in rows if row["phase"] == "after")
            print("PASS: durable session directory and tool evidence agree after a normal close")
        finally:
            if master is not None:
                (output / "terminal.tty").write_bytes(captured)
            if stage is not None:
                print(f"offline stage: {stage}", flush=True)
            if pid is not None:
                try:
                    waited, _ = os.waitpid(pid, os.WNOHANG)
                    if waited == 0:
                        os.kill(pid, signal.SIGTERM)
                        def reaped():
                            poll_pty()
                            return os.waitpid(pid, os.WNOHANG)[0] != 0
                        if not wait_for(reaped, 6):
                            os.kill(pid, signal.SIGKILL)
                            os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            if master is not None:
                os.close(master)
            if guard is not None:
                guard.close()
            for child in related:
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            mock.terminate()
            try:
                mock.wait(timeout=3)
            except subprocess.TimeoutExpired:
                mock.kill()
                mock.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--lifecycle", choices=["coding", "startup", "ctrl-c", "server-crash", "abrupt", "timeout"], default="coding")
    args = parser.parse_args()
    directory = args.output or Path(tempfile.mkdtemp(prefix="bw-offline-pty-"))
    run(args.installed.resolve(), args.runtime.resolve(), directory.resolve(), args.lifecycle)
