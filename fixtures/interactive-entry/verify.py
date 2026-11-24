#!/usr/bin/env python3
"""Verify the installed CLI through owned PTYs and fresh, disposable state."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

from recovery import terminal
from run import ROOT, wait_for


def main():
    runtime = os.environ.get("BASHWINK_OPENCODE_BIN") or shutil.which("opencode")
    if not runtime or not Path(runtime).is_file():
        raise SystemExit("set BASHWINK_OPENCODE_BIN to pinned OpenCode 2.3.2")
    with tempfile.TemporaryDirectory(prefix="bw-interactive-entry-") as tmp:
        root = Path(tmp).resolve()
        install = root / "install"
        installed = os.environ.get("BW")
        if installed is None:
            subprocess.run([ROOT / "scripts/build_alpha.sh", install], check=True)
            installed = install / "bin/bashwink"
        installed = Path(installed).resolve()
        home = root / "home"
        home.mkdir()
        state = root / "state"
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home),
            "TERM": "xterm-256color", "BASHWINK_HOME": str(state),
            "BASHWINK_OPENCODE_BIN": str(Path(runtime).resolve()),
            "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_AUTOUPDATE": "1",
        }
        git = root / "git"
        nested = git / "deep/sub"
        nested.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "."], cwd=git, env=env, check=True)
        plain = root / "non-git"
        plain.mkdir()
        evidence = state / "data/evidence/evidence.jsonl"

        def call(args):
            return subprocess.run([installed, *args], cwd=plain, env=env, timeout=12,
                                  capture_output=True, text=True)

        doctor = call(["doctor"])
        assert doctor.returncode == 0, doctor.stdout + doctor.stderr
        assert "0 failures" in doctor.stdout
        assert "approved commands run with host access" in doctor.stdout
        native = subprocess.run([installed, "doctor"], cwd=plain,
                                env={**env, "BASHWINK_BACKEND": "native"}, timeout=12,
                                capture_output=True, text=True)
        assert native.returncode == 1 and "native coding sessions are not qualified" in native.stdout
        assert call(["--version"]).stdout.startswith("bashwink ")
        assert call(["--help"]).returncode == 0
        assert call([]).stdout.startswith("bashwink — an evidence-first coding agent")
        print("PASS: fresh installed doctor, version, help, and noninteractive startup")

        def boots():
            if not evidence.exists():
                return []
            return [row for line in evidence.read_text().splitlines(keepends=True)
                    if line.endswith("\n") and (row := json.loads(line)).get("phase") == "boot"]

        for project in (git, plain, nested):
            old = len(boots())
            with terminal([installed], project, env) as (pid, _, contains, finish, _):
                assert wait_for(lambda: contains("Ask anything"), 18), "TUI did not render"
                assert wait_for(lambda: len(boots()) > old, 6), "no new boot record"
                assert f"location={project}" in boots()[-1]["payload"]["note"]
                os.kill(pid, signal.SIGTERM)
                finish(130)
            print(f"PASS: TUI rendered, attested {project.relative_to(root)}, and exited with 130")

        doctor = call(["doctor"])
        assert doctor.returncode == 0, doctor.stdout + doctor.stderr
        assert "0 failures" in doctor.stdout
        print("PASS: installed doctor accepted the resulting evidence state")


if __name__ == "__main__":
    main()
