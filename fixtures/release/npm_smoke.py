#!/usr/bin/env python3
"""Interactive smoke test of the INSTALLED npm package (standard mode), in a real PTY.

    python3 fixtures/release/npm_smoke.py <tarball> --out report.json

Installs the tarball into a throwaway prefix with a throwaway npm cache and HOME (as a tester would, with no
source checkout), then: version, doctor, a refused --sandbox, the first-run trust question, the TUI with the
persistent STANDARD label on screen, the run record and evidence, a second launch, and uninstall. It makes no
model request. This is an installation check on the machine running it, not a clean-host qualification.
"""
import argparse
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
sys.path.insert(0, str(HERE.parent / "native-offline"))
sys.path.insert(0, str(HERE))
from recovery import terminal  # noqa: E402
from run import wait_for  # noqa: E402
from screen import screen_text  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append({"check": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"{'PASS' if ok else 'FAIL':5} {name}" + (f" — {detail}" if detail else ""), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tarball", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="bw-npm-smoke-")).resolve()
    node_dir = str(Path(shutil.which("node")).parent)
    try:
        prefix, cache, home, project = (work / n for n in ("prefix", "cache", "home", "project"))
        for d in (prefix, cache, home, project):
            d.mkdir()
        base_env = {"HOME": str(home), "PATH": f"/usr/bin:/bin:{node_dir}", "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
        started = time.monotonic()
        install = subprocess.run(["npm", "install", "-g", "--prefix", str(prefix), "--cache", str(cache), "--no-audit", "--no-fund",
                                  str(args.tarball.resolve())], env=base_env, capture_output=True, text=True)
        check("npm install -g <tarball> succeeds without any source checkout", install.returncode == 0, f"{time.monotonic() - started:.0f}s")
        if install.returncode != 0:
            print(install.stderr[-600:])
            return finish(args, 1)
        package = prefix / "lib/node_modules/bashwink"
        env = {**base_env, "PATH": f"{prefix / 'bin'}:{base_env['PATH']}"}
        seen_inodes, size = set(), 0
        for p in package.rglob("*"):
            if p.is_file() and not p.is_symlink() and (p.stat().st_dev, p.stat().st_ino) not in seen_inodes:
                seen_inodes.add((p.stat().st_dev, p.stat().st_ino))
                size += p.stat().st_size
        check("installed size recorded", True, f"{size} bytes including runtimes")
        check("no workspace dependency or source-tree path leaked into the installed manifest",
              "workspace:" not in (package / "package.json").read_text() and str(Path(__file__).resolve().parents[2]) not in (package / "lib/bashwink.js").read_text())

        version = subprocess.run(["bashwink", "--version"], env=env, cwd=project, capture_output=True, text=True)
        check("bashwink --version", version.returncode == 0 and version.stdout.startswith("bashwink 0.1.0-alpha.1"), version.stdout.strip())
        doctor = subprocess.run(["bashwink", "doctor"], env=env, cwd=project, capture_output=True, text=True)
        check("doctor finds the npm-installed runtimes and evidence plugin", doctor.returncode == 0 and "✓ OpenCode runtime" in doctor.stdout and "✓ Bun runtime" in doctor.stdout and "✓ Evidence plugin" in doctor.stdout)
        sandbox = subprocess.run(["bashwink", "--sandbox"], env=env, cwd=project, capture_output=True, text=True)
        check("--sandbox fails closed and is recorded", sandbox.returncode == 3 and "sandbox mode is not installed" in sandbox.stderr and "No model request was made" in sandbox.stderr)

        (project / "a.ts").write_text("export const a = 1\n")
        ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
        for step in (["git", "init", "-q", "."], ["git", "add", "a.ts"], ["git", "commit", "-qm", "i"]):
            subprocess.run(step, cwd=project, env=ge, check=True)

        evidence = home / ".local/share/bashwink/evidence/evidence.jsonl"
        runs = home / ".local/share/bashwink/runs"
        with terminal([str(prefix / "bin/bashwink")], project, env) as (pid, master, contains, finish_pty, capture):
            asked = wait_for(lambda: contains("Trust this folder?"), 40)
            shown = bytes(capture).decode(errors="replace")
            check("first launch asks whether to trust the folder and says it is not a sandbox", bool(asked) and "NOT a sandbox" in shown)
            if not asked:
                print("   output:", " ".join(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", " ", shown).split())[-700:])
            os.write(master, b"y\r")
            ready = wait_for(lambda: contains("Ask anything"), 90)
            check("the TUI starts", bool(ready))
            time.sleep(4)
            contains("")
            screen = screen_text(bytes(capture))
            check("the persistent STANDARD label is on screen", "[STANDARD - native, not a sandbox]" in screen)
            if "[STANDARD" not in screen:
                print("   screen:", " | ".join(" ".join(line.split()) for line in screen.splitlines() if line.strip())[:900])
            check("evidence booted for this run", evidence.exists() and '"phase":"boot"' in evidence.read_text())
            os.kill(pid, 15)
            try:
                finish_pty(130)
                code_ok = True
            except AssertionError as error:
                code_ok = False
                print("   ", str(error)[:160])
            check("SIGTERM ends the session with 130", code_ok)
        records = sorted(runs.glob("*.json")) if runs.exists() else []
        record = json.loads(records[-1].read_text()) if records else {}
        check("the run record names the execution mode standard-native", record.get("execution", {}).get("backend", {}).get("mode") == "standard-native", str(record.get("execution", {}).get("backend", {}).get("mode")))
        check("the run record shows evidence recorded", record.get("evidence") == "recorded", str(record.get("evidence")))
        with terminal([str(prefix / "bin/bashwink")], project, env) as (pid, master, contains, finish_pty, capture):
            again = wait_for(lambda: contains("Ask anything"), 90)
            asked_again = b"Trust this folder?" in bytes(capture)
            os.kill(pid, 15)
            try:
                finish_pty(130)
            except AssertionError:
                pass
        check("a second launch does not ask again and reaches the TUI", bool(again) and not asked_again)
        leftovers = subprocess.run(["/bin/ps", "-axo", "command="], capture_output=True, text=True).stdout
        check("no bashwink or its runtime is left running", str(package) not in leftovers)

        removed = subprocess.run(["npm", "uninstall", "-g", "--prefix", str(prefix), "--cache", str(cache)], env=base_env, capture_output=True, text=True)
        removed = subprocess.run(["npm", "uninstall", "-g", "--prefix", str(prefix), "--cache", str(cache), "bashwink"], env=base_env, capture_output=True, text=True)
        check("npm uninstall -g removes the command and package", removed.returncode == 0 and not (prefix / "bin/bashwink").exists() and not package.exists())
        check("uninstall leaves the user's state and project alone", (home / ".config/bashwink").exists() and (project / "a.ts").read_text() == "export const a = 1\n")
        return finish(args, 0)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def finish(args, code):
    args.out.write_text(json.dumps(results, indent=2) + "\n")
    return code or (0 if all(r["verdict"] == "PASS" for r in results) else 1)


if __name__ == "__main__":
    sys.exit(main())
