#!/usr/bin/env python3
"""Measure the release VM image's startup, whole-workload resources and review latency.

    python3 fixtures/release/vm_perf.py <release-dir> --out report.json

The model is a synthetic local upstream, so this reports NO time-to-first-token and no
provider latency. It measures the VM, the guest agent runtime and the host work around them.
Memory and CPU cover the whole workload: the launcher, the VM owner and the Virtualization
helper process that holds guest memory, found by which process has the stage disk open.
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
sys.path.insert(0, str(HERE))
from recovery import terminal  # noqa: E402
from run import wait_for  # noqa: E402
from release_first_run import Sampler  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    release = args.release.resolve()
    root = Path(tempfile.mkdtemp(prefix="bw-perf-")).resolve()
    result = {"model": "synthetic local upstream", "ttft": "NOT_MEASURED (synthetic upstream)"}
    try:
        subprocess.run([REPO / "scripts/build_alpha.sh", root / "bashwink"], check=True, stdout=subprocess.DEVNULL)
        lib = root / "bashwink/lib"
        (lib / "offline-vm").mkdir()
        for name in ("vm-owner", "Image", "initramfs"):
            shutil.copyfile(release / "lib/offline-vm" / name, lib / "offline-vm" / name)
            (lib / "offline-vm" / name).chmod(0o755 if name == "vm-owner" else 0o644)
        shutil.copyfile(release / "lib/offline-vm.json", lib / "offline-vm.json")
        fixture = REPO / "fixtures/native-offline/vm-provider-fixture.ts"
        entry = lib / "vm-provider-fixture.js"
        subprocess.run([shutil.which("bun"), "build", fixture, "--target=bun", "--outfile", entry], check=True, stdout=subprocess.DEVNULL)
        project = root / "project"
        project.mkdir()
        files = {
            "one.ts": "export const one = 0\n", "two.ts": "export const two = 0\n", "obsolete.ts": "export const obsolete = true\n",
            "accept.test.ts": 'import { expect, test } from "bun:test"\nimport { one } from "./one"\nimport { two } from "./two"\n'
                              'import { added } from "./new"\ntest("independent acceptance", () => expect([one, two, added]).toEqual([2, 3, 5]))\n',
        }
        for name, text in files.items():
            (project / name).write_text(text)
        env = {"PATH": os.environ["PATH"], "HOME": str(root), "TERM": "xterm-256color", "BASHWINK_HOME": str(root / "state"),
               "BASHWINK_OPENCODE_BIN": "/missing-host-opencode", "BW_SYNTHETIC_CREDENTIAL": "disposable-host-provider-canary-perf",
               "BASHWINK_VM_PROVIDER": "relaydemo", "BASHWINK_VM_MAX_REQUESTS": "10"}
        ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
        for step in (["git", "init", "-q", "."], ["git", "add", *files], ["git", "commit", "-qm", "i"]):
            subprocess.run(step, cwd=project, env=ge, check=True)
        bw = root / "bashwink/bin/bashwink"
        for a in (["auth", "add", "relaydemo", "--base-url", "https://api.openai.com/v1", "--env", "BW_SYNTHETIC_CREDENTIAL",
                   "--model", "fixture-model:openai"], ["model", "use", "relaydemo/fixture-model"]):
            subprocess.run([bw, *a], cwd=project, env=env, check=True, stdout=subprocess.DEVNULL)
        bun = shutil.which("bun")

        def session(extra, prompt, marker, sample):
            began = time.monotonic()
            with terminal([bun, entry, *extra], project, env) as (pid, master, contains, finish, capture):
                sampler = Sampler(pid) if sample else None
                if sampler:
                    sampler.start()
                tui = wait_for(lambda: contains("Ask anything") or contains("Fix the persistent project"), 60)
                to_tui = time.monotonic() - began
                done = None
                if prompt and tui:
                    time.sleep(0.3)
                    os.write(master, prompt.encode())
                    time.sleep(0.2)
                    began_turn = time.monotonic()
                    os.write(master, b"\r")
                    end = time.monotonic() + 120
                    while time.monotonic() < end and not contains(marker):
                        if b"Allow once" in bytes(capture)[-1500:]:
                            time.sleep(0.5)
                            os.write(master, b"\r")
                            time.sleep(1.5)
                        time.sleep(0.25)
                    done = time.monotonic() - began_turn if contains(marker) else None
                footprint = sampler.footprint_mib() if sampler else None
                os.write(master, b"\x04")
                finish(0)
                if sampler:
                    sampler.stop.set()
                    sampler.join(timeout=5)
                return to_tui, done, sampler, footprint

        cold, turn, sampler, footprint = session([], "Fix the persistent project", "VM project tool sequence completed", True)
        result["first_launch_to_tui_seconds"] = round(cold, 2)
        result["scripted_five_step_turn_seconds"] = None if turn is None else round(turn, 2)
        result["workload_peak_rss_kib"] = sampler.peak_rss_kib
        result["workload_peak_footprint_mib"] = round(max(sampler.peak_footprint_mib, footprint or 0), 1)
        result["workload_peak_cpu_percent_of_one_core"] = round(sampler.peak_cpu_percent, 1)
        result["workload_processes"] = sorted(set(sampler.members.values()))
        result["sampler_error"] = sampler.error
        warm = []
        for _ in range(3):
            began = time.monotonic()
            with terminal([bun, entry, "--continue"], project, env) as (_, master, contains, finish, capture):
                ok = wait_for(lambda: contains("Fix the persistent project"), 60)
                if ok:
                    warm.append(round(time.monotonic() - began, 2))
                os.write(master, b"\x04")
                finish(0)
        result["session_recovery_continue_to_tui_seconds"] = warm

        review = [bw, "sandbox", "vm-review"]
        began = time.monotonic()
        with terminal(review, project, env) as (_, master, contains, finish, capture):
            wait_for(lambda: contains("Type apply"), 60)
            result["review_preview_seconds"] = round(time.monotonic() - began, 2)
            applying = time.monotonic()
            os.write(master, b"apply\r")
            finish(0)
            result["apply_four_files_seconds"] = round(time.monotonic() - applying, 2)
        began = time.monotonic()
        with terminal([bw, "sandbox", "vm-verify"], project, env) as (_, _, contains, finish, capture):
            ok = wait_for(lambda: contains("Protected tests exited with status 0"), 90)
            finish(0)
        result["protected_verification_seconds"] = round(time.monotonic() - began, 2) if ok else None
        args.out.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
