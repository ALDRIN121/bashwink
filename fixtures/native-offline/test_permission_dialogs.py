#!/usr/bin/env python3
"""Regression test for approval detection in the PTY fixtures.

The failing capture of the legacy guest-TUI fixture contained two permission dialogs but the text
"Allow once" only once, because the terminal renderer repaints changed cells only and the second
dialog reused the first one's option row. Dialogs must be counted from OpenCode's own state
events, never from words on the screen.
"""
import unittest

from run import DialogApprover, permission_dialogs

TITLE = b"title=QmFzaHdpbmsgVk0gZml4dHVyZQ=="


def osc(state, kind=None, session=False):
    parts = [b"state=" + state]
    if session:
        parts.append(b"id=ses_df137eaeeffeXYqnYrVJ58ljcT")
    if kind:
        parts.append(b"kind=" + kind)
    parts += [b"app=opencode", TITLE]
    return b"\x1b]7501;" + b":".join(parts) + b"\x1b\\"


def dialog():
    # OpenCode announces each blocked state twice: once without and once with the session id.
    return osc(b"blocked", b"permission") + osc(b"blocked", b"permission", True)


# Sequence recorded in the failing run: working, dialog, (approved) working, dialog, ... clear.
FAILING_RUN = (
    osc(b"idle") + b"Ask anything" + osc(b"working") + b"Permission required" + dialog()
    + b"[Allow once  Allow always  Reject]" + osc(b"working") + osc(b"working", None, True)
    + b"BW_VM_TOOL_1" + dialog() + b"Permission required $ sh check.sh" + osc(b"clear")
)


class PermissionDialogs(unittest.TestCase):
    def test_second_dialog_is_counted_although_its_option_text_never_reappears(self):
        self.assertEqual(FAILING_RUN.count(b"Allow once"), 1)
        self.assertEqual(permission_dialogs(FAILING_RUN), 2)

    def test_one_dialog_announced_twice_is_one_dialog(self):
        self.assertEqual(permission_dialogs(osc(b"working") + dialog()), 1)

    def test_no_dialog_no_count(self):
        self.assertEqual(permission_dialogs(b"hello" + osc(b"working") + osc(b"idle")), 0)

    def test_other_blocked_kinds_are_not_permission_dialogs(self):
        self.assertEqual(permission_dialogs(osc(b"working") + osc(b"blocked", b"question")), 0)

    def test_approver_answers_each_dialog_exactly_once(self):
        sent = []
        approver = DialogApprover(sent.append)
        stream = osc(b"working") + dialog()
        approver.poll(stream)
        approver.poll(stream)  # the same console again: no second answer
        self.assertEqual(sent, [b"\r"])
        approver.poll(stream + osc(b"working") + dialog())
        self.assertEqual(sent, [b"\r", b"\r"])


if __name__ == "__main__":
    unittest.main()
