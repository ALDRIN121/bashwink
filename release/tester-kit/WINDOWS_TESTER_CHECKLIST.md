# Windows 11 x64: manual checklist (about 20 minutes)

Run `windows-qualify.ps1` first (see README.md). This list covers what a script cannot see: the screen, the keyboard
and the terminal. Mark each line **OK**, **PROBLEM** (say what you saw) or **SKIPPED** (say why). Do not disable any
Windows security feature for this test. If Windows SmartScreen or antivirus blocks something, stop and report exactly
what it said; do not work around it.

The script removes its temporary project. Create a separate throwaway Git repository for these checks. For checks that
need a live model, connect your own provider and set a spending limit, or mark those checks **SKIPPED**.

## A. Install and start
- [ ] `npm.cmd install -g .\bashwink-0.1.0-alpha.1.tgz` finishes without errors (note any warning text).
- [ ] In **Windows Terminal (PowerShell)**, `cd` into the throwaway project and run `bashwink.cmd`. The interactive screen appears.
- [ ] Repeat in **cmd.exe** and, if you use it, **VS Code's terminal**.
- [ ] The first screen asks whether to trust the folder and states that standard mode is **not a sandbox**.
- [ ] After you answer, the mode label `[STANDARD - native, not a sandbox]` is visible and stays visible while you work.

## B. The screen
- [ ] Text is readable; box-drawing characters and arrows are not shown as `?` or boxes.
- [ ] Resize the window while a response is streaming: the layout recovers, nothing is left garbled.
- [ ] Paste a multi-line prompt: it arrives intact.
- [ ] Type or paste a non-ASCII word (for example `Grüße 用户`): it appears correctly in the prompt.
- [ ] Mouse wheel / PageUp scrolls the conversation.

## C. Permissions (read every prompt before answering)
- [ ] Ask it to run `node test.js`: a permission prompt names the **exact command** before anything runs. Deny once: nothing runs.
- [ ] Ask it to create a file in the project, then ask it to create one **outside** the project (e.g. on the Desktop):
      the second is refused. Check the Desktop: no file appeared.
- [ ] Decline the trust question in a second throwaway folder: the session is read-only and says so.

## D. Keyboard and cancellation
- [ ] While a response is streaming, press **Ctrl+C** once: the response stops, the prompt returns or the program exits cleanly.
- [ ] Press Ctrl+C again / `exit`: you are back at the shell prompt with no error text left on screen.
- [ ] Start a long response and **close the terminal window**. Open Task Manager: no `opencode.exe` or `bun.exe` remains running
      after about 10 seconds. (If one does, note its name and PID; do not leave it running.)

## E. Sessions
- [ ] Quit and start `bashwink.cmd --continue` in the same folder. The previous conversation is there.
- [ ] `bashwink.cmd session list` lists it.

## F. Paths
- [ ] Run from a folder whose path contains a **space** and one with a **non-ASCII character**: both work.
- [ ] If you have a project on another drive letter (`D:\`) or reached through a **junction/symlink**, run there: edits land in the real folder.

## G. Remove
- [ ] `npm.cmd uninstall -g bashwink` removes the `bashwink` command. Your project and the folders under
      `%USERPROFILE%\.config\bashwink` and `%USERPROFILE%\.local\share\bashwink` are untouched (they are yours to delete).

## What to send back
1. The `bashwink-windows-qualification-*.json` file from the script (it contains no key).
2. This checklist with each line marked.
3. For any PROBLEM: the exact command, what you expected, what happened, and a screenshot with private text covered.
