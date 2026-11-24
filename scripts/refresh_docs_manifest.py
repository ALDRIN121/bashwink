#!/usr/bin/env python3
"""Refresh recorded hashes in docs/bashwink/PACKAGE_MANIFEST.json after intentional edits.

    python3 scripts/refresh_docs_manifest.py            # list what differs (no changes)
    python3 scripts/refresh_docs_manifest.py --write    # record the current hashes

This does not weaken `verify_bashwink_docs.py --check-manifest`: that check still fails for any
file that differs from the manifest. This tool is the explicit, reviewable step that says "these
documents were edited on purpose". It only updates entries that already exist. It never adds or
removes a file, and it refuses to run if a listed file is missing, so a deleted document cannot be
papered over. Every change is printed (path, old and new hash) for the commit message.
"""
import hashlib
import json
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs/bashwink"
MANIFEST = DOCS / "PACKAGE_MANIFEST.json"


def main():
    write = "--write" in sys.argv
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    changed = []
    for rel, info in manifest["files"].items():
        path = DOCS / rel
        if not path.is_file():
            print(f"ERROR: {rel} is listed in the manifest but missing; refusing to continue", file=sys.stderr)
            return 1
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != info["sha256"] or len(data) != info["size_bytes"]:
            changed.append((rel, info["sha256"], digest))
            if write:
                info["sha256"], info["size_bytes"] = digest, len(data)
    for rel, old, new in changed:
        print(f"{'updated' if write else 'differs'}  {rel}\n    {old}\n -> {new}")
    if write and changed:
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"{len(changed)} file(s) {'updated' if write else 'differ from the manifest'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
