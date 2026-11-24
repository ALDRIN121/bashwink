#!/usr/bin/env python3
"""Measure process creation for a trusted, inert fixture under the production no-fork rule."""
from pathlib import Path
import re
import subprocess
import tempfile

from run import ROOT


def main():
    source = (ROOT / "packages/bw-cli/src/native-offline.ts").read_text()
    rules = re.search(r"const RECOVERY_RULES = `([^`]+)`", source)
    assert rules, "production no-fork rules not found"
    with tempfile.TemporaryDirectory(prefix="bw-native-process-", dir="/private/tmp") as temporary:
        root = Path(temporary).resolve()
        fixture = root / "probe"
        c = root / "probe.c"
        c.write_text(r'''
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int successful(pid_t child) {
    int status = 0;
    return waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

int main(int argc, char **argv) {
    if (argc != 2) return 5;
    if (!strcmp(argv[1], "nested-control")) {
        if (setsid() < 0 || getsid(0) != getpid()) return 6;
        pid_t inner = fork();
        if (inner == 0) _exit(0);
        return inner > 0 && successful(inner) ? 0 : 7;
    }
    int denied = !strcmp(argv[1], "deny");
    pid_t child = fork();
    int fork_error = child < 0 ? errno : 0;
    if (child == 0) _exit(0);
    if (child > 0 && !successful(child)) return 8;
    char *arguments[] = {argv[0], "nested-control", NULL};
    int spawn_error = posix_spawn(&child, argv[0], NULL, NULL, arguments, environ);
    if (spawn_error == 0 && !successful(child)) return 9;
    printf("fork errno=%d, posix_spawn errno=%d\n", fork_error, spawn_error);
    return (fork_error == (denied ? EPERM : 0) && spawn_error == (denied ? EPERM : 0)) ? 0 : 10;
}
''')
        subprocess.run(["/usr/bin/clang", "-Wall", "-Werror", str(c), "-o", str(fixture)], check=True)
        common = '''
(version 1)
(deny default)
(allow process-fork)
(allow process-exec (literal (param "PROBE")))
(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib")
                  (literal "/private") (literal "/private/tmp") (subpath (param "ROOT")))
'''
        for mode, policy in [("positive", common), ("deny", common + rules.group(1))]:
            result = subprocess.run([
                "/usr/bin/sandbox-exec", "-D", f"ROOT={root}", "-D", f"PROBE={fixture}",
                "-p", policy, str(fixture), mode,
            ], capture_output=True, text=True, timeout=8)
            assert result.returncode == 0, (mode, result.returncode, result.stdout, result.stderr)
            print(mode, result.stdout.strip())
        print("PASS: the inert child created a new session and nested descendant in the positive control; the file-only policy denied fork and spawn at the OS")


if __name__ == "__main__":
    main()
