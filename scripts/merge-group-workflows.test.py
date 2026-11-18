#!/usr/bin/env python3
"""The `main` merge queue needs every required check to report on the merge_group commit.

A required check that never reports makes the queue remove the PR after check_response_timeout_minutes
(`checks_timed_out`). Text checks only: no YAML dependency, so it runs on a bare runner.
"""
import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def read(name):
    return (WORKFLOWS / name).read_text()


def triggers(text):
    """Top-level keys under `on:`."""
    block = re.search(r"^on:\n((?:[ \t]+.*\n|\n)+)", text, re.M)
    assert block, "no top-level `on:` block"
    return set(re.findall(r"^  ([\w-]+):", block.group(1), re.M))


class CiWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.text = read("ci.yml")

    def test_runs_on_merge_group(self):
        self.assertIn("merge_group", triggers(self.text))

    def test_pr_title_lint_stays_pull_request_only(self):
        # A skipped job satisfies a required check; the queue commit has no PR title to lint.
        self.assertRegex(self.text, r"commit-message:\n\s+if: github\.event_name == 'pull_request'")

    def test_queue_runs_are_never_cancelled(self):
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", self.text)


class ClaWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.text = read("cla.yml")

    def test_runs_on_merge_group(self):
        self.assertIn("merge_group", triggers(self.text))

    def test_cla_assistant_job_reports_without_signing(self):
        self.assertRegex(self.text, r"(?m)^  cla-assistant:")
        # The signing step is gated on a comment or pull_request_target, so it is skipped on merge_group
        # and the job passes: the PR already passed the CLA on its own head.
        step_if = re.search(r"^\s+if: (.*)$", self.text, re.M)
        self.assertIsNotNone(step_if)
        self.assertNotIn("merge_group", step_if.group(1))

    def test_merge_group_job_has_no_checkout_or_extra_secret(self):
        self.assertNotIn("actions/checkout", self.text)
        self.assertEqual(re.findall(r"secrets\.(\w+)", self.text), ["GITHUB_TOKEN"])


if __name__ == "__main__":
    unittest.main()
