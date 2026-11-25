<#
.SYNOPSIS
  Native Windows ConPTY terminal end-to-end test for standalone Bashwink (0.2.0-alpha.1).
.DESCRIPTION
  Uses Win32 CreatePseudoConsole + a local System.Net.HttpListener loopback mock server to test:
    1. Clean tarball install into a temporary npm global prefix
    2. First launch setup ignoring ambient OPENAI_API_KEY, cancel setup (0 requests, no partial file),
       then save local loopback endpoint (0 requests before task submission)
    3. Workspace trust approval, diff preview + edit approval, command execution with host warning,
       and independent `node --test` verification
    4. Ctrl+C (`\x03`) task cancellation inside ConPTY
    5. Clean `/exit` and `npm uninstall -g bashwink` preserving user profile data
#>
param(
  [string]$Tarball = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($Tarball)) {
  $Tarball = Join-Path $RepoRoot "build\standalone\bashwink-0.2.0-alpha.1.tgz"
}
if (-not (Test-Path $Tarball)) {
  node (Join-Path $PSScriptRoot "build.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Failed to build standalone tarball." }
}

$ConPtySource = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class ConPtySession : IDisposable {
  private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
  private const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential)]
  private struct COORD {
    public short X;
    public short Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, int nSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern void ClosePseudoConsole(IntPtr hPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CreateProcessW(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFOEX lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  private IntPtr hPC = IntPtr.Zero;
  private PROCESS_INFORMATION procInfo;
  private SafeFileHandle inputWriteHandle;
  private SafeFileHandle outputReadHandle;
  private StreamWriter writer;
  private readonly StringBuilder transcript = new StringBuilder();
  private readonly object lockObj = new object();
  private Thread readerThread;
  private volatile bool reading = true;
  private int cursor = 0;

  public ConPtySession(string commandLine, string workingDirectory, short cols, short rows) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = true;

    SafeFileHandle inputRead;
    SafeFileHandle outputWrite;
    if (!CreatePipe(out inputRead, out inputWriteHandle, ref sa, 0) ||
        !CreatePipe(out outputReadHandle, out outputWrite, ref sa, 0)) {
      throw new InvalidOperationException("CreatePipe failed: " + Marshal.GetLastWin32Error());
    }

    COORD size = new COORD { X = cols, Y = rows };
    int hr = CreatePseudoConsole(size, inputRead, outputWrite, 0, out hPC);
    inputRead.Dispose();
    outputWrite.Dispose();
    if (hr != 0) throw new InvalidOperationException("CreatePseudoConsole failed: 0x" + hr.ToString("X"));

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrList = Marshal.AllocHGlobal(attrSize);
    try {
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
        throw new InvalidOperationException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      }
      if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
        throw new InvalidOperationException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
      }

      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.lpAttributeList = attrList;

      if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workingDirectory, ref si, out procInfo)) {
        throw new InvalidOperationException("CreateProcessW failed: " + Marshal.GetLastWin32Error());
      }
    } finally {
      DeleteProcThreadAttributeList(attrList);
      Marshal.FreeHGlobal(attrList);
    }

    writer = new StreamWriter(new FileStream(inputWriteHandle, FileAccess.Write, 4096, false), new UTF8Encoding(false)) { AutoFlush = true };
    readerThread = new Thread(ReadLoop) { IsBackground = true };
    readerThread.Start();
  }

  private void ReadLoop() {
    byte[] buffer = new byte[4096];
    using (FileStream fs = new FileStream(outputReadHandle, FileAccess.Read, 4096, false)) {
      while (reading) {
        try {
          int read = fs.Read(buffer, 0, buffer.Length);
          if (read <= 0) break;
          string chunk = Encoding.UTF8.GetString(buffer, 0, read);
          lock (lockObj) {
            transcript.Append(chunk);
          }
        } catch {
          break;
        }
      }
    }
  }

  public void WaitFor(string text, int timeoutMs) {
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < deadline) {
      lock (lockObj) {
        string current = transcript.ToString();
        int idx = current.IndexOf(text, cursor, StringComparison.Ordinal);
        if (idx >= 0) {
          cursor = idx + text.Length;
          return;
        }
      }
      Thread.Sleep(25);
    }
    throw new TimeoutException(string.Format("Timed out waiting for '{0}'. Transcript:\n{1}", text, Transcript));
  }

  public void Send(string text) {
    writer.Write(text);
  }

  public void Resize(short cols, short rows) {
    if (hPC != IntPtr.Zero) ResizePseudoConsole(hPC, new COORD { X = cols, Y = rows });
  }

  public int WaitForExit(int timeoutMs) {
    uint wait = WaitForSingleObject(procInfo.hProcess, (uint)timeoutMs);
    if (wait != 0) {
      TerminateProcess(procInfo.hProcess, 1);
      throw new TimeoutException("Process did not exit within timeout.\n" + Transcript);
    }
    uint code;
    GetExitCodeProcess(procInfo.hProcess, out code);
    Thread.Sleep(100);
    return (int)code;
  }

  public string Transcript {
    get {
      lock (lockObj) { return transcript.ToString(); }
    }
  }

  public void Dispose() {
    reading = false;
    try { if (writer != null) writer.Dispose(); } catch { }
    try { if (hPC != IntPtr.Zero) ClosePseudoConsole(hPC); hPC = IntPtr.Zero; } catch { }
    try { if (procInfo.hThread != IntPtr.Zero) CloseHandle(procInfo.hThread); } catch { }
    try { if (procInfo.hProcess != IntPtr.Zero) CloseHandle(procInfo.hProcess); } catch { }
  }
}
"@

Add-Type -TypeDefinition $ConPtySource -Language CSharp

$Root = Join-Path ([IO.Path]::GetTempPath()) ("bw-win-conpty-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$Prefix = Join-Path $Root "prefix"
$HomeDir = Join-Path $Root "home"
$BwHome = Join-Path $HomeDir ".bashwink"
$RepoDir = Join-Path $Root "repo"
New-Item -ItemType Directory -Force -Path $Prefix, $HomeDir, $RepoDir | Out-Null

$OldPrefix = $env:npm_config_prefix
$OldHome = $env:BASHWINK_HOME
$OldOpenAi = $env:OPENAI_API_KEY
$OldPath = $env:PATH

# Start loopback HTTP mock server using System.Net.HttpListener inside PowerShell runspace
$Port = Get-Random -Minimum 49200 -Maximum 60000
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/v1/")
$Listener.Start()

$ServerState = [hashtable]::Synchronized(@{ Scenario = "fix"; Turn = 0; Count = 0 })

$Runspace = [runspacefactory]::CreateRunspace()
$Runspace.Open()
$Runspace.SessionStateProxy.SetVariable("Listener", $Listener)
$Runspace.SessionStateProxy.SetVariable("State", $ServerState)
$PsServer = [powershell]::Create()
$PsServer.Runspace = $Runspace
[void]$PsServer.AddScript({
  while ($Listener.IsListening) {
    try {
      $Ctx = $Listener.GetContext()
      $Reader = New-Object System.IO.StreamReader($Ctx.Request.InputStream)
      $Body = $Reader.ReadToEnd()
      $State.Count += 1
      $State.Turn += 1
      $t = $State.Turn
      $s = $State.Scenario
      $json = ""
      if ($s -eq "fix") {
        if ($t -eq 1) {
          $json = '{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"e1","type":"function","function":{"name":"edit_file","arguments":"{\"path\":\"sum.js\",\"oldText\":\"a - b\",\"newText\":\"a + b\"}"}}]}}]}'
        } elseif ($t -eq 2) {
          $json = '{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"node\",\"args\":[\"--test\",\"sum.test.js\"]}"}}]}}]}'
        } else {
          $json = '{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Fixed and verified."}}]}'
        }
      } elseif ($s -eq "cancel_cmd") {
        if ($t -eq 1) {
          $json = '{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"cc1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"node\",\"args\":[\"-e\",\"setInterval(()=>{},1000)\"]}"}}]}}]}'
        } else {
          $json = '{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"cancelled"}}]}'
        }
      }
      $Bytes = [Text.Encoding]::UTF8.GetBytes($json)
      $Ctx.Response.StatusCode = 200
      $Ctx.Response.ContentType = "application/json"
      $Ctx.Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
      $Ctx.Response.OutputStream.Close()
    } catch {
      break
    }
  }
})
$ServerAsync = $PsServer.BeginInvoke()

try {
  $env:npm_config_prefix = $Prefix
  $env:BASHWINK_HOME = $BwHome
  $env:OPENAI_API_KEY = "sk-dummy-windows-1234567890"
  $env:PATH = "$Prefix;$env:PATH"

  & npm.cmd install -g $Tarball --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install -g failed" }
  $BashwinkCmd = Join-Path $Prefix "bashwink.cmd"
  if (-not (Test-Path $BashwinkCmd)) { throw "Missing $BashwinkCmd" }

  Set-Content -Path (Join-Path $RepoDir "sum.js") -Value "export function sum(a, b) { return a - b; }`n"
  Set-Content -Path (Join-Path $RepoDir "sum.test.js") -Value "import test from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('adds', () => assert.equal(sum(2, 3), 5));`n"

  # 1. Launch into CLI banner, open /model, cancel setup once (0 requests, no standalone.json), /exit
  $s1 = New-Object ConPtySession ("`"$BashwinkCmd`""), $RepoDir, 100, 30
  try {
    $s1.WaitFor("Model    none configured", 15000)
    $s1.WaitFor("bashwink (no model)> ", 15000)
    $s1.Send("/model`r`n")
    $s1.WaitFor("Select provider [1-48 or id] (or 'cancel'):", 15000)
    $s1.Send("cancel`r`n")
    $s1.WaitFor("bashwink (no model)> ", 15000)
    $s1.Send("/exit`r`n")
    $c1 = $s1.WaitForExit(15000)
    if ($c1 -ne 0) { throw "Cancelled setup returned exit $c1" }
  } finally {
    $s1.Dispose()
  }
  if ($ServerState.Count -ne 0) { throw "Expected 0 requests after cancelled setup, got $($ServerState.Count)" }
  if (Test-Path (Join-Path $BwHome "standalone.json")) { throw "Cancelled setup left standalone.json behind" }

  # 2. Launch -> /model -> custom local preset -> trust -> approve edit + command -> Ctrl+C cancel -> /exit
  $ServerState.Scenario = "fix"
  $ServerState.Turn = 0
  $s2 = New-Object ConPtySession ("`"$BashwinkCmd`""), $RepoDir, 100, 30
  try {
    $s2.WaitFor("bashwink (no model)> ", 15000)
    $s2.Send("`r`n")
    $s2.WaitFor("Select provider [1-48 or id] (or 'cancel'):", 15000)
    $s2.Send("10`r`n")
    $s2.WaitFor("Endpoint URL", 15000)
    $s2.Send("http://127.0.0.1:$Port/v1`r`n")
    $s2.WaitFor("Model ID", 15000)
    $s2.Send("win-local-model`r`n")
    $s2.WaitFor("Choose [1/2/3] (or 'cancel'):", 15000)
    $s2.Send("3`r`n")
    $s2.WaitFor("Save and use this model? [y/N]", 15000)
    $s2.Send("y`r`n")
    $s2.WaitFor("bashwink> ", 15000)
    if ($ServerState.Count -ne 0) { throw "Outbound requests fired before task submission ($($ServerState.Count))" }
    $s2.Resize(80, 24)
    $s2.Send("fix sum`r`n")
    $s2.WaitFor("Trust this workspace for interactive edit/command approvals? [y/N]", 15000)
    $s2.Send("y`r`n")
    $s2.WaitFor("Apply this change? [y/N]", 15000)
    $s2.Send("y`r`n")
    $s2.WaitFor("Run this command? [y/N]", 15000)
    $s2.Send("y`r`n")
    $s2.WaitFor("Outcome   completed", 15000)
    $s2.WaitFor("bashwink> ", 15000)

    # Cancel a slow command with Ctrl+C (\u0003)
    $ServerState.Scenario = "cancel_cmd"
    $ServerState.Turn = 0
    $s2.Send("run slow command`r`n")
    $s2.WaitFor("Run this command? [y/N]", 15000)
    $s2.Send("y`r`n")
    Start-Sleep -Milliseconds 300
    $s2.Send([string][char]3)
    $s2.WaitFor("Outcome   cancelled", 15000)
    $s2.WaitFor("> ", 15000)
    $s2.Send("/exit`r`n")
    $c2 = $s2.WaitForExit(15000)
    if ($c2 -ne 0) { throw "Interactive ConPTY session returned exit $c2" }
  } finally {
    $s2.Dispose()
  }

  Push-Location $RepoDir
  try {
    & node --test sum.test.js
    if ($LASTEXITCODE -ne 0) { throw "Independent Windows node --test sum.test.js failed" }
  } finally {
    Pop-Location
  }

  # 3. Uninstall and verify profile preservation
  & npm.cmd uninstall -g bashwink
  if ($LASTEXITCODE -ne 0) { throw "npm uninstall -g bashwink failed" }
  if (Test-Path $BashwinkCmd) { throw "bashwink.cmd still exists after uninstall" }
  if (-not (Test-Path (Join-Path $BwHome "standalone.json"))) { throw "standalone.json missing after uninstall" }

  Write-Host "PASS: Windows native ConPTY E2E verified (setup cancel, 0 pre-submit requests, edit approval, command execution, Ctrl+C cancel, uninstall)."
} finally {
  $env:npm_config_prefix = $OldPrefix
  $env:BASHWINK_HOME = $OldHome
  $env:OPENAI_API_KEY = $OldOpenAi
  $env:PATH = $OldPath
  try { $Listener.Stop(); $Listener.Close() } catch { }
  try { $PsServer.Dispose(); $Runspace.Close() } catch { }
  if (Test-Path $Root) { Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue }
}
