#!/usr/bin/env python3
"""Fail external-alpha admission unless the candidate has complete native evidence."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import sys

TARGETS = {"macos-arm64": "seatbelt", "ubuntu-x86_64": "bubblewrap"}
REQUIRED = (
    "clean-install",
    "interactive-mock",
    "interactive-live-provider",
    "file-and-link-policy",
    "subprocess-and-detached-cleanup",
    "network-and-provider-transport",
    "secret-isolation",
    "approval-and-alternate-dispatch",
    "session-recovery-and-export",
    "unsupported-host-and-no-fallback",
    "resource-limits",
    "ci-or-reviewed-equivalent",
)
VERDICTS = {"PASS", "FAIL", "BLOCKED", "NOT_RUN"}
REPORT = Path(__file__).resolve().parents[1] / "docs/bashwink/NATIVE_SANDBOX_QUALIFICATION.json"


def validate(matrix, revision, evidence_exists):
    errors = []
    if not isinstance(matrix, dict) or matrix.get("schema") != 1:
        return ["unrecognized qualification matrix schema"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        return ["candidate revision must be a full Git commit SHA"]
    advertised = matrix.get("advertised")
    if not isinstance(advertised, list) or sorted(str(item) for item in advertised) != sorted(TARGETS):
        errors.append("advertised platforms must match the two required native targets")

    rows = matrix.get("qualification")
    if not isinstance(rows, list):
        return errors + ["missing qualification result list"]
    expected_pairs = {(platform, check) for platform in TARGETS for check in REQUIRED}
    seen = Counter()
    policies = {platform: set() for platform in TARGETS}
    for row in rows:
        if not isinstance(row, dict):
            errors.append("malformed qualification result")
            continue
        pair = (str(row.get("platform")), str(row.get("id")))
        platform, check = pair
        label = f"{platform}/{check}"
        if pair not in expected_pairs:
            errors.append(f"{label}: unrecognized platform or check")
            continue
        seen[pair] += 1
        if row.get("backend") != TARGETS[platform]:
            errors.append(f"{label}: wrong backend")
        verdict = str(row.get("verdict"))
        if verdict != "PASS":
            reason = row.get("reason")
            if verdict not in VERDICTS or not isinstance(reason, str) or not reason.strip():
                errors.append(f"{label}: invalid verdict or missing reason")
            else:
                errors.append(f"{label}: {verdict} ({reason})")
            continue
        if row.get("commit") != revision:
            errors.append(f"{label}: evidence is for a different revision")
        policy = str(row.get("policyDigest"))
        if not re.fullmatch(r"[0-9a-f]{64}", policy):
            errors.append(f"{label}: missing policy digest")
        else:
            policies[platform].add(policy)
        for field in ("command", "expected", "observed", "evidence"):
            value = row.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{label}: missing {field}")
            elif field == "evidence" and not evidence_exists(value):
                errors.append(f"{label}: evidence file not found")

    for platform, check in sorted(expected_pairs):
        if seen[(platform, check)] != 1:
            errors.append(f"{platform}/{check}: expected exactly one result")
    for platform, digests in sorted(policies.items()):
        if len(digests) > 1:
            errors.append(f"{platform}: results mix different policies")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=REPORT)
    parser.add_argument("--revision", help="full Git SHA of the intended release (default: HEAD)")
    args = parser.parse_args()
    try:
        revision = args.revision or subprocess.check_output(
            ["git", "-C", str(REPORT.parents[2]), "rev-parse", "HEAD"], text=True
        ).strip()
        matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
        root = args.matrix.resolve().parent

        def exists(value):
            candidate = (root / value).resolve()
            return candidate.is_relative_to(root) and candidate.is_file() and candidate.stat().st_size > 0

        errors = validate(matrix, revision, exists)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        errors = [str(error)]
    if errors:
        print("External-alpha native qualification FAIL", file=sys.stderr)
        for message in errors:
            print(f"- {message}", file=sys.stderr)
        return 1
    print(f"External-alpha native qualification PASS for {revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
