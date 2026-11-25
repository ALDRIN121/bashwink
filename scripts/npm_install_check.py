#!/usr/bin/env python3
"""Install the npm tarball into a throwaway prefix and exercise the installed command. Portable (macOS, Linux, Windows).

    python3 scripts/npm_install_check.py build/npm/bashwink-0.1.0-alpha.1.tgz [--out report.json]

No PTY and no model request: install, version, doctor, a refused `--sandbox`, that the first-run state is created
under the profile and not in the project, and uninstall. The interactive TUI check is fixtures/release/npm_smoke.py
(POSIX). Exit status 0 only if every check passed.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

NPM = shutil.which("npm") or "npm"
results = []


def check(name, ok, detail=""):
    results.append({"check": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"{'PASS' if ok else 'FAIL':5} {name}" + (f" - {detail}" if detail else ""), flush=True)


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("tarball", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    windows = sys.platform == "win32"
    work = Path(tempfile.mkdtemp(prefix="bw-install-")).resolve()
    try:
        prefix, cache, home, project = (work / n for n in ("prefix", "cache", "home", "project"))
        for d in (prefix, cache, home, project):
            d.mkdir()
        env = {k: v for k, v in os.environ.items() if k.upper() not in ("BASHWINK_HOME", "BASHWINK_OPENCODE_BIN", "XDG_CONFIG_HOME", "XDG_DATA_HOME")}
        env.update({"HOME": str(home), "USERPROFILE": str(home), "npm_config_cache": str(cache)})
        started = time.monotonic()
        install = subprocess.run([NPM, "install", "-g", "--prefix", str(prefix), "--no-audit", "--no-fund", str(args.tarball.resolve())],
                                 env=env, capture_output=True, text=True)
        check("npm install -g <tarball>", install.returncode == 0, f"{time.monotonic() - started:.0f}s")
        if install.returncode:
            print((install.stdout + install.stderr)[-800:])
            return finish(args)
        command = str(prefix / "bashwink.cmd") if windows else str(prefix / "bin/bashwink")
        package = prefix / ("node_modules" if windows else "lib/node_modules") / "bashwink"
        check("the command and package exist", Path(command).exists() and package.is_dir())
        run = lambda *a: subprocess.run([command, *a], env=env, cwd=project, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        version = run("--version")
        check("bashwink --version", version.returncode == 0 and version.stdout.startswith("bashwink 0.1.0-alpha.1"), version.stdout.strip() or version.stderr.strip()[:200])
        doctor = run("doctor")
        check("doctor runs and finds the npm-installed runtimes and plugin",
              "OpenCode runtime" in doctor.stdout and "Bun runtime" in doctor.stdout and "✓ Evidence plugin" in doctor.stdout,
              f"exit {doctor.returncode}" + ("" if "✓ Evidence plugin" in doctor.stdout else f"; {doctor.stdout[-300:]!r}"))
        sandbox = run("--sandbox")
        check("--sandbox fails closed with exit 3 and starts nothing", sandbox.returncode == 3 and "sandbox mode is not installed" in sandbox.stderr and "No model request was made" in sandbox.stderr, f"exit {sandbox.returncode}")
        mode = run("backend")
        check("the execution mode is standard-native", "standard-native" in mode.stdout, mode.stdout.strip()[:120])
        check("nothing was written into the project directory", not any(project.iterdir()), str([p.name for p in project.iterdir()]))
        check("first-run state is under the user profile", any(home.rglob("startup-failures.jsonl")))
        removed = subprocess.run([NPM, "uninstall", "-g", "--prefix", str(prefix), "bashwink"], env=env, capture_output=True, text=True)
        check("npm uninstall -g removes the command and the package", removed.returncode == 0 and not Path(command).exists() and not package.exists())
        check("uninstall leaves the user's state alone", any(home.rglob("startup-failures.jsonl")))
        return finish(args)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def finish(args):
    if args.out:
        args.out.write_text(json.dumps({"platform": sys.platform, "machine": os.uname().machine if hasattr(os, "uname") else "", "checks": results}, indent=2) + "\n")
    return 0 if results and all(r["verdict"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
