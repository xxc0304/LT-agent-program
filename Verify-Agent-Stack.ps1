param(
    [switch]$SkipDemos
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$failures = [System.Collections.Generic.List[string]]::new()
$passed = 0

# Windows PowerShell 5.1 otherwise decodes UTF-8 output from Node as the
# active legacy code page, which makes Chinese test names appear corrupted.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
}
catch {
    # Verification still works if the host does not allow changing encoding.
}

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    Push-Location $WorkingDirectory
    try {
        $output = @(& $Command @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    catch {
        $exitCode = 1
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    finally {
        Pop-Location
    }

    if ($exitCode -eq 0) {
        $script:passed += 1
        Write-Host "PASS: $Name" -ForegroundColor Green
    }
    else {
        $script:failures.Add("$Name (exit code $exitCode)")
        Write-Host "FAIL: $Name (exit code $exitCode)" -ForegroundColor Red
        Write-Host "Last output lines:" -ForegroundColor Yellow
        $output | Select-Object -Last 25 | ForEach-Object { Write-Host $_ }
    }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Node.js was not found. Install Node.js 20 or newer and retry."
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') {
    throw "Could not parse Node.js version: $nodeVersion"
}
if ([int]$Matches[1] -lt 20) {
    throw "Node.js $nodeVersion found; this project requires version 20 or newer."
}

Write-Host "Agent stack verification (local/Mock only; no model API or live HA)" -ForegroundColor White
Write-Host "Repository: $repoRoot"
Write-Host "Node.js: $nodeVersion"

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
$deviceManagerTestName = "Device manager unit tests"
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

$steps = @(
    @{ Name = "Common contract compatibility tests"; Directory = (Join-Path $repoRoot "common-contracts"); Command = "node"; Arguments = @("--test", "test/task-compat.test.mjs") },
    @{ Name = "Common contract example validation"; Directory = $repoRoot; Command = "node"; Arguments = @("common-contracts/validate-examples.mjs") },
    @{ Name = $deviceManagerTestName; Directory = $deviceManagerDirectory; Command = $deviceManagerTestCommand; Arguments = $deviceManagerTestArguments },
    @{ Name = "Device manager Mock acceptance"; Directory = (Join-Path $repoRoot "device-manager"); Command = "npm"; Arguments = @("run", "acceptance") },
    @{ Name = "Energy agent unit tests"; Directory = (Join-Path $repoRoot "energy-saving"); Command = "npm"; Arguments = @("test") },
    @{ Name = "Learning behavior unit tests"; Directory = (Join-Path $repoRoot "learning-behavior"); Command = "npm"; Arguments = @("test") },
    @{ Name = "Household memory unit tests"; Directory = (Join-Path $repoRoot "agent-memory"); Command = "npm"; Arguments = @("test") },
    @{ Name = "Multi-agent orchestrator unit tests"; Directory = (Join-Path $repoRoot "multi-agent-orchestrator"); Command = "npm"; Arguments = @("test") }
)

foreach ($step in $steps) {
    Invoke-VerificationStep -Name $step.Name -WorkingDirectory $step.Directory -Command $step.Command -Arguments $step.Arguments
}

if (-not $SkipDemos) {
    $demos = @(
        @{ Name = "Energy agent Mock demo"; Directory = (Join-Path $repoRoot "energy-saving"); Command = "npm"; Arguments = @("run", "demo") },
        @{ Name = "Multi-agent to Mock HA end-to-end demo"; Directory = (Join-Path $repoRoot "multi-agent-orchestrator"); Command = "npm"; Arguments = @("run", "demo") }
    )
    foreach ($demo in $demos) {
        Invoke-VerificationStep -Name $demo.Name -WorkingDirectory $demo.Directory -Command $demo.Command -Arguments $demo.Arguments
    }
}

$total = $passed + $failures.Count
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "Passed: $passed / $total"
if ($failures.Count -gt 0) {
    Write-Host "Failed checks:" -ForegroundColor Red
    foreach ($failure in $failures) { Write-Host "- $failure" -ForegroundColor Red }
    exit 1
}

Write-Host "All local/Mock checks passed." -ForegroundColor Green
Write-Host "This does not verify a live OpenClaw Gateway, Home Assistant, vision-model accuracy, or physical appliances."
