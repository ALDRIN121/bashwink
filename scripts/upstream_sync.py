#!/usr/bin/env python3
"""Bashwink upstream sync report.

Compares the pinned OpenCode baseline against a chosen upstream revision and produces a
compatibility report. It never merges, rebases, pushes or writes to the upstream repo —
the manual release gate depends on a human reading this report first.

Usage:
    python3 scripts/upstream_sync.py --repo <path-to-opencode-clone> [--target v2.4.0]
    python3 scripts/upstream_sync.py --repo <clone> --target origin/dev --format json
    python3 scripts/upstream_sync.py --repo <clone> --offline --format json  # baseline only

Exit codes:
    0  report produced, no breaking extension-surface changes detected
    1  report produced and flagged breaking changes (still a successful run)
    2  the script itself could not run (bad path, bad git state, network failure)

Why a script and not a GitHub Action: the release gate must be runnable against a local
clone during development, and it must fail closed on an unreadable repository rather
than silently reporting "no changes".
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Extension surfaces Bashwink depends on. A change here is a compatibility event and is
# what makes the report actionable rather than a raw diff.
WATCHED_PATHS = (
    "packages/plugin/src/promise/",
    "packages/plugin/src/effect/",
    "packages/plugin/package.json",
    "packages/core/src/plugin/",
    "packages/core/src/tool/",
    "packages/cli/src/commands/commands.ts",
    "packages/schema/src/config/",
    "packages/schema/src/tool.ts",
    "packages/sdk/src/",
)

# Public entry points whose signature changes break compiled plugins.
BREAKING_MARKERS = (
    "export function",
    "export const",
    "export interface",
    "export type",
    "export class",
)


def git(repo: Path, *args: str) -> str:
    """Run a git command, raising a readable error instead of returning empty output."""
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


@dataclass
class Report:
    repo: str
    baseline_sha: str
    baseline_describe: str
    target_ref: str
    target_sha: str = ""
    target_describe: str = ""
    pinned_version: str = ""
    target_version: str = ""
    commits_behind: int = 0
    total_files_changed: int = 0
    watched: dict[str, list[str]] = field(default_factory=dict)
    breaking: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    verdict: str = "UNKNOWN"


def package_version(repo: Path, rev: str) -> str:
    try:
        raw = git(repo, "show", f"{rev}:package.json")
    except RuntimeError:
        return ""
    match = re.search(r'"version"\s*:\s*"([^"]+)"', raw)
    return match.group(1) if match else ""


def resolve_ref(repo: Path, ref: str) -> str:
    for candidate in (f"{ref}^{{commit}}", f"refs/tags/{ref}^{{commit}}", f"origin/{ref}^{{commit}}"):
        try:
            return git(repo, "rev-parse", candidate)
        except RuntimeError:
            continue
    raise RuntimeError(f"cannot resolve ref {ref!r} in {repo}")


def build_report(repo: Path, target_ref: str, offline: bool) -> Report:
    baseline = git(repo, "rev-parse", "HEAD")
    report = Report(
        repo=str(repo),
        baseline_sha=baseline,
        baseline_describe=git(repo, "describe", "--tags", "--always", baseline),
        target_ref=target_ref,
        pinned_version=package_version(repo, baseline),
    )

    if offline:
        report.notes.append("offline mode: target revision not resolved")
        report.verdict = "BASELINE_ONLY"
        return report

    target = resolve_ref(repo, target_ref)
    report.target_sha = target
    report.target_describe = git(repo, "describe", "--tags", "--always", target)
    report.target_version = package_version(repo, target)

    if target == baseline:
        report.notes.append("target equals the pinned baseline; nothing to sync")
        report.verdict = "UP_TO_DATE"
        return report

    try:
        report.commits_behind = int(git(repo, "rev-list", "--count", f"{baseline}..{target}"))
    except RuntimeError:
        report.commits_behind = -1
        report.notes.append("target is not a descendant of the baseline (diverged history)")

    names = git(repo, "diff", "--name-only", f"{baseline}..{target}")
    changed = [line for line in names.splitlines() if line.strip()]
    report.total_files_changed = len(changed)

    for watched in WATCHED_PATHS:
        hits = [path for path in changed if path.startswith(watched)]
        if hits:
            report.watched[watched] = hits

    # A watched-path change is only breaking if a public declaration line changed.
    for watched, files in report.watched.items():
        for path in files:
            diff = git(repo, "diff", "--unified=0", f"{baseline}..{target}", "--", path)
            for line in diff.splitlines():
                if not line.startswith(("+", "-")):
                    continue
                if line.startswith(("+++", "---")):
                    continue
                body = line[1:].strip()
                if any(body.startswith(marker) for marker in BREAKING_MARKERS):
                    report.breaking.append(f"{path}: {line[0]}{body}")
                    break

    if report.breaking:
        report.verdict = "REVIEW_REQUIRED"
        report.notes.append(
            "public declarations changed on a watched extension surface; "
            "compile and run the plugin test suite before accepting the sync",
        )
    elif report.watched:
        report.verdict = "LOW_RISK"
        report.notes.append("watched surfaces changed without public declaration edits")
    else:
        report.verdict = "NO_EXTENSION_IMPACT"
        report.notes.append("no watched extension surface changed")

    return report


def render_markdown(report: Report) -> str:
    lines = [
        "# Bashwink upstream sync report",
        "",
        f"- Repository: `{report.repo}`",
        f"- Baseline: `{report.baseline_sha[:12]}` ({report.baseline_describe}), package version `{report.pinned_version or '?'}`",
        f"- Target: `{report.target_ref}`"
        + (f" -> `{report.target_sha[:12]}` ({report.target_describe}), version `{report.target_version or '?'}`" if report.target_sha else ""),
        f"- Commits ahead of baseline: {report.commits_behind}",
        f"- Files changed: {report.total_files_changed}",
        f"- **Verdict: {report.verdict}**",
        "",
    ]
    if report.watched:
        lines += ["## Watched extension surfaces changed", ""]
        for surface, files in sorted(report.watched.items()):
            lines.append(f"### `{surface}`")
            for path in files:
                lines.append(f"- `{path}`")
            lines.append("")
    if report.breaking:
        lines += ["## Public declaration changes (review these)", "", "```diff"]
        lines += report.breaking
        lines += ["```", ""]
    if report.notes:
        lines += ["## Notes", ""]
        lines += [f"- {note}" for note in report.notes]
        lines.append("")
    lines += [
        "## Manual gate",
        "",
        "This report does not merge, rebase or publish anything. To accept an update:",
        "",
        "1. Read the declaration changes above.",
        "2. Run the upstream suite and the Bashwink plugin suite on the target revision.",
        "3. Run `fixtures/reset.sh --check` and the evidence chain test.",
        "4. Update `UPSTREAM_BASELINE.md` with the new SHA, then commit.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Produce a Bashwink upstream compatibility report.")
    parser.add_argument("--repo", required=True, help="path to the OpenCode clone")
    parser.add_argument("--target", default="origin/dev", help="tag, branch or SHA to compare against")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--offline", action="store_true", help="report the baseline only; resolve no target")
    parser.add_argument("--out", default=None, help="write the report here instead of stdout")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    if not (repo / ".git").exists():
        print(f"error: {repo} is not a git repository", file=sys.stderr)
        return 2

    try:
        report = build_report(repo, args.target, args.offline)
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    body = json.dumps(asdict(report), indent=2) if args.format == "json" else render_markdown(report)
    if args.out:
        Path(args.out).write_text(body + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(body)

    return 1 if report.verdict == "REVIEW_REQUIRED" else 0


if __name__ == "__main__":
    sys.exit(main())
