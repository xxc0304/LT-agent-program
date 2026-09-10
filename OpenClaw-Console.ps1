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

    Write-Host 'OpenClaw Console' -ForegroundColor Cyan
    Write-Host "Windows account: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-Host "OpenClaw command: $shim"
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
