$ErrorActionPreference = 'Stop'

$logPath = Join-Path $PSScriptRoot 'openclaw-console.log'
$nodeDir = 'C:\Program Files\nodejs'
$npmBin = Join-Path $env:APPDATA 'npm'
$shim = Join-Path $npmBin 'openclaw.cmd'

Start-Transcript -LiteralPath $logPath -Force | Out-Null

try {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$nodeDir;$npmBin;$machinePath;$userPath;$env:Path"
    # Keep the team-aligned OpenClaw 2026.7.1-2 profile separate from any newer profile.
    $env:OPENCLAW_STATE_DIR = Join-Path $env:USERPROFILE '.openclaw-2026.7.1-2\state'
    $env:OPENCLAW_CONFIG_PATH = Join-Path $env:USERPROFILE '.openclaw-2026.7.1-2\openclaw.json'

    Write-Host 'OpenClaw Console' -ForegroundColor Cyan
    Write-Host "Windows account: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-Host "OpenClaw command: $shim"
    Write-Host "OpenClaw profile: $env:OPENCLAW_CONFIG_PATH"
    Write-Host ''

    if (-not (Test-Path -LiteralPath $shim -PathType Leaf)) {
        throw "OpenClaw command was not found: $shim"
    }

    & $shim --version
    if ($LASTEXITCODE -ne 0) {
        throw "OpenClaw exited with code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host 'OpenClaw is ready.' -ForegroundColor Green
    Write-Host 'Next setup command: openclaw onboard'
    Write-Host 'This PowerShell window will remain open.'
}
catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Diagnostic log: $logPath" -ForegroundColor Yellow
}
finally {
    Stop-Transcript | Out-Null
}
