param([string]$ReportDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$Server = '__POCKET_DRIVE_SERVER__'
Add-Type -AssemblyName System.Net.Http
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Save-Json($Path, $Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), $Utf8)
    try {
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $null) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Clean-Path([string]$Value) {
    $Value = $Value.Trim().Trim('"').Trim("'")
    if ($Value.StartsWith('~')) { $Value = $HOME + $Value.Substring(1) }
    return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Value))
}
function Fingerprint([string]$Path) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Choose an original file, not a link.' }
    $size = $file.Length; $ticks = $file.LastWriteTimeUtc.Ticks
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    $after = Get-Item -LiteralPath $Path -Force
    if ($size -ne $after.Length -or $ticks -ne $after.LastWriteTimeUtc.Ticks) { throw 'Source changed while reading.' }
    return @{ size = $size; modified_ns = $null; sha256 = $hash }
}
function Source-Entry($Path, $Relative, $Kind) {
    $entry = [ordered]@{ source = $Path; relative_path = $Relative; kind = $Kind; upload_id = [Guid]::NewGuid().ToString(); status = 'pending'; attempts = 0; error = '' }
    if ($Kind -eq 'file') {
        try { $entry.fingerprint = Fingerprint $Path }
        catch { $entry.fingerprint = $null; $entry.status = 'failed'; $entry.error = $_.Exception.Message }
    }
    return [pscustomobject]$entry
}
function Find-Sources($Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symbolic links and junctions are skipped; choose the original.' }
    $entries = New-Object System.Collections.Generic.List[object]
    $skipped = New-Object System.Collections.Generic.List[string]
    if (-not $item.PSIsContainer) { $entries.Add((Source-Entry $item.FullName '' 'file')) }
    else {
        $stack = New-Object System.Collections.Stack
        $stack.Push(@{ path = $item.FullName; relative = $item.Name })
        while ($stack.Count) {
            $directory = $stack.Pop()
            $entries.Add((Source-Entry $directory.path $directory.relative 'folder'))
            foreach ($child in Get-ChildItem -LiteralPath $directory.path -Force) {
                if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                    ($child.DirectoryName -eq $ReportDirectory -and $child.Name -like 'pocket-drive-upload-*.json')) { $skipped.Add($child.FullName); continue }
                $relative = $directory.relative + '/' + $child.Name
                if ($child.PSIsContainer) { $stack.Push(@{ path = $child.FullName; relative = $relative }) }
                else { $entries.Add((Source-Entry $child.FullName $relative 'file')) }
            }
            if ($entries.Count + $stack.Count -gt 15000) { throw 'At most 15,000 files/folders are allowed in one job.' }
        }
    }
    return @{ entries = @($entries.ToArray()); skipped = @($skipped.ToArray()) }
}
# Every worker owns its HttpClient and file stream. The key stays in process memory.
$Worker = {
    param($Entry, $Server, $Key, $StateFile, $FolderMode)
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(135)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    function Request($Method, $Route, $Body = $null, $Offset = $null) {
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), ($Server + $Route))
        $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Key)
        if ($Body -is [byte[]]) {
            $request.Content = [System.Net.Http.ByteArrayContent]::new($Body)
            $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/octet-stream')
        } elseif ($null -ne $Body) {
            $request.Content = [System.Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 10 -Compress), $utf8, 'application/json')
        }
        if ($null -ne $Offset) { $request.Headers.Add('Upload-Offset', [string]$Offset) }
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try {
                $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                if (-not $response.IsSuccessStatusCode) {
                    try { $message = ($text | ConvertFrom-Json).error } catch { $message = 'Request failed.' }
                    $error = [Exception]::new("HTTP $([int]$response.StatusCode): $message")
                    $error.Data['status'] = [int]$response.StatusCode
                    throw $error
                }
                return ($text | ConvertFrom-Json)
            } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
    function Hash-Source {
        $file = Get-Item -LiteralPath $Entry.source -Force
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Source is a directory or link.' }
        $size = $file.Length; $ticks = $file.LastWriteTimeUtc.Ticks
        $stream = [IO.File]::OpenRead($file.FullName); $hasher = [Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $hasher.Dispose() }
        $after = Get-Item -LiteralPath $Entry.source -Force
        if ($size -ne $after.Length -or $ticks -ne $after.LastWriteTimeUtc.Ticks) { throw 'Source changed while reading.' }
        return @{ size = $size; sha256 = $hash; ticks = $ticks }
    }
    function Save-Entry {
        $temp = "$StateFile.tmp"
        [IO.File]::WriteAllText($temp, ($Entry | ConvertTo-Json -Depth 20), $utf8)
        if ([IO.File]::Exists($StateFile)) { [IO.File]::Replace($temp, $StateFile, $null) }
        else { [IO.File]::Move($temp, $StateFile) }
    }
    try {
        if ($FolderMode) {
            $tree = (Request 'GET' '/api/folders/tree').folders
            $mapping = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
            foreach ($folder in $tree) {
                $name = [regex]::Replace($folder.name, '[A-Z]', { param($m) $m.Value.ToLowerInvariant() })
                $mapping[([string]$folder.parent_id + '/' + $name)] = $folder.id
            }
            foreach ($folderEntry in $Entry) {
                try {
                    $parent = ''
                    foreach ($name in $folderEntry.relative_path.Split('/')) {
                        $ascii = [regex]::Replace($name, '[A-Z]', { param($m) $m.Value.ToLowerInvariant() })
                        $lookup = $parent + '/' + $ascii
                        if (-not $mapping.ContainsKey($lookup)) {
                            $destination = if ($parent) { $parent } else { 'root' }
                            try { $mapping[$lookup] = (Request 'POST' '/api/folders' @{ name = $name; parent_id = $destination }).id }
                            catch {
                                if ($_.Exception.Data['status'] -ne 409) { throw }
                                foreach ($f in (Request 'GET' '/api/folders/tree').folders) {
                                    $n = [regex]::Replace($f.name, '[A-Z]', { param($m) $m.Value.ToLowerInvariant() })
                                    $mapping[([string]$f.parent_id + '/' + $n)] = $f.id
                                }
                                if (-not $mapping.ContainsKey($lookup)) { throw }
                            }
                        }
                        $parent = $mapping[$lookup]
                    }
                    $folderEntry.status = 'complete'; $folderEntry.error = ''
                } catch { $folderEntry.status = 'failed'; $folderEntry.error = $_.Exception.Message.Replace($Key, '[redacted]') }
            }
            return ,$Entry
        }
        for ($attempt = 0; $attempt -lt 4; $attempt++) {
            $Entry.attempts++; $Entry.status = 'uploading'
            Save-Entry
            try {
                $identity = Hash-Source
                if ($null -eq $Entry.fingerprint) { $Entry.fingerprint = @{ size = $identity.size; modified_ns = $null; sha256 = $identity.sha256 }; Save-Entry }
                if ($identity.size -ne $Entry.fingerprint.size -or $identity.sha256 -ne $Entry.fingerprint.sha256) { throw 'Source changed since this job; start a fresh upload for this file.' }
                $route = '/api/uploads/' + $Entry.upload_id
                try { $status = Request 'GET' $route }
                catch {
                    if ($_.Exception.Data['status'] -ne 404) { throw }
                    $status = Request 'POST' '/api/uploads' @{ id = $Entry.upload_id; name = [IO.Path]::GetFileName($Entry.source); size = $identity.size; mime_type = 'application/octet-stream'; folder_id = 'root'; relative_path = $Entry.relative_path }
                }
                if ($status.busy) { $busy = [Exception]::new('Another request is using this upload.'); $busy.Data['status'] = 409; throw $busy }
                if ($status.status -ne 'complete') {
                    $stream = [IO.File]::OpenRead($Entry.source)
                    try {
                        $offset = [long]$status.offset
                        [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
                        while ($offset -lt $identity.size) {
                            $info = Get-Item -LiteralPath $Entry.source -Force
                            if ($info.Length -ne $identity.size -or $info.LastWriteTimeUtc.Ticks -ne $identity.ticks) { throw 'Source changed during upload.' }
                            $buffer = New-Object byte[] ([int][Math]::Min([long]$status.chunk_size, $identity.size - $offset))
                            $count = $stream.Read($buffer, 0, $buffer.Length)
                            if ($count -ne $buffer.Length) { throw 'Source ended before expected size.' }
                            $status = Request 'PATCH' $route $buffer $offset
                            $offset = [long]$status.offset
                        }
                    } finally { $stream.Dispose() }
                    $current = Hash-Source
                    if ($current.sha256 -ne $identity.sha256 -or $current.size -ne $identity.size) { throw 'Source changed during upload.' }
                    $status = Request 'POST' ($route + '/complete') @{}
                }
                if ($status.file.checksum -ne $identity.sha256) { throw 'Server checksum differs; inspect this upload before retrying.' }
                $Entry | Add-Member -NotePropertyName file_id -NotePropertyValue $status.file.id -Force
                $Entry.status = 'complete'; $Entry.error = ''; Save-Entry
                return $Entry
            } catch {
                $Entry.status = 'failed'; $Entry.error = $_.Exception.Message.Replace($Key, '[redacted]'); Save-Entry
                $code = $_.Exception.Data['status']
                $cause = $_.Exception
                while ($cause.InnerException) { $cause = $cause.InnerException }
                $temporary = $null -eq $code -and ($cause -is [System.Net.Http.HttpRequestException] -or $cause -is [System.Threading.Tasks.TaskCanceledException])
                if ($attempt -eq 3 -or (-not $temporary -and $code -notin @(408,409,429,500,502,503,504))) { return $Entry }
                Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
            }
        }
    } catch {
        if ($FolderMode) {
            foreach ($e in $Entry) { if ($e.status -ne 'complete') { $e.status = 'failed'; $e.error = $_.Exception.Message.Replace($Key, '[redacted]') } }
            return ,$Entry
        }
        $Entry.status = 'failed'; $Entry.error = $_.Exception.Message.Replace($Key, '[redacted]'); Save-Entry
        return $Entry
    } finally { $client.Dispose(); $handler.Dispose() }
}

function Main {
    Write-Host "Pocket Drive native uploader`nServer: $Server`nReports: $ReportDirectory"
    $probe = Join-Path $ReportDirectory ([Guid]::NewGuid().ToString() + '.tmp')
    [IO.File]::WriteAllText($probe, '', $Utf8); Remove-Item -LiteralPath $probe
    $automatic = $env:POCKET_DRIVE_UPLOAD_REPORT -or $env:POCKET_DRIVE_UPLOAD_SOURCE
    if ($automatic) {
        if ($env:POCKET_DRIVE_UPLOAD_REPORT) { $mode = '2'; $target = $env:POCKET_DRIVE_UPLOAD_REPORT }
        else { $mode = '1'; $target = $env:POCKET_DRIVE_UPLOAD_SOURCE }
    }
    else {
        Write-Host '1. Upload a file or folder'; Write-Host '2. Retry or resume from JSON report'
        $mode = Read-Host 'Choose 1 or 2 [1]'; if (-not $mode) { $mode = '1' }
        if ($mode -notin @('1','2')) { throw 'Choose 1 or 2.' }
        Write-Host 'File: C:\Users\Hendry\Documents\trial.sql'; Write-Host 'Folder: C:\Users\Hendry\Documents\Reports'
        Write-Host 'Spaces and surrounding quotes are supported. Links/junctions are skipped.'
        $target = Read-Host $(if ($mode -eq '2') { 'JSON report path' } else { 'File or folder path' })
    }
    if ($mode -eq '2') {
        $report = Get-Content -LiteralPath (Clean-Path $target) -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($report.format -ne 'pocket-drive-upload' -or $report.version -ne 1 -or $report.server.TrimEnd('/') -ne $Server.TrimEnd('/')) { throw 'Report is invalid or belongs to another server.' }
        $entries = @($report.entries); $skipped = @($report.skipped)
        foreach ($entry in $entries) {
            if ($entry.kind -notin @('file','folder') -or -not $entry.source -or $null -eq $entry.relative_path) { throw 'Report contains an invalid source/destination.' }
            if ($entry.kind -eq 'file' -and $entry.upload_id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { throw 'Report contains an invalid upload ID.' }
        }
    } else {
        Write-Host 'Scanning and fingerprinting files...'
        $source = Find-Sources (Clean-Path $target); $entries = $source.entries; $skipped = $source.skipped
    }
    if ($entries.Count -gt 15000) { throw 'At most 15,000 entries per job.' }
    $concurrency = $env:POCKET_DRIVE_UPLOAD_CONCURRENCY
    if ($automatic) { if (-not $concurrency) { $concurrency = '3' } }
    else { do { $concurrency = Read-Host 'Parallel file uploads, 1-8 [3]'; if (-not $concurrency) { $concurrency = '3' } } while ($concurrency -notmatch '^[1-8]$') }
    if ($concurrency -notmatch '^[1-8]$') { throw 'Concurrency must be 1-8.' }
    if ($automatic) { $key = [Console]::In.ReadLine().Trim() }
    else {
        $secure = Read-Host 'API key (hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    if ($key -notmatch '^pd_[a-f0-9]{64}$') { throw 'Enter a complete Pocket Drive API key.' }
    Write-Host "Destination: My files; concurrency: $concurrency; entries: $($entries.Count)"
    if (-not $automatic) { $confirm = Read-Host 'Start uploading? [Y/n]'; if ($confirm -and $confirm -notin @('y','yes')) { return 0 } }
    $job = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
    $checkpoint = Join-Path $ReportDirectory "pocket-drive-upload-progress-$job.json"
    $report = @{ format = 'pocket-drive-upload'; version = 1; server = $Server; created_at = [DateTime]::UtcNow.ToString('o'); entries = @($entries); skipped = @($skipped) }
    Save-Json $checkpoint $report
    Write-Host "Recovery report: $checkpoint"
    $working = Join-Path ([IO.Path]::GetTempPath()) ('pocket-native-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($working)
    $pool = [RunspaceFactory]::CreateRunspacePool(1, [int]$concurrency); $pool.Open()
    $active = New-Object System.Collections.Generic.List[object]
    $next = 0; $pending = @($entries | Where-Object { $_.kind -eq 'file' -and $_.status -ne 'complete' })
    try {
        $folders = @($entries | Where-Object { $_.kind -eq 'folder' } | Sort-Object { $_.relative_path.Split('/').Count })
        if ($folders.Count) { [void](& $Worker $folders $Server $key '' $true); Save-Json $checkpoint $report }
        while ($next -lt $pending.Count -or $active.Count) {
            while ($next -lt $pending.Count -and $active.Count -lt [int]$concurrency) {
                $entry = $pending[$next++]; $state = Join-Path $working ($entry.upload_id + '.json')
                $ps = [PowerShell]::Create(); $ps.RunspacePool = $pool
                [void]$ps.AddScript($Worker.ToString()).AddArgument($entry).AddArgument($Server).AddArgument($key).AddArgument($state).AddArgument($false)
                $active.Add(@{ ps = $ps; handle = $ps.BeginInvoke(); entry = $entry; state = $state })
            }
            foreach ($item in @($active.ToArray())) {
                if ($item.handle.IsCompleted) {
                    try {
                        $result = @($item.ps.EndInvoke($item.handle))
                        if ($result.Count) {
                            $item.entry.status = $result[-1].status; $item.entry.error = $result[-1].error
                            $item.entry.fingerprint = $result[-1].fingerprint; $item.entry.attempts = $result[-1].attempts
                            if ($result[-1].file_id) { $item.entry | Add-Member -NotePropertyName file_id -NotePropertyValue $result[-1].file_id -Force }
                        } else { $item.entry.status = 'failed'; $item.entry.error = 'Worker ended without a result; retry from confirmed status.' }
                    } catch { $item.entry.status = 'failed'; $item.entry.error = $_.Exception.Message.Replace($key, '[redacted]') }
                    finally { $item.ps.Dispose() }
                    [void]$active.Remove($item); Save-Json $checkpoint $report
                    Write-Host "$($item.entry.status): $($item.entry.source) $($item.entry.error)"
                }
            }
            if ($active.Count) { Start-Sleep -Milliseconds 100 }
        }
    } finally {
        foreach ($item in $active) { $item.ps.Stop(); $item.ps.Dispose() }
        $pool.Close(); $pool.Dispose()
        Save-Json $checkpoint $report
        if (Test-Path -LiteralPath $working) { Remove-Item -LiteralPath $working -Recurse -Force }
    }
    $failed = @($entries | Where-Object { $_.status -ne 'complete' })
    $uploaded = @($entries | Where-Object { $_.kind -eq 'file' -and $_.status -eq 'complete' }).Count
    Write-Host "Finished: $uploaded files uploaded; $($failed.Count) failed entries; $($skipped.Count) skipped."
    if ($failed.Count) { $failure = Join-Path $ReportDirectory "pocket-drive-upload-failures-$job.json"; Save-Json $failure $report; Write-Host "Failure report: $failure"; return 1 }
    return 0
}
try { exit (Main) } catch { Write-Error $_.Exception.Message; exit 1 }
