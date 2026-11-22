#!/usr/bin/env python3
"""Generate a distributable third-party notices bundle.

Independent review point taken: a findings document is not a notices bundle. This script
copies the *actual license text* of every component that reaches a Bashwink artifact into
one file that a release can ship.

Two distribution models are handled separately because they carry different obligations
(see LICENSING_DETERMINATION.md):

    --model PM-0   publish the plugin only; no native code redistributed
    --model PM-1   ship a binary containing libopentui (optionally without FFmpeg)

Usage:
    python3 scripts/generate_notices.py --upstream <opencode-clone> --model PM-1 --out THIRD_PARTY_NOTICES.txt
    python3 scripts/generate_notices.py --model PM-0 --out THIRD_PARTY_NOTICES.txt
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

# Components linked into libopentui.dylib and therefore into a PM-1 binary.
# `pattern` is a glob relative to the native package directory.
NATIVE_COMPONENTS = [
    ("OpenTUI native library (libopentui)", "MIT", ["LICENSE"]),
    ("WUFFS", "Apache-2.0", ["LICENSE-WUFFS"]),
    ("zlib", "Zlib", ["LICENSE-ZLIB"]),
    ("libwebp", "BSD-3-Clause", ["LICENSE-LIBWEBP", "PATENTS-LIBWEBP", "AUTHORS-LIBWEBP"]),
    ("stb", "MIT / public domain", ["LICENSE-STB"]),
    ("Ghostty", "MIT", ["LICENSE-GHOSTTY"]),
    ("lcms2", "MIT", ["LICENSE-LCMS2"]),
    ("FFmpeg", "LGPL-2.1-or-later", ["LICENSE-FFMPEG", "FFMPEG-SOURCE.md"]),
]

# Only these are present when FFmpeg is compiled out.
NO_FFMPEG_EXCLUDED = {"FFmpeg"}


def find_native_package(upstream: Path) -> Path | None:
    pattern = str(upstream / "node_modules" / ".bun" / "@opentui+core-darwin-arm64@*" / "node_modules" / "@opentui" / "core-darwin-arm64")
    hits = sorted(glob.glob(pattern))
    return Path(hits[0]) if hits else None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a distributable third-party notices bundle.")
    parser.add_argument("--model", required=True, choices=["PM-0", "PM-1"],
                        help="PM-0 = plugin only (no native redistribution); PM-1 = bundled binary")
    parser.add_argument("--upstream", default=None, help="path to the pinned OpenCode clone")
    parser.add_argument("--no-ffmpeg", action="store_true",
                        help="PM-1 only: the native library was rebuilt without FFmpeg")
    parser.add_argument("--out", required=True, help="output file")
    parser.add_argument("--manifest", default=None, help="optional JSON manifest to write")
    args = parser.parse_args()

    lines: list[str] = []
    included: list[dict[str, object]] = []
    missing: list[str] = []

    lines.append("BASHWINK — THIRD-PARTY NOTICES")
    lines.append("=" * 78)
    lines.append("")
    lines.append(f"Distribution model: {args.model}")
    if args.model == "PM-0":
        lines.append("")
        lines.append("Bashwink is distributed as source/JavaScript only. It does NOT")
        lines.append("redistribute any native code. OpenCode and its native dependencies are")
        lines.append("installed by the user and are peers, not bundled components.")
    else:
        lines.append("")
        lines.append("Bashwink bundles a native UI library (libopentui). The notices below")
        lines.append("cover every component linked into that library.")
        if args.no_ffmpeg:
            lines.append("")
            lines.append("This build was compiled WITHOUT FFmpeg: no FFmpeg code is present and")
            lines.append("no LGPL-2.1 obligation attaches to FFmpeg. See LICENSING_DETERMINATION.md.")
    lines.append("")
    lines.append("Bashwink itself is MIT licensed. See LICENSE.")
    lines.append("")

    if args.model == "PM-0":
        lines.append("-" * 78)
        lines.append("No third-party code is redistributed under PM-0.")
        lines.append("-" * 78)
    else:
        if not args.upstream:
            print("error: --upstream is required for PM-1", file=sys.stderr)
            return 2
        upstream = Path(args.upstream)
        if not upstream.is_dir():
            print(f"error: upstream path not found: {upstream}", file=sys.stderr)
            return 2
        pkg = find_native_package(upstream)
        if pkg is None:
            print("error: could not locate @opentui/core-darwin-arm64 in the upstream clone", file=sys.stderr)
            return 2

        for name, license_id, files in NATIVE_COMPONENTS:
            if args.no_ffmpeg and name in NO_FFMPEG_EXCLUDED:
                continue
            present = []
            for rel in files:
                p = pkg / rel
                if p.is_file():
                    present.append(rel)
            if not present:
                missing.append(f"{name} ({', '.join(files)})")
                continue
            lines.append("")
            lines.append("-" * 78)
            lines.append(f"{name}")
            lines.append(f"License: {license_id}")
            lines.append(f"Files: {', '.join(present)}")
            lines.append("-" * 78)
            for rel in present:
                lines.append("")
                lines.append(f"--- {rel} ---")
                lines.append(read_text(pkg / rel))
            included.append({"component": name, "license": license_id, "files": present})

    lines.append("")
    lines.append("=" * 78)
    lines.append("END OF NOTICES")
    lines.append("")

    out = Path(args.out)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"model:            {args.model}")
    print(f"no-ffmpeg:        {bool(args.no_ffmpeg and args.model == 'PM-1')}")
    print(f"components:       {len(included)}")
    print(f"output:           {out}  ({out.stat().st_size:,} bytes)")
    if missing:
        print("\nMISSING license files (bundle is INCOMPLETE):", file=sys.stderr)
        for item in missing:
            print(f"  - {item}", file=sys.stderr)

    if args.manifest:
        Path(args.manifest).write_text(
            json.dumps({"model": args.model, "no_ffmpeg": bool(args.no_ffmpeg), "components": included,
                        "missing": missing}, indent=1) + "\n", encoding="utf-8")
        print(f"manifest:         {args.manifest}")

    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
