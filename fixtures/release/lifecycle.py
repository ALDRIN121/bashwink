#!/usr/bin/env python3
"""Lifecycle qualification of the release CLI and image: exits, interruptions, repeats.

    python3 fixtures/release/lifecycle.py <archive-dir> --out report.json [--only name,name]

Uses the release archive's own CLI with a deliberately invalid provider key, so no model request
is made. Every scenario takes a process inventory before and after, and a run fails if a
Bashwink VM process or stage directory the scenario created is still there.

Scenarios: normal, ctrl-c, sigint, sigterm, sigkill, repeat, no-space, owner-fails.
The 30-minute deadline has its own long-running harness (deadline.py).
"""
import argparse
import json
import os
import re
import shutil
import signal
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

BASE = "https://api.commandcode.ai/provider/v1"
results = []


def check(name, ok, detail=""):
    results.append({"check": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"{'PASS' if ok else 'FAIL':5} {name}" + (f" — {detail}" if detail else ""), flush=True)


def vm_processes():
    """(pid, command) of Bashwink VM owners and every Virtualization helper, system wide."""
    rows = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout.splitlines()
    found = {}
    for row in rows:
        pid, _, command = row.strip().partition(" ")
        if "offline-vm/vm-owner" in command or "com.apple.Virtualization.VirtualMachine" in command:
            found[int(pid)] = command[:80]
    return found


def stage_dirs():
    return {p.name for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()}


def settle(before, seconds=8):
    """Wait for processes created since `before` to go away; return the survivors."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        extra = {pid: c for pid, c in vm_processes().items() if pid not in before}
        if not extra:
            return {}
        time.sleep(0.5)
    return {pid: c for pid, c in vm_processes().items() if pid not in before}


class Install:
    def __init__(self, archive_dir, work, key_file):
        self.work = work
        self.home = work / "home"
        self.home.mkdir()
        self.env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(self.home), "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
        archive = next(archive_dir.glob("*.tar.gz"))
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter="tar")
        subprocess.run([next(work.glob("bashwink-*-macos-arm64")) / "install.sh"], env=self.env, check=True, capture_output=True)
        self.bw = self.home / ".local/bin/bashwink"
        self.project = work / "project"
        self.project.mkdir()
        (self.project / "a.ts").write_text("export const a = 1\n")
        ge = {**self.env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
        for step in (["git", "init", "-q", "."], ["git", "add", "a.ts"], ["git", "commit", "-qm", "i"]):
            subprocess.run(step, cwd=self.project, env=ge, check=True)
        for args in (["auth", "add", "commandcode", "--base-url", BASE, "--key-file", str(key_file), "--model", "claude-sonnet-5:anthropic"],
                     ["model", "use", "commandcode/claude-sonnet-5"], ["trust", str(self.project), "--by", "lifecycle"]):
            subprocess.run([self.bw, *args], cwd=self.project, env=self.env, check=True, capture_output=True)

    def launch(self):
        return terminal([self.bw], self.project, self.env)


def to_tui(contains, capture):
    return wait_for(lambda: contains("Ask anything"), 60)


def scenario_normal(inst):
    before, stages = set(vm_processes()), stage_dirs()
    with inst.launch() as (pid, master, contains, finish, capture):
        ok = to_tui(contains, capture)
        os.write(master, b"\x04")
        finish(0)
    check("normal exit: TUI reached, exit 0", ok)
    check("normal exit: no VM process left", not settle(before), str(settle(before)))
    check("normal exit: no stage directory left", stage_dirs() - stages == set(), str(stage_dirs() - stages))


def scenario_ctrl_c(inst):
    before, stages = set(vm_processes()), stage_dirs()
    with inst.launch() as (pid, master, contains, finish, capture):
        ok = to_tui(contains, capture)
        time.sleep(1)
        # Ctrl+C reaches the guest TUI as input. Two presses on an idle prompt, then Ctrl+D if needed.
        os.write(master, b"\x03")
        time.sleep(1)
        os.write(master, b"\x03")
        exited = wait_for(lambda: (contains(""), None)[1] or contains("HOST_VM_STOPPED"), 20)
        if not exited:
            os.write(master, b"\x04")
        try:
            finish(0)
            code0 = True
        except AssertionError as error:
            code0 = False
            print("   exit status detail:", str(error)[:160])
    check("Ctrl+C in the TUI ends the session", ok and code0, "exited on Ctrl+C" if exited else "needed Ctrl+D after two Ctrl+C")
    check("Ctrl+C: no VM process left", not settle(before), str(settle(before)))


def signalled(inst, sig, label, expect_codes):
    before, stages = set(vm_processes()), stage_dirs()
    with inst.launch() as (pid, master, contains, finish, capture):
        to_tui(contains, capture)
        time.sleep(1)
        os.kill(pid, sig)
        try:
            wait_for(lambda: (contains(""), None)[1] or False, 1)
            finish(expect_codes[0])
            code = True
        except AssertionError as error:
            code = str(error)[:140]
    left = settle(before, 12)
    check(f"{label}: launcher ends with an expected status", code is True, str(code))
    check(f"{label}: the VM and its helper stop", not left, str(left))
    kept = stage_dirs() - stages
    check(f"{label}: an interrupted session keeps its stage for recovery, registered", len(kept) == 1, str(kept))
    listed = subprocess.run([inst.bw, "sandbox", "stages"], env=inst.env, cwd=inst.project, capture_output=True, text=True).stdout
    check(f"{label}: `sandbox stages` lists it as removable (its session is gone)", any(k in listed and "would remove" in listed for k in kept), listed.strip()[:200])
    purged = subprocess.run([inst.bw, "sandbox", "stages", "--purge"], env=inst.env, cwd=inst.project, capture_output=True, text=True)
    check(f"{label}: `sandbox stages --purge` removes exactly that stage", purged.returncode == 0 and not (stage_dirs() & kept), purged.stdout.strip()[:200])
    # A fresh session works afterwards (nothing stuck behind: lock, state, project).
    with inst.launch() as (_, master, contains, finish, capture):
        again = to_tui(contains, capture)
        os.write(master, b"\x04")
        finish(0)
    check(f"{label}: a new session starts afterwards", bool(again))


def scenario_sigint(inst):
    signalled(inst, signal.SIGINT, "SIGINT", (130,))


def scenario_sigterm(inst):
    signalled(inst, signal.SIGTERM, "SIGTERM", (143, 130))


def scenario_sigkill(inst):
    signalled(inst, signal.SIGKILL, "SIGKILL", (-9,))


def scenario_repeat(inst):
    before, stages = set(vm_processes()), stage_dirs()
    times = []
    for _ in range(10):
        began = time.monotonic()
        with inst.launch() as (_, master, contains, finish, capture):
            if to_tui(contains, capture):
                times.append(round(time.monotonic() - began, 2))
            os.write(master, b"\x04")
            finish(0)
    check("10 consecutive sessions each reach the TUI and exit 0", len(times) == 10, str(times))
    left = settle(before)
    check("10 sessions: no VM process accumulates", not left, str(left))
    check("10 sessions: no stage directory accumulates", stage_dirs() - stages == set(), str(stage_dirs() - stages))
    shells = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    leaked = [row for row in shells.splitlines() if "lib/bashwink.js" in row and str(inst.home) in row]
    check("10 sessions: no Bashwink launcher process remains", not leaked, str(leaked[:3]))


def scenario_no_space(inst):
    """State directory on a full volume: the launch must refuse clearly, leave nothing running."""
    image = inst.work / "full.dmg"
    subprocess.run(["/usr/bin/hdiutil", "create", "-size", "24m", "-fs", "HFS+", "-volname", "bwfull", "-ov", str(image)], check=True, capture_output=True)
    attach = subprocess.run(["/usr/bin/hdiutil", "attach", "-nobrowse", "-noverify", str(image)], check=True, capture_output=True, text=True).stdout
    mount = re.search(r"(/Volumes/\S+)\s*$", attach.strip().splitlines()[-1])
    if mount is None:
        check("full-volume setup", False, attach[-200:])
        return
    volume = Path(mount[1])
    try:
        # A fully configured, approved installation whose STATE lives on the small volume.
        shutil.copytree(inst.home / ".config/bashwink", volume / "bw")
        filler = volume / "filler"
        with filler.open("wb", buffering=0) as handle:  # unbuffered: errors surface at the write, not at close
            for chunk in (1 << 20, 1 << 12, 1 << 9, 1):
                try:
                    while True:
                        handle.write(b"\0" * chunk)
                except OSError:
                    continue  # retry with a smaller chunk until not a single byte fits
        free = shutil.disk_usage(volume).free
        check("full state volume: the volume really is full", free < 4096, f"{free} bytes free")
        before, stages = set(vm_processes()), stage_dirs()
        env = {**inst.env, "BASHWINK_HOME": str(volume / "bw")}
        with terminal([inst.bw], inst.project, env) as (pid, master, contains, finish, capture):
            wait_for(lambda: contains("No model request was made") or contains("Ask anything"), 90)
            time.sleep(1)
            contains("")
            reached_tui = b"Ask anything" in bytes(capture)
            out = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", bytes(capture).decode(errors="replace"))
            if reached_tui:
                os.write(master, b"\x04")
            try:
                finish(3)
                code = 3
            except AssertionError as error:
                found = re.match(r"\((-?\d+|None),", str(error))
                code = found[1] if found else "?"
        check("full state volume: the launch refuses (exit 3) and never reaches the TUI", code == 3 and not reached_tui, f"exit {code}, volume free {free} bytes")
        check("full state volume: the message names the real cause (no space)", "no space left" in out.lower() or "enospc" in out.lower(), " ".join(out.split())[:240])
        check("full state volume: the launch stopped before any model request", "No model request was made" in out or "provider usage" not in out)
        check("full state volume: no VM process or stage directory was created", not settle(before, 3) and stage_dirs() - stages == set())
    finally:
        subprocess.run(["/usr/bin/hdiutil", "detach", "-force", str(volume)], capture_output=True)
        image.unlink(missing_ok=True)


def scenario_owner_fails(inst):
    """The VM owner cannot start the VM: no model request, a clear status, the stage is recorded."""
    repo = HERE.parents[1]
    root = inst.work / "dev-install"
    subprocess.run([repo / "scripts/build_alpha.sh", root], check=True, stdout=subprocess.DEVNULL)
    lib = root / "lib"
    (lib / "offline-vm").mkdir()
    release = next(inst.work.glob("bashwink-*-macos-arm64"))
    for name in ("Image", "initramfs"):
        shutil.copyfile(release / "lib/offline-vm" / name, lib / "offline-vm" / name)
        (lib / "offline-vm" / name).chmod(0o644)
    (lib / "offline-vm/vm-owner").write_text("#!/bin/sh\nexit 7\n")
    (lib / "offline-vm/vm-owner").chmod(0o755)
    import hashlib
    digests = {n: hashlib.sha256((lib / "offline-vm" / n).read_bytes()).hexdigest() for n in ("vm-owner", "Image", "initramfs")}
    (lib / "offline-vm.json").write_text(json.dumps({"version": 2, "relay": True, "sha256": digests}))
    state = inst.work / "owner-fails-state"
    env = {**inst.env, "BASHWINK_HOME": str(state), "BASHWINK_VM_PROVIDER": "commandcode",
           "PATH": inst.env["PATH"] + ":" + str(Path(shutil.which("bun")).parent)}
    for args in (["auth", "add", "commandcode", "--base-url", BASE, "--key-file", str(inst.work / "bogus.key"), "--model", "claude-sonnet-5:anthropic"],
                 ["model", "use", "commandcode/claude-sonnet-5"], ["trust", str(inst.project), "--by", "lifecycle"]):
        done = subprocess.run([root / "bin/bashwink", *args], cwd=inst.project, env=env, capture_output=True, text=True)
        if done.returncode != 0:
            check(f"owner-fails setup: bashwink {' '.join(args[:2])}", False, (done.stdout + done.stderr).strip()[:300])
            return
    before, stages = set(vm_processes()), stage_dirs()
    with terminal([root / "bin/bashwink"], inst.project, env) as (pid, master, contains, finish, capture):
        wait_for(lambda: contains("VM owner exited"), 60)
        try:
            finish(1)
            code = "1"
        except AssertionError as error:
            code = str(error)[:60]
        text = bytes(capture).decode(errors="replace")
    check("a VM owner that fails to start: a clear status is shown", "VM owner exited with status 7" in text, code)
    check("a VM owner that fails to start: no relay request was possible and none is recorded",
          not any(json.loads(f.read_text())["requests"] for f in state.glob("data/vm-projects/*/provider-usage-*.json")))
    kept = stage_dirs() - stages
    check("a VM owner that fails to start: the stage is retained and registered", len(kept) == 1, str(kept))
    purged = subprocess.run([root / "bin/bashwink", "sandbox", "stages", "--purge"], env=env, cwd=inst.project, capture_output=True, text=True)
    check("a VM owner that fails to start: its stage is purged through the registry", purged.returncode == 0 and not (kept & stage_dirs()))
    check("a VM owner that fails to start: no VM process remains", not settle(before, 3))


SCENARIOS = {"normal": scenario_normal, "ctrl-c": scenario_ctrl_c, "sigint": scenario_sigint, "sigterm": scenario_sigterm,
             "sigkill": scenario_sigkill, "repeat": scenario_repeat, "no-space": scenario_no_space,
             "owner-fails": scenario_owner_fails}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only")
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="bw-lifecycle-")).resolve()
    try:
        key = work / "bogus.key"
        key.write_text("bw-invalid-credential-for-lifecycle\n")
        key.chmod(0o600)
        inst = Install(args.archive_dir, work, key)
        start = {"vm_processes": vm_processes(), "stages": sorted(stage_dirs())}
        for name in (args.only.split(",") if args.only else SCENARIOS):
            print(f"--- {name}", flush=True)
            SCENARIOS[name](inst)
        end = {"vm_processes": vm_processes(), "stages": sorted(stage_dirs())}
        new_processes = {p: c for p, c in end["vm_processes"].items() if p not in start["vm_processes"]}
        check("whole run: no new VM process survives", not new_processes, str(new_processes))
        args.out.write_text(json.dumps({"results": results, "start": start, "end": end}, indent=2) + "\n")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0 if all(r["verdict"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
