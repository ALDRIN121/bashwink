#!/usr/bin/env python3
"""Record or refresh deliberate local patches in the vendored engine inventory.

Task 1's rule is that a vendored file may differ from its pinned source **only** if the
difference is recorded. Editing a file by hand and leaving the inventory alone would make the
provenance test fail — which is the intended behaviour, but it means every deliberate change needs
a matching entry.

This script is the single place that records such a change, so the reason is written down at the
point the digest is updated rather than reconstructed later from a diff.

Usage:
    python3 scripts/record_engine_patch.py --list
    python3 scripts/record_engine_patch.py --path <vendor-relative-path> --reason "..." [--reason ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

VENDOR = Path("vendor/engine")
INVENTORY = VENDOR / "INVENTORY.json"
ENGINE_PIN = "c0ad18b402eb2827fc1ee71c171b1177b3fc02d1"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def upstream_digest(upstream: Path | None, path: str) -> str | None:
    """The digest of this path at the engine pin, or None when the file is an addition."""
    if upstream is None:
        return None
    proc = subprocess.run(
        ["git", "-C", str(upstream), "show", f"{ENGINE_PIN}:{path}"],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    return hashlib.sha256(proc.stdout).hexdigest()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--path", action="append", default=[], help="path relative to vendor/engine")
    ap.add_argument("--reason", action="append", default=[], help="why this file differs from upstream")
    ap.add_argument("--upstream", default="../bashwink-upstream/opencode", help="pinned upstream checkout")
    ap.add_argument("--list", action="store_true", help="show recorded patches and drift")
    args = ap.parse_args(argv)

    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    upstream = Path(args.upstream).resolve() if Path(args.upstream).exists() else None

    if args.list:
        recorded = inventory.get("patches", [])
        print(f"{len(recorded)} recorded patch(es):")
        for p in recorded:
            entry = inventory["files"].get(p["path"], {})
            actual = sha(VENDOR / p["path"]) if (VENDOR / p["path"]).is_file() else "(missing)"
            state = "in sync" if entry.get("patchedDigest") == actual else "DRIFTED"
            print(f"  [{p.get('kind','?'):8}] {p['path']}  ({state})")
        # Report drift in non-patch files too, so a stray edit is visible without running pytest.
        drift = []
        for key, entry in inventory["files"].items():
            f = VENDOR / key
            if not f.is_file():
                drift.append(f"{key} (missing)")
                continue
            if entry.get("patch"):
                continue
            if entry.get("sourceDigest") and sha(f) != entry["sourceDigest"]:
                drift.append(key)
        if drift:
            print(f"\n{len(drift)} unrecorded change(s):")
            for d in drift[:20]:
                print(f"  {d}")
        return 0

    if not args.path:
        print("nothing to do: pass --path (and --reason) or --list", file=sys.stderr)
        return 2
    if len(args.reason) == 1 and len(args.path) > 1:
        # One shared reason for several files is legitimate, but say so explicitly in the entry.
        reasons = args.reason * len(args.path)
    elif len(args.reason) == len(args.path):
        reasons = args.reason
    elif not args.reason:
        print("a --reason is required: an unexplained digest change is not a recorded patch", file=sys.stderr)
        return 2
    else:
        print("provide one --reason per --path, or a single shared --reason", file=sys.stderr)
        return 2

    existing = {p["path"]: p for p in inventory.get("patches", [])}
    for path, reason in zip(args.path, reasons):
        f = VENDOR / path
        if not f.is_file():
            print(f"no such vendored file: {path}", file=sys.stderr)
            return 1
        src = upstream_digest(upstream, path)
        kind = "modified" if src else "added"
        entry = inventory["files"].setdefault(path, {})
        entry.update(
            {
                "upstreamPath": path,
                "sourceCommit": ENGINE_PIN,
                "sourceDigest": src,
                "bytes": f.stat().st_size,
                "patch": True,
                "patchedDigest": sha(f),
                "patchedFrom": ENGINE_PIN,
                "note": reason,
            }
        )
        existing[path] = {"path": path, "kind": kind, "reason": reason}
        print(f"  recorded [{kind}] {path}")

    inventory["patches"] = [existing[k] for k in sorted(existing)]
    INVENTORY.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(f"\ninventory: {len(inventory['files'])} files, {len(inventory['patches'])} patch(es)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
