#!/usr/bin/env python3
import copy
import unittest

from verify_native_release import REQUIRED, TARGETS, validate

REV = "a" * 40
POLICY = "b" * 64


def fixture():
    return {
        "schema": 1,
        "advertised": list(TARGETS),
        "qualification": [
            {
                "platform": platform,
                "backend": backend,
                "id": check,
                "verdict": "PASS",
                "commit": REV,
                "policyDigest": POLICY,
                "command": "test command",
                "expected": "expected",
                "observed": "observed",
                "evidence": "fixture.log",
                "reason": "",
            }
            for platform, backend in TARGETS.items()
            for check in REQUIRED
        ],
    }


class NativeReleaseGateTest(unittest.TestCase):
    def test_complete_exact_evidence(self):
        self.assertEqual(validate(fixture(), REV, lambda source: source == "fixture.log"), [])

    def test_evidence_cannot_be_missing_blocked_duplicate_or_stale(self):
        for problem in ("missing", "BLOCKED", "NOT_RUN", "FAIL", "duplicate", "stale", "no-evidence"):
            with self.subTest(problem=problem):
                matrix = fixture()
                first = matrix["qualification"][0]
                if problem == "missing":
                    matrix["qualification"].pop(0)
                elif problem == "duplicate":
                    matrix["qualification"].append(copy.copy(first))
                elif problem == "stale":
                    first["commit"] = "c" * 40
                elif problem == "no-evidence":
                    first["evidence"] = "missing.log"
                else:
                    first.update(verdict=problem, reason="required control unavailable")
                self.assertTrue(validate(matrix, REV, lambda source: source == "fixture.log"))

    def test_unsupported_target_and_platform_mismatch_block_release(self):
        matrix = fixture()
        matrix["advertised"].append("linux-arm64")
        matrix["qualification"][0]["backend"] = "unrestricted"
        self.assertTrue(validate(matrix, REV, lambda source: True))

    def test_probe_records_do_not_replace_required_qualification(self):
        matrix = fixture()
        matrix["observations"] = matrix.pop("qualification")
        matrix["qualification"] = []
        self.assertTrue(validate(matrix, REV, lambda source: True))


if __name__ == "__main__":
    unittest.main()
