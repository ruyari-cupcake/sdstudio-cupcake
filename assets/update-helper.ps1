param([Parameter(Mandatory = $true)][string] $PlanPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ownershipFile = '.cupcake-app-files.json'
$stageRoot = $null
$workspace = $null
$resultPath = $null
$applyAccepted = $false
$processesStopped = $false
$processHandles = [Collections.Generic.List[Diagnostics.Process]]::new()
$backups = [Collections.Generic.List[object]]::new()
$published = [Collections.Generic.List[string]]::new()
$createdDirectories = [Collections.Generic.List[string]]::new()
$launchPath = $null
$artifactPath = $null

function Same-Path([string] $Left, [string] $Right) {
    return [StringComparer]::OrdinalIgnoreCase.Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd('\'),
        [IO.Path]::GetFullPath($Right).TrimEnd('\'))
}

function Is-Within([string] $Candidate, [string] $Root) {
    $normalized = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    return (Same-Path $normalized $Root) -or $normalized.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Full-Path([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
        throw 'An absolute update path is required.'
    }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-NoLinks([string] $Value) {
    $current = Full-Path $Value
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Update paths cannot contain links: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Relative-Path([string] $Value) {
    if ([string]::IsNullOrEmpty($Value) -or $Value.Contains('\') -or
        [IO.Path]::IsPathRooted($Value) -or $Value -match '[:<>"|?*]') {
        throw 'Invalid file path in the application manifest.'
    }
    foreach ($part in $Value.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or
            $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            throw 'Invalid file path in the application manifest.'
        }
        foreach ($character in $part.ToCharArray()) {
            if ([int] $character -lt 32) { throw 'Invalid file path in the application manifest.' }
        }
    }
    return $Value
}

function Read-Manifest([string] $Text, [object] $Plan) {
    $value = $Text | ConvertFrom-Json
    if ($value.schema -ne 1 -or $value.files -isnot [Array] -or $value.appId -cne $Plan.target.appId -or
        $value.channel -cne $Plan.channel -or $value.executable -cne $Plan.target.executable) {
        throw 'The application manifest belongs to a different app or update channel.'
    }
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = [Collections.Generic.List[string]]::new()
    foreach ($entry in @($value.files)) {
        if ($entry -isnot [string]) { throw 'Invalid application file list.' }
        $relative = Relative-Path $entry
        if ($relative -ieq $ownershipFile -or -not $set.Add($relative)) {
            throw 'The application file list contains a repeated path.'
        }
        [void] $files.Add($relative)
    }
    if (-not $set.Contains($value.executable)) { throw 'The executable is missing from the application file list.' }
    # A file cannot simultaneously be the parent directory of another file.
    foreach ($relative in $files) {
        $parts = $relative.Split('/')
        if ($parts.Length -gt 1) {
            for ($index = 1; $index -lt $parts.Length; $index++) {
                if ($set.Contains(($parts[0..($index - 1)] -join '/'))) {
                    throw 'An application file conflicts with a directory.'
                }
            }
        }
    }
    return [pscustomobject] @{ Files = $files; FileSet = $set }
}

function Ensure-Directory([string] $Directory, [bool] $Track = $false) {
    Assert-NoLinks $Directory
    if ([IO.Directory]::Exists($Directory)) { return }
    if ([IO.File]::Exists($Directory)) { throw "A file occupies an update directory: $Directory" }
    $parent = [IO.Path]::GetDirectoryName($Directory)
    if ($parent -and -not [IO.Directory]::Exists($parent)) { Ensure-Directory $parent $Track }
    [void] [IO.Directory]::CreateDirectory($Directory)
    if ($Track) { [void] $createdDirectories.Add($Directory) }
}

function Write-Result([string] $State, [string] $Message = '', [bool] $RolledBack = $false) {
    if (-not $resultPath) { return }
    $result = [ordered] @{
        schema = 1
        state = $State
        message = $Message
        rolledBack = $RolledBack
        backupPath = $stageRoot
        executable = $launchPath
    }
    $temporary = $resultPath + '.tmp'
    [IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Depth 5), $utf8)
    if ([IO.File]::Exists($resultPath)) {
        # A .NET string argument receives an empty string for PowerShell $null.
        # File.Replace needs an actual null to omit its backup filename.
        [IO.File]::Replace($temporary, $resultPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
        [IO.File]::Move($temporary, $resultPath)
    }
}

function Open-OwnedProcess([int] $ProcessId, [string] $ExpectedExecutable) {
    $ownedProcess = [Diagnostics.Process]::GetProcessById($ProcessId)
    try {
        # Materialize the OS handle while the owner is still alive. WaitForExit
        # later refers to this process instance, not a recycled numeric PID.
        $null = $ownedProcess.Handle
        $null = $ownedProcess.StartTime
        if (-not (Same-Path $ownedProcess.MainModule.FileName $ExpectedExecutable)) {
            throw 'The process does not match the running application.'
        }
        if ($ownedProcess.HasExited) { throw 'The running application has already exited.' }
        return $ownedProcess
    } catch {
        $ownedProcess.Dispose()
        throw
    }
}

function Open-PortableWrapper([int] $MainProcessId, [string] $Executable) {
    $visited = [Collections.Generic.HashSet[int]]::new()
    $currentId = $MainProcessId
    while ($currentId -gt 0 -and $visited.Add($currentId)) {
        $record = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $currentId"
        if (-not $record) { break }
        $parentId = [int] $record.ParentProcessId
        if ($parentId -le 0 -or $visited.Contains($parentId)) { break }
        $parentRecord = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $parentId"
        if (-not $parentRecord) { break }
        if ($parentRecord.ExecutablePath -and (Same-Path $parentRecord.ExecutablePath $Executable)) {
            return Open-OwnedProcess $parentId $Executable
        }
        $currentId = $parentId
    }
    throw 'The portable application launcher could not be identified.'
}

function Backup-File([string] $Source, [string] $Backup) {
    Assert-NoLinks $Source
    if ([IO.Directory]::Exists($Source)) { throw "An application file is now a directory: $Source" }
    if (-not [IO.File]::Exists($Source)) { return }
    Ensure-Directory ([IO.Path]::GetDirectoryName($Backup))
    [IO.File]::Move($Source, $Backup)
    [void] $backups.Add([pscustomobject] @{ Source = $Source; Backup = $Backup })
}

function Publish-File([string] $Source, [string] $Destination) {
    Assert-NoLinks $Destination
    if (Test-Path -LiteralPath $Destination) { throw "An existing file would be overwritten: $Destination" }
    Ensure-Directory ([IO.Path]::GetDirectoryName($Destination)) $true
    [IO.File]::Move($Source, $Destination)
    [void] $published.Add($Destination)
}

function Restore-PreviousFiles {
    for ($index = $published.Count - 1; $index -ge 0; $index--) {
        [IO.File]::Delete($published[$index])
    }
    for ($index = $backups.Count - 1; $index -ge 0; $index--) {
        $entry = $backups[$index]
        [IO.File]::Move($entry.Backup, $entry.Source)
    }
    for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
        $directory = $createdDirectories[$index]
        if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
            [IO.Directory]::Delete($directory)
        }
    }
}

function Start-Application {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $launchPath
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($launchPath)
    $startInfo.UseShellExecute = $true
    $launched = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $launched) { throw 'The application could not be restarted.' }
    $launched.Dispose()
}

function Remove-OwnPreparation {
    # Keep the tiny result record for the next launch. These paths are all owned
    # by this operation; downloaded/user files are never recursively removed.
    foreach ($fileName in @('plan.json', 'update-helper.ps1')) {
        $ownPath = [IO.Path]::Combine($workspace, $fileName)
        if ([IO.File]::Exists($ownPath)) { [IO.File]::Delete($ownPath) }
    }
}

function Show-InstallFailure([bool] $Restored, [bool] $Restarted) {
    Add-Type -AssemblyName System.Windows.Forms
    if ($Restarted) {
        $message = '업데이트를 마치지 못했어요. 이전 버전으로 다시 열었어요.'
    } elseif ($Restored) {
        $message = '업데이트를 마치지 못했어요. 이전 파일은 복원했어요. 프로그램을 다시 열어주세요.'
    } else {
        $message = "업데이트를 마치지 못했어요.`n이전 파일은 여기에 보관했어요:`n$stageRoot"
    }
    [void] [Windows.Forms.MessageBox]::Show($message, 'SDStudio 업데이트',
        [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
}

try {
    $planFile = Full-Path $PlanPath
    Assert-NoLinks $planFile
    $plan = [IO.File]::ReadAllText($planFile, $utf8) | ConvertFrom-Json
    if ($plan.schema -ne 1 -or @('public', 'private') -cnotcontains $plan.channel -or
        @('portable', 'folder') -cnotcontains $plan.kind -or -not $plan.target.appId) {
        throw 'Invalid update plan.'
    }
    $workspace = Full-Path $plan.workspace
    if (-not (Same-Path ([IO.Path]::GetDirectoryName($planFile)) $workspace) -or
        -not (Same-Path $planFile ([IO.Path]::Combine($workspace, 'plan.json'))) -or
        -not (Same-Path $PSCommandPath ([IO.Path]::Combine($workspace, 'update-helper.ps1')))) {
        throw 'The update helper must run from its own prepared workspace.'
    }
    Assert-NoLinks $workspace
    $resultPath = [IO.Path]::Combine($workspace, 'result.json')
    $artifactPath = Full-Path $plan.artifact.path
    $target = Full-Path $plan.target.path
    $relativeExecutable = Relative-Path $plan.target.executable
    if ([IO.Path]::GetExtension($relativeExecutable) -ine '.exe') { throw 'Invalid application executable.' }
    Assert-NoLinks $artifactPath
    Assert-NoLinks $target
    if ($plan.kind -eq 'portable') {
        if ([IO.Path]::GetFileName($target) -cne $relativeExecutable -or -not [IO.File]::Exists($target)) {
            throw 'The portable update target does not match the installed executable.'
        }
        $launchPath = $target
        if (Is-Within $workspace ([IO.Path]::GetDirectoryName($plan.mainProcess.executablePath))) {
            throw 'The helper cannot run inside the portable extraction directory.'
        }
    } else {
        if (-not [IO.Directory]::Exists($target)) { throw 'The installed application folder is missing.' }
        $launchPath = [IO.Path]::Combine($target, $relativeExecutable.Replace('/', '\'))
    }
    if (Same-Path $artifactPath $launchPath) { throw 'The downloaded artifact cannot be the running executable.' }
    $main = Open-OwnedProcess ([int] $plan.mainProcess.pid) (Full-Path $plan.mainProcess.executablePath)
    [void] $processHandles.Add($main)
    if ($plan.kind -eq 'portable') {
        [void] $processHandles.Add((Open-PortableWrapper $main.Id $launchPath))
    } elseif (-not (Same-Path $plan.mainProcess.executablePath $launchPath)) {
        throw 'The folder update target is not the running application.'
    }

    $stageParent = [IO.Path]::GetDirectoryName($target)
    if ([string]::IsNullOrEmpty($stageParent)) { $stageParent = $target }
    $stageRoot = [IO.Path]::Combine($stageParent, '.cupcake-update-' + [Guid]::NewGuid().ToString('N'))
    Ensure-Directory $stageRoot
    $payloadRoot = [IO.Path]::Combine($stageRoot, 'payload')
    $backupRoot = [IO.Path]::Combine($stageRoot, 'backup')
    Ensure-Directory $payloadRoot

    $artifactStream = [IO.File]::Open($artifactPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($artifactStream.Length -ne [long] $plan.artifact.size -or $plan.artifact.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
            throw 'The update file size does not match the release.'
        }
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($hasher.ComputeHash($artifactStream)).Replace('-', '').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        if ($hash -cne ([string] $plan.artifact.sha256).ToLowerInvariant()) { throw 'The update file hash does not match the release.' }
        $artifactStream.Position = 0
        if ($plan.kind -eq 'portable') {
            $nextExecutable = [IO.Path]::Combine($payloadRoot, $relativeExecutable)
            $output = [IO.File]::Open($nextExecutable, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $artifactStream.CopyTo($output); $output.Flush($true) }
            finally { $output.Dispose() }
        } else {
            $oldManifestPath = [IO.Path]::Combine($target, $ownershipFile)
            Assert-NoLinks $oldManifestPath
            if (-not [IO.File]::Exists($oldManifestPath)) {
                throw 'This folder needs the first update-capable release installed before it can update itself.'
            }
            $oldManifest = Read-Manifest ([IO.File]::ReadAllText($oldManifestPath, $utf8)) $plan
            $archive = [IO.Compression.ZipArchive]::new($artifactStream, [IO.Compression.ZipArchiveMode]::Read, $true)
            try {
                $entries = [Collections.Generic.Dictionary[string, IO.Compression.ZipArchiveEntry]]::new([StringComparer]::OrdinalIgnoreCase)
                foreach ($entry in $archive.Entries) {
                    $entryPath = Relative-Path $entry.FullName.TrimEnd('/')
                    if ($entries.ContainsKey($entryPath)) { throw 'The update archive contains a repeated path.' }
                    $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
                    if ($unixType -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) {
                        throw 'The update archive contains a link.'
                    }
                    $entries.Add($entryPath, $entry)
                }
                if (-not $entries.ContainsKey($ownershipFile)) { throw 'The update archive has no application file list.' }
                $reader = [IO.StreamReader]::new($entries[$ownershipFile].Open(), $utf8)
                try { $manifestText = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $newManifest = Read-Manifest $manifestText $plan
                foreach ($entry in $entries.Values) {
                    if ($entry.FullName.EndsWith('/')) { continue }
                    if ($entry.FullName -ine $ownershipFile -and -not $newManifest.FileSet.Contains($entry.FullName)) {
                        throw 'The update archive contains a file outside its application file list.'
                    }
                }
                foreach ($relative in $oldManifest.Files) {
                    $existing = [IO.Path]::Combine($target, $relative.Replace('/', '\'))
                    if (Is-Within $existing $workspace) { throw 'An application file conflicts with the update workspace.' }
                    Assert-NoLinks $existing
                    if ([IO.Directory]::Exists($existing)) { throw 'An application file has become a directory.' }
                }
                foreach ($relative in $newManifest.Files) {
                    if (-not $entries.ContainsKey($relative) -or $entries[$relative].FullName.EndsWith('/')) {
                        throw 'An application file is missing from the update archive.'
                    }
                    $destination = [IO.Path]::Combine($target, $relative.Replace('/', '\'))
                    if (Is-Within $destination $workspace) { throw 'An application file conflicts with the update workspace.' }
                    Assert-NoLinks $destination
                    if (-not $oldManifest.FileSet.Contains($relative) -and (Test-Path -LiteralPath $destination)) {
                        throw "A new application file would replace a personal file: $relative"
                    }
                    $prepared = [IO.Path]::Combine($payloadRoot, $relative.Replace('/', '\'))
                    Ensure-Directory ([IO.Path]::GetDirectoryName($prepared))
                    $inputStream = $entries[$relative].Open()
                    $output = [IO.File]::Open($prepared, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                    try { $inputStream.CopyTo($output); $output.Flush($true) }
                    finally { $inputStream.Dispose(); $output.Dispose() }
                }
                [IO.File]::WriteAllText([IO.Path]::Combine($payloadRoot, $ownershipFile), $manifestText, $utf8)
            } finally { $archive.Dispose() }
        }
    } finally { $artifactStream.Dispose() }

    Write-Result 'ready'
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    $instruction = [Console]::In.ReadLine()
    if ($instruction -cne 'APPLY') {
        Write-Result 'cancelled'
        [IO.Directory]::Delete($stageRoot, $true)
        Remove-OwnPreparation
        exit 0
    }
    [Console]::Out.WriteLine('APPLY-ACCEPTED')
    [Console]::Out.Flush()
    $applyAccepted = $true
    foreach ($ownedProcess in $processHandles) { $ownedProcess.WaitForExit() }
    $processesStopped = $true
    Write-Result 'installing'

    if ($plan.kind -eq 'portable') {
        Backup-File $launchPath ([IO.Path]::Combine($backupRoot, $relativeExecutable))
        Publish-File $nextExecutable $launchPath
    } else {
        foreach ($relative in ($oldManifest.Files | Sort-Object)) {
            Backup-File ([IO.Path]::Combine($target, $relative.Replace('/', '\'))) ([IO.Path]::Combine($backupRoot, $relative.Replace('/', '\')))
        }
        Backup-File $oldManifestPath ([IO.Path]::Combine($backupRoot, $ownershipFile))
        foreach ($relative in ($newManifest.Files | Sort-Object)) {
            Publish-File ([IO.Path]::Combine($payloadRoot, $relative.Replace('/', '\'))) ([IO.Path]::Combine($target, $relative.Replace('/', '\')))
        }
        Publish-File ([IO.Path]::Combine($payloadRoot, $ownershipFile)) $oldManifestPath
    }
    Write-Result 'installed'
    Start-Application
    # A cleanup failure must never roll back an already started new application.
    try {
        [IO.File]::Delete($artifactPath)
        [IO.Directory]::Delete($stageRoot, $true)
        Remove-OwnPreparation
    } catch {
        Write-Result 'installed' ('Temporary update files could not be removed: ' + $_.Exception.Message)
    }
    exit 0
} catch {
    $failure = $_.Exception.Message
    $restored = $false
    $restarted = $false
    if ($processesStopped) {
        try {
            Restore-PreviousFiles
            $restored = $true
            Start-Application
            $restarted = $true
        } catch {
            $failure += ' Recovery: ' + $_.Exception.Message
        }
    }
    try { Write-Result 'failed' $failure $restored } catch { }
    if ($processesStopped) {
        try { Show-InstallFailure $restored $restarted } catch { }
    }
    if (-not $applyAccepted) {
        [Console]::Out.WriteLine('ERROR ' + (@{ message = $failure } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        if ($stageRoot -and [IO.Directory]::Exists($stageRoot)) {
            try { [IO.Directory]::Delete($stageRoot, $true) } catch { }
        }
    }
    exit 1
} finally {
    foreach ($ownedProcess in $processHandles) { $ownedProcess.Dispose() }
}
