#!/usr/bin/env python3
"""Run the installed-VM project acceptance against the release archive's VM assets.

    python3 fixtures/release/vm-acceptance.py <release-dir> [--keep]

`<release-dir>` is the extracted archive directory (it contains lib/offline-vm). The guest
image, kernel and VM owner are the release bytes. The host CLI is the development bundle plus
the synthetic upstream the acceptance fixture needs, because the release CLI only talks to
the real provider hosts. The release CLI itself is exercised by release-first-run.py.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "native-offline"))
from vm_project_acceptance import accept_project  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("release", type=Path)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    release = args.release.resolve()
    manifest = json.loads((release / "lib/offline-vm.json").read_text())
    root = Path(tempfile.mkdtemp(prefix="bw-release-vm-acceptance-")).resolve()
    print(f"acceptance output: {root}", flush=True)
    try:
        assets = {}
        for name in ("vm-owner", "Image", "initramfs"):
            source = release / "lib/offline-vm" / name
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            assert digest == manifest["sha256"][name], f"{name} does not match the release manifest"
            copy = root / f"release-{name}"
            shutil.copyfile(source, copy)
            copy.chmod(0o755 if name == "vm-owner" else 0o644)
            assets[name] = copy
            print(f"release asset {name} sha256 {digest}", flush=True)
        subprocess.run([HERE.parents[1] / "scripts/build_alpha.sh", root / "bashwink"], check=True,
                       stdout=subprocess.DEVNULL)
        protected = root / "protected.txt"
        protected.write_text("Unrelated host fixture\n")
        accept_project(root, assets["vm-owner"], assets["Image"], assets["initramfs"], protected, relay=True)
        print("RELEASE VM ACCEPTANCE: PASS", flush=True)
    finally:
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
