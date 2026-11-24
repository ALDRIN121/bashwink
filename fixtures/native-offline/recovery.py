#!/usr/bin/env python3
"""Installed PTY checks for native recovery and reviewed single-file export."""
from contextlib import contextmanager
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
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time

from run import ROOT, run, wait_for


@contextmanager
def terminal(command, cwd, environment):
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execve(str(command[0]), [str(part) for part in command], environment)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 130, 0, 0))
    buffer = bytearray()
    status = None

    def drain():
        nonlocal status
        if select.select([master], [], [], 0.08)[0]:
            try:
                buffer.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if status is None:
            waited, result = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = os.waitstatus_to_exitcode(result)
        return status

    def contains(text):
        drain()
        return text.encode() in buffer

    def finish(expected):
        assert wait_for(lambda: drain() is not None, 10), "PTY did not exit"
        assert status == expected, (status, expected, bytes(buffer[-1800:]))

    try:
        yield pid, master, contains, finish, buffer
    finally:
        if drain() is None:
            os.kill(pid, signal.SIGTERM)
            if not wait_for(lambda: drain() is not None, 5):
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        os.close(master)


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def session(stage):
    path = stage / "scratch/data/opencode/opencode.db"
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        return db.execute("SELECT id FROM session_v2 ORDER BY id").fetchall()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    installed, runtime = args.installed.resolve(), args.runtime.resolve()
    root = (args.output or Path(tempfile.mkdtemp(prefix="bw-offline-recovery-"))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    project = root / "host"
    project.mkdir()
    host = project / "task.txt"
    host.write_text("Original approved host base\n")
    host_hash = digest(host)
    stage = run(installed, runtime, project, "coding", stage_file=True)
    assert digest(host) == host_hash, "the sandbox automatically exported on exit"
    [(session_id,)] = session(stage)
    evidence = stage / "scratch/evidence/evidence.jsonl"
    beginning = evidence.read_bytes()
    environment = {
        "PATH": os.environ["PATH"], "TERM": "xterm-256color", "HOME": str(root),
        "BASHWINK_OPENCODE_BIN": str(runtime),
    }
    log = root / "resume.jsonl"
    mock_console = root / "resume-mock.log"
    with mock_console.open("wb") as output:
        mock = subprocess.Popen([
            sys.executable, str(ROOT / "fixtures/mock_provider.py"), "--port", "0",
            "--scenario", "native-recovery", "--log", str(log),
        ], stdout=output, stderr=subprocess.STDOUT)
        try:
            found = wait_for(lambda: re.search(rb"listening on http://127\.0\.0\.1:(\d+)", mock_console.read_bytes()))
            assert found
            port = found.group(1).decode()
            recovery = [installed, "sandbox", "offline", port, "--stage", stage]
            command = [installed, "sandbox", "export", stage]

            for name, selection in (("continue", ["--continue"]), ("session", ["--session", session_id])):
                with terminal(recovery + selection, root, environment) as (pid, master, contains, finish, buffer):
                    try:
                        assert wait_for(lambda: contains("Run the offline coding check"), 12), "saved prompt was absent from the native TUI"
                        if name == "continue":
                            os.write(master, b"Check the saved conversation")
                            time.sleep(0.2)
                            os.write(master, b"\r")
                            def continued():
                                contains("never rendered")
                                if not log.exists():
                                    return False
                                events = [json.loads(line) for line in log.read_text().splitlines()]
                                return any(event.get("initial_prompt_present") and event.get("recovery_prompt_present") for event in events)
                            assert wait_for(continued, 10), "mock did not observe same-session conversation continuity"
                            # Stop an active, already attached stage through the supervised signal path.
                            os.kill(pid, signal.SIGTERM)
                            finish(130)
                        else:
                            os.write(master, b"\x04")
                            finish(0)
                    finally:
                        (root / f"{name}.tty").write_bytes(buffer)
                assert session(stage) == [(session_id,)]
            contents = evidence.read_bytes()
            assert contents.startswith(beginning) and len(contents) > len(beginning)
            boots = [row["call"]["id"] for row in map(json.loads, contents.splitlines()) if row["phase"] == "boot"]
            assert len(boots) == 3 and len(set(boots)) == 3
            assert digest(host) == host_hash
            print("PASS: --continue and --session reopened the same conversation after a supervised interruption, with three fresh boot proofs and an unchanged evidence prefix")

            def reject(selection, message):
                before = log.read_bytes()
                with terminal(recovery + selection, root, environment) as (_, _, contains, finish, buffer):
                    finish(3)
                    assert contains(message), bytes(buffer[-1000:])
                assert log.read_bytes() == before

            database = stage / "scratch/data/opencode/opencode.db"
            with sqlite3.connect(database) as db:
                db.execute("UPDATE session_v2 SET directory = ? WHERE id = ?", (str(root), session_id))
            reject(["--session", session_id], "no saved session owned")
            with sqlite3.connect(database) as db:
                db.execute("UPDATE session_v2 SET directory = ? WHERE id = ?", (str(stage / "work"), session_id))
            metadata = stage / "stage.json"
            old_metadata = metadata.read_bytes()
            incompatible = json.loads(old_metadata)
            incompatible["profile"] = "incompatible"
            metadata.write_text(json.dumps(incompatible))
            reject(["--continue"], "incompatible execution profile")
            metadata.write_bytes(old_metadata)
            active = stage / ".active"
            active.mkdir()
            reject(["--continue"], "interrupted without a supervised close")
            active.rmdir()
            stale = stage / "scratch/scopes/.readiness-fixture"
            stale.mkdir()
            (stale / "ready.json").write_text("{}")
            reject(["--continue"], "outstanding readiness state")
            (stale / "ready.json").unlink()
            stale.rmdir()
            evidence.write_bytes(beginning)
            reject(["--continue"], "does not extend the saved chain")
            evidence.write_bytes(contents)
            print("PASS: ownership, profile, outstanding activation, stale readiness and truncated evidence refused before a provider request")

            original = host.read_bytes()
            with terminal(command, project, environment) as (_, master, contains, finish, _):
                assert wait_for(lambda: contains("Type apply"), 10)
                assert contains("+ Bashwink offline edit")
                os.write(master, b"no\r")
                finish(0)
            assert digest(host) == host_hash
            with terminal(command, project, environment) as (_, master, contains, finish, _):
                assert wait_for(lambda: contains("Type apply"), 10)
                os.write(master, b"\x03")
                finish(3)
            assert digest(host) == host_hash and not (stage / ".active").exists()

            with terminal(command, project, environment) as (_, master, contains, finish, _):
                assert wait_for(lambda: contains("Type apply"), 10)
                host.write_text("Conflicting host edit\n")
                changed = digest(host)
                os.write(master, b"apply\r")
                finish(3)
            assert digest(host) == changed

            # A modified base remains rejected even if its bytes are restored. Use a new
            # separately authorized fixture stage for link tests and the final export.
            host.write_bytes(original)
            stage = run(installed, runtime, project, "coding", stage_file=True)
            command[-1] = stage
            staged = stage / "work/task.txt"
            saved = staged.with_name("saved-fixture")
            staged.rename(saved)
            outside = root / "protected-export-canary"
            outside.write_text("Protected export fixture\n")
            outside_hash = digest(outside)
            staged.symlink_to(outside)
            with terminal(command, project, environment) as (_, _, _, finish, _):
                finish(3)
            staged.unlink()
            os.link(outside, staged)
            with terminal(command, project, environment) as (_, _, _, finish, _):
                finish(3)
            staged.unlink()
            os.mkfifo(staged)
            with terminal(command, project, environment) as (_, _, _, finish, _):
                finish(3)
            staged.unlink()
            saved.rename(staged)
            with terminal(command, root, environment) as (_, _, contains, finish, _):
                finish(3)
                assert contains("original, unchanged host directory")
            with terminal(command[:-1] + [str(stage / ".." / stage.name)], project, environment) as (_, _, contains, finish, _):
                finish(3)
                assert contains("offline stage is missing or unrecognized")
            assert digest(outside) == outside_hash and host.read_bytes() == original
            with terminal(command, project, environment) as (_, master, contains, finish, buffer):
                assert wait_for(lambda: contains("Type apply"), 10), bytes(buffer[-1500:])
                os.write(master, b"apply\r")
                finish(0)
            assert host.read_bytes() == b"Bashwink offline edit\n"
            assert digest(outside) == outside_hash
            print("PASS: export respected cancellation and refused a conflict, wrong directory, traversal, symlink, hardlink and FIFO before applying the approved bytes")
        finally:
            mock.terminate()
            mock.wait(timeout=5)


if __name__ == "__main__":
    main()
