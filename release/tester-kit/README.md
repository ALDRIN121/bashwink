# Bashwink private alpha: tester kit

Place `bashwink-0.1.0-alpha.1.tgz`, `SHA256SUMS` and the files from this folder together.

Use a standard user account on **Windows 11 x64**, with Node.js 22, npm, Git, PowerShell and access to the public npm
registry. npm downloads the pinned Bun and OpenCode runtimes. Windows ARM64 is unsupported. This test collects
Windows 11 qualification evidence for the private candidate.

## 1. Verify the tarball and run the script

In PowerShell, run this from the folder containing the tarball.

```powershell
Get-FileHash -Algorithm SHA256 .\bashwink-0.1.0-alpha.1.tgz
Get-Content .\SHA256SUMS
```

Compare the hashes, ignoring letter case. Stop if the checksum file is missing or the hashes differ. Review the script,
then run it with your usual PowerShell settings. If Windows blocks it, report the message.

```powershell
.\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz
```

This check needs no model key. It installs the tarball globally with npm, tests the installed command in a folder with
spaces and non-ASCII characters, tests reinstall and uninstall, and prints the path to the qualification JSON.

## 2. Optional: one bounded run against your own provider

Create a key file only you can read, with a key that has a spending limit at your provider, then:

```powershell
.\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz `
  -KeyFile "$env:USERPROFILE\bashwink-test.key" -BaseUrl https://api.example.com/v1 -Model my-model
```

Pass the key by file path. The script sets limits of 25 requests and 200,000 counted tokens. A request in flight can
take usage over the limit, and the token count excludes cached reads and writes.

## 3. Do the manual checklist

The script uninstalls Bashwink at the end. Reinstall it in the first step of the
[manual checklist](WINDOWS_TESTER_CHECKLIST.md), which covers the screen, permissions, Ctrl+C, closing the terminal,
sessions and paths. Use a disposable Git project. Approved shell commands run with your user account's access.

## 4. Send back

The result `.json` file and the marked checklist. If anything looks wrong, stop and report it; do not try to work around
a security prompt or disable any protection.
