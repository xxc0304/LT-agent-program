$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js was not found. Install Node.js 20 or newer."
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw "Node.js 20 or newer is required; found $nodeVersion"
}

Write-Host "Running the Agent integration Mock demo" -ForegroundColor Cyan
Write-Host "Node.js: $nodeVersion"
Write-Host "Scope: synthetic occupancy event + local rule orchestration + Mock HA; no model API, live HA, or physical devices."

Push-Location (Join-Path $repoRoot "multi-agent-orchestrator")
try {
    & npm run demo:energy-event
    if ($LASTEXITCODE -ne 0) {
        throw "Integration demo failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
