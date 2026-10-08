param(
    [string]$MeshCentralRoot = 'C:\Program Files\Open Source\MeshCentral',
    [string]$BinaryDirectory = '',
    [string]$BinaryArchiveUrl = 'https://raw.githubusercontent.com/og-debug447/meshcentral-webcam/main/dist/meshagent-webcam-win-0.1.2.zip',
    [string]$ServiceName = 'meshcentral.exe'
)

$ErrorActionPreference = 'Stop'
$package = Join-Path $MeshCentralRoot 'node_modules\meshcentral'
$data = Join-Path $MeshCentralRoot 'meshcentral-data'
$packageAgents = Join-Path $package 'agents'
$signedAgents = Join-Path $data 'signedagents'
$staging = $null
$sourceX86 = $null
$sourceX64 = $null
$targetX86 = Join-Path $packageAgents 'MeshService.exe'
$targetX64 = Join-Path $packageAgents 'MeshService64.exe'
$signedX86 = Join-Path $signedAgents 'MeshService.exe'
$signedX64 = Join-Path $signedAgents 'MeshService64.exe'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell with Run as administrator, then run this updater again.'
}
foreach ($path in @($package, $packageAgents, $signedAgents, $sourceX86, $sourceX64)) {
    if ($null -ne $path -and -not (Test-Path -LiteralPath $path)) { throw "Required path not found: $path" }
}

if ([string]::IsNullOrWhiteSpace($BinaryDirectory)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $staging = Join-Path ([IO.Path]::GetTempPath()) ('mcwebcam-agent-' + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $staging 'meshagent-webcam.zip'
    $extracted = Join-Path $staging 'files'
    New-Item -ItemType Directory -Force -Path $staging, $extracted | Out-Null
    Write-Output "Downloading webcam-capable x86/x64 agents from GitHub..."
    Invoke-WebRequest -UseBasicParsing -Uri $BinaryArchiveUrl -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
    $sourceX86 = Join-Path $extracted 'MeshService.exe'
    $sourceX64 = Join-Path $extracted 'MeshService64.exe'
} else {
    $sourceX86 = Join-Path $BinaryDirectory 'MeshService.exe'
    $sourceX64 = Join-Path $BinaryDirectory 'MeshService64.exe'
}
foreach ($path in @($sourceX86, $sourceX64)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required agent binary not found: $path" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path (Join-Path $data 'mcwebcam-backups') ('agents-' + $stamp)
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) { throw "MeshCentral service not found: $ServiceName" }

$signedPaths = @($signedX86, $signedX64)
$signedAcls = @{}
$serviceStoppedByScript = $false
try {
    Copy-Item -LiteralPath $targetX86 -Destination (Join-Path $backup 'package-MeshService.exe')
    Copy-Item -LiteralPath $targetX64 -Destination (Join-Path $backup 'package-MeshService64.exe')

    if ($service.Status -ne 'Stopped') {
        Write-Output "Stopping $ServiceName..."
        Stop-Service -Name $ServiceName -Force
        (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
        $serviceStoppedByScript = $true
    }

    foreach ($path in $signedPaths) {
        if (Test-Path -LiteralPath $path) {
            $signedAcls[$path] = Get-Acl -LiteralPath $path
            & icacls.exe $path /grant "$($identity.Name):(F)" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Could not access signed-agent cache: $path" }
            Copy-Item -LiteralPath $path -Destination (Join-Path $backup ('signed-' + [IO.Path]::GetFileName($path)))
            Remove-Item -LiteralPath $path -Force
        }
    }

    Copy-Item -LiteralPath $sourceX86 -Destination $targetX86 -Force
    Copy-Item -LiteralPath $sourceX64 -Destination $targetX64 -Force

    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
    $deadline = (Get-Date).AddSeconds(120)
    do {
        $ready = (Test-Path -LiteralPath $signedX86) -and (Test-Path -LiteralPath $signedX64)
        if ($ready) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $ready) { throw 'MeshCentral did not refresh both signed service agents within 120 seconds.' }

    Write-Output 'MeshCentral is using the webcam-capable signed service agents.'
    Write-Output 'Now use MeshCentral Agent Update/Reinstall on the Windows endpoint.'
    Write-Output "Backup: $backup"
} catch {
    $failure = $_.Exception.Message
    try {
        $running = Get-Service -Name $ServiceName
        if ($running.Status -ne 'Stopped') {
            Stop-Service -Name $ServiceName -Force
            (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
        }
        Copy-Item -LiteralPath (Join-Path $backup 'package-MeshService.exe') -Destination $targetX86 -Force
        Copy-Item -LiteralPath (Join-Path $backup 'package-MeshService64.exe') -Destination $targetX64 -Force
        foreach ($path in $signedPaths) {
            if (Test-Path -LiteralPath $path) {
                & icacls.exe $path /grant "$($identity.Name):(F)" | Out-Null
                Remove-Item -LiteralPath $path -Force
            }
            $saved = Join-Path $backup ('signed-' + [IO.Path]::GetFileName($path))
            if (Test-Path -LiteralPath $saved) {
                Copy-Item -LiteralPath $saved -Destination $path -Force
                if ($signedAcls.ContainsKey($path)) { Set-Acl -LiteralPath $path -AclObject $signedAcls[$path] }
            }
        }
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
    } catch {
        throw "Webcam agent update failed ($failure) and rollback failed: $($_.Exception.Message). Backup: $backup"
    }
    throw "Webcam agent update failed: $failure. Previous files were restored. Backup: $backup"
}
