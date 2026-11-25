<#
.SYNOPSIS
  Qualify a Bashwink private-alpha tarball on a physical Windows 11 x64 machine. Needs only Node.js 22+ and npm.

.DESCRIPTION
  Checks the file you were sent, installs it globally, runs the installed command in a folder whose name contains
  spaces and non-ASCII characters, and writes a result file you send back to the owner. No Python, WSL or Docker.

  It does NOT need a model key. Without one it verifies install, runtime resolution, plugin staging, the refused
  --sandbox, first-run state under your user profile, a Git project path with spaces and Unicode, the trust step,
  and uninstall/reinstall. With -KeyFile it also runs one small bounded coding task against YOUR provider.

  The key is never printed, never passed as an argument and never written to the result file. Use a key with a
  spending limit set at your provider. Windows ARM64 is not supported by this alpha; the script stops there.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\windows-qualify.ps1 -Tarball .\bashwink-0.1.0-alpha.1.tgz `
    -KeyFile "$env:USERPROFILE\bashwink-test.key" -BaseUrl https://api.example.com/v1 -Model my-model
#>
param(
  [Parameter(Mandatory = $true)][string]$Tarball,
  [string]$Sums = "",
  [string]$KeyFile = "",
  [string]$BaseUrl = "",
  [string]$Model = "",
  [string]$Protocol = "openai",
  [string]$Out = ""
)
$ErrorActionPreference = "Continue"
$results = New-Object System.Collections.ArrayList
$script:failed = 0

function Check([string]$name, $ok, [string]$detail = "") {
  $verdict = if ($null -eq $ok) { "NOT_RUN" } elseif ($ok) { "PASS" } else { "FAIL" }
  if ($verdict -eq "FAIL") { $script:failed++ }
  [void]$results.Add([ordered]@{ check = $name; verdict = $verdict; detail = $detail })
  Write-Host ("{0,-8}{1}{2}" -f $verdict, $name, $(if ($detail) { " - $detail" } else { "" }))
}
function Run([string]$exe, [string[]]$arguments, [string]$cwd = "") {
  if ($cwd) { Push-Location $cwd }
  try {
    $text = (& $exe @arguments 2>&1 | Out-String)
    return @{ code = $LASTEXITCODE; text = $text }
  } finally { if ($cwd) { Pop-Location } }
}

Write-Host "Bashwink Windows qualification`n"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$os = Get-CimInstance Win32_OperatingSystem
$info = [ordered]@{
  when = (Get-Date).ToString("s"); windows = $os.Caption; build = $os.BuildNumber; version = $os.Version; arch = $arch
  powershell = $PSVersionTable.PSVersion.ToString(); locale = (Get-Culture).Name; user_is_admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
$node = (& node --version 2>&1 | Out-String).Trim(); $npm = (& npm --version 2>&1 | Out-String).Trim()
$info.node = $node; $info.npm = $npm
$info.avx2_note = "not probed; the OpenCode runtime needs a CPU with AVX2"
$info.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-14}{1}" -f $_.Key, $_.Value) }
Write-Host ""

if ($arch -ne "AMD64") { Check "platform: Windows x64 (AMD64)" $false "this machine reports $arch. Windows ARM64 is not supported by this alpha; stopping."; exit 2 }
Check "platform: Windows x64 (AMD64)" $true "$($os.Caption) build $($os.BuildNumber)"
Check "Node.js 22 or newer is installed" ($node -match "^v(2[2-9]|[3-9]\d)\.") $node

$tgz = (Resolve-Path $Tarball).Path
$actual = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLower()
if (-not $Sums) { $Sums = Join-Path (Split-Path $tgz) "SHA256SUMS" }
if (Test-Path $Sums) {
  $line = Get-Content $Sums | Where-Object { $_ -match [regex]::Escape((Split-Path $tgz -Leaf)) } | Select-Object -First 1
  $expected = if ($line) { ($line -split "\s+")[0].ToLower() } else { "" }
  Check "the tarball matches the published SHA-256" ($expected -eq $actual) "sha256 $actual"
} else { Check "the tarball matches the published SHA-256" $null "no SHA256SUMS next to the tarball; sha256 is $actual - compare it with the owner's message" }

# Built from character codes so the script itself stays ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI).
$unicode = ([string][char]0x00FC) + " " + [char]0x7528 + [char]0x6237
$work = Join-Path $env:TEMP ("Bashwink Test " + $unicode + " " + [guid]::NewGuid().ToString("N").Substring(0, 6))
$project = Join-Path $work ("proj ect " + $unicode)
New-Item -ItemType Directory -Force $project | Out-Null

$install = Run "npm" @("install", "-g", "--no-audit", "--no-fund", $tgz)
Check "npm install -g <tarball> succeeds" ($install.code -eq 0) $(if ($install.code) { $install.text.Substring([Math]::Max(0, $install.text.Length - 300)) } else { "" })
if ($install.code -ne 0) { Write-Host "Install failed; the remaining checks cannot run."; exit 1 }

$version = Run "bashwink" @("--version")
Check "bashwink --version works from PowerShell" ($version.code -eq 0 -and $version.text -match "bashwink 0\.1\.0-alpha\.1") $version.text.Trim()
$cmdVersion = (& cmd /c "bashwink --version 2>&1" | Out-String)
Check "bashwink --version works from cmd.exe" ($cmdVersion -match "bashwink 0\.1\.0-alpha\.1") $cmdVersion.Trim()
$doctor = Run "bashwink" @("doctor") $project
Check "doctor finds the runtimes and the evidence plugin" ($doctor.text -match "OpenCode runtime" -and $doctor.text -match "Bun runtime" -and $doctor.text -match "Evidence plugin") ($doctor.text -split "`n" | Select-String "runtime|plugin" | Select-Object -First 3 | Out-String).Trim()
$sandbox = Run "bashwink" @("--sandbox") $project
Check "--sandbox is refused and starts nothing (exit 3)" ($sandbox.code -eq 3 -and $sandbox.text -match "will not start") "exit $($sandbox.code)"
$mode = Run "bashwink" @("backend") $project
Check "the mode is standard-native (no isolation is claimed)" ($mode.text -match "standard-native" -and $mode.text -match '"filesystemIsolation": false') ""
Check "nothing was written into the project folder" ((Get-ChildItem -Force $project | Measure-Object).Count -eq 0) ""
$paths = $doctor.text
Check "first-run state is under your user profile ($env:USERPROFILE)" ($paths -match [regex]::Escape($env:USERPROFILE) -or (Test-Path (Join-Path $env:USERPROFILE ".config\bashwink")) -or (Test-Path (Join-Path $env:USERPROFILE ".local\share\bashwink"))) ""

# A disposable Git project with a deliberate bug, in a path with spaces and Unicode.
Set-Content -Encoding UTF8 (Join-Path $project "sum.js") "module.exports = (a, b) => a - b`n"
Set-Content -Encoding UTF8 (Join-Path $project "test.js") "const assert = require('assert')`nassert.strictEqual(require('./sum')(2, 3), 5)`nconsole.log('tests passed')`n"
git -C $project init -q 2>&1 | Out-Null
git -C $project config user.name tester; git -C $project config user.email tester@example.invalid; git -C $project config core.autocrlf false
git -C $project add -A 2>&1 | Out-Null; git -C $project commit -q -m baseline 2>&1 | Out-Null
$trust = Run "bashwink" @("trust", $project, "--by", "tester")
Check "trust works for a path with spaces and Unicode" ($trust.code -eq 0 -and $trust.text -match "trusted") $trust.text.Trim()
$before = Run "node" @("test.js") $project
Check "the disposable project fails its test first" ($before.code -ne 0) ""

if ($KeyFile -and $BaseUrl -and $Model) {
  $add = Run "bashwink" @("auth", "add", "qual", "--base-url", $BaseUrl, "--key-file", (Resolve-Path $KeyFile).Path, "--model", "${Model}:${Protocol}:200000:8192")
  Check "auth add with a key file (the key is never printed or stored in the config)" ($add.code -eq 0) ""
  [void](Run "bashwink" @("model", "use", "qual/$Model"))
  $check = Run "bashwink" @("auth", "check", "qual")
  Check "auth check reports the provider can authenticate" ($check.code -eq 0) ($check.text.Trim() -replace "\s+", " ")
  $env:BASHWINK_MAX_REQUESTS = "25"; $env:BASHWINK_MAX_TOKENS = "200000"
  $live = Run "bashwink" @("run", "--auto", "The test in this folder fails (run: node test.js). Fix the bug in sum.js and run the test again.") $project
  Remove-Item Env:BASHWINK_MAX_REQUESTS, Env:BASHWINK_MAX_TOKENS
  Check "the live coding run finished (exit 0)" ($live.code -eq 0) "exit $($live.code)"
  $after = Run "node" @("test.js") $project
  Check "the project's test passes afterwards (checked independently)" ($after.code -eq 0) ""
  $diff = (git -C $project diff --stat | Out-String).Trim()
  Check "only the intended file changed" ($diff -match "sum.js" -and ($diff -split "`n").Count -le 3) $diff
  Check "a usage summary was printed" ($live.text -match "Usage: \d+ model request") ""
  $keyText = (Get-Content -Raw $KeyFile).Trim()
  $hits = @(Get-ChildItem -Recurse -Force -File $work, $env:USERPROFILE\.config\bashwink, $env:USERPROFILE\.local\share\bashwink -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 20MB } | Select-String -SimpleMatch -Quiet -Pattern $keyText -ErrorAction SilentlyContinue)
  Check "the key does not appear in any Bashwink file or the run output" ($hits.Count -eq 0 -and -not $live.text.Contains($keyText)) ""
  [void](Run "bashwink" @("auth", "remove", "qual"))
} else { Check "live coding task (needs -KeyFile -BaseUrl -Model)" $null "skipped: no provider supplied" }

$reinstall = Run "npm" @("install", "-g", "--no-audit", "--no-fund", $tgz)
$again = Run "bashwink" @("--version")
Check "reinstalling over the existing install works" ($reinstall.code -eq 0 -and $again.code -eq 0) ""
$remove = Run "npm" @("uninstall", "-g", "bashwink")
$gone = Run "cmd" @("/c", "bashwink --version 2>&1")
Check "uninstall removes the command" ($remove.code -eq 0 -and $gone.text -notmatch "bashwink 0\.1\.0") ""
Check "uninstall leaves your project alone" (Test-Path (Join-Path $project "sum.js")) ""

if (-not $Out) { $Out = Join-Path (Get-Location) ("bashwink-windows-qualification-" + (Get-Date).ToString("yyyyMMdd-HHmmss") + ".json") }
([ordered]@{ machine = $info; tarball_sha256 = $actual; summary = @{ pass = @($results | Where-Object verdict -eq "PASS").Count; fail = @($results | Where-Object verdict -eq "FAIL").Count; not_run = @($results | Where-Object verdict -eq "NOT_RUN").Count }; checks = $results } | ConvertTo-Json -Depth 6) | ForEach-Object { [System.IO.File]::WriteAllText($Out, $_, (New-Object System.Text.UTF8Encoding $false)) }
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
Write-Host "`nResult file: $Out`nSend that file to the owner. It contains no key. Now do the manual checklist (WINDOWS_TESTER_CHECKLIST.md)."
if ($script:failed -gt 0) { exit 1 } else { exit 0 }
