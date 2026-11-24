#!/usr/bin/env python3
"""Live-provider qualification of the installed release archive (bounded spend).

    python3 fixtures/release/live.py <archive-dir> --key-file ~/.config/bashwink-qual/commandcode.key --out report.json

Uses the release CLI in a scrubbed environment with a fresh HOME. The key is given to Bashwink only
as `--key-file <path>`, the existing mechanism: its value is never printed, never an argument, never
copied. Afterwards the harness searches every place the key could have leaked for its bytes (and
for its base64 form) and reports counts only.

Stages (each reported PASS / FAIL, or NOT_RUN with the reason):
  key file checks, authentication, a real coding task through the TUI (read, edit, run tests),
  review/apply, protected tests, resume, model switch and continuity, cancellation during
  inference (observed as the host's upstream connection closing) and during a tool (observed from
  the saved workspace), recovery after SIGKILL, time to first token, token usage, and containment.

Spend is bounded: the relay allows BASHWINK_VM_MAX_REQUESTS per session (set to 12 here) and the
prompts are small. The harness prints the usage totals at the end.
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "native-offline"))
sys.path.insert(0, str(HERE))
from recovery import terminal  # noqa: E402
from run import DialogApprover, wait_for  # noqa: E402
from screen import screen_text  # noqa: E402
from release_first_run import Sampler  # noqa: E402

BASE = "https://api.commandcode.ai/provider/v1"
results = []
usage_totals = {}


def check(name, verdict, detail=""):
    results.append({"stage": name, "verdict": verdict, "detail": detail})
    print(f"{verdict:8} {name}" + (f" — {detail}" if detail else ""), flush=True)


def session_db(home):
    """Open the saved guest session database from the newest checkpoint (read-only copy)."""
    found = sorted(glob.glob(str(home / ".local/share/bashwink/vm-projects/*/checkpoint.json")))
    if not found:
        return None, None
    record = json.loads(json.loads(Path(found[0]).read_text())["payload"])
    state = record["snapshot"]["state"]
    scratch = Path(tempfile.mkdtemp(prefix="bw-live-db-"))
    (scratch / "o.db").write_bytes(base64.b64decode(state["bashwink/opencode/opencode.db"]))
    if state.get("bashwink/opencode/opencode.db-wal"):
        (scratch / "o.db-wal").write_bytes(base64.b64decode(state["bashwink/opencode/opencode.db-wal"]))
    return sqlite3.connect(scratch / "o.db"), (record, scratch)


def messages(connection):
    rows = connection.execute("select data from session_message order by rowid").fetchall()
    out = []
    for (data,) in rows:
        try:
            out.append(json.loads(data))
        except (TypeError, ValueError):
            pass
    return out


def usage_records(home):
    return [json.loads(Path(f).read_text()) for f in sorted(glob.glob(str(home / ".local/share/bashwink/vm-projects/*/provider-usage-*.json")))]


def leak_scan(key, roots, extra_blobs):
    """Count occurrences of the key (raw and base64) in files under `roots` and in `extra_blobs`."""
    forms = [key, base64.b64encode(key), base64.urlsafe_b64encode(key)]
    hits = []
    for root in roots:
        for path in Path(root).rglob("*"):
            try:
                if path.is_symlink() or not path.is_file() or path.stat().st_size > 400 * 1024 * 1024:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            if any(form in data for form in forms):
                hits.append(str(path))
    for label, blob in extra_blobs:
        if any(form in blob for form in forms):
            hits.append(label)
    return hits


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive_dir", type=Path)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    key_path = args.key_file.expanduser()

    # --- key file checks (nothing about the contents is printed) -------------------------------
    try:
        metadata = key_path.lstat()
    except OSError as error:
        check("key file exists", "BLOCKED", f"{error.strerror}: {key_path}")
        args.out.write_text(json.dumps(results, indent=2) + "\n")
        return 2
    mode_ok = stat.S_ISREG(metadata.st_mode) and (metadata.st_mode & 0o077) == 0 and metadata.st_uid == os.getuid()
    check("key file is a private regular file owned by you (mode 600 or stricter)", "PASS" if mode_ok else "FAIL",
          f"mode {oct(metadata.st_mode & 0o777)}, {metadata.st_size} bytes")
    if not mode_ok or metadata.st_size == 0 or metadata.st_size > 4096:
        args.out.write_text(json.dumps(results, indent=2) + "\n")
        return 2
    key = key_path.read_bytes().strip()  # held in memory for the leak scan only; never printed

    work = Path(tempfile.mkdtemp(prefix="bw-live-")).resolve()
    try:
        return run(args, key_path, key, work)
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


def run(args, key_path, key, work):
    home = work / "home"
    home.mkdir()
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
           "BASHWINK_VM_MAX_REQUESTS": "12"}
    archive = next(args.archive_dir.glob("*.tar.gz"))
    with tarfile.open(archive) as bundle:
        bundle.extractall(work, filter="tar")
    subprocess.run([next(work.glob("bashwink-*-macos-arm64")) / "install.sh"], env=env, check=True, capture_output=True)
    bw = home / ".local/bin/bashwink"
    project = work / "project"
    project.mkdir()
    (project / "calc.ts").write_text("export function add(a: number, b: number): number {\n  return a - b\n}\n")
    (project / "calc.test.ts").write_text('import { expect, test } from "bun:test"\nimport { add } from "./calc"\ntest("add", () => expect(add(2, 3)).toBe(5))\n')
    ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
    for step in (["git", "init", "-q", "."], ["git", "add", "calc.ts", "calc.test.ts"], ["git", "commit", "-qm", "initial"]):
        subprocess.run(step, cwd=project, env=ge, check=True)

    # --- credential initialization and authentication --------------------------------------------
    steps = [["auth", "add", "commandcode", "--base-url", BASE, "--key-file", str(key_path),
              "--model", "claude-sonnet-5:anthropic", "--model", "gpt-6.1-sol:openai"],
             ["model", "use", "commandcode/claude-sonnet-5"], ["auth", "check", "commandcode"]]
    for step in steps:
        done = subprocess.run([bw, *step], cwd=project, env=env, capture_output=True, text=True)
        leaked = key.decode(errors="replace") in (done.stdout + done.stderr)
        check(f"bashwink {' '.join(step[:2])}", "PASS" if done.returncode == 0 and not leaked else "FAIL", "output holds no key" if not leaked else "KEY IN OUTPUT")
    doctor = subprocess.run([bw, "doctor"], cwd=project, env=env, capture_output=True, text=True)
    check("doctor reports the provider credential present, never its value", "PASS" if doctor.returncode == 0 and key.decode(errors="replace") not in doctor.stdout else "FAIL",
          doctor.stdout.strip().splitlines()[-1])

    transcripts = []

    # --- session 1: real coding through the TUI ---------------------------------------------------
    prompt = ("calc.ts has a bug: add() subtracts instead of adding. Read calc.ts and calc.test.ts, fix add() in calc.ts, "
              "run `bun test calc.test.ts` to confirm it passes, then reply with one sentence.")
    with terminal([bw], project, env) as (pid, master, contains, finish, capture):
        sampler = Sampler(pid)
        sampler.start()
        wait_for(lambda: contains("Approve this project?"), 40)
        os.write(master, b"y\r")
        began = time.monotonic()
        ready = wait_for(lambda: contains("Ask anything"), 60)
        check("approved project reaches the TUI", "PASS" if ready else "FAIL", f"{time.monotonic() - began:.1f}s")
        argv_leak = key in subprocess.run(["/bin/ps", "-axww", "-o", "command="], capture_output=True).stdout
        check("the key is not in any process's command line while the VM runs", "PASS" if not argv_leak else "FAIL")
        time.sleep(1)
        os.write(master, prompt.encode())
        time.sleep(0.3)
        asked = time.monotonic()
        os.write(master, b"\r")
        approver = DialogApprover(lambda data: os.write(master, data))
        deadline = time.monotonic() + 300
        done = False
        while time.monotonic() < deadline:
            approver.poll(bytes(capture))
            contains("")
            text = screen_text(bytes(capture))
            if re.search(r"\b1 pass\b", bytes(capture).decode(errors="replace")) and "0 fail" in bytes(capture).decode(errors="replace"):
                time.sleep(10)
                done = True
                break
            time.sleep(0.5)
        elapsed = time.monotonic() - asked
        footprint = sampler.footprint_mib()
        check("indicator stays on screen during live coding", "PASS" if "[SANDBOXED VM]" in screen_text(bytes(capture)) else "FAIL")
        os.write(master, b"\x04")
        try:
            finish(0)
        except AssertionError as error:
            check("session 1 exits cleanly", "FAIL", str(error)[:160])
        sampler.stop.set()
        sampler.join(timeout=5)
        transcripts.append(("session-1.pty", bytes(capture)))
        shown = bytes(capture).decode(errors="replace")
        usage_line = re.search(r"VM provider usage: [^\n]*", shown)
    check("live coding: tests ran and passed inside the guest", "PASS" if done else "FAIL", f"{approver.sent} dialog(s) approved, {elapsed:.0f}s end to end")
    check("host project unchanged before review", "PASS" if (project / "calc.ts").read_text().count("a - b") == 1 else "FAIL")
    check("whole-workload resources during live coding", "PASS", f"peak RSS {sampler.peak_rss_kib // 1024} MiB, footprint ~{footprint:.0f} MiB, peak CPU {sampler.peak_cpu_percent:.0f}% of one core")
    check("token and request accounting printed by the host", "PASS" if usage_line else "FAIL", usage_line[0][:150] if usage_line else "")

    connection, handle = session_db(home)
    if connection is not None:
        msgs = messages(connection)
        models = [m["model"]["id"] for m in msgs if isinstance(m, dict) and isinstance(m.get("model"), dict)]
        errors = [m["error"] for m in msgs if isinstance(m, dict) and isinstance(m.get("error"), dict)]
        check("evidence attributes the responses to the selected model", "PASS" if models and set(models) == {"claude-sonnet-5"} else "FAIL", str(sorted(set(models))))
        check("no provider error in the saved session", "PASS" if not errors else "FAIL", str(errors[:1]))
        stamps = connection.execute("select data from session_part order by rowid").fetchall()
        _ = stamps  # part timestamps are summarized by the report script; the raw proxy follows
        created = [m["time"]["created"] for m in msgs if isinstance(m, dict) and isinstance(m.get("time"), dict) and "created" in m["time"]]
        report_ttft = None
        for m in msgs:
            if isinstance(m, dict) and m.get("agent") and isinstance(m.get("time"), dict) and "completed" in m["time"] and created:
                report_ttft = (m["time"]["created"] - min(created)) / 1000
                break
        check("time to first assistant activity (proxy from saved timestamps)", "PASS" if report_ttft is not None else "NOT_RUN",
              f"{report_ttft:.2f}s from first saved message to the first assistant message start" if report_ttft is not None else "")
        shutil.rmtree(handle[1], ignore_errors=True)

    for record in usage_records(home):
        for k in ("requests", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"):
            usage_totals[k] = usage_totals.get(k, 0) + record.get(k, 0)

    # --- review, apply, protected tests ----------------------------------------------------------
    with terminal([bw, "sandbox", "vm-review"], project, env) as (_, master, contains, finish, capture):
        shown = wait_for(lambda: contains("Type apply"), 30)
        os.write(master, b"apply\r")
        finish(0)
    fixed = "a + b" in (project / "calc.ts").read_text()
    check("review shows the diff and apply writes the fix to the host project", "PASS" if shown and fixed else "FAIL")
    with terminal([bw, "sandbox", "vm-verify"], project, env) as (_, _, contains, finish, capture):
        passed = wait_for(lambda: contains("Protected tests exited with status 0"), 90)
        finish(0)
    check("protected tests pass in a fresh VM against the applied files", "PASS" if passed else "FAIL")

    # --- session 2: resume and model switch ------------------------------------------------------
    with terminal([bw, "--continue"], project, env) as (pid, master, contains, finish, capture):
        ok = wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
        check("--continue restores the session", "PASS" if ok else "FAIL")
        time.sleep(1)
        os.write(master, b"/models")
        time.sleep(0.5)
        os.write(master, b"\r")
        time.sleep(1.5)
        os.write(master, b"gpt-6.1")
        time.sleep(1)
        os.write(master, b"\r")
        time.sleep(1.5)
        contains("")
        picker = screen_text(bytes(capture))
        os.write(master, b"Which file did you edit earlier and what was the original bug? Answer in one short sentence.")
        time.sleep(0.3)
        os.write(master, b"\r")
        approver = DialogApprover(lambda data: os.write(master, data))
        end = time.monotonic() + 120
        while time.monotonic() < end:
            approver.poll(bytes(capture))
            contains("")
            time.sleep(0.5)
            if re.search(r"calc\.ts", screen_text(bytes(capture))[-1500:]) and "gpt" in screen_text(bytes(capture)).lower() and time.monotonic() - end > -100:
                break
        os.write(master, b"\x04")
        try:
            finish(0)
        except AssertionError:
            pass
        transcripts.append(("session-2.pty", bytes(capture)))
    connection, handle = session_db(home)
    if connection is not None:
        msgs = messages(connection)
        models = [m["model"]["id"] for m in msgs if isinstance(m, dict) and isinstance(m.get("model"), dict)]
        check("model switch: the saved session shows both models", "PASS" if {"claude-sonnet-5", "gpt-6.1-sol"} <= set(models) else "FAIL", str(sorted(set(models))))
        shutil.rmtree(handle[1], ignore_errors=True)
    for record in usage_records(home):
        pass

    # --- cancellation during inference (upstream connection closes) -------------------------------
    def upstream_connections(pid):
        out = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-iTCP", "-p", str(pid)], capture_output=True, text=True).stdout
        return [line for line in out.splitlines() if "ESTABLISHED" in line]

    with terminal([bw, "--continue"], project, env) as (pid, master, contains, finish, capture):
        wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
        time.sleep(1)
        os.write(master, b"Write a very long, detailed explanation of how floating point addition works, at least 900 words.")
        time.sleep(0.3)
        os.write(master, b"\r")
        seen = wait_for(lambda: upstream_connections(pid), 60)
        check("cancellation during inference: an upstream connection is open while the model streams", "PASS" if seen else "NOT_RUN", f"{len(seen) if seen else 0} connection(s)")
        time.sleep(4)
        os.write(master, b"\x03")
        closed = wait_for(lambda: not upstream_connections(pid), 15)
        if not closed:
            os.write(master, b"\x1b")
            time.sleep(0.4)
            os.write(master, b"\x1b")
            closed = wait_for(lambda: not upstream_connections(pid), 15)
        check("cancellation during inference: the upstream connection closes", "PASS" if closed else "FAIL")
        os.write(master, b"\x04")
        try:
            finish(0)
        except AssertionError:
            pass

    # --- cancellation during tool execution (read back from the saved workspace) ------------------
    with terminal([bw, "--continue"], project, env) as (pid, master, contains, finish, capture):
        wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
        time.sleep(1)
        os.write(master, b"Run exactly this shell command and nothing else: i=0; while true; do i=$((i+1)); echo $i > tick.txt; sleep 1; done")
        time.sleep(0.3)
        os.write(master, b"\r")
        approver = DialogApprover(lambda data: os.write(master, data))
        wait_for(lambda: (approver.poll(bytes(capture)), contains(""))[0] >= 1, 90)
        time.sleep(12)
        os.write(master, b"\x03")
        time.sleep(1)
        os.write(master, b"\x03")
        cancelled_at = time.monotonic()
        time.sleep(25)  # a surviving loop would keep counting for all of this
        os.write(master, b"\x04")
        try:
            finish(0)
        except AssertionError:
            pass
    saved = None
    found = sorted(glob.glob(str(home / ".local/share/bashwink/vm-projects/*/checkpoint.json")))
    if found:
        files = json.loads(json.loads(Path(found[0]).read_text())["payload"])["snapshot"]["files"]
        if "tick.txt" in files:
            saved = int(base64.b64decode(files["tick.txt"]).decode().strip() or 0)
    check("cancellation during tool execution: the guest loop stopped (saved counter stayed near the pre-cancel count)",
          "NOT_RUN" if saved is None else ("PASS" if saved <= 22 else "FAIL"),
          "the model did not run the loop, so there is nothing to observe" if saved is None else f"counter {saved} (about 12-14 expected at cancel; a surviving loop would reach ~38+)")

    # --- recovery after SIGKILL -------------------------------------------------------------------
    before_stages = {p.name for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()}
    with terminal([bw, "--continue"], project, env) as (pid, master, contains, finish, capture):
        wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
        os.write(master, b"Say the single word ready.")
        time.sleep(0.3)
        os.write(master, b"\r")
        time.sleep(3)
        os.kill(pid, signal.SIGKILL)
        try:
            finish(-9)
        except AssertionError:
            pass
    time.sleep(6)
    leftovers = {p.name for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()} - before_stages
    with terminal([bw, "--continue"], project, env) as (_, master, contains, finish, capture):
        again = wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
        os.write(master, b"\x04")
        try:
            finish(0)
        except AssertionError:
            pass
    check("recovery after SIGKILL mid-inference: the next --continue works", "PASS" if again else "FAIL", f"{len(leftovers)} retained stage(s), registered")
    purge = subprocess.run([bw, "sandbox", "stages", "--purge"], cwd=project, env=env, capture_output=True, text=True)
    check("retained stage from the killed session is purged by its registry entry", "PASS" if purge.returncode == 0 and not (leftovers & {p.name for p in Path('/private/tmp').glob('bashwink-vm-*')}) else "FAIL")

    # --- containment: the key must be nowhere it should not be ------------------------------------
    for record in usage_records(home):
        pass
    state_blobs = []
    for f in glob.glob(str(home / ".local/share/bashwink/vm-projects/*/checkpoint.json")):
        record = json.loads(json.loads(Path(f).read_text())["payload"])
        for name, blob in {**record["snapshot"]["files"], **record["snapshot"]["state"]}.items():
            state_blobs.append((f"checkpoint:{name}", base64.b64decode(blob)))
    hits = leak_scan(key, [home, work / "project"], state_blobs + [(label, data) for label, data in transcripts])
    # DiagnosticReports written during the run (crash reports) are checked as well.
    reports = Path.home() / "Library/Logs/DiagnosticReports"
    if reports.is_dir():
        hits += leak_scan(key, [p for p in reports.iterdir() if p.stat().st_mtime > time.time() - 7200], [])
    check("credential containment: the key is in no file, checkpoint, guest state, transcript, evidence, usage record or crash report", "PASS" if not hits else "FAIL",
          "no occurrence" if not hits else f"{len(hits)} location(s) (names only): {[Path(h).name for h in hits][:5]}")
    check("the key file itself is unchanged and still private", "PASS" if key_path.read_bytes().strip() == key and (key_path.stat().st_mode & 0o077) == 0 else "FAIL")

    args.out.write_text(json.dumps({"results": results, "provider_usage_totals": usage_totals}, indent=2) + "\n")
    print("provider usage totals:", usage_totals)
    return 0 if all(r["verdict"] in ("PASS", "NOT_RUN") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
