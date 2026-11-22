#!/usr/bin/env python3
"""Generate the canonical status summary from the task register.

Why this exists (independent review F-05): status text was maintained by hand in several
documents and drifted — `IMPLEMENTATION_STATUS.md` still reported a stale 8,001 tally and
claimed no root `LICENSE` existed after one had been written. Hand-maintained duplicates of
machine-checkable facts always drift. This script derives the numbers from the single source
of truth (`BASHWINK_TASKS_90.csv`) and writes one block that other documents transclude.

Usage:
    python3 scripts/generate_status_summary.py            # print
    python3 scripts/generate_status_summary.py --write    # update the block in place
    python3 scripts/generate_status_summary.py --check    # fail if the block is stale
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "docs" / "bashwink"
CSV_PATH = DOCS / "BASHWINK_TASKS_90.csv"
TARGET = DOCS / "IMPLEMENTATION_STATUS.md"
BEGIN = "<!-- BEGIN GENERATED:status -->"
END = "<!-- END GENERATED:status -->"

PHASES = [f"P{i}" for i in range(8)]


def load_rows() -> list[dict[str, str]]:
    raw = CSV_PATH.read_text(encoding="utf-8-sig")
    return list(csv.DictReader(io.StringIO(raw)))


def build_block(rows: list[dict[str, str]]) -> str:
    lines = [BEGIN, "", "| Phase | Tasks | Done | In progress | Blocked | Not started |", "| --- | ---: | ---: | ---: | ---: | ---: |"]
    total: Counter[str] = Counter()
    for phase in PHASES:
        group = [r for r in rows if r["Phase"] == phase]
        counts = Counter(r["Status"] for r in group)
        total.update(counts)
        lines.append(
            f"| {phase} | {len(group)} | {counts['Done']} | {counts['In progress']} | {counts['Blocked']} | {counts['Not started']} |"
        )
    lines.append(
        f"| **Total** | **{len(rows)}** | **{total['Done']}** | **{total['In progress']}** | "
        f"**{total['Blocked']}** | **{total['Not started']}** |"
    )
    lines += ["", END]
    return "\n".join(lines)


def build_task_table(rows: list[dict[str, str]]) -> str:
    """Every task that is not `Not started`, with its status. Generated, never hand-typed."""
    lines = ["| ID | Status | Title |", "| --- | --- | --- |"]
    for row in rows:
        if row["Status"] == "Not started":
            continue
        lines.append(f"| {row['ID']} | **{row['Status']}** | {row['Title']} |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the canonical Bashwink status summary.")
    parser.add_argument("--write", action="store_true", help="update the generated block in place")
    parser.add_argument("--check", action="store_true", help="fail if the committed block is stale")
    args = parser.parse_args()

    if not CSV_PATH.is_file():
        print(f"error: task register not found: {CSV_PATH}", file=sys.stderr)
        return 2

    rows = load_rows()
    block = build_block(rows)

    if args.check or args.write:
        text = TARGET.read_text(encoding="utf-8")
        pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL)
        if not pattern.search(text):
            print(f"error: no generated block found in {TARGET}", file=sys.stderr)
            return 2
        updated = pattern.sub(lambda _: block, text)
        if args.check:
            if updated != text:
                print("FAIL: IMPLEMENTATION_STATUS.md status block is stale; run --write", file=sys.stderr)
                return 1
            print("OK: status block matches the task register")
            return 0
        TARGET.write_text(updated, encoding="utf-8")
        print(f"updated {TARGET.relative_to(REPO)}")

    if not (args.check or args.write):
        print(block)
    return 0


if __name__ == "__main__":
    sys.exit(main())
