#!/usr/bin/env python3
"""From inside the RELEASE guest, try to reach out, then read what happened from the checkpoint.

    python3 fixtures/release/vm_egress_probe.py <release-dir>

A synthetic model asks the guest shell to: list network interfaces, fetch a public address and
the VM's would-be host gateway, look for host paths, check its user id and try to read and write
the raw stage disk. The command output is written to probe.txt in the staged project; the host
reads it from the saved checkpoint, so the observation does not depend on the guest's word
about itself beyond the bytes it wrote.
"""
import base64
import hashlib
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
from run import wait_for, purge_stages_under  # noqa: E402

PROBE = r"""
s=$(printf '\057'); u="${s}Users"; pv="${s}private"; vo="${s}Volumes"; dev="${s}dev${s}vda"; mt="${s}proc${s}mounts"
{
  echo '## links'; ip -o link | cut -d: -f2
  echo '## routes'; ip route 2>&1; echo "routes-exit=$?"
  echo '## public'; timeout 4 wget -q -O- http://1.1.1.1/ 2>&1 | head -c 80; echo "public-exit=$?"
  echo '## gateway'; timeout 4 wget -q -O- http://192.168.64.1/ 2>&1 | head -c 80; echo "gateway-exit=$?"
  echo '## dns'; timeout 4 nslookup example.com 2>&1 | head -c 120; echo
  echo '## host paths'; ls "$u" 2>&1 | head -2; ls "$pv" 2>&1 | head -2; ls "$vo" 2>&1 | head -2
  echo '## user'; id
  echo '## disk'; (printf x >"$dev") 2>&1 | head -1; (head -c 1 "$dev" | wc -c) 2>&1 | head -1
  echo '## mounts'; cut -d' ' -f1,3 "$mt" | tr '\n' ';'; echo
  echo '## end'
} > probe.txt 2>&1
"""


def main():
    release = Path(sys.argv[1]).resolve()
    manifest = json.loads((release / "lib/offline-vm.json").read_text())
    root = Path(tempfile.mkdtemp(prefix="bw-egress-probe-")).resolve()
    generated = HERE / "_generated_egress.ts"
    try:
        subprocess.run([REPO / "scripts/build_alpha.sh", root / "bashwink"], check=True, stdout=subprocess.DEVNULL)
        lib = root / "bashwink/lib"
        (lib / "offline-vm").mkdir()
        for name in ("vm-owner", "Image", "initramfs"):
            shutil.copyfile(release / "lib/offline-vm" / name, lib / "offline-vm" / name)
            (lib / "offline-vm" / name).chmod(0o755 if name == "vm-owner" else 0o644)
            assert hashlib.sha256((lib / "offline-vm" / name).read_bytes()).hexdigest() == manifest["sha256"][name]
        (lib / "offline-vm.json").write_text((release / "lib/offline-vm.json").read_text())
        source = (REPO / "fixtures/native-offline/vm-provider-fixture.ts").read_text()
        replacement = "const actions = [\n  { tool: \"shell\", args: { command: " + json.dumps(PROBE) + " } },\n]\n"
        source = re.sub(r"const actions = \[.*?\n\]\n", lambda _: replacement, source, count=1, flags=re.S)
        generated.write_text(source)
        entry = lib / "egress.js"
        bun = shutil.which("bun")
        subprocess.run([bun, "build", generated, "--target=bun", "--outfile", entry], check=True, stdout=subprocess.DEVNULL)
        project = root / "project"
        project.mkdir()
        (project / "one.ts").write_text("export const one = 0\n")
        env = {"PATH": os.environ["PATH"], "HOME": str(root), "TERM": "xterm-256color", "BASHWINK_HOME": str(root / "state"),
               "BASHWINK_OPENCODE_BIN": "/missing-host-opencode", "BW_SYNTHETIC_CREDENTIAL": "disposable-host-provider-canary-egress",
               "BASHWINK_VM_PROVIDER": "relaydemo", "BASHWINK_VM_MAX_REQUESTS": "10"}
        ge = {**env, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e.i", "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e.i"}
        for step in (["git", "init", "-q", "."], ["git", "add", "one.ts"], ["git", "commit", "-qm", "i"]):
            subprocess.run(step, cwd=project, env=ge, check=True)
        bw = root / "bashwink/bin/bashwink"
        for args in (["auth", "add", "relaydemo", "--base-url", "https://api.openai.com/v1", "--env", "BW_SYNTHETIC_CREDENTIAL",
                      "--model", "fixture-model:openai"], ["model", "use", "relaydemo/fixture-model"]):
            subprocess.run([bw, *args], cwd=project, env=env, check=True, stdout=subprocess.DEVNULL)
        session_capture = bytearray()
        with terminal([shutil.which("bun"), entry], project, env) as (_, master, contains, finish, capture):
            session_capture = capture
            assert wait_for(lambda: contains("Ask anything"), 40), bytes(capture[-500:])
            time.sleep(0.3)
            os.write(master, b"Fix the persistent project")
            time.sleep(0.2)
            os.write(master, b"\r")
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and not contains("VM project tool sequence completed"):
                if b"Allow once" in bytes(capture)[-1500:]:
                    time.sleep(0.5)
                    os.write(master, b"\r")
                    time.sleep(1.5)
                time.sleep(0.3)
            assert contains("VM project tool sequence completed"), bytes(capture[-800:])
            os.write(master, b"\x04")
            finish(0)
        [checkpoint] = list((root / "state/data/vm-projects").glob("*/checkpoint.json"))
        record = json.loads(json.loads(checkpoint.read_text())["payload"])
        if "probe.txt" not in record["snapshot"]["files"]:
            print("snapshot files:", sorted(record["snapshot"]["files"]))
            print(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", bytes(session_capture).decode(errors="replace"))[-1500:])
            evidence = base64.b64decode(record["snapshot"]["state"]["bashwink/data/evidence/evidence.jsonl"]).decode()
            for line in evidence.splitlines()[-6:]:
                row = json.loads(line)
                print("EVIDENCE", row.get("phase"), json.dumps(row.get("payload"))[:300])
            return 1
        output = base64.b64decode(record["snapshot"]["files"]["probe.txt"]).decode()
        print(output)
        sections = dict(re.findall(r"## (\w[\w ]*)\n(.*?)(?=\n## |\Z)", output, flags=re.S))
        problems = []
        if sections.get("links", "").split() != ["lo"]:
            problems.append(f"unexpected interfaces: {sections.get('links')!r}")
        if sections.get("routes", "").split("routes-exit")[0].strip():
            problems.append("the guest has a route")
        for name in ("public", "gateway"):
            if "Network unreachable" not in sections.get(name, ""):
                problems.append(f"{name} fetch was not refused as unreachable")
        if "timed out" not in sections.get("dns", "") and "refused" not in sections.get("dns", ""):
            problems.append("name resolution did not fail")
        if sections.get("host paths", "").count("No such file or directory") != 3:
            problems.append("a host path name resolved")
        if "uid=0" in sections.get("user", "") or "uid=" not in sections.get("user", ""):
            problems.append("guest shell runs as root or its user is unknown")
        if sections.get("disk", "").count("Permission denied") != 2:
            problems.append("the raw stage disk was readable or writable")
        filesystems = {part.split(" ")[-1] for part in sections.get("mounts", "").strip().split(";") if part}
        if not filesystems <= {"rootfs", "proc", "sysfs", "devtmpfs", "devpts", "tmpfs"}:
            problems.append(f"unexpected filesystems: {sorted(filesystems)}")
        if "end" not in output.split("## ")[-1]:
            problems.append("probe did not finish")
        print("EGRESS PROBE:", "FAIL " + "; ".join(problems) if problems else "PASS")
        return 1 if problems else 0
    finally:
        generated.unlink(missing_ok=True)
        purge_stages_under(root, root / "bashwink/bin/bashwink")
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
