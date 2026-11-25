# Bashwink private alpha: tester kit

Files you were sent: `bashwink-0.1.0-alpha.1.tgz`, `SHA256SUMS`, and this folder.

**Requirements (Windows 11 x64):** Node.js 22 or newer with npm, Git, PowerShell. Nothing else: no Python, no WSL, no
Docker. Windows **ARM64 is not supported** by this alpha; on an ARM64 machine the script stops with a clear message.

## 1. Run the script (about 3 minutes, needs no model key)

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz
```

The script is plain text: read it first. It installs the tarball globally with npm, runs the installed command in a
folder whose name contains spaces and non-ASCII characters, tests install/reinstall/uninstall and writes a result file.

## 2. Optional: one bounded run against your own provider

Create a key file only you can read, with a key that has a spending limit at your provider, then:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz `
  -KeyFile "$env:USERPROFILE\bashwink-test.key" -BaseUrl https://api.example.com/v1 -Model my-model
```

The key is passed only as a file path. It is never printed, never put in the config and never written to the result
file. The run is capped at 25 model requests and 200,000 tokens. The owner's own key is never shared with testers.

## 3. Do the manual checklist

`WINDOWS_TESTER_CHECKLIST.md`: screen, permissions, Ctrl+C, closing the terminal, sessions and paths.

## 4. Send back

The result `.json` file and the marked checklist. If anything looks wrong, stop and report it; do not try to work around
a security prompt or disable any protection.
