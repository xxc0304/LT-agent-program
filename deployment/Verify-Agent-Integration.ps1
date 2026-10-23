param(
    [switch]$SkipDemos
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()
$passed = 0

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
}
catch {}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js was not found. Install Node.js 20 or newer." }
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw "Node.js 20 or newer is required; found $nodeVersion"
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    Push-Location $Directory
    try {
        $output = @(& $Command @Arguments 2>&1)
        $code = $LASTEXITCODE
    }
    catch {
        $output = @($_.Exception.Message)
        $code = 1
    }
    finally {
        Pop-Location
    }

    if ($code -eq 0) {
        $script:passed++
        Write-Host "PASS: $Name" -ForegroundColor Green
    }
    else {
        $script:failures.Add("$Name (exit code $code)")
        Write-Host "FAIL: $Name (exit code $code)" -ForegroundColor Red
        $output | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
    }
}

$deviceManagerDirectory = Join-Path $repoRoot "device-manager"
$openClawSdkProbe = @()
Push-Location $deviceManagerDirectory
try {
    $openClawSdkProbe = @(& node --input-type=module -e "import('openclaw/plugin-sdk/session-visibility').then(()=>console.log('sdk:available')).catch(error=>console.log('sdk:error:'+error.code+':'+error.message))")
}
finally { Pop-Location }
$openClawSdkProbeText = $openClawSdkProbe -join "`n"
$deviceManagerTestCommand = "npm"
$deviceManagerTestArguments = @("test")
$deviceManagerTestName = "Device manager tests"
if ($openClawSdkProbeText -notmatch "sdk:available") {
    if ($openClawSdkProbeText -notmatch "sdk:error:ERR_MODULE_NOT_FOUND|Cannot find package 'openclaw'") {
        throw "OpenClaw package is present but its required plugin SDK entry could not be loaded. $openClawSdkProbeText"
    }
    $hostSdkOnlyTests = @(
        "energy-operations-tools.test.js",
        "maintenance-reminders.test.js",
        "mock-maintenance-reminder-tool.test.js",
        "openclaw-agent-transport.test.js",
        "openclaw-memory-runtime.test.js",
        "openclaw-routine-notifications.test.js"
    )
    $coreTests = @(Get-ChildItem -LiteralPath (Join-Path $deviceManagerDirectory "test") -File -Filter "*.test.js" |
        Where-Object { $_.Name -notin $hostSdkOnlyTests } |
        ForEach-Object { $_.FullName })
    if ($coreTests.Count -eq 0) { throw "No device-manager core tests were found." }
    $deviceManagerTestCommand = "node"
    $deviceManagerTestArguments = @("--test") + $coreTests
    $deviceManagerTestName = "Device manager core tests (OpenClaw SDK tests skipped; host SDK unavailable)"
    Write-Host "OpenClaw plugin SDK is not installed in the package-local Node environment; excluding only $($hostSdkOnlyTests.Count) host-SDK adapter test files. Gateway plugin validation remains a separate runtime check." -ForegroundColor Yellow
}

Write-Host "Agent integration verification: local tests and Mock only" -ForegroundColor White
Write-Host "Repository: $repoRoot"
Write-Host "Node.js: $nodeVersion"

$steps = @(
    @{ Name = "Common contract compatibility"; Directory = (Join-Path $repoRoot "common-contracts"); Command = "node"; Arguments = @("--test", "test/task-compat.test.mjs") },
    @{ Name = "Common contract examples"; Directory = $repoRoot; Command = "node"; Arguments = @("common-contracts/validate-examples.mjs") },
    @{ Name = $deviceManagerTestName; Directory = $deviceManagerDirectory; Command = $deviceManagerTestCommand; Arguments = $deviceManagerTestArguments },
    @{ Name = "Device manager Mock acceptance"; Directory = (Join-Path $repoRoot "device-manager"); Command = "npm"; Arguments = @("run", "acceptance") },
    @{ Name = "Energy Agent tests"; Directory = (Join-Path $repoRoot "energy-saving"); Command = "npm"; Arguments = @("test") },
    @{ Name = "Household memory tests"; Directory = (Join-Path $repoRoot "agent-memory"); Command = "npm"; Arguments = @("test") },
    @{ Name = "Multi-Agent orchestrator tests"; Directory = (Join-Path $repoRoot "multi-agent-orchestrator"); Command = "npm"; Arguments = @("test") }
)
foreach ($step in $steps) {
    Invoke-Step -Name $step.Name -Directory $step.Directory -Command $step.Command -Arguments $step.Arguments
}

if (-not $SkipDemos) {
    Invoke-Step -Name "Integrated energy event to Mock HA demo" -Directory (Join-Path $repoRoot "multi-agent-orchestrator") -Command "npm" -Arguments @("run", "demo:energy-event")
}

$total = $passed + $failures.Count
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host "Passed: $passed / $total"
if ($failures.Count -gt 0) {
    Write-Host "Failed checks:" -ForegroundColor Red
    foreach ($failure in $failures) { Write-Host "- $failure" -ForegroundColor Red }
    exit 1
}
Write-Host "All scoped Agent integration checks passed." -ForegroundColor Green
Write-Host "This does not verify a live OpenClaw Gateway, real Home Assistant, physical appliances, source authentication, or production security settings."
