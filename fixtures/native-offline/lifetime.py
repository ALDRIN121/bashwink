#!/usr/bin/env python3
"""Verify stale-stage retirement against a real stopped native writer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

from recovery import terminal
from run import ROOT, process_identity, run, wait_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    installed, runtime = args.installed.resolve(), args.runtime.resolve()
    root = (args.output or Path(tempfile.mkdtemp(prefix="bw-native-lifetime-"))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    project = root / "host"
    project.mkdir()
    host = project / "task.txt"
    host.write_text("Original supervised lifetime fixture\n")
    host_hash = hashlib.sha256(host.read_bytes()).hexdigest()
    stage = run(installed, runtime, project, "coding", stage_file=True)
    environment = {
        "PATH": os.environ["PATH"], "TERM": "xterm-256color", "HOME": str(root),
        "BASHWINK_OPENCODE_BIN": str(runtime),
    }
    mock_path = root / "mock-lifetime.log"
    with mock_path.open("wb") as console:
        mock = subprocess.Popen([
            sys.executable, str(ROOT / "fixtures/mock_provider.py"),
            "--port", "0", "--scenario", "native-recovery",
        ], stdout=console, stderr=subprocess.STDOUT)
        try:
            listening = wait_for(lambda: re.search(rb"listening on http://127\.0\.0\.1:(\d+)", mock_path.read_bytes()))
            assert listening
            port = listening.group(1).decode()
            reopen = [installed, "sandbox", "offline", port, "--stage", stage, "--continue"]
            recover = [installed, "sandbox", "recover", stage]
            export = [installed, "sandbox", "export", stage]
            proof = stage / ".active/quiescence.json"
            scoping = stage / "scratch/scopes"

            def recover_now():
                return subprocess.run(recover, cwd=project, env=environment, capture_output=True, text=True, timeout=10)

            def signal_owned(pid, expected, received):
                assert expected and process_identity(pid) == expected, "owned process identity changed"
                os.kill(pid, received)

            server_pid = None
            server_identity = None
            # Keep the controlling PTY alive independently of the wrapper. Killing a
            # session leader can otherwise deliver a tty hangup to the whole group.
            guardian = [sys.executable, "-u", "-c", """
import subprocess, sys, time
launcher = subprocess.Popen(sys.argv[1:])
print(f"fixture wrapper {launcher.pid}", flush=True)
print(f"fixture wrapper exit {launcher.wait()}", flush=True)
time.sleep(40)
""", *reopen]
            with terminal(guardian, project, environment) as (_, _, contains, _, capture):
                assert wait_for(lambda: contains("Run the offline coding check"), 12)
                wrapper = re.search(rb"fixture wrapper (\d+)", capture)
                assert wrapper
                launcher = int(wrapper.group(1))
                launcher_identity = process_identity(launcher)
                assert json.loads(proof.read_text())["kind"] == "file-only-run"
                acknowledgment = next(scoping.glob(".readiness-*/ready.json"))
                server_pid = json.loads(acknowledgment.read_text())["pid"]
                server_identity = process_identity(server_pid)
                parent = subprocess.check_output(["/bin/ps", "-p", str(server_pid), "-o", "ppid="], text=True)
                assert int(parent) == launcher
                signal_owned(server_pid, server_identity, signal.SIGSTOP)
                try:
                    assert wait_for(lambda: subprocess.check_output(
                        ["/bin/ps", "-p", str(server_pid), "-o", "stat="], text=True).strip().startswith("T"), 3)
                    signal_owned(launcher, launcher_identity, signal.SIGKILL)
                    assert wait_for(lambda: contains("fixture wrapper exit -9"), 5)
                    assert process_identity(server_pid) == server_identity
                    with terminal(export, project, environment) as (_, _, denied, end, _):
                        end(3)
                        assert denied("lifetime is still held")
                    with terminal(reopen, project, environment) as (_, _, denied, end, _):
                        end(3)
                        assert denied("lifetime is still held")
                    jobs = [subprocess.Popen(recover, cwd=project, env=environment, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, text=True) for _ in range(2)]
                    for job in jobs:
                        _, error = job.communicate(timeout=5)
                        assert job.returncode == 3 and "lifetime is still held" in error
                    assert proof.is_file() and hashlib.sha256(host.read_bytes()).hexdigest() == host_hash
                    print("PASS: live orphan held the kernel lifetime lock after launcher SIGKILL; repeated recovery, reopen and export were refused")
                finally:
                    if process_identity(server_pid) == server_identity:
                        signal_owned(server_pid, server_identity, signal.SIGCONT)
            assert wait_for(lambda: process_identity(server_pid) != server_identity, 12), "owned server did not exit after lease EOF"

            complete = proof.read_bytes()
            proof.write_bytes(complete[:8])
            assert recover_now().returncode == 3 and proof.is_file()
            proof.write_bytes(complete)
            manifest = stage / "stage.json"
            saved = manifest.read_bytes()
            manifest.write_bytes(saved[:8])
            assert recover_now().returncode == 3 and proof.is_file()
            manifest.write_bytes(saved)
            # Reproduce interrupted removal of one readiness entry and keep the host proof intact.
            acknowledgment.unlink(missing_ok=True)
            jobs = [subprocess.Popen(recover, cwd=project, env=environment, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True) for _ in range(2)]
            outputs = [job.communicate(timeout=8) for job in jobs]
            assert any(job.returncode == 0 and "Retired the closed" in out for job, (out, _) in zip(jobs, outputs))
            assert all(job.returncode in {0, 3} for job in jobs)
            again = recover_now()
            assert again.returncode == 0 and "No native activation to retire" in again.stdout
            assert not list(scoping.iterdir()) and not proof.parent.exists()
            print("PASS: an independent exclusive lock allowed retirement after exit; partial proofs and manifests were refused, concurrent retirement and retry were safe")

            with terminal(reopen, project, environment) as (_, master, contains, finish, _):
                assert wait_for(lambda: contains("Run the offline coding check"), 12)
                os.write(master, b"\x04")
                finish(0)
            assert hashlib.sha256(host.read_bytes()).hexdigest() == host_hash
            with terminal(export, project, environment) as (exporter, _, contains, finish, _):
                assert wait_for(lambda: contains("Type apply"), 10)
                os.kill(exporter, signal.SIGKILL)
                finish(-9)
            for _ in range(2):
                refused = recover_now()
                assert refused.returncode == 3 and "no verified native writer proof" in refused.stderr
            assert hashlib.sha256(host.read_bytes()).hexdigest() == host_hash
            print("PASS: clean reopen worked again; interrupted export remained interlocked and left the host hash unchanged")
        finally:
            mock.terminate()
            mock.wait(timeout=5)


if __name__ == "__main__":
    main()
