#!/usr/bin/env python3
"""Fetch the native build inputs a clean clone needs, at their pins, with recorded digests.

`vendor/engine/packages/process-daemon/build.rs` fetches Ghostty itself when `GHOSTTY_SOURCE_DIR`
is unset. That works on a developer machine with network access and is wrong for this project in
three ways:

1. it happens *during* `cargo build`, so the build's inputs are decided by the build itself;
2. a clean clone has no record of what was fetched beyond a bare commit hash;
3. there is no integrity check on the tarball, only Git's own object hashing.

This script prefetches the same bytes at the same pinned revision, records the sha256 of every
file it places on disk, and prints the environment the build needs. `scripts/build_local_engine.py`
then consumes it. Nothing here downloads an OpenCode or OpenTUI artifact — only the two native
source trees the compiler needs, which are third-party inputs the plan permits.

Usage:
    python3 scripts/fetch_native_inputs.py --check      # report what is present, exit 1 if incomplete
    python3 scripts/fetch_native_inputs.py --fetch      # clone/verify the pinned inputs
    python3 scripts/fetch_native_inputs.py --env        # print exports for the shell
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VENDOR = REPO / "vendor" / "engine"
DAEMON = VENDOR / "packages" / "process-daemon"

# Default location, overridable so a CI job can point at a cached directory.
CACHE = Path(os.environ.get("BASHWINK_NATIVE_CACHE", REPO / "build" / "native-inputs"))
MANIFEST = CACHE / "native-inputs.json"

GHOSTTY_REPO = "https://github.com/ghostty-org/ghostty.git"
MARKER_NAME = ".bw-complete"


class FetchRefused(RuntimeError):
    pass


def ghostty_revision() -> str:
    """The revision build.rs would fetch, read from the vendored pin (not hard-coded here)."""
    path = DAEMON / "ghostty-revision"
    if not path.is_file():
        raise FetchRefused(
            f"missing {path.relative_to(REPO)}: the Ghostty pin lives in the vendored tree and "
            "cannot be guessed. Run scripts/import_local_engine.py first."
        )
    rev = path.read_text(encoding="utf-8").strip()
    if not rev or len(rev) < 7:
        raise FetchRefused(f"{path} does not contain a commit revision: {rev!r}")
    return rev


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path) -> str:
    """A digest over the whole tree: relative paths plus file digests, sorted.

    This is not Git's object hash. It answers a different question — "are these the bytes I
    recorded?" — which is what a build input needs, and it does not require a `.git` directory.

    `.git` and the completion marker are excluded. The marker especially: it is written *after*
    this digest is computed, so including it would make every subsequent check disagree with the
    recorded value — a self-invalidating digest that proves nothing.
    """
    entries: list[str] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root)
        if ".git" in rel.parts or rel.name == MARKER_NAME:
            continue
        entries.append(f"{rel}:{sha256_file(path)}")
    digest = hashlib.sha256()
    for line in entries:
        digest.update(line.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def run(argv: list[str], *, cwd: Path | None = None, quiet: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0 and not quiet:
        raise FetchRefused(
            f"command failed ({result.returncode}): {' '.join(argv)}\n"
            f"stderr: {result.stderr.strip()[:1500]}"
        )
    return result


def ghostty_dir(rev: str) -> Path:
    return CACHE / f"ghostty-{rev}"


def ensure_ghostty(rev: str) -> tuple[Path, str]:
    """Clone the pinned Ghostty revision if absent; return the directory and its tree digest."""
    target = ghostty_dir(rev)
    marker = target / MARKER_NAME

    if marker.is_file():
        return target, json.loads(marker.read_text(encoding="utf-8"))["treeDigest"]

    if target.exists():
        # A half-finished directory is deleted rather than reused: a partial checkout that happens
        # to satisfy a build is worse than no checkout at all.
        run(["rm", "-rf", str(target)])
    target.parent.mkdir(parents=True, exist_ok=True)

    run(["git", "init", "--quiet", str(target)])
    run(["git", "-C", str(target), "fetch", "--depth=1", GHOSTTY_REPO, rev])
    run(["git", "-C", str(target), "-c", "core.longpaths=true", "checkout", "--detach", rev])

    head = run(["git", "-C", str(target), "rev-parse", "HEAD"]).stdout.strip()
    if head != rev:
        raise FetchRefused(f"checked out {head}, expected {rev}")

    digest = tree_digest(target)
    marker.write_text(
        json.dumps({"revision": rev, "treeDigest": digest, "source": GHOSTTY_REPO}, indent=2) + "\n",
        encoding="utf-8",
    )
    return target, digest


def zig_executable() -> Path | None:
    """Locate a Zig the daemon can use (0.16.x). Absent is a valid answer, not an error."""
    explicit = os.environ.get("BASHWINK_ZIG_PTY")
    if explicit and Path(explicit).is_file():
        return Path(explicit)
    for candidate in (
        Path("/tmp/zig-install/zig-aarch64-macos-0.16.0"),
        REPO / "build" / "toolchains" / "zig-0.16.0",
    ):
        if candidate.is_dir() and (candidate / "zig").is_file():
            return candidate / "zig"
    which = subprocess.run(["which", "zig"], capture_output=True, text=True)
    return Path(which.stdout.strip()) if which.returncode == 0 and which.stdout.strip() else None


def check(rev: str) -> dict:
    target = ghostty_dir(rev)
    marker = target / MARKER_NAME
    status: dict = {
        "ghosttyRevision": rev,
        "ghosttyDir": str(target),
        "present": marker.is_file(),
        "treeDigest": None,
        "digestMatches": False,
        "zig": str(zig_executable()) if zig_executable() else None,
    }
    if marker.is_file():
        recorded = json.loads(marker.read_text(encoding="utf-8"))
        actual = tree_digest(target)
        status["treeDigest"] = actual
        status["recordedTreeDigest"] = recorded["treeDigest"]
        status["digestMatches"] = actual == recorded["treeDigest"]
    return status


def env_exports(rev: str, zig: Path | None) -> list[str]:
    exports = [
        f'export GHOSTTY_SOURCE_DIR="{ghostty_dir(rev)}"',
        f'export ZIG_GLOBAL_CACHE_DIR="{CACHE / "zig-cache"}"',
    ]
    if zig is not None:
        # The daemon shells out to a bare `zig`, so the PATH entry is what actually selects the
        # version — a variable would be ignored by build.rs.
        exports.append(f'export PATH="{zig.parent}:$PATH"')
    return exports


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fetch", action="store_true", help="clone the pinned inputs")
    ap.add_argument("--check", action="store_true", help="report state; exit 1 when incomplete")
    ap.add_argument("--env", action="store_true", help="print shell exports for the build")
    args = ap.parse_args(argv)

    try:
        rev = ghostty_revision()
        if args.fetch:
            target, digest = ensure_ghostty(rev)
            print(f"ghostty {rev} -> {target}")
            print(f"treeDigest {digest}")
        zig = zig_executable()
        if args.env:
            for line in env_exports(rev, zig):
                print(line)
            return 0
        if args.check or not args.fetch:
            status = check(rev)
            print(json.dumps(status, indent=2))
            incomplete = not status["present"] or not status["digestMatches"] or not status["zig"]
            return 1 if incomplete else 0
        return 0
    except FetchRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
