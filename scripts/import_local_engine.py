#!/usr/bin/env python3
"""Import the pinned OpenCode source closure into ``vendor/engine/``.

Task 1 of the local-engine migration. This is deliberately a *tracked* script rather than a set
of shell commands, so the import can be reproduced and reviewed: the set of imported paths is
data in this file, and every imported file is recorded with its upstream path, source commit and
digest.

What is imported
----------------
- The 17 declared production workspaces, by their upstream directory names.
- ``packages/script`` — the upstream build script workspace.
- ``packages/process-daemon`` — the PTY helper, imported from its own pin rather than from the
  engine commit, because the design pins it separately.
- ``packages/core/src/models-dev/snapshot.txt`` — the committed model snapshot the compiler embeds.
- Root build inputs: ``package.json``, ``bun.lock``, ``bunfig.toml``, ``tsconfig.json``,
  ``turbo.json``, ``.oxlintrc.json``, ``LICENSE`` and ``patches/`` so the lockfile's patched
  dependencies resolve locally.
- ``LICENSE`` with its upstream copyright line intact.

What is deliberately not imported
---------------------------------
The standalone web app, the desktop app, the unrelated services, GitHub workflow assets, the
upstream docs and translation READMEs, and — critically — any *untracked* build output. The
upstream checkout carries a 198 MB untracked ``packages/cli/dist/`` binary; copying it would
smuggle a prebuilt engine into a "build from source" migration.

Two modes
---------
``--check``   report what would be imported and what is missing; change nothing.
``--write``   perform the import and write ``UPSTREAM.json`` and ``INVENTORY.json``.

The import refuses to run if the source checkout's HEAD is not the pinned engine commit, so a
stale tree cannot silently become the vendored source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ENGINE_PIN = "c0ad18b402eb2827fc1ee71c171b1177b3fc02d1"
ENGINE_TAG = "v2.3.2"
HELPER_PIN = "03d848f7b8d71d31d3e56f2abd8b337efbc1bc32"
HELPER_TAG = "process-daemon-v0.6.0"
UPSTREAM_URL = "https://github.com/anomalyco/opencode"
VENDOR = Path("vendor/engine")

# Upstream directory → the design's workspace label. `plugins/browser` is the design's name;
# upstream calls the directory `plugin-browser`. Recording the mapping stops a future reader
# from concluding a workspace was dropped.
WORKSPACES = {
    "packages/cli": "cli",
    "packages/client": "client",
    "packages/server": "server",
    "packages/tui": "tui",
    "packages/core": "core",
    "packages/ai": "ai",
    "packages/plugin": "plugin",
    "packages/plugin-browser": "plugins/browser",
    "packages/protocol": "protocol",
    "packages/schema": "schema",
    "packages/util": "util",
    "packages/theme": "theme",
    "packages/ui": "ui",
    "packages/simulation": "simulation",
    "packages/codemode": "codemode",
    "packages/latex": "latex",
    "packages/merman": "merman",
    # Build inputs, not part of the 17, imported because the build consumes them.
    "packages/script": "script (build input)",
    # Measured transitive workspace dependencies of the 17. The design calls its list a
    # "starting set" and requires the final file set to be determined by building; `bun install
    # --frozen-lockfile` on the 17 alone fails outright with:
    #   workspace "@opencode/ai" depends on workspace "@opencode/http-recorder" (packages/
    #   http-recorder), which is listed in bun.lock but not on disk
    # so these are not optional extras — without them the vendor workspace cannot install.
    "packages/http-recorder": "http-recorder (transitive build dependency)",
    "packages/httpapi-codegen": "httpapi-codegen (transitive build dependency)",
}

ROOT_FILES = [
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "turbo.json",
    ".oxlintrc.json",
    "LICENSE",
]

ROOT_DIRS = ["patches"]

HELPER_DIR = "packages/process-daemon"


def git(repo: Path, *args: str, binary: bool = False):
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=not binary,
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr if not binary else proc.stderr.decode("utf-8", "replace")
        raise SystemExit(f"git {' '.join(args)} failed in {repo}: {err.strip()}")
    return proc.stdout


def tracked_files(repo: Path, paths: list[str]) -> list[str]:
    out = git(repo, "ls-files", "-z", "--", *paths)
    return sorted({p for p in out.split("\0") if p})


def blob(repo: Path, commit: str, path: str) -> bytes:
    return git(repo, "show", f"{commit}:{path}", binary=True)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream", required=True, help="pinned OpenCode checkout")
    ap.add_argument("--repo", default=".", help="Bashwink checkout root")
    ap.add_argument("--write", action="store_true", help="perform the import (default: report only)")
    args = ap.parse_args(argv)

    repo = Path(args.repo).resolve()
    up = Path(args.upstream).resolve()

    if not (repo / ".git").exists():
        raise SystemExit(f"{repo} is not a Git checkout")
    if not (up / ".git").exists():
        raise SystemExit(f"{up} is not a Git checkout")

    head = git(up, "rev-parse", "HEAD").strip()
    if head != ENGINE_PIN:
        raise SystemExit(
            f"refusing to import: upstream HEAD is {head[:12]}, expected the pinned {ENGINE_PIN[:12]}.\n"
            "Check out the pin first; a stale tree must not become the vendored source."
        )
    # The helper pin must also be present, even though the working tree is at the engine pin.
    try:
        git(up, "cat-file", "-e", f"{HELPER_PIN}^{{commit}}")
    except SystemExit:
        raise SystemExit(f"the helper pin {HELPER_PIN[:12]} is not in this checkout")

    plan: list[tuple[str, str, str]] = []  # (upstream path, source commit, vendor path)
    missing: list[str] = []

    for rel in list(WORKSPACES) + [HELPER_DIR]:
        commit = HELPER_PIN if rel == HELPER_DIR else ENGINE_PIN
        files = tracked_files(up, [rel])
        if not files:
            missing.append(rel)
            continue
        for f in files:
            plan.append((f, commit, f))

    root = tracked_files(up, ROOT_FILES)
    for f in ROOT_FILES:
        if f not in root:
            missing.append(f)
    for d in ROOT_DIRS:
        dir_files = tracked_files(up, [d])
        if not dir_files:
            missing.append(d)
        root.extend(dir_files)
    for f in root:
        plan.append((f, ENGINE_PIN, f))

    # The model snapshot is inside core and therefore already covered; assert it explicitly so a
    # future narrowing of the import cannot drop it silently.
    snapshot = "packages/core/src/models-dev/snapshot.txt"
    if not any(p[0] == snapshot for p in plan):
        missing.append(snapshot)

    if missing:
        raise SystemExit("missing required upstream inputs: " + ", ".join(missing))

    # --- size report before doing anything -------------------------------------------------
    total = 0
    for upstream_path, commit, _ in plan:
        total += len(blob(up, commit, upstream_path))
    print(f"would import {len(plan)} tracked files, {total / 1048576:.1f} MB uncompressed")
    print(f"  workspaces: {len(WORKSPACES)} declared + PTY helper + {len(root)} root build inputs")

    # Explicitly report the untracked binary we are refusing to copy, so its absence is visible.
    dist = up / "packages/cli/dist"
    if dist.exists():
        print(f"  refusing untracked build output: {dist} (present upstream, not imported)")

    if not args.write:
        print("\nreport only — pass --write to perform the import")
        return 0

    vendor = repo / VENDOR
    if vendor.exists():
        print(f"\n{vendor} already exists; refusing to overwrite an existing import", file=sys.stderr)
        return 1
    vendor.mkdir(parents=True)

    files_inventory: dict[str, dict] = {}
    for upstream_path, commit, vendor_path in plan:
        data = blob(up, commit, upstream_path)
        dest = vendor / vendor_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        files_inventory[vendor_path] = {
            "upstreamPath": upstream_path,
            "sourceCommit": commit,
            "sourceDigest": sha256(data),
            "bytes": len(data),
        }

    # Provenance manifest.
    upstream_manifest = {
        "engine": {
            "name": "OpenCode",
            "url": UPSTREAM_URL,
            "tag": ENGINE_TAG,
            "commit": ENGINE_PIN,
            "license": "MIT",
            "copyright": "Copyright (c) 2025 opencode",
        },
        "ptyHelper": {
            "name": "process-daemon",
            "url": UPSTREAM_URL,
            "tag": HELPER_TAG,
            "commit": HELPER_PIN,
            "path": HELPER_DIR,
            "license": "MIT",
        },
        "importedWorkspaces": {label: rel for rel, label in WORKSPACES.items()},
        "notImported": [
            "packages/app (standalone web app)",
            "packages/desktop (desktop app)",
            "packages/gui-plugins, packages/session-ui, packages/nav-menus, packages/stories",
            "services/*",
            "packages/data/*",
            "packages/cli/dist (untracked build output)",
            ".github/* (upstream CI and release assets)",
            "docs/*, README.*.md (upstream documentation and translations)",
        ],
        "localPatches": [],
    }
    # The absolute path of the local upstream checkout is deliberately NOT recorded here. It is a
    # machine-specific path, it would differ for every contributor, and the plan forbids machine
    # paths in artefacts. The pins recorded above are what make the import traceable; the checkout
    # location is a property of whoever ran the import, not of the import itself.
    (vendor / "UPSTREAM.json").write_text(json.dumps(upstream_manifest, indent=2) + "\n", encoding="utf-8")
    (vendor / "INVENTORY.json").write_text(
        json.dumps(
            {
                "note": "Every vendored file, its upstream path, the commit it came from and its "
                "digest. A file whose digest differs from sourceDigest must carry a patches[] entry.",
                "engine": {"commit": ENGINE_PIN, "tag": ENGINE_TAG},
                "ptyHelper": {"commit": HELPER_PIN, "tag": HELPER_TAG},
                "files": files_inventory,
                "patches": [],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"\nimported {len(files_inventory)} files into {vendor}")
    print("wrote UPSTREAM.json and INVENTORY.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
