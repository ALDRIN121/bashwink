#!/usr/bin/env python3
"""Validate the macOS-only v0.1.0-alpha.1 candidate without publishing anything."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from verify_native_release import REPORT, validate as validate_native


REPO_ROOT = REPORT.parents[2]
VERSION = "v0.1.0-alpha.1"
MANIFEST = REPORT.parent / f"releases/{VERSION}/RELEASE_MANIFEST.json"
TARGET = "macos-arm64"
BACKEND = "apple-virtualization"
RUNTIME = "2.3.2"
# The archive carries the package version; the Git tag and manifest carry the leading "v".
ARTIFACT = f"bashwink-{VERSION.removeprefix('v')}-{TARGET}.tar.gz"
REPOSITORY = "ALDRIN121/bashwink"
CHECKS = (
    "interactive-coding", "real-provider", "clean-install", "supported-platform",
    "shell-containment", "host-access-denial", "credential-protection", "session-recovery",
    "reviewed-edits", "critical-security-review", "regression", "required-ci",
    "release-archive", "documentation", "feedback-channel",
)
ARTIFACT_CHECKS = {
    "interactive-coding", "real-provider", "clean-install", "session-recovery",
    "reviewed-edits", "release-archive",
}
VERIFY_JOBS = (
    "lint", "docs integrity", "secret scan", "license scope", "scope statement",
    *(f"{job} ({runner})" for job in ("evidence", "cli", "runtime health", "fixtures")
      for runner in ("ubuntu-latest", "macos-15")),
)


def file_under(root, value):
    if not isinstance(value, str) or not value:
        return None
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    candidate = root / relative
    return candidate if (
        candidate.resolve().is_relative_to(root.resolve()) and not candidate.is_symlink()
        and candidate.is_file() and candidate.stat().st_size > 0
    ) else None


def json_report(root, name):
    report = file_under(root, name)
    return json.loads(report.read_text(encoding="utf-8")) if report else None


def validate_ci(ci, root, revision):
    if not isinstance(ci, dict):
        return ["missing GitHub Actions run and job reports"]
    run = json_report(root, ci.get("runReport"))
    jobs = json_report(root, ci.get("jobsReport"))
    if not isinstance(run, dict) or not isinstance(jobs, dict):
        return ["missing GitHub Actions run and job reports"]
    run_id = run.get("id")
    repository = run.get("repository")
    if (
        type(run_id) is not int or run_id < 1 or not isinstance(repository, dict)
        or repository.get("full_name") != REPOSITORY or run.get("name") != "verify"
        or run.get("head_sha") != revision or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("html_url") != f"https://github.com/{REPOSITORY}/actions/runs/{run_id}"
    ):
        return ["verify workflow has no successful run for the exact candidate SHA"]
    rows = jobs.get("jobs")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        return ["missing GitHub Actions job list"]
    errors = []
    for name in VERIFY_JOBS:
        matching = [row for row in rows if row.get("name") == name]
        if len(matching) != 1:
            errors.append(f"CI {name}: expected one completed job")
            continue
        job = matching[0]
        if (
            job.get("status") != "completed" or job.get("conclusion") != "success"
            or job.get("run_id") != run_id or job.get("head_sha") != revision
        ):
            errors.append(f"CI {name}: missing successful result for this run and SHA")
    return errors


def validate(manifest, matrix, revision, manifest_root, evidence_root):
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or manifest.get("version") != VERSION:
        return ["unrecognized v0.1.0-alpha.1 release manifest"]
    errors = []
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None or manifest.get("candidate") != revision:
        errors.append("release manifest has no matching candidate commit")
    supported = manifest.get("supported")
    platform = supported[0] if isinstance(supported, list) and len(supported) == 1 else None
    if not isinstance(platform, dict) or not (
        platform.get("platform") == TARGET and platform.get("architecture") == "arm64"
        and platform.get("backend") == BACKEND and platform.get("runtime") == RUNTIME
        and re.fullmatch(r"\d+\.\d+(?:\.\d+)?", str(platform.get("osVersion")))
        and re.fullmatch(r"[0-9A-Z]+[a-z]?", str(platform.get("osBuild")))
    ):
        errors.append("record one verified macOS Apple Silicon version and build")
        platform = None

    errors.extend(validate_native(matrix, revision, lambda name: bool(file_under(evidence_root, name)),
                                  {TARGET: BACKEND}))
    rows = matrix.get("qualification") if isinstance(matrix, dict) else None
    if platform and isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict) or row.get("verdict") != "PASS":
                continue
            if (
                any(row.get(key) != platform[key] for key in (
                    "osVersion", "osBuild", "architecture", "runtime",
                )) or type(row.get("exitCode")) is not int
                or not isinstance(row.get("hostObservation"), str) or not row["hostObservation"].strip()
            ):
                errors.append(f"{row.get('id')}: incomplete native observation for the selected build")

    artifact = manifest.get("artifact")
    checksum = artifact.get("sha256") if isinstance(artifact, dict) else None
    checks = manifest.get("checks")
    seen = Counter()
    if isinstance(checks, list):
        for row in checks:
            if not isinstance(row, dict) or row.get("id") not in CHECKS:
                errors.append("unrecognized release check")
                continue
            check = row["id"]
            seen[check] += 1
            verdict = row.get("verdict")
            if verdict != "PASS":
                errors.append(f"{check}: {verdict} ({row.get('reason', 'no reason')})")
            elif row.get("commit") != revision or not file_under(manifest_root, row.get("evidence")):
                errors.append(f"{check}: missing evidence for the candidate SHA")
            elif check in ARTIFACT_CHECKS and (
                checksum is None or row.get("artifactSha256") != checksum
            ):
                errors.append(f"{check}: evidence does not identify the installed archive")
    for check in CHECKS:
        if seen[check] != 1:
            errors.append(f"{check}: expected one release check")

    archive = file_under(manifest_root, ARTIFACT)
    if not isinstance(artifact, dict) or artifact.get("path") != ARTIFACT or archive is None:
        errors.append("versioned candidate archive unavailable")
    else:
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != checksum:
                errors.append("candidate archive checksum mismatch")
    errors.extend(validate_ci(manifest.get("ci"), manifest_root, revision))
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--matrix", type=Path, default=REPORT)
    parser.add_argument("--revision", default="HEAD")
    args = parser.parse_args()
    try:
        revision = subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--verify", "--end-of-options",
             f"{args.revision}^{{commit}}"],
            text=True,
        ).strip()
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        matrix = json.loads(args.matrix.read_text(encoding="utf-8"))["alphaQualification"]
        errors = validate(manifest, matrix, revision, args.manifest.parent, args.matrix.parent)
    except (KeyError, OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        errors = [str(error)]
    if errors:
        print("External v0.1.0-alpha.1 release FAIL", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"External v0.1.0-alpha.1 candidate PASS for {revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
