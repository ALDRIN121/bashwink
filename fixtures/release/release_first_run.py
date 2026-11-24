#!/usr/bin/env python3
"""First-run acceptance of the release archive, as a developer who has never used Bashwink.

    python3 fixtures/release/release_first_run.py <archive-dir> --out report.json
        [--key-file PATH]   private file holding a CommandCode key; without it a bogus key is
                            used, which exercises startup and the provider's 401 path only
        [--live]            run the live coding, review/apply, resume and protected-test stages

<archive-dir> holds the release `.tar.gz` and `SHA256SUMS`. Everything happens under a
throwaway HOME with a scrubbed environment: no BASHWINK_* variable, no PATH entry for Bun or
OpenCode, no existing state. This is a clean-ENVIRONMENT simulation on the machine running it.
It is not a clean-HOST qualification and the report says so.
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
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "native-offline"))
from recovery import terminal  # noqa: E402
from run import wait_for  # noqa: E402
from screen import screen_text  # noqa: E402

BASE_URL = "https://api.commandcode.ai/provider/v1"
MODELS = ["claude-sonnet-5:anthropic", "gpt-6.1-sol:openai"]
CODING_PROMPT = (
    "calc.ts has a bug: add() subtracts instead of adding. Fix add() in calc.ts so that "
    "`bun test calc.test.ts` passes, run that command to confirm, and then stop."
)


class Report:
    def __init__(self, path):
        self.path = path
        self.data = {"stages": [], "measurements": {}}

    def stage(self, name, verdict, detail=""):
        self.data["stages"].append({"stage": name, "verdict": verdict, "detail": detail})
        print(f"{verdict:8} {name}" + (f" — {detail}" if detail else ""), flush=True)
        self.path.write_text(json.dumps(self.data, indent=2) + "\n")

    def measure(self, key, value):
        self.data["measurements"][key] = value
        self.path.write_text(json.dumps(self.data, indent=2) + "\n")


class Sampler(threading.Thread):
    """Samples the whole workload: launcher, VM owner and the Virtualization helper that holds
    guest memory. Helper processes are found by who has the stage disk open."""

    def __init__(self, root_pid):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.stop = threading.Event()
        self.peak_rss_kib = 0
        self.peak_footprint_mib = 0.0
        self.peak_cpu_percent = 0.0
        self.samples = []
        self.members = {}
        self.error = None

    def descendants(self):
        rows = subprocess.run(["/bin/ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout.split()
        pairs = list(zip(map(int, rows[0::2]), map(int, rows[1::2])))
        found, frontier = {self.root_pid}, [self.root_pid]
        while frontier:
            current = frontier.pop()
            for pid, parent in pairs:
                if parent == current and pid not in found:
                    found.add(pid)
                    frontier.append(pid)
        return found

    def stage_holders(self):
        holders = set()
        for stage in Path("/private/tmp").glob("bashwink-vm-*/stage.raw"):
            out = subprocess.run(["/usr/sbin/lsof", "-t", str(stage)], capture_output=True, text=True).stdout
            holders.update(int(p) for p in out.split())
        return holders

    @staticmethod
    def cpu_seconds(pid):
        out = subprocess.run(["/bin/ps", "-o", "time=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if not out:
            return None
        parts = out.replace("-", ":").split(":")
        total = 0.0
        for part in parts:
            total = total * 60 + float(part)
        return total

    def run(self):
        try:
            self.sample_loop()
        except Exception as error:  # a dead sampler must be visible, not a silent zero
            self.error = repr(error)

    def sample_loop(self):
        last_cpu, last_time = {}, time.monotonic()
        while not self.stop.is_set():
            pids = self.descendants() | self.stage_holders()
            rss = 0
            cpu = 0.0
            now = time.monotonic()
            for pid in pids:
                out = subprocess.run(["/bin/ps", "-o", "rss=,comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
                if not out:
                    continue
                size, _, command = out.partition(" ")
                rss += int(size)
                self.members[pid] = command.strip().rsplit("/", 1)[-1]
                seconds = self.cpu_seconds(pid)
                if seconds is not None and pid in last_cpu and now > last_time:
                    cpu += max(0.0, seconds - last_cpu[pid]) / (now - last_time) * 100
                if seconds is not None:
                    last_cpu[pid] = seconds
            last_time = now
            self.peak_rss_kib = max(self.peak_rss_kib, rss)
            self.peak_cpu_percent = max(self.peak_cpu_percent, cpu)
            self.samples.append((round(now, 2), rss, round(cpu, 1)))
            self.stop.wait(1.0)

    def footprint_mib(self):
        total = 0.0
        for pid in self.descendants() | self.stage_holders():
            out = subprocess.run(["/usr/bin/footprint", "-p", str(pid)], capture_output=True, text=True).stdout
            match = re.search(r"Footprint:\s+([\d.]+)\s+(KB|MB|GB)", out)
            if match:
                value = float(match[1])
                total += value / 1024 if match[2] == "KB" else value * 1024 if match[2] == "GB" else value
        self.peak_footprint_mib = max(self.peak_footprint_mib, total)
        return total


def auth_failure_from_checkpoint(home):
    """Independent observation of the provider's answer: the guest's saved session database."""
    import base64
    import glob
    import sqlite3
    found = glob.glob(str(home / ".local/share/bashwink/vm-projects/*/checkpoint.json"))
    if not found:
        return "FAIL", "no checkpoint"
    record = json.loads(json.loads(Path(found[0]).read_text())["payload"])
    state = record["snapshot"]["state"]
    scratch = Path(tempfile.mkdtemp(prefix="bw-auth-db-"))
    try:
        (scratch / "o.db").write_bytes(base64.b64decode(state["bashwink/opencode/opencode.db"]))
        if state.get("bashwink/opencode/opencode.db-wal"):
            (scratch / "o.db-wal").write_bytes(base64.b64decode(state["bashwink/opencode/opencode.db-wal"]))
        errors = []
        for (content,) in sqlite3.connect(scratch / "o.db").execute("select data from session_message"):
            try:
                value = json.loads(content)
            except (TypeError, ValueError):
                continue
            error = value.get("error") if isinstance(value, dict) else None
            if isinstance(error, dict):
                errors.append((error.get("type"), error.get("status"), error.get("message")))
        usage = [json.loads(Path(f).read_text()) for f in glob.glob(str(Path(found[0]).parent / "provider-usage-*.json"))]
        sent = sum(u["requests"] for u in usage)
        tokens = sum(u["inputTokens"] + u["outputTokens"] for u in usage)
        ok = any(e[0] == "provider.auth" and e[1] == 401 for e in errors) and sent == 1 and tokens == 0
        return ("PASS" if ok else "FAIL"), f"errors={errors[:2]} requests_sent={sent} tokens={tokens}"
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def tree_size(path):
    return sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file() and not p.is_symlink())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive_dir", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    report = Report(args.out)
    work = Path(tempfile.mkdtemp(prefix="bw-first-run-")).resolve()
    try:
        return run_stages(args, report, work)
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


def run_stages(args, report, work):
    archive = next(args.archive_dir.glob("*.tar.gz"))
    home = work / "home"
    (home / "Downloads").mkdir(parents=True)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "TERM": "xterm-256color", "LANG": "en_US.UTF-8"}
    report.measure("test_environment", {
        "clean_environment_simulation": True,
        "clean_host": False,
        "note": "fresh HOME and scrubbed environment on the engineering machine; Docker is installed here",
        "macos": subprocess.check_output(["sw_vers", "-productVersion"], text=True).strip(),
        "build": subprocess.check_output(["sysctl", "-n", "kern.osversion"], text=True).strip(),
        "chip": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(),
        "memory_bytes": int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)),
    })
    print(f"work directory: {work}", flush=True)

    # 1-2. Obtain the archive and verify its checksum (positive and negative).
    for name in (archive.name, "SHA256SUMS"):
        shutil.copyfile(args.archive_dir / name, home / "Downloads" / name)
    ok = subprocess.run(["/usr/bin/shasum", "-a", "256", "-c", "SHA256SUMS"], cwd=home / "Downloads", capture_output=True, text=True)
    report.stage("verify archive checksum", "PASS" if ok.returncode == 0 else "FAIL", ok.stdout.strip())
    tampered = work / "tampered"
    tampered.mkdir()
    shutil.copyfile(archive, tampered / archive.name)
    with (tampered / archive.name).open("r+b") as handle:
        handle.seek(1000)
        byte = handle.read(1)
        handle.seek(1000)
        handle.write(bytes([byte[0] ^ 1]))
    shutil.copyfile(args.archive_dir / "SHA256SUMS", tampered / "SHA256SUMS")
    bad = subprocess.run(["/usr/bin/shasum", "-a", "256", "-c", "SHA256SUMS"], cwd=tampered, capture_output=True, text=True)
    report.stage("tampered archive fails checksum", "PASS" if bad.returncode != 0 else "FAIL")

    # 3. Install.
    extract_start = time.monotonic()
    with tarfile.open(home / "Downloads" / archive.name) as bundle:
        bundle.extractall(home / "Downloads", filter="tar")
    extracted = home / "Downloads" / archive.name.removesuffix(".tar.gz")
    report.measure("extract_seconds", round(time.monotonic() - extract_start, 2))
    start = time.monotonic()
    installed = subprocess.run([extracted / "install.sh"], cwd=home, env=env, capture_output=True, text=True)
    report.measure("install_seconds", round(time.monotonic() - start, 2))
    bw = home / ".local/bin/bashwink"
    prefix = home / ".local/opt/bashwink"
    report.stage("install", "PASS" if installed.returncode == 0 and bw.exists() else "FAIL",
                 f"exit {installed.returncode}, {report.data['measurements']['install_seconds']}s")
    report.measure("installed_bytes", tree_size(prefix))
    report.measure("archive_bytes", archive.stat().st_size)
    # A tampered installed file must stop launches (asset integrity on every start).
    version = subprocess.run([bw, "--version"], cwd=home, env=env, capture_output=True, text=True)
    report.stage("installed --version", "PASS" if version.returncode == 0 else "FAIL", version.stdout.strip())

    # The installer refuses a damaged archive directory and installs nothing.
    marker = extracted / "lib/version.json"
    pristine = marker.read_bytes()
    marker.write_bytes(pristine + b" ")
    damaged = subprocess.run([extracted / "install.sh", "--prefix", str(work / "damaged/bashwink"), "--bin-dir", str(work / "damaged/bin")],
                             cwd=home, env=env, capture_output=True, text=True)
    marker.write_bytes(pristine)
    report.stage("installer refuses a damaged archive directory",
                 "PASS" if damaged.returncode != 0 and "integrity" in damaged.stderr and not (work / "damaged/bashwink/0.1.0-alpha.1").exists() else "FAIL",
                 f"exit {damaged.returncode}")
    # A tampered installed VM asset stops every launch and doctor names it.
    image = prefix / "0.1.0-alpha.1/lib/offline-vm/Image"
    size = image.stat().st_size
    image.chmod(0o644)
    with image.open("ab") as handle:
        handle.write(b"\0")
    refused = subprocess.run([bw], cwd=home, env=env, capture_output=True, text=True, timeout=60)
    diag = subprocess.run([bw, "doctor"], cwd=home, env=env, capture_output=True, text=True, timeout=60)
    with image.open("r+b") as handle:
        handle.truncate(size)
    report.stage("tampered installed VM asset refuses launch and doctor fails",
                 "PASS" if refused.returncode == 3 and "integrity check failed: Image" in refused.stderr
                 and "No model request was made" in refused.stderr and diag.returncode == 1 and "vm-assets" in diag.stdout else "FAIL",
                 f"launch exit {refused.returncode}, doctor exit {diag.returncode}")

    # 4. An unrelated project.
    project = work / "project"
    project.mkdir()
    (project / "calc.ts").write_text("export function add(a: number, b: number): number {\n  return a - b\n}\n")
    (project / "calc.test.ts").write_text(
        'import { expect, test } from "bun:test"\nimport { add } from "./calc"\n'
        'test("add", () => expect(add(2, 3)).toBe(5))\n')
    (project / ".env").write_text("UNAPPROVED_CANARY=do-not-copy\n")
    git_env = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
    subprocess.run(["git", "init", "-q", "."], cwd=project, env=git_env, check=True)
    subprocess.run(["git", "add", "calc.ts", "calc.test.ts"], cwd=project, env=git_env, check=True)
    subprocess.run(["git", "commit", "-qm", "initial"], cwd=project, env=git_env, check=True)
    originals = {n: (project / n).read_bytes() for n in ("calc.ts", "calc.test.ts", ".env")}

    # 5. First launch with nothing configured must stop before any model request.
    first = subprocess.run([bw], cwd=project, env=env, capture_output=True, text=True, timeout=60)
    report.stage("bare launch with no provider stops cleanly",
                 "PASS" if first.returncode == 3 and "no model is selected" in first.stderr and "No model request was made" in first.stderr else "FAIL",
                 f"exit {first.returncode}")

    # 6. Provider credentials and approved model.
    key_file = args.key_file
    bogus = False
    if key_file is None:
        key_file = work / "bogus.key"
        key_file.write_text("bw-invalid-credential-for-first-run\n")
        key_file.chmod(0o600)
        bogus = True
    steps = [
        ["auth", "add", "commandcode", "--base-url", BASE_URL, "--key-file", str(key_file),
         *[x for m in MODELS for x in ("--model", m)]],
        ["model", "use", "commandcode/claude-sonnet-5"],
        ["auth", "check", "commandcode"],
    ]
    for step in steps:
        done = subprocess.run([bw, *step], cwd=project, env=env, capture_output=True, text=True)
        report.stage(f"bashwink {' '.join(step[:2])}", "PASS" if done.returncode == 0 else "FAIL", done.stdout.strip()[:160] or done.stderr.strip()[:160])
    doctor = subprocess.run([bw, "doctor"], cwd=project, env=env, capture_output=True, text=True, timeout=60)
    report.stage("doctor after configuration", "PASS" if doctor.returncode == 0 else "FAIL",
                 doctor.stdout.strip().splitlines()[-1])

    # 7a. Workspace approval can be declined; nothing starts.
    with terminal([bw], project, env) as (_, master, contains, finish, capture):
        wait_for(lambda: contains("Approve this project?"), 40)
        shown = bytes(capture).decode(errors="replace")
        os.write(master, b"n\r")
        finish(3)
    declined_ok = "Approve this project?" in shown and "calc.ts" in shown and ".env" not in shown
    report.stage("workspace approval: shown, then declined", "PASS" if declined_ok else "FAIL")
    report.stage("declined approval started no VM and made no request",
                 "PASS" if "offline VM stage" not in shown and "Execution mode" not in shown else "FAIL")

    # 7b. Approve, cold-start the VM, and reach the TUI.
    live_note = "bogus key" if bogus else "live key"
    stages_before = {p.name for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()}
    sampler = None
    launch_started = time.monotonic()
    with terminal([bw], project, env) as (pid, master, contains, finish, capture):
        sampler = Sampler(pid)
        sampler.start()
        if not wait_for(lambda: contains("Approve this project?"), 40):
            report.stage("workspace approval prompt", "FAIL", bytes(capture[-400:]).decode(errors="replace"))
            return 1
        approval_at = time.monotonic()
        report.measure("launch_to_approval_prompt_seconds", round(approval_at - launch_started, 2))
        os.write(master, b"y\r")
        ready = wait_for(lambda: contains("Ask anything"), 60)
        report.measure("cold_start_approval_to_tui_seconds", round(time.monotonic() - approval_at, 2))
        report.stage("approve and reach TUI (cold VM)", "PASS" if ready else "FAIL", f"{live_note}")
        banner = "ISOLATED VM" in bytes(capture).decode(errors="replace")
        report.stage("execution mode shown before the TUI", "PASS" if banner else "FAIL")
        report.stage("execution mode shown inside the TUI (guest toast)",
                     "PASS" if wait_for(lambda: contains("Bashwink · ISOLATED VM"), 15) else "FAIL")
        time.sleep(3)
        contains("")
        report.stage("persistent indicator on the guest home screen",
                     "PASS" if "[SANDBOXED VM]" in screen_text(bytes(capture)) else "FAIL")
        report.measure("idle_footprint_mib", round(sampler.footprint_mib(), 1))
        if not args.live and bogus:
            # A real request to the real endpoint with a deliberately invalid key. Nothing of
            # value is sent. The outcome is read back from the saved session, not the screen.
            time.sleep(0.5)
            os.write(master, b"Reply with the single word ready.")
            time.sleep(0.2)
            os.write(master, b"\r")
            wait_for(lambda: contains("Reply with the single word ready"), 20)
            time.sleep(15)
            contains("")
            report.stage("persistent indicator in the guest TUI session view",
                         "PASS" if "[SANDBOXED VM]" in screen_text(bytes(capture)) else "FAIL")
        if not args.live:
            os.write(master, b"\x04")
            try:
                finish(0)
            except AssertionError as error:
                report.stage("exit after TUI reached", "FAIL", str(error)[:200])
        else:
            os.write(master, (CODING_PROMPT).encode())
            time.sleep(0.2)
            asked_at = time.monotonic()
            os.write(master, b"\r")
            approved = 0
            deadline = time.monotonic() + 600
            first_token = None
            while time.monotonic() < deadline:
                text = bytes(capture)
                if first_token is None and len(text) > 0 and b"Thinking" in text[-4000:]:
                    first_token = time.monotonic() - asked_at
                if b"Allow once" in text[-1500:] and approved < 6:
                    os.write(master, b"\r")
                    approved += 1
                    time.sleep(1.0)
                if re.search(rb"1 pass", text) and b"0 fail" in text:
                    time.sleep(8)
                    break
                contains("")
                time.sleep(0.5)
            report.measure("time_to_first_activity_seconds", None if first_token is None else round(first_token, 2))
            report.measure("peak_footprint_mib_sample", round(sampler.footprint_mib(), 1))
            os.write(master, b"\x04")
            try:
                finish(0)
            except AssertionError as error:
                report.stage("exit after coding", "FAIL", str(error)[:300])
            report.stage("live coding turn completed", "PASS" if re.search(rb"1 pass", bytes(capture)) else "FAIL",
                         f"{approved} approval(s)")
        text = bytes(capture).decode(errors="replace")
        usage = re.search(r"VM provider usage: (\d+)/(\d+) requests", text)
        report.measure("usage_line", usage[0] if usage else None)
        if usage:
            report.measure("provider_requests_used", int(usage[1]))
            report.measure("provider_request_limit", int(usage[2]))
        (work / "first-session.pty").write_bytes(bytes(capture))
    sampler.stop.set()
    sampler.join(timeout=5)
    if not args.live and bogus:
        report.stage("live endpoint rejects an invalid key (read from the saved session)", *auth_failure_from_checkpoint(home))
    report.measure("peak_workload_rss_kib", sampler.peak_rss_kib)
    report.measure("peak_workload_cpu_percent_of_one_core", round(sampler.peak_cpu_percent, 1))
    report.measure("peak_workload_footprint_mib", round(sampler.peak_footprint_mib, 1))
    report.measure("workload_processes", sorted(set(sampler.members.values())))
    if sampler.error:
        report.stage("resource sampler", "FAIL", sampler.error)
    leaked = {p.name for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()} - stages_before
    report.stage("no stage directory left in /private/tmp after a committed session", "PASS" if not leaked else "FAIL", ", ".join(sorted(leaked)))
    unchanged = all((project / n).read_bytes() == data for n, data in originals.items() if not args.live or n != "calc.ts")
    report.stage("host project unchanged until review", "PASS" if unchanged else "FAIL")

    # Repeated launches in the now-approved project. The VM always boots from scratch; "warm"
    # means the assets are in the host page cache and the project was already approved.
    warm = []
    for _ in range(3):
        began = time.monotonic()
        with terminal([bw], project, env) as (_, master, contains, finish, capture):
            if wait_for(lambda: contains("Ask anything"), 60):
                warm.append(round(time.monotonic() - began, 2))
            os.write(master, b"\x04")
            finish(0)
    report.measure("warm_launch_to_tui_seconds", warm)
    report.stage("repeat launches reach the TUI", "PASS" if len(warm) == 3 else "FAIL", f"{warm}")

    if args.live:
        # 10-12. Review, apply, protected tests.
        review_start = time.monotonic()
        with terminal([bw, "sandbox", "vm-review"], project, env) as (_, master, contains, finish, capture):
            shown = wait_for(lambda: contains("Type apply"), 30)
            diff = bytes(capture).decode(errors="replace")
            os.write(master, b"apply\r")
            finish(0)
        report.measure("review_and_apply_seconds", round(time.monotonic() - review_start, 2))
        fixed = b"a + b" in (project / "calc.ts").read_bytes()
        report.stage("review shows diff and apply changes the project", "PASS" if shown and fixed and "calc.ts" in diff else "FAIL")
        report.stage("untracked .env untouched", "PASS" if (project / ".env").read_bytes() == originals[".env"] else "FAIL")
        verify_start = time.monotonic()
        with terminal([bw, "sandbox", "vm-verify"], project, env) as (_, _, contains, finish, capture):
            passed = wait_for(lambda: contains("Protected tests exited with status 0"), 90)
            finish(0)
        report.measure("protected_verification_seconds", round(time.monotonic() - verify_start, 2))
        report.stage("protected tests in a fresh VM", "PASS" if passed else "FAIL")
        # 13. Exit and resume.
        resume_start = time.monotonic()
        with terminal([bw, "--continue"], project, env) as (_, master, contains, finish, capture):
            ready = wait_for(lambda: contains("Ask anything") or contains("calc.ts"), 60)
            report.measure("warm_resume_launch_to_tui_seconds", round(time.monotonic() - resume_start, 2))
            os.write(master, b"\x04")
            finish(0)
        report.stage("exit and resume (--continue)", "PASS" if ready else "FAIL")

    # 14. Uninstall.
    sizes_before = tree_size(prefix)
    removed = subprocess.run([prefix / "0.1.0-alpha.1/uninstall.sh"], cwd=home, env=env, capture_output=True, text=True)
    gone = not prefix.exists() and not bw.exists()
    state_kept = any((home / p).exists() for p in (".config/bashwink", ".local/share/bashwink"))
    report.stage("uninstall removes the install and keeps state", "PASS" if removed.returncode == 0 and gone and state_kept else "FAIL",
                 f"{sizes_before} bytes removed")
    # --purge-state may only remove stages this installation recorded. Every stage directory that
    # already existed on this machine (older builds, other tools) is a decoy that must survive.
    decoys = {p.name: p.stat().st_ino for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()}
    purge = subprocess.run([extracted / "uninstall.sh", "--purge-state"], cwd=home, env=env, input="delete\n", capture_output=True, text=True)
    purged = not (home / ".config/bashwink").exists() and not (home / ".local/share/bashwink").exists()
    report.stage("uninstall --purge-state removes state and exits 0", "PASS" if purge.returncode == 0 and purged else "FAIL", f"exit {purge.returncode}")
    survivors = {p.name: p.stat().st_ino for p in Path("/private/tmp").glob("bashwink-vm-*") if p.is_dir()}
    report.stage("purge left every pre-existing stage directory alone", "PASS" if survivors == decoys else "FAIL",
                 f"{len(decoys)} existed before, {len(survivors)} after")
    return 0


if __name__ == "__main__":
    sys.exit(main())
