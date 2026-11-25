# Bashwink 0.1.0-alpha.1 (private alpha)

An evidence-first AI coding CLI that drives a pinned OpenCode runtime. This is a **private alpha for invited
testers**; it is not published to the public npm registry and must not be.

```sh
npm install -g ./bashwink-0.1.0-alpha.1.tgz
cd my-project
bashwink
```

**Mode: STANDARD.** Bashwink runs on your computer with your user's access. It asks before each shell command and
file edit, refuses file access outside the project, network tools and code execution, and records what ran. It is **not an operating-system sandbox**: a command you
approve can do anything you can do. Work in a Git repository, keep a backup, and read each approval.

Requirements: Node.js (for `npm`; only Node 22 has been tested, 18 or newer is expected to work), and one of macOS
(Apple Silicon or Intel), Linux (x64 or arm64), or Windows 11 x64. These are the platforms the package is built for, not
a claim that each is qualified: `share/doc/KNOWN_LIMITATIONS.md` says what has and has not been run.
**Windows on ARM64 is not supported.** The tarball ships its locally built FFmpeg-free OpenCode engine
(`libexec/opencode` or `libexec/opencode.exe` with `engine-manifest.json`) and installs the pinned Bun 1.4.4
runtime from npm (`bun`). No external `@opencode/cli` package is required. If Bun or the verified local engine
manifest is missing, Bashwink names it and exits with status 1 or 127.

First steps: `bashwink --version`, `bashwink doctor`, then the guide in `share/doc/ALPHA_TESTER_GUIDE.md`
(inside the installed package directory; `npm root -g` shows where). Known limits: `share/doc/KNOWN_LIMITATIONS.md`.
Uninstall: `npm uninstall -g bashwink` (your settings and run records stay; see the guide to remove them).

`bashwink --sandbox` (an optional isolated VM) is **not part of this package** and fails closed: it starts nothing
and falls back to nothing.
