"""Installed PTY acceptance for the persistent VM project profile."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import sys
import time

from recovery import terminal
from run import DialogApprover, process_identity, wait_for


def digest(data):
    return hashlib.sha256(data).hexdigest()


def accept_project(root, runner, image, initramfs, protected, relay=False):
    install = root / "bashwink"
    installed = install / "bin/bashwink"
    assets = install / "lib/offline-vm"
    assets.mkdir()
    for name, source in (("vm-owner", runner), ("Image", image), ("initramfs", initramfs)):
        source.rename(assets / name)
    (assets.parent / "offline-vm.json").write_text(json.dumps({
        "version": 2, **({"relay": True} if relay else {}),
        "sha256": {file.name: digest(file.read_bytes()) for file in assets.iterdir()},
    }))
    project = root / "git-project"
    project.mkdir()
    state = root / "private-state"
    environment = {
        "PATH": os.environ["PATH"], "HOME": str(root), "TERM": "xterm-256color",
        "BASHWINK_HOME": str(state), "BASHWINK_OPENCODE_BIN": "/missing-host-opencode",
    }
    launch = [installed]
    if relay:
        key = "disposable-host-provider-canary-6G47"
        bun = shutil.which("bun", path=environment["PATH"])
        assert bun
        fixture = Path(__file__).resolve().parent / "vm-provider-fixture.ts"
        entry = assets.parent / "vm-provider-fixture.js"
        subprocess.run([bun, "build", fixture, "--target=bun", "--outfile", entry], check=True)
        environment.update(BW_SYNTHETIC_CREDENTIAL=key, BASHWINK_VM_PROVIDER="relaydemo",
                           BASHWINK_VM_MAX_REQUESTS="10")
        for args in (
            ["auth", "add", "relaydemo", "--base-url", "https://api.openai.com/v1",
             "--env", "BW_SYNTHETIC_CREDENTIAL", "--model", "fixture-model:openai"],
            ["model", "use", "relaydemo/fixture-model"],
        ):
            subprocess.run([installed, *args], cwd=project, env=environment, check=True,
                           stdout=subprocess.DEVNULL)
        launch = [Path(bun), entry]
    originals = {
        "one.ts": b"export const one = 0\n",
        "two.ts": b"export const two = 0\n",
        "obsolete.ts": b"export const obsolete = true\n",
        "accept.test.ts": b'import { expect, test } from "bun:test"\n'
                         b'import { one } from "./one"\nimport { two } from "./two"\n'
                         b'import { added } from "./new"\n'
                         b'test("independent acceptance", () => expect([one, two, added]).toEqual([2, 3, 5]))\n',
    }
    for name, content in originals.items():
        (project / name).write_bytes(content)
    subprocess.run(["git", "init", "-q", "."], cwd=project, env=environment, check=True)
    subprocess.run(["git", "add", "--", *originals], cwd=project, env=environment, check=True)
    subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "initial"], cwd=project, env=environment, check=True)
    (project / ".env").write_bytes(b"SYNTHETIC_UNAPPROVED_FIXTURE=sentinel\n")
    outside_hash = digest(protected.read_bytes())

    def feed(master, text):
        os.write(master, text.encode())
        time.sleep(0.15)
        os.write(master, b"\r")

    def seen(contains, label, capture, seconds=25):
        assert wait_for(lambda: contains(label), seconds), (label, bytes(capture[-1600:]))

    def checkpoint():
        [path] = list(state.glob("data/vm-projects/*/checkpoint.json"))
        record = json.loads(path.read_bytes())
        assert digest(record["payload"].encode()) == record["digest"]
        return path.parent, json.loads(record["payload"])["snapshot"]

    def check_unchanged():
        assert all((project / name).read_bytes() == data for name, data in originals.items())
        assert not (project / "new.ts").exists()
        assert (project / ".env").read_bytes() == b"SYNTHETIC_UNAPPROVED_FIXTURE=sentinel\n"
        assert digest(protected.read_bytes()) == outside_hash

    def ticker(raw_disk):
        with raw_disk.open("rb") as source:
            source.seek(1024)
            counter = source.read(512).rstrip(b"\0")
        return int(counter.strip()) if re.fullmatch(rb"[0-9]+\n", counter) else 0

    with terminal(launch, project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Ask anything", capture, 35)
        time.sleep(0.25)
        feed(master, "Fix the persistent project")
        approver = DialogApprover(lambda data: os.write(master, data))

        def completed():
            done = contains("VM project tool sequence completed")
            approver.poll(bytes(capture))
            return done

        try:
            assert wait_for(completed, 45), f"coding did not finish, {approver.sent} dialogs approved"
            # Both shell steps (3 and 4) were reached and each needed an interactive approval.
            assert approver.sent >= 2 and b"BW_VM_PROJECT_TOOL_3" in capture and b"BW_VM_PROJECT_TOOL_4" in capture
            raw_path = re.search(rb"Bashwink offline VM stage: (/private/tmp/bashwink-vm-[A-Za-z0-9]+)", capture)
            assert raw_path
            raw_disk = Path(os.fsdecode(raw_path[1])) / "stage.raw"
            assert wait_for(lambda: ticker(raw_disk) >= 2, 5), "detached writer did not start"
            os.write(master, b"\x04")
            finish(0)
            assert contains("HOST_VM_STOPPED")
        finally:
            (root / "project-coding.pty").write_bytes(capture)
    check_unchanged()
    retired_tick = ticker(raw_disk)
    time.sleep(0.8)
    assert ticker(raw_disk) == retired_tick, "detached writer survived project shutdown"
    directory, saved = checkpoint()
    [identifier] = saved["sessions"]
    before_files = saved["files"]
    assert set(before_files) == {"one.ts", "two.ts", "new.ts", "accept.test.ts"}
    assert base64.b64decode(before_files["one.ts"]) == b"export const one = 2\n"
    assert base64.b64decode(before_files["two.ts"]) == b"export const two = 3\n"
    assert base64.b64decode(before_files["new.ts"]) == b"export const added = 5\n"
    assert base64.b64decode(before_files["accept.test.ts"]) == originals["accept.test.ts"]
    evidence_key = "bashwink/data/evidence/evidence.jsonl"
    plan_key = "bashwink/data/current-plan.json"
    task_plan = saved["state"][plan_key]
    assert json.loads(base64.b64decode(task_plan))["objective"] == "Persistent VM fixture task"
    assert "bashwink/data/bashwink.sqlite" in saved["state"]
    evidence = base64.b64decode(saved["state"][evidence_key])
    print("PASS: installed PTY completed a multi-file edit and approved VM tests while the checkout stayed unchanged", flush=True)

    for label, arguments in (("continue", ["--continue"]), ("session", ["--session", identifier])):
        with terminal([*launch, *arguments], project, environment) as (_, master, contains, finish, capture):
            try:
                seen(contains, "Fix the persistent project", capture, 35)
                time.sleep(0.25)
                feed(master, "Continue the saved project task")
                seen(contains, "VM project original conversation observed", capture)
                os.write(master, b"\x04")
                finish(0)
            finally:
                (root / f"project-{label}.pty").write_bytes(capture)
        _, next_saved = checkpoint()
        assert next_saved["sessions"] == [identifier] and next_saved["files"] == before_files
        next_evidence = base64.b64decode(next_saved["state"][evidence_key])
        assert next_evidence.startswith(evidence) and len(next_evidence) > len(evidence)
        assert next_saved["state"][plan_key] == task_plan
        evidence = next_evidence
    print(f"PASS: --continue and --session {identifier} preserved conversation, task plan, project files, and evidence", flush=True)

    # Hold the PTY through launcher death so the owner can demonstrate lease EOF independently.
    guardian = [sys.executable, "-u", "-c", """
import subprocess, sys, time
child = subprocess.Popen(sys.argv[1:])
print(f"fixture launcher {child.pid}", flush=True)
print(f"fixture exit {child.wait()}", flush=True)
time.sleep(20)
""", *launch, "--continue"]
    with terminal(guardian, project, environment) as (_, _, contains, _, capture):
        seen(contains, "Fix the persistent project", capture, 35)
        with (directory / ".lifetime").open("rb") as held:
            try:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                raise AssertionError("live VM did not block project access")
        launcher = int(re.search(rb"fixture launcher (\d+)", capture)[1])
        assert process_identity(launcher)
        rows = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,command="], text=True)
        [owner] = [int(pid) for pid, parent, command in (row.split(maxsplit=2) for row in rows.splitlines())
                   if int(parent) == launcher and command.startswith(str(assets / "vm-owner") + " ")]
        owner_identity = process_identity(owner)
        assert owner_identity and process_identity(owner) == owner_identity
        os.kill(owner, signal.SIGSTOP)
        try:
            os.kill(launcher, signal.SIGKILL)
            seen(contains, "fixture exit -9", capture, 8)
            assert process_identity(owner) == owner_identity
            refused = subprocess.run([installed, "sandbox", "vm-review"], cwd=project, env=environment,
                                     capture_output=True, text=True, timeout=6)
            assert refused.returncode == 3 and "lifetime is still held" in refused.stderr
            if relay:
                raw = re.search(rb"Bashwink offline VM stage: (/private/tmp/bashwink-vm-[A-Za-z0-9]+)", capture)
                assert raw
                with socket.socket(socket.AF_UNIX) as probe:
                    try:
                        probe.connect(str(Path(os.fsdecode(raw[1])) / "relay.sock"))
                    except (ConnectionRefusedError, FileNotFoundError):
                        pass
                    else:
                        raise AssertionError("relay remained reachable after launcher death")
        finally:
            if process_identity(owner) == owner_identity:
                os.kill(owner, signal.SIGCONT)
        seen(contains, "HOST_VM_STOPPED", capture, 10)
    assert checkpoint()[1] == next_saved
    check_unchanged()
    saved_path = directory / "checkpoint.json"
    good_record = saved_path.read_bytes()
    saved_path.write_bytes(good_record[:12])
    try:
        with terminal([installed, "--continue"], project, environment) as (_, _, contains, finish, _):
            finish(3)
            assert not contains("Ask anything")
    finally:
        saved_path.write_bytes(good_record)
    with terminal([*launch, "--continue"], project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Fix the persistent project", capture, 35)
        os.write(master, b"\x04")
        finish(0)
    assert checkpoint()[1]["files"] == before_files
    foreign = root / "foreign"
    foreign.mkdir()
    (foreign / "one.ts").write_bytes(originals["one.ts"])
    subprocess.run(["git", "init", "-q", "."], cwd=foreign, env=environment, check=True)
    subprocess.run(["git", "add", "one.ts"], cwd=foreign, env=environment, check=True)
    subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "foreign"], cwd=foreign, env=environment, check=True)
    with terminal([installed, "--session", identifier], foreign, environment) as (_, _, contains, finish, _):
        finish(3)
        assert contains("no saved session owned by this VM project") and not contains("Ask anything")
    print("PASS: reopened the last sealed checkpoint after launcher death, and refused corrupt or foreign session state", flush=True)

    review = [installed, "sandbox", "vm-review"]
    bun = shutil.which("bun", path=environment["PATH"])
    fault = Path(__file__).resolve().parent / "vm-apply-interrupt.ts"
    assert bun
    for phase in ("journaled", "stage-created"):
        with terminal([Path(bun), fault, phase, "one.ts"], project, environment) as (_, master, contains, finish, capture):
            seen(contains, "Type apply", capture)
            feed(master, "apply")
            finish(-9)
        check_unchanged()
        unidentified = list(project.glob(".bashwink-vm-apply-*"))
        assert len(unidentified) == (0 if phase == "journaled" else 1)
        for _ in range(2):
            recovered = subprocess.run([installed, "sandbox", "vm-recover"], cwd=project, env=environment, capture_output=True, text=True)
            assert recovered.returncode == 0, recovered.stderr
        assert all(stage.is_dir() for stage in unidentified), "unidentified staging was not preserved"
        check_unchanged()
    assert len(list(directory.glob("apply-abandoned-*.json"))) == 2
    print("PASS: SIGKILL before staging identity preserved host files and quarantined the unidentified directory", flush=True)
    with terminal(review, project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Type apply", capture)
        for name, operation in (("one.ts", "modified"), ("two.ts", "modified"),
                                ("new.ts", "added"), ("obsolete.ts", "deleted")):
            assert contains(f"@@ {name} ({operation}) @@")
        feed(master, "no")
        finish(0)
    check_unchanged()
    with terminal(review, project, environment) as (pid, _, contains, finish, capture):
        seen(contains, "Type apply", capture)
        os.kill(pid, signal.SIGKILL)
        finish(-9)
    check_unchanged()

    (project / "new.ts").write_bytes(b"export const conflict = true\n")
    with terminal(review, project, environment) as (_, master, contains, finish, capture):
        if wait_for(lambda: contains("Type apply"), 3):
            feed(master, "apply")
        finish(3)
    assert (project / "new.ts").read_bytes() == b"export const conflict = true\n"
    (project / "new.ts").unlink()
    check_unchanged()

    with terminal([*review, "one.ts"], project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Type apply", capture)
        assert contains("@@ one.ts (modified) @@") and not contains("@@ two.ts")
        feed(master, "apply")
        finish(0)
    assert (project / "one.ts").read_bytes() == base64.b64decode(before_files["one.ts"])
    assert (project / "two.ts").read_bytes() == originals["two.ts"]
    assert not (project / "new.ts").exists()
    with terminal([*launch, "--continue"], project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Fix the persistent project", capture, 35)
        feed(master, "Continue the saved project task")
        seen(contains, "VM project original conversation observed", capture)
        os.write(master, b"\x04")
        finish(0)
    assert (project / "one.ts").read_bytes() == base64.b64decode(before_files["one.ts"])
    assert (project / "two.ts").read_bytes() == originals["two.ts"]
    print("PASS: session resumed after the first reviewed application", flush=True)
    with terminal(review, project, environment) as (_, master, contains, finish, capture):
        seen(contains, "Type apply", capture)
        assert not contains("@@ one.ts (modified) @@"), "already applied file returned in review"
        assert contains("@@ two.ts (modified) @@")
        feed(master, "no")
        finish(0)
    print("PASS: refreshed baseline excludes the previously applied file from the next review", flush=True)

    recovery = [installed, "sandbox", "vm-recover"]
    for phase, selection in (("prepared", ["two.ts"]), ("mutated", ["new.ts", "obsolete.ts"])):
        with terminal([Path(bun), fault, phase, *selection], project, environment) as (_, master, contains, finish, capture):
            seen(contains, "Type apply", capture)
            feed(master, "apply")
            finish(-9)
        assert (directory / "apply.json").is_file()
        assert (project / "obsolete.ts").read_bytes() == originals["obsolete.ts"]
        new_file = project / "new.ts"
        if phase == "prepared":
            assert (project / "two.ts").read_bytes() == originals["two.ts"] and not new_file.exists()
        else:
            installed_inode = new_file.stat().st_ino
        for _ in range(2):
            recovered = subprocess.run(recovery, cwd=project, env=environment, capture_output=True, text=True)
            assert recovered.returncode == 0, recovered.stderr
        assert not (directory / "apply.json").exists()
        if phase == "mutated":
            assert new_file.stat().st_ino == installed_inode
    print("PASS: PTY approvals survived SIGKILL before and during application, and recovery preserved the already applied inode", flush=True)
    assert not (project / "obsolete.ts").exists()
    for name, data in before_files.items():
        assert (project / name).read_bytes() == base64.b64decode(data)
    receipts = [json.loads(receipt.read_bytes())["record"] for receipt in directory.glob("apply-receipt-*.json")]
    assert len(receipts) == 3 and all(item["outcome"] == "committed" for item in receipts)
    committed = {entry["name"]: entry["after"] for item in receipts for entry in item["files"]}
    assert committed["obsolete.ts"] is None
    for name in ("new.ts", "one.ts", "two.ts"):
        assert committed[name]["revision"] == digest((project / name).read_bytes())
    assert (project / ".env").read_bytes() == b"SYNTHETIC_UNAPPROVED_FIXTURE=sentinel\n"
    assert digest(protected.read_bytes()) == outside_hash
    changed = subprocess.check_output(["git", "diff", "--name-only"], cwd=project, env=environment)
    assert set(changed.decode().splitlines()) == {"obsolete.ts", "one.ts", "two.ts"}
    protected_test = project / "accept.test.ts"
    protected_test.write_bytes(b"// edited test fixture\n")
    with terminal([installed, "sandbox", "vm-verify"], project, environment) as (_, _, contains, finish, _):
        finish(3)
        assert contains("protected host test changed")
    protected_test.write_bytes(originals["accept.test.ts"])
    with terminal([installed, "sandbox", "vm-verify"], project, environment) as (_, _, contains, finish, capture):
        seen(contains, "Protected tests exited with status 0", capture, 35)
        finish(0)
    [verification] = list(directory.glob("verification-*.json"))
    report = json.loads(verification.read_bytes())
    assert report["exitCode"] == 0 and report["protectedHashes"] == {
        "accept.test.ts": digest(originals["accept.test.ts"]),
    }
    assert report["sourceHashes"]["new.ts"] == digest((project / "new.ts").read_bytes())
    assert b"1 pass" in report["output"].encode()
    print("PASS: review cancellation, interrupted review, conflict refusal, apply, and protected test verification matched the exact host diff", flush=True)
    if relay:
        usages = [json.loads(file.read_bytes()) for file in directory.glob("provider-usage-*.json")]
        assert any(report["inputTokens"] > 0 and report["outputTokens"] > 0 for report in usages)
        assert any(report.get("requestedSession") == identifier and report["requests"] > 0 for report in usages)
        assert all(report["requests"] <= report["maxRequests"] for report in usages)
        assert all(record["model"] == "fixture-model" for report in usages for record in report["models"])
        assert all(key.encode() not in transcript.read_bytes() for transcript in root.glob("*.pty"))
        assert key not in json.dumps(usages)
        assert all(key.encode() not in base64.b64decode(blob) for blob in checkpoint()[1]["state"].values())
        print("PASS: real guest OpenCode streamed through the synthetic relay and host usage records, guest state and PTY held no provider credential", flush=True)
