#!/usr/bin/env python3
"""License scope gate.

Enforces that every dependency with a copyleft or unresolved license has a *recorded
decision* in the inventory, rather than a blanket pass/fail rule.

Why not "fail if any GPL appears anywhere in node_modules" (independent review F-07):
that rule is simultaneously too strict and too weak. Too strict because a docs-site
dependency never reaches the artifact. Too weak because the real question — what
obligations attach to the bytes we actually distribute — is not answered by a word
search. This gate makes the absence of a decision fatal, and leaves the substance to
the recorded judgement plus legal review.

Usage:
    python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json
    python3 scripts/check_license_scope.py --inventory ... --fail-on-open   # release gate

Exit codes:
    0  every copyleft/unresolved package has a decision (open items may remain)
    1  a package has no recorded decision, or the inventory is malformed
    2  the script could not run
    3  --fail-on-open was passed and a release-blocking decision is still OPEN
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

COPYLEFT_MARKERS = ("GPL", "AGPL", "LGPL", "MPL", "SSPL", "BUSL", "CDDL", "EPL", "CC-BY-SA")
UNRESOLVED_MARKERS = ("NO-LICENSE-FIELD", "SEE-LICENSE-FILE", "UNKNOWN")


def needs_decision(license_text: str) -> bool:
    upper = license_text.upper()
    return any(marker in upper for marker in COPYLEFT_MARKERS + UNRESOLVED_MARKERS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify every copyleft dependency has a recorded decision.")
    parser.add_argument("--inventory", required=True, help="path to DEPENDENCY_LICENSES.json")
    parser.add_argument("--fail-on-open", action="store_true", help="also fail if a release-blocking decision is OPEN")
    args = parser.parse_args()

    path = Path(args.inventory)
    if not path.is_file():
        print(f"error: inventory not found: {path}", file=sys.stderr)
        return 2
    try:
        inventory = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        print(f"error: inventory is not valid JSON: {error}", file=sys.stderr)
        return 2

    packages = inventory.get("packages")
    decisions = inventory.get("decisions")
    if not isinstance(packages, list) or not isinstance(decisions, dict):
        print("error: inventory must contain 'packages' (list) and 'decisions' (object)", file=sys.stderr)
        return 2

    problems: list[str] = []
    requiring = [p for p in packages if needs_decision(str(p.get("license", "")))]
    names = {str(p.get("name")) for p in requiring}

    for name in sorted(names):
        if name not in decisions:
            examples = sorted({str(p.get("version")) for p in requiring if str(p.get("name")) == name})
            problems.append(f"no recorded decision for {name} (versions: {', '.join(examples)})")

    for name, decision in decisions.items():
        if not isinstance(decision, dict):
            problems.append(f"decision for {name} is not an object")
            continue
        for field in ("license", "in_shipped_path", "decision", "status"):
            if field not in decision:
                problems.append(f"decision for {name} is missing '{field}'")
        status = str(decision.get("status", ""))
        if status not in ("OPEN", "ACCEPTED_OUT_OF_SCOPE", "RESOLVED", "RESOLVED_BY_DESIGN"):
            problems.append(f"decision for {name} has unknown status {status!r}")

    open_blocking = [
        name
        for name, decision in decisions.items()
        if isinstance(decision, dict)
        and str(decision.get("status")) == "OPEN"
        and decision.get("blocks_release") is True
    ]

    shipped = [name for name, d in decisions.items() if isinstance(d, dict) and d.get("in_shipped_path") is True]

    print(f"packages inventoried: {len(packages)}")
    print(f"requiring a decision: {len(names)}")
    print(f"decisions recorded:   {len(decisions)}")
    print(f"in shipped path:      {', '.join(sorted(shipped)) or '(none)'}")
    print(f"open + release-blocking: {', '.join(sorted(open_blocking)) or '(none)'}")

    if problems:
        print("\nFAIL: license scope is incomplete", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print("\nOK: every copyleft or unresolved dependency has a recorded decision")

    if args.fail_on_open and open_blocking:
        print("\nFAIL: release-blocking licensing decisions are still OPEN:", file=sys.stderr)
        for name in sorted(open_blocking):
            print(f"  - {name}: {decisions[name].get('decision')}", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
