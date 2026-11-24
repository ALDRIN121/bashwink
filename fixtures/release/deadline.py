#!/usr/bin/env python3
"""The session deadline, end to end, at the real default (about 29 minutes in the guest).

    python3 fixtures/release/deadline.py <release-dir> --out report.json

Runs the release VM image behind a synthetic upstream (the release CLI only talks to real provider
hosts, so a fixture entry supplies the relay). The turn edits files; the session is then left idle
until the guest's own deadline ends it. Checks, from independent observations on the host:

  - the session ended on its own, with exit 0, after about 29 minutes (guest deadline 1,740,000 ms,
    host VM timer 1,800,000 ms), not by the host timer (which would exit 124 and lose the work);
  - the guest told the user the time limit was reached and that the work is saved;
  - the saved checkpoint holds the files the turn edited and a hash-chained evidence log that
    extends the previous one with a fresh boot;
  - the host project is unchanged until review, and no VM process or helper is left.
"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "fixtures/native-offline"))
from recovery import terminal  # noqa: E402
from run import DialogApprover, wait_for, purge_stages_under  # noqa: E402

GUEST_MS = 1_740_000
HOST_MS = 1_800_000


def vm_processes():
    rows = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout.splitlines()
    out = {}
    for row in rows:
        pid, _, command = row.strip().partition(" ")
        if "vm-owner" in command or "com.apple.Virtualization.VirtualMachine" in command:
            out[int(pid)] = command[:70]
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    release = args.release.resolve()
    root = Path(tempfile.mkdtemp(prefix="bw-deadline-")).resolve()
    report = {"guest_deadline_ms": GUEST_MS, "host_timer_ms": HOST_MS, "checks": []}

    def check(name, ok, detail=""):
        report["checks"].append({"check": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
        print(f"{'PASS' if ok else 'FAIL':5} {name}" + (f" — {detail}" if detail else ""), flush=True)

    try:
        subprocess.run([REPO / "scripts/build_alpha.sh", root / "bashwink"], check=True, stdout=subprocess.DEVNULL)
        lib = root / "bashwink/lib"
        (lib / "offline-vm").mkdir()
        for name in ("vm-owner", "Image", "initramfs"):
            shutil.copyfile(release / "lib/offline-vm" / name, lib / "offline-vm" / name)
            (lib / "offline-vm" / name).chmod(0o755 if name == "vm-owner" else 0o644)
        shutil.copyfile(release / "lib/offline-vm.json", lib / "offline-vm.json")
        entry = lib / "vm-provider-fixture.js"
        subprocess.run([shutil.which("bun"), "build", REPO / "fixtures/native-offline/vm-provider-fixture.ts", "--target=bun", "--outfile", entry],
                       check=True, stdout=subprocess.DEVNULL)
        project = root / "project"
        project.mkdir()
        files = {"one.ts": "export const one = 0\n", "two.ts": "export const two = 0\n", "obsolete.ts": "export const obsolete = true\n",
                 "accept.test.ts": 'import { expect, test } from "bun:test"\nimport { one } from "./one"\nimport { two } from "./two"\n'
                                   'import { added } from "./new"\ntest("independent acceptance", () => expect([one, two, added]).toEqual([2, 3, 5]))\n'}
        for name, text in files.items():
            (project / name).write_text(text)
        env = {"PATH": os.environ["PATH"], "HOME": str(root), "TERM": "xterm-256color", "BASHWINK_HOME": str(root / "state"),
               "BASHWINK_OPENCODE_BIN": "/missing-host-opencode", "BW_SYNTHETIC_CREDENTIAL": "disposable-host-provider-canary-deadline",
               "BASHWINK_VM_PROVIDER": "relaydemo", "BASHWINK_VM_MAX_REQUESTS": "10"}
        ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
        for step in (["git", "init", "-q", "."], ["git", "add", *files], ["git", "commit", "-qm", "i"]):
            subprocess.run(step, cwd=project, env=ge, check=True)
        bw = root / "bashwink/bin/bashwink"
        for a in (["auth", "add", "relaydemo", "--base-url", "https://api.openai.com/v1", "--env", "BW_SYNTHETIC_CREDENTIAL", "--model", "fixture-model:openai"],
                  ["model", "use", "relaydemo/fixture-model"]):
            subprocess.run([bw, *a], cwd=project, env=env, check=True, stdout=subprocess.DEVNULL)
        before = set(vm_processes())
        bun = shutil.which("bun")
        with terminal([bun, entry], project, env) as (pid, master, contains, finish, capture):
            started = time.monotonic()
            assert wait_for(lambda: contains("Ask anything"), 60), "TUI did not start"
            time.sleep(0.3)
            os.write(master, b"Fix the persistent project")
            time.sleep(0.2)
            os.write(master, b"\r")
            approver = DialogApprover(lambda data: os.write(master, data))
            end = time.monotonic() + 120
            while time.monotonic() < end and not contains("VM project tool sequence completed"):
                approver.poll(bytes(capture))
                time.sleep(0.1)
            check("the turn completed and edited files before the deadline", contains("VM project tool sequence completed"))
            print(f"   turn done at +{time.monotonic() - started:.0f}s; idling until the guest deadline ...", flush=True)
            # Wait for the whole thing to end by itself. 33 minutes is a hard bound.
            limit = started + 33 * 60
            while time.monotonic() < limit:
                contains("")  # drains output and reaps the child once it has exited
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(1)
            status = None
            elapsed = time.monotonic() - started
            contains("")
            try:
                finish(0)
                status = 0
            except AssertionError as error:
                found = re.match(r"\((-?\d+|None),", str(error))
                status = found[1] if found else "unknown"
            console = bytes(capture).decode(errors="replace")
            report["elapsed_seconds"] = round(elapsed, 1)
            report["exit_status"] = status
        check("the session ended by itself with exit 0 (not the host timer's 124)", status == 0, f"status {status} after {elapsed:.0f}s")
        check("it ended near the guest deadline (29 minutes), not near the host timer (30)", GUEST_MS / 1000 - 30 <= elapsed <= GUEST_MS / 1000 + 90, f"{elapsed:.0f}s; guest {GUEST_MS/1000:.0f}s, host {HOST_MS/1000:.0f}s")
        check("the user was told the limit was reached and the work saved", "time limit was reached" in console and "work is saved" in console)
        [checkpoint] = list((root / "state/data/vm-projects").glob("*/checkpoint.json"))
        record = json.loads(json.loads(checkpoint.read_text())["payload"])
        saved = {k: base64.b64decode(v).decode() for k, v in record["snapshot"]["files"].items()}
        check("the saved checkpoint holds the files the turn edited", saved.get("one.ts") == "export const one = 2\n" and saved.get("new.ts") == "export const added = 5\n" and "obsolete.ts" not in saved, str(sorted(saved)))
        evidence = base64.b64decode(record["snapshot"]["state"]["bashwink/data/evidence/evidence.jsonl"]).decode()
        check("the evidence log was saved and contains the turn's tool calls", evidence.count('"phase":"after"') >= 3 and '"phase":"boot"' in evidence)
        check("the host project is unchanged until review", all((project / n).read_text() == t for n, t in files.items()) and not (project / "new.ts").exists())
        left = {p: c for p, c in vm_processes().items() if p not in before}
        time.sleep(3)
        left = {p: c for p, c in vm_processes().items() if p not in before}
        check("no VM owner or helper process remains", not left, str(left))
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    finally:
        purge_stages_under(root, root / "bashwink/bin/bashwink")
        shutil.rmtree(root, ignore_errors=True)
    return 0 if all(c["verdict"] == "PASS" for c in report["checks"]) else 1


if __name__ == "__main__":
    sys.exit(main())
