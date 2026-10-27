param(
    [string] $HelperPath = (Join-Path $PSScriptRoot '..\assets\update-helper.ps1'),
    [string] $RunRoot = (Join-Path ([IO.Path]::GetTempPath()) ('sdstudio-update-smoke-' + [Guid]::NewGuid().ToString('N')))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = [Text.UTF8Encoding]::new($false)
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[string]]::new()
$appId = 'io.example.sdstudio.smoke'
$ownership = '.cupcake-app-files.json'
$HelperPath = [IO.Path]::GetFullPath($HelperPath)
$RunRoot = [IO.Path]::GetFullPath($RunRoot)
[void] [IO.Directory]::CreateDirectory($RunRoot)

# Observe only the tested helper's real native error dialog. This keeps the
# production helper unchanged and lets an unattended Windows job acknowledge it.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public sealed class UpdateDialogObserver : IDisposable {
  private delegate void WinEventProc(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] private struct Message {
    public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam;
    public uint Time; public Point Position; public uint Private;
  }
  [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  private readonly uint processId;
  private readonly Thread worker;
  private readonly ManualResetEvent ready = new ManualResetEvent(false);
  private readonly WinEventProc callback;
  private uint workerId;
  private Exception failure;
  private int closedCount;
  public int ClosedCount { get { return Interlocked.CompareExchange(ref closedCount, 0, 0); } }
  public string LastTitle { get; private set; }
  public UpdateDialogObserver(int process) {
    processId = (uint)process;
    callback = OnEvent;
    worker = new Thread(Run);
    worker.IsBackground = true;
    worker.SetApartmentState(ApartmentState.STA);
    worker.Start();
    ready.WaitOne();
    if (failure != null) throw failure;
  }
  private void Run() {
    workerId = GetCurrentThreadId();
    IntPtr hook = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, callback, processId, 0, 0);
    if (hook == IntPtr.Zero) { failure = new Win32Exception(); ready.Set(); return; }
    ready.Set();
    try {
      Message message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
        TranslateMessage(ref message); DispatchMessage(ref message);
      }
    } finally { UnhookWinEvent(hook); }
  }
  private void OnEvent(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time) {
    if (obj != 0 || child != 0 || window == IntPtr.Zero) return;
    StringBuilder name = new StringBuilder(64);
    GetClassName(window, name, name.Capacity);
    if (name.ToString() != "#32770") return;
    StringBuilder title = new StringBuilder(256);
    GetWindowText(window, title, title.Capacity);
    LastTitle = title.ToString();
    Interlocked.Increment(ref closedCount);
    PostMessage(window, 0x0010, UIntPtr.Zero, IntPtr.Zero);
  }
  public void Dispose() {
    PostThreadMessage(workerId, 0x0012, UIntPtr.Zero, IntPtr.Zero);
    worker.Join(); ready.Dispose();
  }
}
'@

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Write-Text([string] $FilePath, [string] $Text) {
    [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($FilePath))
    [IO.File]::WriteAllText($FilePath, $Text, $utf8)
}

function Hash([string] $FilePath) {
    return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Build-Fixture([string] $Version, [string] $Destination) {
    $namespace = 'Fixture' + [Guid]::NewGuid().ToString('N')
    $source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
namespace $namespace {
  public class Program {
    public static void Main(string[] args) {
      if (args.Length > 0 && args[0] == "hold") {
        Console.WriteLine(Process.GetCurrentProcess().Id);
        Console.Out.Flush();
        Console.ReadLine();
        return;
      }
      if (args.Length > 1 && args[0] == "wrapper") {
        ProcessStartInfo info = new ProcessStartInfo(args[1], "hold");
        info.UseShellExecute = false;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.CreateNoWindow = true;
        using (Process child = Process.Start(info)) {
          Console.WriteLine(child.StandardOutput.ReadLine());
          Console.Out.Flush();
          Console.ReadLine();
          child.StandardInput.WriteLine("exit");
          child.StandardInput.Flush();
          child.WaitForExit();
        }
        return;
      }
      string pipeName = Environment.GetEnvironmentVariable("SDSTUDIO_UPDATE_SMOKE_PIPE");
      using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out)) {
        pipe.Connect();
        using (StreamWriter writer = new StreamWriter(pipe)) {
          writer.WriteLine("$Version|" + AppDomain.CurrentDomain.BaseDirectory);
          writer.Flush();
        }
      }
    }
  }
}
"@
    Add-Type -TypeDefinition $source -OutputAssembly $Destination -OutputType ConsoleApplication
}

function Start-Fixture([string] $Executable, [string] $Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
    $process = [Diagnostics.Process]::Start($info)
    [void] $ownedProcesses.Add($process)
    return $process
}

function Manifest([string] $Directory, [string[]] $Files, [string] $Channel = 'private') {
    $value = [ordered] @{ schema = 1; appId = $appId; channel = $Channel; executable = 'Studio.exe'; files = $Files }
    Write-Text (Join-Path $Directory $ownership) ($value | ConvertTo-Json -Depth 5)
}

function Folder-Fixture([string] $Name, [bool] $Collision = $false) {
    $caseRoot = Join-Path $RunRoot $Name
    $installed = Join-Path $caseRoot 'installed'
    $new = Join-Path $caseRoot 'new'
    [void] [IO.Directory]::CreateDirectory($installed)
    [void] [IO.Directory]::CreateDirectory($new)
    [IO.File]::Copy($script:oldBinary, (Join-Path $installed 'Studio.exe'))
    [IO.File]::Copy($script:newBinary, (Join-Path $new 'Studio.exe'))
    Write-Text (Join-Path $installed 'resources\old.txt') 'old-owned-file'
    Write-Text (Join-Path $installed 'zz-lock.txt') 'old-locked-file'
    Write-Text (Join-Path $installed 'personal\keep.txt') 'personal-data'
    Write-Text (Join-Path $installed 'user-data\project.json') '{"prompt":"keep all data"}'
    Write-Text (Join-Path $new 'resources\new.txt') 'new-owned-file'
    Write-Text (Join-Path $new 'zz-new.txt') 'new-owned-later-file'
    Manifest $installed @('Studio.exe', 'resources/old.txt', 'zz-lock.txt')
    $newFiles = @('Studio.exe', 'resources/new.txt', 'zz-new.txt')
    if ($Collision) {
        Write-Text (Join-Path $new 'personal\keep.txt') 'must-not-overwrite'
        $newFiles += 'personal/keep.txt'
    }
    Manifest $new $newFiles
    $artifact = Join-Path $caseRoot 'release.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($new, $artifact)
    $main = Start-Fixture (Join-Path $installed 'Studio.exe') 'hold'
    $line = $main.StandardOutput.ReadLine()
    if ([string]::IsNullOrEmpty($line)) {
        throw ('Fixture did not start: ' + $main.StandardError.ReadToEnd())
    }
    return [pscustomobject] @{
        Root = $caseRoot; Installed = $installed; Artifact = $artifact; Main = $main
        MainId = [int] $line; MainExecutable = (Join-Path $installed 'Studio.exe'); Kind = 'folder'
        Target = $installed; WorkspaceRoot = (Join-Path $installed 'user-data\.updates\private')
    }
}

function Start-Helper([object] $Fixture, [string] $HashOverride = '') {
    $workspace = Join-Path $Fixture.WorkspaceRoot ('install-' + [Guid]::NewGuid().ToString('N'))
    [void] [IO.Directory]::CreateDirectory($workspace)
    $scriptPath = Join-Path $workspace 'update-helper.ps1'
    [IO.File]::Copy($HelperPath, $scriptPath)
    $artifactHash = Hash $Fixture.Artifact
    if ($HashOverride) { $artifactHash = $HashOverride }
    $plan = [ordered] @{
        schema = 1; channel = 'private'; kind = $Fixture.Kind
        artifact = @{ path = $Fixture.Artifact; sha256 = $artifactHash; size = ([IO.FileInfo] $Fixture.Artifact).Length }
        target = @{ path = $Fixture.Target; appId = $appId; executable = 'Studio.exe' }
        workspace = $workspace
        mainProcess = @{ pid = $Fixture.MainId; executablePath = $Fixture.MainExecutable }
    }
    $planPath = Join-Path $workspace 'plan.json'
    Write-Text $planPath ($plan | ConvertTo-Json -Depth 6)
    $pipeName = 'sdstudio-update-' + [Guid]::NewGuid().ToString('N')
    $pipe = [IO.Pipes.NamedPipeServerStream]::new($pipeName, [IO.Pipes.PipeDirection]::In)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" -PlanPath "' + $planPath + '"'
    $info.WorkingDirectory = $workspace
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['SDSTUDIO_UPDATE_SMOKE_PIPE'] = $pipeName
    $process = [Diagnostics.Process]::Start($info)
    [void] $ownedProcesses.Add($process)
    return [pscustomobject] @{ Process = $process; Workspace = $workspace; Pipe = $pipe }
}

function Ready([object] $Run) {
    $line = $Run.Process.StandardOutput.ReadLine()
    if ($line -cne 'READY') {
        $Run.Process.StandardInput.Close()
        $Run.Process.WaitForExit()
        throw ('Expected READY, received: ' + $line + ' ' + $Run.Process.StandardError.ReadToEnd())
    }
}

function Apply([object] $Run, [object] $Fixture) {
    $Run.Process.StandardInput.WriteLine('APPLY')
    $Run.Process.StandardInput.Flush()
    $ack = $Run.Process.StandardOutput.ReadLine()
    Assert ($ack -ceq 'APPLY-ACCEPTED') ('Expected APPLY-ACCEPTED, received: ' + $ack)
    Assert ((Hash $Fixture.MainExecutable) -ceq (Hash $script:oldBinary)) 'Files changed while the application was still running.'
    $Fixture.Main.StandardInput.WriteLine('exit')
    $Fixture.Main.StandardInput.Flush()
    $Fixture.Main.WaitForExit()
    $Run.Process.WaitForExit()
    return ([IO.File]::ReadAllText((Join-Path $Run.Workspace 'result.json'), $utf8) | ConvertFrom-Json)
}

function Relaunched([object] $Run, [string] $Version, [string] $Directory) {
    $Run.Pipe.WaitForConnection()
    $reader = [IO.StreamReader]::new($Run.Pipe)
    try { $actual = $reader.ReadLine() } finally { $reader.Dispose(); $Run.Pipe.Dispose() }
    Assert ($actual -ceq ($Version + '|' + $Directory.TrimEnd('\') + '\')) ('Wrong relaunch: ' + $actual)
}

try {
    $script:oldBinary = Join-Path $RunRoot 'old-fixture.exe'
    $script:newBinary = Join-Path $RunRoot 'new-fixture.exe'
    Build-Fixture 'old' $script:oldBinary
    Build-Fixture 'new' $script:newBinary

    $fixture = Folder-Fixture 'cancel'
    $run = Start-Helper $fixture
    Ready $run
    $run.Process.StandardInput.Close()
    $run.Process.WaitForExit()
    Assert ($run.Process.ExitCode -eq 0) 'Cancel did not exit normally.'
    Assert (-not $fixture.Main.HasExited) 'Cancel stopped the running application.'
    Assert ((Hash $fixture.MainExecutable) -ceq (Hash $script:oldBinary)) 'Cancel changed the installed executable.'
    Assert ([IO.File]::Exists((Join-Path $fixture.Installed 'resources\old.txt'))) 'Cancel removed an installed file.'
    $run.Pipe.Dispose()
    $fixture.Main.StandardInput.WriteLine('exit'); $fixture.Main.StandardInput.Flush(); $fixture.Main.WaitForExit()
    [void] $results.Add('cancel-without-APPLY preserves the running app and files')

    $fixture = Folder-Fixture 'folder-success'
    $run = Start-Helper $fixture
    Ready $run
    $result = Apply $run $fixture
    Assert ($run.Process.ExitCode -eq 0 -and $result.state -ceq 'installed') ('Folder update failed: ' + $result.message)
    Assert ((Hash $fixture.MainExecutable) -ceq (Hash $script:newBinary)) 'The new executable was not installed.'
    Assert (-not [IO.File]::Exists((Join-Path $fixture.Installed 'resources\old.txt'))) 'A stale app-owned file survived.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'resources\new.txt')) -ceq 'new-owned-file') 'The new app-owned file is wrong.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'personal\keep.txt')) -ceq 'personal-data') 'Personal data was changed.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'user-data\project.json')) -ceq '{"prompt":"keep all data"}') 'Nested selected storage was changed.'
    Assert (-not [IO.File]::Exists($fixture.Artifact)) 'The successful download was not cleaned up.'
    Relaunched $run 'new' $fixture.Installed
    [void] $results.Add('folder update replaces owned files, removes stale files, preserves nested data, and relaunches the new app')

    $fixture = Folder-Fixture 'folder-rollback'
    $run = Start-Helper $fixture
    Ready $run
    # A personal file appears AFTER READY at a newly introduced app path. The
    # executable and another app file sort before this path, so this exercises
    # rollback of new files and old backups without a production test hook.
    Write-Text (Join-Path $fixture.Installed 'zz-new.txt') 'external-arrival'
    $dialog = [UpdateDialogObserver]::new($run.Process.Id)
    try { $result = Apply $run $fixture } finally { $dialog.Dispose() }
    Assert ($run.Process.ExitCode -eq 1 -and $result.state -ceq 'failed' -and $result.rolledBack) 'The publication failure did not roll back.'
    Assert ($result.message -notlike '*Recovery:*') ('Rollback could not relaunch: ' + $result.message)
    Assert ($result.message -like '*zz-new.txt*') ('The intended publication failure was not reached: ' + $result.message)
    Assert ($dialog.ClosedCount -eq 1) 'The actual post-quit failure did not show exactly one error dialog.'
    Assert ($dialog.LastTitle -ceq 'SDStudio 업데이트') 'The failure dialog had the wrong title.'
    Assert ((Hash $fixture.MainExecutable) -ceq (Hash $script:oldBinary)) 'Rollback did not restore the executable.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'resources\old.txt')) -ceq 'old-owned-file') 'Rollback did not restore stale owned content.'
    Assert (-not [IO.File]::Exists((Join-Path $fixture.Installed 'resources\new.txt'))) 'Rollback left a newly published application file behind.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'zz-new.txt')) -ceq 'external-arrival') 'Rollback changed the personal file that arrived after READY.'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'personal\keep.txt')) -ceq 'personal-data') 'Rollback changed personal data.'
    Relaunched $run 'old' $fixture.Installed
    [void] $results.Add('a real publication collision removes the newly published EXE, restores old files, preserves late personal files, and relaunches the old app')

    foreach ($rejection in @('hash', 'collision')) {
        $fixture = Folder-Fixture ('reject-' + $rejection) ($rejection -eq 'collision')
        if ($rejection -eq 'hash') { $run = Start-Helper $fixture ('0' * 64) } else { $run = Start-Helper $fixture }
        $line = $run.Process.StandardOutput.ReadLine()
        Assert ($line.StartsWith('ERROR ')) ('Expected rejection, got: ' + $line)
        $run.Process.WaitForExit()
        Assert ($run.Process.ExitCode -eq 1) 'Invalid input did not fail.'
        Assert (-not $fixture.Main.HasExited) 'Invalid input stopped the app.'
        Assert ((Hash $fixture.MainExecutable) -ceq (Hash $script:oldBinary)) 'Invalid input changed the app.'
        Assert ([IO.File]::ReadAllText((Join-Path $fixture.Installed 'personal\keep.txt')) -ceq 'personal-data') 'A personal file collision was overwritten.'
        $fixture.Main.StandardInput.WriteLine('exit'); $fixture.Main.StandardInput.Flush(); $fixture.Main.WaitForExit()
        $run.Pipe.Dispose()
        [void] $results.Add($rejection + ' rejection happens before READY and leaves the app intact')
    }

    $caseRoot = Join-Path $RunRoot 'portable'
    $installed = Join-Path $caseRoot 'program'
    $extracted = Join-Path $caseRoot 'extracted'
    [void] [IO.Directory]::CreateDirectory($installed)
    [void] [IO.Directory]::CreateDirectory($extracted)
    $wrapperPath = Join-Path $installed 'Studio.exe'
    $mainPath = Join-Path $extracted 'Studio.exe'
    [IO.File]::Copy($script:oldBinary, $wrapperPath)
    [IO.File]::Copy($script:oldBinary, $mainPath)
    $artifact = Join-Path $caseRoot 'release.exe'
    [IO.File]::Copy($script:newBinary, $artifact)
    $wrapper = Start-Fixture $wrapperPath ('wrapper "' + $mainPath + '"')
    $mainId = [int] $wrapper.StandardOutput.ReadLine()
    [void] $ownedProcesses.Add([Diagnostics.Process]::GetProcessById($mainId))
    $fixture = [pscustomobject] @{
        Root = $caseRoot; Installed = $installed; Artifact = $artifact; Main = $wrapper
        MainId = $mainId; MainExecutable = $mainPath; Kind = 'portable'; Target = $wrapperPath
        WorkspaceRoot = (Join-Path $caseRoot 'chosen-data\.updates\private')
    }
    $run = Start-Helper $fixture
    Ready $run
    $result = Apply $run $fixture
    Assert ($run.Process.ExitCode -eq 0 -and $result.state -ceq 'installed') ('Portable update failed: ' + $result.message)
    Assert ((Hash $wrapperPath) -ceq (Hash $script:newBinary)) 'The portable launcher was not replaced.'
    Assert ((Hash $mainPath) -ceq (Hash $script:oldBinary)) 'The extracted executable was replaced instead of the portable launcher.'
    Relaunched $run 'new' $installed
    [void] $results.Add('portable update waits for the matching wrapper and replaces/relaunches the original EXE')

    [pscustomobject] @{ passed = $results.Count; cases = $results.ToArray(); root = $RunRoot } | ConvertTo-Json -Depth 5
} finally {
    foreach ($ownedProcess in $ownedProcesses) {
        try { if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); $ownedProcess.WaitForExit() } } catch { }
        $ownedProcess.Dispose()
    }
}
