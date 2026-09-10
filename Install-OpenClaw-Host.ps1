$ErrorActionPreference = 'Stop'

$logPath = Join-Path $PSScriptRoot 'openclaw-host-install.log'
$officialInstaller = Join-Path $PSScriptRoot 'openclaw-install.ps1'
$exitCode = 1

Start-Transcript -LiteralPath $logPath -Force | Out-Null

try {
    Write-Host 'Installing OpenClaw into the current Windows account...' -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath $officialInstaller -PathType Leaf)) {
        throw "Official installer was not found: $officialInstaller"
    }

    $nodeDir = 'C:\Program Files\nodejs'
    $codexGitDir = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd'

    if (Test-Path -LiteralPath $codexGitDir -PathType Container) {
        $env:Path = "$codexGitDir;$env:Path"
        Write-Host "Using existing Git runtime: $codexGitDir"
    }

    if (Test-Path -LiteralPath $nodeDir -PathType Container) {
        $env:Path = "$nodeDir;$env:Path"
    }

    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $officialInstaller -NoOnboard
    if ($LASTEXITCODE -ne 0) {
        throw "The official installer exited with code $LASTEXITCODE."
    }

    $npmBin = Join-Path $env:APPDATA 'npm'
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$nodeDir;$npmBin;$machinePath;$userPath"

    $userEntries = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() })
    if ($userEntries -notcontains $npmBin) {
        [Environment]::SetEnvironmentVariable('Path', (($userEntries + $npmBin) -join ';'), 'User')
    }

    $shim = Join-Path $npmBin 'openclaw.cmd'
    if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) {
        throw "Installation finished, but OpenClaw was not found at: $shim"
    }

    Write-Host ''
    Write-Host 'Installation verification:' -ForegroundColor Cyan
    & $shim --version
    if ($LASTEXITCODE -ne 0) {
        throw "OpenClaw version check exited with code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host 'OpenClaw is installed successfully.' -ForegroundColor Green
    Write-Host 'Model accounts and Gateway have not been configured yet.'
    $exitCode = 0
}
catch {
    Write-Host ''
    Write-Host "INSTALLATION FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Log file: $logPath" -ForegroundColor Yellow
}
finally {
    Stop-Transcript | Out-Null
    Write-Host ''
    Read-Host 'Press Enter to close this installer'
}

exit $exitCode
