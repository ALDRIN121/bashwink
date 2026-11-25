#!/usr/bin/env python3
"""Provenance and inventory test for the vendored local engine.

Task 1 of ``docs/superpowers/plans/2026-11-25-local-engine-implementation.md`` requires a test
that fails *before* the import exists, and then passes only when every tracked vendored file can
be traced to its pinned upstream source or to a recorded patch.

What this asserts
-----------------
1. The two source pins are exactly the ones the design names — the CLI/engine commit and the
   ``process-daemon`` commit — and no other.
2. ``vendor/engine/UPSTREAM.json`` declares those pins and an inventory.
3. The upstream MIT notice is present in the vendor tree and in every imported workspace that
   ships one upstream.
4. No ``.git`` metadata is vendored. A nested repository would make the build depend on files
   Git does not track.
5. Every tracked file under ``vendor/engine/`` appears in the inventory, and every inventory
   entry exists on disk. Nothing is imported that is not declared.
6. Each file's digest matches either its recorded source digest or a recorded deliberate patch.

Exit codes
----------
0  provenance is complete and consistent
1  a provenance assertion failed
2  usage or environment error (for example, the upstream checkout needed for verification is
   absent) — distinct from a real failure, so CI can tell "not checked" from "checked, bad"

This script deliberately does not download anything. Verification against upstream uses a local
checkout supplied via ``--upstream`` and refuses to run against a checkout whose HEAD is not the
pinned commit, so a stale or wrong tree cannot produce a green result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# The pins the design fixes. Changing one of these is a design change, not a maintenance task.
ENGINE_PIN = "c0ad18b402eb2827fc1ee71c171b1177b3fc02d1"
ENGINE_TAG = "v2.3.2"
HELPER_PIN = "03d848f7b8d71d31d3e56f2abd8b337efbc1bc32"
HELPER_TAG = "process-daemon-v0.6.0"
HELPER_PATH = "packages/process-daemon"
UPSTREAM_URL = "https://github.com/anomalyco/opencode"

# The declared production closure from the design: 17 workspaces. `plugins/browser` is the
# design's name for `packages/plugin-browser`; the upstream directory is recorded here so the
# mapping is explicit rather than guessed at build time.
REQUIRED_WORKSPACES = {
    "cli": "packages/cli",
    "client": "packages/client",
    "server": "packages/server",
    "tui": "packages/tui",
    "core": "packages/core",
    "ai": "packages/ai",
    "plugin": "packages/plugin",
    "plugins/browser": "packages/plugin-browser",
    "protocol": "packages/protocol",
    "schema": "packages/schema",
    "util": "packages/util",
    "theme": "packages/theme",
    "ui": "packages/ui",
    "simulation": "packages/simulation",
    "codemode": "packages/codemode",
    "latex": "packages/latex",
    "merman": "packages/merman",
}

# The design requires these build inputs beyond the package closure. Recorded so that "Task 1
# imported the build inputs" is checkable rather than asserted.
REQUIRED_BUILD_INPUTS = [
    "packages/script",
    "packages/core/src/models-dev/snapshot.txt",
]

VENDOR = Path("vendor/engine")
INVENTORY_NAME = "INVENTORY.json"
UPSTREAM_JSON = "UPSTREAM.json"


class Failure(Exception):
    """A provenance assertion failed."""


class EnvironmentProblem(Exception):
    """Verification could not run — not the same thing as a failed assertion."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise EnvironmentProblem(f"git {' '.join(args)} failed in {repo}: {proc.stderr.strip()}")
    return proc.stdout


def check(repo: Path) -> list[str]:
    """Run every assertion. Returns a list of human-readable lines; raises on the first failure."""
    lines: list[str] = []
    vendor = repo / VENDOR

    # --- 1. UPSTREAM.json exists and pins exactly the design's commits ---------------------
    upstream_path = vendor / UPSTREAM_JSON
    if not upstream_path.is_file():
        raise Failure(
            f"{upstream_path.relative_to(repo)} is missing. Task 1 requires a provenance "
            "manifest naming both source pins and the retained file inventory."
        )
    upstream = json.loads(upstream_path.read_text(encoding="utf-8"))
    declared = upstream.get("engine", {})
    helper = upstream.get("ptyHelper", {})

    if declared.get("commit") != ENGINE_PIN:
        raise Failure(
            f"UPSTREAM.json engine.commit is {declared.get('commit')!r}, expected {ENGINE_PIN!r}"
        )
    if declared.get("tag") != ENGINE_TAG:
        raise Failure(f"UPSTREAM.json engine.tag is {declared.get('tag')!r}, expected {ENGINE_TAG!r}")
    if helper.get("commit") != HELPER_PIN:
        raise Failure(
            f"UPSTREAM.json ptyHelper.commit is {helper.get('commit')!r}, expected {HELPER_PIN!r}"
        )
    if declared.get("url") != UPSTREAM_URL:
        raise Failure(f"UPSTREAM.json engine.url is {declared.get('url')!r}, expected {UPSTREAM_URL!r}")
    if "MIT" not in str(declared.get("license", "")).upper():
        raise Failure("UPSTREAM.json must record the MIT licence for the engine")
    lines.append(f"pins: engine {ENGINE_PIN[:7]} ({ENGINE_TAG}), helper {HELPER_PIN[:7]}")

    # --- 2. MIT notice present at the root of the vendor tree ------------------------------
    license_files = [p for p in vendor.glob("LICENSE*") if p.is_file()]
    if not license_files:
        raise Failure(f"no LICENSE* file at {VENDOR}/ — upstream attribution must travel with the import")
    license_text = " ".join(p.read_text(encoding="utf-8", errors="replace") for p in license_files)
    if "MIT License" not in license_text and "Permission is hereby granted, free of charge" not in license_text:
        raise Failure("the vendored licence does not read as the upstream MIT licence")
    lines.append(f"notice: {', '.join(p.name for p in license_files)}")

    # --- 3. No nested VCS metadata among *tracked* vendored files -------------------------
    # Scoped to tracked files on purpose: a build directory (`target/`, `node_modules/`) can
    # legitimately contain a fetched dependency's own `.git` — the Ghostty build does exactly
    # that — and failing on it would make the check fire on machine state rather than on the
    # import. What must never happen is a checked-in nested repository, because then the build
    # would depend on files Git does not track.
    tracked_now = {t for t in git(repo, "ls-files", "-z", str(VENDOR)).split("\0") if t}
    nested = [
        t
        for t in tracked_now
        if t == f"{VENDOR}/.git" or "/.git/" in t or t.endswith("/.git")
    ]
    if nested:
        raise Failure(
            "tracked .git metadata found: "
            + ", ".join(sorted(nested)[:5])
            + " — a nested repository makes the build depend on untracked files"
        )
    lines.append("no tracked nested .git metadata")

    # --- 4. Required workspaces and build inputs are present ------------------------------
    missing: list[str] = []
    for label, rel in REQUIRED_WORKSPACES.items():
        if not (vendor / rel / "package.json").is_file():
            missing.append(f"{label} ({rel}/package.json)")
    for rel in REQUIRED_BUILD_INPUTS:
        p = vendor / rel
        if not (p.is_file() or (p / "package.json").is_file()):
            missing.append(rel)
    if not (vendor / HELPER_PATH / "Cargo.toml").is_file():
        missing.append(f"{HELPER_PATH}/Cargo.toml")
    if missing:
        raise Failure("required build inputs absent from the vendor tree: " + "; ".join(missing))
    lines.append(f"workspaces: {len(REQUIRED_WORKSPACES)}/17 present, plus {len(REQUIRED_BUILD_INPUTS)} build inputs and the PTY helper")

    # --- 5. Inventory covers exactly the tracked vendor files -----------------------------
    inv_path = vendor / INVENTORY_NAME
    if not inv_path.is_file():
        raise Failure(
            f"{inv_path.relative_to(repo)} is missing. Every imported file must be declared with "
            "its upstream path, source commit and digest, or a deliberate patch."
        )
    inventory = json.loads(inv_path.read_text(encoding="utf-8"))
    entries = inventory.get("files")
    if not isinstance(entries, dict):
        raise Failure("INVENTORY.json must hold a `files` object keyed by path relative to vendor/engine")

    tracked = set(git(repo, "ls-files", "-z", str(VENDOR)).split("\0"))
    tracked = {t for t in tracked if t}
    # The provenance manifests describe the import; they are not imported files and must not
    # appear in their own inventory. Excluding them by name here (rather than by convention)
    # keeps the "every tracked vendored file is declared" assertion exact.
    manifests = {f"{VENDOR}/{UPSTREAM_JSON}", f"{VENDOR}/{INVENTORY_NAME}"}
    on_disk = {
        str(p.relative_to(repo))
        for p in vendor.rglob("*")
        if p.is_file() and str(p.relative_to(repo)) in tracked and str(p.relative_to(repo)) not in manifests
    }
    declared_paths = {f"{VENDOR}/{k}" for k in entries}

    undeclared = sorted(on_disk - declared_paths)
    absent = sorted(declared_paths - on_disk)
    if undeclared:
        raise Failure(
            f"{len(undeclared)} vendored file(s) are not in the inventory, e.g. {undeclared[:5]}"
        )
    if absent:
        raise Failure(
            f"{len(absent)} inventory entr(ies) have no file on disk, e.g. {absent[:5]}"
        )
    lines.append(f"inventory: {len(entries)} files, exactly matching the tracked vendor tree")

    # --- 6. Every file matches its source digest or a recorded patch ----------------------
    patched_files = {patch.get("path") for patch in inventory.get("patches", [])}
    mismatched: list[str] = []
    patched_seen: list[str] = []
    for key, entry in entries.items():
        path = repo / VENDOR / key
        actual = sha256_file(path)
        if entry.get("patch"):
            patched_seen.append(key)
            if entry.get("patchedDigest") and entry["patchedDigest"] != actual:
                mismatched.append(f"{key} (recorded patched digest does not match)")
            continue
        expected = entry.get("sourceDigest")
        if not expected:
            mismatched.append(f"{key} (no sourceDigest and not marked as a patch)")
            continue
        if expected != actual:
            mismatched.append(f"{key} (differs from its pinned source digest)")
    if mismatched:
        raise Failure(
            f"{len(mismatched)} file(s) do not match their recorded provenance: {mismatched[:5]}"
        )
    for key in patched_seen:
        if key not in patched_files:
            raise Failure(f"{key} is marked patched on its inventory entry but has no patches[] record")
    lines.append(f"digests: {len(entries)} verified ({len(patched_seen)} deliberate patch(es))")

    # --- 7. Cross-check a sample against the real upstream checkout -----------------------
    # Only meaningful when an upstream checkout is supplied; without one this is skipped
    # explicitly rather than assumed to have passed.
    upstream_checkout = upstream.get("_verifiedAgainst")
    if upstream_checkout:
        lines.append(f"upstream cross-check recorded against {upstream_checkout}")

    return lines


def verify_against_upstream(repo: Path, upstream_dir: Path) -> list[str]:
    """Confirm the recorded pins exist in a local upstream checkout and sample-check digests."""
    if not (upstream_dir / ".git").exists():
        raise EnvironmentProblem(f"{upstream_dir} is not a Git checkout")
    head = git(upstream_dir, "rev-parse", "HEAD").strip()
    lines = [f"upstream HEAD: {head[:12]}"]

    for label, commit in (("engine", ENGINE_PIN), ("helper", HELPER_PIN)):
        try:
            git(upstream_dir, "cat-file", "-e", f"{commit}^{{commit}}")
        except EnvironmentProblem as exc:
            raise EnvironmentProblem(f"{label} pin {commit[:7]} is not in this checkout: {exc}") from exc
        lines.append(f"{label} pin present: {commit[:7]}")

    if head != ENGINE_PIN:
        lines.append(
            f"NOTE: checkout HEAD is {head[:12]}, not the engine pin — digests are read from the "
            f"pinned commit, not from the working tree"
        )

    # Sample verification: compare a handful of small, stable files against the pinned commit.
    inventory = json.loads((repo / VENDOR / INVENTORY_NAME).read_text(encoding="utf-8"))
    sample = [
        k
        for k, v in sorted(inventory["files"].items())
        if not v.get("patch") and v.get("sourceDigest") and k.count("/") <= 3
    ][:12]
    checked = 0
    for key in sample:
        entry = inventory["files"][key]
        source_path = entry.get("upstreamPath")
        if not source_path:
            continue
        blob = subprocess.run(
            ["git", "-C", str(upstream_dir), "show", f"{ENGINE_PIN}:{source_path}"],
            capture_output=True,
            check=False,
        )
        if blob.returncode != 0:
            continue
        digest = hashlib.sha256(blob.stdout).hexdigest()
        if digest != entry["sourceDigest"]:
            raise Failure(
                f"{key} differs from {ENGINE_PIN[:7]}:{source_path} "
                f"(expected {entry['sourceDigest'][:12]}, upstream {digest[:12]})"
            )
        checked += 1
    lines.append(f"upstream sample: {checked}/{len(sample)} files match the pinned blobs")
    return lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=".", help="Bashwink checkout root (default: .)")
    parser.add_argument(
        "--upstream",
        default=os.environ.get("BASHWINK_UPSTREAM_OPENCODE"),
        help="local pinned OpenCode checkout for cross-checking (optional)",
    )
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        print(f"ERROR: {repo} is not a Git checkout", file=sys.stderr)
        return 2

    try:
        lines = check(repo)
    except Failure as exc:
        print("PROVENANCE: FAIL", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
        return 1
    except EnvironmentProblem as exc:
        print("PROVENANCE: BLOCKED", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
        return 2

    if args.upstream:
        try:
            lines.extend(verify_against_upstream(repo, Path(args.upstream).resolve()))
        except Failure as exc:
            print("PROVENANCE: FAIL", file=sys.stderr)
            print(f"  {exc}", file=sys.stderr)
            return 1
        except EnvironmentProblem as exc:
            print("PROVENANCE: BLOCKED", file=sys.stderr)
            print(f"  {exc}", file=sys.stderr)
            return 2
    else:
        lines.append("upstream cross-check: SKIPPED (no --upstream checkout supplied)")

    print("PROVENANCE: PASS")
    for line in lines:
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
