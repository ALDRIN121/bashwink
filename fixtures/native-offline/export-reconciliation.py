#!/usr/bin/env python3
"""Interrupt a real atomic host export and independently inspect both file identities."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from recovery import digest, terminal
from run import ROOT, run, wait_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installed", type=Path)
    parser.add_argument("runtime", type=Path)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="bw-export-reconciliation-")).resolve()
    installed, runtime = args.installed.resolve(), args.runtime.resolve()
    observer = root / "protected.txt"
    observer.write_text("Unrelated host fixture\n")
    observer_hash = digest(observer)
    for phase in ("prepared", "exchanged", "recorded", "cleaned"):
        project = root / phase
        project.mkdir()
        host = project / "task.txt"
        host.write_text("Original approved export fixture\n")
        base = (host.stat().st_ino, digest(host))
        stage = run(installed, runtime, project, "coding", stage_file=True)
        proposed = digest(stage / "work/task.txt")
        evidence = stage / "scratch/evidence/evidence.jsonl"
        evidence_before = digest(evidence)
        env = {**os.environ, "TERM": "xterm-256color"}
        command = [Path(os.environ["BUN_EXE"]), ROOT / "fixtures/native-offline/export-interrupt.ts",
                   stage, phase]
        with terminal(command, project, env) as (_, master, contains, finish, _):
            assert wait_for(lambda: contains("Type apply"), 10)
            os.write(master, b"apply\r")
            finish(-9)
        installed_identity = host.stat().st_ino
        recover = [installed, "sandbox", "recover-export", stage]
        receipt = stage / ".export-receipt.json"
        displaced_files = list(project.glob(".bashwink-export-*"))
        if phase == "prepared":
            assert (installed_identity, digest(host)) == base and len(displaced_files) == 1
            result = subprocess.run(recover, cwd=project, capture_output=True, text=True)
            assert result.returncode == 0 and "Reconciled" in result.stdout, result
            assert (host.stat().st_ino, digest(host)) == base
            assert not displaced_files[0].exists() and not receipt.exists()
            assert not (stage / ".active").exists() and digest(evidence) == evidence_before
            assert digest(observer) == observer_hash
            print("PASS: prepared: discarded the unexchanged proposal without a commit receipt")
            continue
        assert installed_identity != base[0] and digest(host) == proposed
        assert len(displaced_files) == (0 if phase == "cleaned" else 1)
        for displaced in displaced_files:
            assert (displaced.stat().st_ino, digest(displaced)) == base
        assert receipt.exists() == (phase != "exchanged")
        receipt_before = receipt.read_bytes() if receipt.exists() else None
        wrong = subprocess.run(recover, cwd=root, capture_output=True, text=True)
        assert wrong.returncode != 0 and all(file.exists() for file in displaced_files)
        if phase == "exchanged":
            approved = host.read_bytes()
            host.write_bytes(b"Concurrent synthetic host edit\n")
            refused = subprocess.run(recover, cwd=project, capture_output=True, text=True)
            assert refused.returncode == 3 and displaced_files[0].exists() and not receipt.exists()
            assert host.read_bytes() == b"Concurrent synthetic host edit\n"
            host.write_bytes(approved)
        first = subprocess.run(recover, cwd=project, capture_output=True, text=True)
        assert first.returncode == 0 and "Reconciled" in first.stdout, first
        record = receipt.read_bytes()
        assert json.loads(record)["outcome"] == "committed"
        assert receipt_before is None or record == receipt_before
        assert host.stat().st_ino == installed_identity and digest(host) == proposed
        assert not list(project.glob(".bashwink-export-*")) and not (stage / ".active").exists()
        retry = subprocess.run(recover, cwd=project, capture_output=True, text=True)
        assert retry.returncode == 0 and "No interrupted" in retry.stdout, retry
        assert receipt.read_bytes() == record and digest(evidence) == evidence_before
        assert host.stat().st_ino == installed_identity and digest(host) == proposed
        assert digest(observer) == observer_hash
        print(f"PASS: {phase}: reconciled one approval, preserved host identity and evidence on retry")


if __name__ == "__main__":
    main()
