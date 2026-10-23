[CmdletBinding()]
param(
    [switch]$InstallerChecks,
    [switch]$InstallFlow,
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$passed = 0
. (Join-Path $PSScriptRoot 'Package-Exclusions.ps1')

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Host "PASS: $Message" -ForegroundColor Green
}

foreach ($required in @(
    'Install-Agent-Stack.cmd',
    'Verify-Agent-Stack.ps1',
    'deployment\Install-Agent-Stack.ps1',
    'deployment\install-agent-stack.mjs',
    'deployment\install-agent-stack.test.mjs',
    'deployment\verify-agent-stack.mjs',
    'deployment\Verify-Agent-Integration.ps1',
    'deployment\Run-Agent-Integration-Demo.ps1'
)) {
    Assert-Condition -Condition (Test-Path -LiteralPath (Join-Path $repoRoot $required) -PathType Leaf) -Message "Package source contains $required"
}

$quickStartDirectory = Join-Path $repoRoot 'deployment'
if (-not (Test-Path -LiteralPath $quickStartDirectory -PathType Container)) { $quickStartDirectory = $repoRoot }
$quickStartFile = $null
foreach ($candidate in Get-ChildItem -LiteralPath $quickStartDirectory -File -Filter 'README-*.md') {
    $candidateText = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8
    if ($candidateText.Contains('--enable-sqlite-memory') -or $candidateText.Contains('-EnableSQLiteMemory')) { $quickStartFile = $candidate; break }
}
if (-not $quickStartFile -and $quickStartDirectory -ne $repoRoot) {
    foreach ($candidate in Get-ChildItem -LiteralPath $repoRoot -File -Filter 'README-*.md') {
        $candidateText = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8
        if ($candidateText.Contains('--enable-sqlite-memory') -or $candidateText.Contains('-EnableSQLiteMemory')) { $quickStartFile = $candidate; break }
    }
}
if (-not $quickStartFile) {
    $quickStartFile = Get-ChildItem -LiteralPath $repoRoot -File -Filter 'README-*.md' | Select-Object -First 1
}
Assert-Condition -Condition ($null -ne $quickStartFile) -Message 'Deployment quick-start document is present'
$installerSource = Get-Content -LiteralPath (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -Raw
$quickStart = Get-Content -LiteralPath $quickStartFile.FullName -Raw -Encoding UTF8
$packageBuilderPath = Join-Path $repoRoot 'deployment\Build-DeploymentPackage.ps1'
$packageBuilder = if (Test-Path -LiteralPath $packageBuilderPath -PathType Leaf) { Get-Content -LiteralPath $packageBuilderPath -Raw } else { '' }
Assert-Condition -Condition ($installerSource.Contains('$repoRoot = Split-Path -Parent $PSScriptRoot')) -Message 'Installer resolves package root from deployment subfolder'
Assert-Condition -Condition ($installerSource.Contains("'2026.7.1-2'")) -Message 'Installer pins the required OpenClaw runtime version'
Assert-Condition -Condition ($installerSource.Contains('Assert-SafeOpenClawExecutable')) -Message 'Installer refuses OpenClaw CMD/BAT shims for strict JSON writes'
Assert-Condition -Condition ($installerSource.Contains("'mock'")) -Message 'Mock verification explicitly selects the Mock backend'
Assert-Condition -Condition ($installerSource.Contains('plugins.entries.device-manager.config.frontdoorAgentId')) -Message 'Installer configures the selected OpenClaw chat Agent in the plugin'
Assert-Condition -Condition ($installerSource.Contains('EnableSQLiteMemory') -and $installerSource.Contains('MemoryDatabasePath')) -Message 'Installer exposes SQLite memory as an explicit opt-in with a path override'
Assert-Condition -Condition ($installerSource.Contains("plugins.entries.device-manager.config.memoryBackend") -and $installerSource.Contains("plugins.entries.device-manager.config.memoryDatabasePath")) -Message 'Installer writes SQLite settings only to the device-manager plugin config'
Assert-Condition -Condition ($installerSource.Contains('plugins.entries.platform-orchestrator.config.frontdoorAgentId')) -Message 'Installer configures the selected OpenClaw chat Agent in the platform plugin'
if ($packageBuilder) {
    Assert-Condition -Condition ($packageBuilder.Contains('deployment/Install-Agent-Stack.ps1')) -Message 'Package builder places the installer under deployment/'
    Assert-Condition -Condition ($packageBuilder.Contains('deployment/install-agent-stack.mjs')) -Message 'Package builder includes the Linux-native installer'
    Assert-Condition -Condition ($packageBuilder.Contains('deployment/verify-agent-stack.mjs')) -Message 'Package builder includes the Node.js local/Mock verification entry point'
    Assert-Condition -Condition ($packageBuilder.Contains('deployment/Package-Exclusions.ps1')) -Message 'Package builder includes the tested package-exclusion rules'
    Assert-Condition -Condition ($packageBuilder.Contains('Install-Agent-Stack.cmd')) -Message 'Package builder includes the one-click CMD entry point'
}
Assert-Condition -Condition ($quickStart.Contains('deployment/install-agent-stack.mjs')) -Message 'Quick start documents the Linux-native installer'
Assert-Condition -Condition ($quickStart.Contains('--enable-sqlite-memory') -or $quickStart.Contains('-EnableSQLiteMemory')) -Message 'Quick start documents the optional SQLite memory deployment switch'
Assert-Condition -Condition ($quickStart.Contains('npm --prefix device-manager install') -and $quickStart.Contains('npm --prefix multi-agent-orchestrator install') -and $quickStart.Contains('--legacy-peer-deps')) -Message 'Quick start installs both direct dependency sets without resolving the OpenClaw peer'
$deliveryReadmePath = Join-Path $repoRoot 'README-交付包.md'
if (Test-Path -LiteralPath $deliveryReadmePath -PathType Leaf) {
    $deliveryReadme = Get-Content -LiteralPath $deliveryReadmePath -Raw -Encoding UTF8
    Assert-Condition -Condition ($deliveryReadme.Contains('npm --prefix device-manager install') -and $deliveryReadme.Contains('npm --prefix multi-agent-orchestrator install') -and $deliveryReadme.Contains('--legacy-peer-deps')) -Message 'Delivery README matches the Linux direct-dependency install steps'
}
$linuxWorkflowPath = Join-Path $repoRoot '.github\workflows\agent-stack.yml'
if (Test-Path -LiteralPath $linuxWorkflowPath -PathType Leaf) {
    $linuxWorkflow = Get-Content -LiteralPath $linuxWorkflowPath -Raw -Encoding UTF8
    Assert-Condition -Condition ($linuxWorkflow.Contains('working-directory: device-manager') -and $linuxWorkflow.Contains('working-directory: multi-agent-orchestrator') -and $linuxWorkflow.Contains('--legacy-peer-deps')) -Message 'Ubuntu workflow installs both direct dependency sets without resolving the OpenClaw peer'
}
$cmdLauncher = Get-Content -LiteralPath (Join-Path $repoRoot 'Install-Agent-Stack.cmd') -Raw
Assert-Condition -Condition ($cmdLauncher.Contains('%*')) -Message 'One-click CMD launcher forwards optional installer parameters'
foreach ($sensitiveDatabasePath in @(
    'agent-memory/data/household.sqlite',
    'device-manager/state/custom.db',
    'data/household.sqlite3',
    'data/custom.sqlite-wal',
    'data/custom.sqlite-shm',
    'data/custom.sqlite-journal',
    'data/custom-wal'
)) {
    Assert-Condition -Condition (Test-ExcludedPackageFile -RelativePath $sensitiveDatabasePath) -Message "Package excludes SQLite data and sidecar file: $sensitiveDatabasePath"
}
Assert-Condition -Condition (-not (Test-ExcludedPackageFile -RelativePath 'agent-memory/src/sqlite-memory-repository.js')) -Message 'Package keeps SQLite implementation source code'
Assert-Condition -Condition (Test-ExcludedPackageFile -RelativePath 'device-manager/agent-workspace/openclaw-workspace-state.json') -Message 'Package excludes local OpenClaw workspace setup markers'
Assert-Condition -Condition (Test-ExcludedPackageFile -RelativePath 'openclaw-agents/energy-saving/USER.md') -Message 'Package excludes OpenClaw workspace user-profile files'

$scriptFiles = @(
    (Join-Path $repoRoot 'Verify-Agent-Stack.ps1'),
    (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1'),
    (Join-Path $repoRoot 'deployment\Package-Exclusions.ps1'),
    (Join-Path $repoRoot 'deployment\Verify-Agent-Integration.ps1'),
    (Join-Path $repoRoot 'deployment\Run-Agent-Integration-Demo.ps1'),
    (Join-Path $repoRoot 'deployment\Test-DeploymentPackage.ps1')
)
$installerNodePath = Join-Path $repoRoot 'deployment\install-agent-stack.mjs'
if (Test-Path -LiteralPath $installerNodePath -PathType Leaf) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        & $nodeCommand.Source --check $installerNodePath
        Assert-Condition -Condition ($LASTEXITCODE -eq 0) -Message 'Linux installer JavaScript syntax checks with Node.js'
    }
}
$packageBuilderPath = Join-Path $repoRoot 'deployment\Build-DeploymentPackage.ps1'
if (Test-Path -LiteralPath $packageBuilderPath -PathType Leaf) { $scriptFiles += $packageBuilderPath }
foreach ($scriptPath in $scriptFiles) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
    Assert-Condition -Condition ($parseErrors.Count -eq 0) -Message "PowerShell syntax parses: $([System.IO.Path]::GetFileName($scriptPath))"
}

if (-not $ArchivePath -and -not ($InstallerChecks -or $InstallFlow)) {
    $artifactDirectory = Join-Path $repoRoot 'output\deployment'
    if (Test-Path -LiteralPath $artifactDirectory -PathType Container) {
        $candidateArchive = Get-ChildItem -LiteralPath $artifactDirectory -File -Filter 'LT-agent-program-deployment-v*.zip' |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidateArchive) { $ArchivePath = $candidateArchive.FullName }
    }
}

if ($ArchivePath) {
    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw "Archive not found: $ArchivePath" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($expected in @(
            'Install-Agent-Stack.cmd',
            'Verify-Agent-Stack.ps1',
            'deployment/Install-Agent-Stack.ps1',
            'deployment/install-agent-stack.mjs',
            'deployment/install-agent-stack.test.mjs',
            'deployment/verify-agent-stack.mjs',
            'docs/linux-development-and-validation.md',
            'deployment/Package-Exclusions.ps1',
            'deployment/Verify-Agent-Integration.ps1',
            'deployment/Run-Agent-Integration-Demo.ps1',
            'deployment/Test-DeploymentPackage.ps1',
            'PACKAGE_MANIFEST.txt',
            'multi-agent-orchestrator/src/openclaw-frontdoor-transport.js',
            'multi-agent-orchestrator/openclaw.plugin.json',
            'multi-agent-orchestrator/src/openclaw-platform-plugin.js',
            'multi-agent-orchestrator/src/openclaw-platform-adapter.js',
            'device-manager/openclaw.plugin.json',
            'docs/household-memory-sqlite-backend-v0.1.md',
            'docs/household-memory-sqlite-backup-v0.1.md'
        )) {
            Assert-Condition -Condition ($entries -contains $expected) -Message "ZIP contains $expected"
        }
        Assert-Condition -Condition (@($entries | Where-Object { $_ -match '^README-.+\.md$' }).Count -gt 0) -Message 'ZIP contains the root quick-start document'
        Assert-Condition -Condition (-not ($entries -contains 'Verify-Agent-Integration.ps1')) -Message 'ZIP does not flatten deployment scripts into its root'
        Assert-Condition -Condition (-not ($entries | Where-Object { $_ -match '(^|/)(\.env(\.|$)|credentials\.json|.*\.(pem|key))$' })) -Message 'ZIP excludes common local credentials and key files'
        Assert-Condition -Condition (-not ($entries | Where-Object { Test-ExcludedPackageFile -RelativePath $_ })) -Message 'ZIP excludes SQLite databases and WAL/SHM/journal sidecars regardless of filename'
        Assert-Condition -Condition (-not ($entries | Where-Object { $_ -match '(^|/)extracted/' })) -Message 'ZIP excludes local extracted reports and source archives'
        Assert-Condition -Condition (-not ($entries | Where-Object { $_ -match '(^|/)openclaw-workspace-state\.json$' })) -Message 'ZIP excludes local OpenClaw workspace setup markers'
        Assert-Condition -Condition (-not ($entries | Where-Object { $_ -match '^(?:device-manager/agent-workspace|openclaw-agents/[^/]+)/USER\.md$' })) -Message 'ZIP excludes OpenClaw workspace user-profile files'
    }
    finally { $archive.Dispose() }
}
else {
    Write-Host 'Archive checks skipped; provide -ArchivePath to inspect a ZIP artifact.' -ForegroundColor Yellow
}

if ($InstallerChecks -or $InstallFlow) {
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lt-agent-install-test-" + [guid]::NewGuid().ToString('N'))
    $fakeBin = Join-Path $tempRoot 'bin'
    $fakeConfig = Join-Path $tempRoot 'openclaw.json'
    $fakeWorkspace = Join-Path $tempRoot 'default-workspace'
    $null = New-Item -ItemType Directory -Path $fakeBin -Force
    $null = New-Item -ItemType Directory -Path $fakeWorkspace -Force
    [System.IO.File]::WriteAllText($fakeConfig, '{"profile":"isolated-test-fixture"}', [System.Text.UTF8Encoding]::new($false))

    $fakeCli = @'
param([string]$ToolName)
$CliArgs = $args
$global:LASTEXITCODE = 0
if ($env:LT_AGENT_TEST_LOG) {
    $record = @{ tool = $ToolName; args = @($CliArgs) } | ConvertTo-Json -Compress -Depth 8
    [System.IO.File]::AppendAllText($env:LT_AGENT_TEST_LOG, $record + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}
if ($ToolName -eq 'node') {
    if ($env:LT_AGENT_TEST_NODE_VERSION) { Write-Output $env:LT_AGENT_TEST_NODE_VERSION }
    else { Write-Output 'v24.19.0' }
    exit 0
}
if ($ToolName -eq 'npm') { exit 0 }
if ($ToolName -ne 'openclaw') { Write-Error 'Unexpected fake executable.'; exit 97 }
if ($CliArgs[0] -eq '--version') { Write-Output 'OpenClaw 2026.7.1-2 (test-fixture)'; exit 0 }
if ($CliArgs[0] -eq 'config' -and $CliArgs[1] -eq 'file') { Write-Output $env:LT_AGENT_TEST_CONFIG; exit 0 }
if ($CliArgs[0] -eq 'config' -and $CliArgs[1] -eq 'validate') { Write-Output 'valid'; exit 0 }
if ($CliArgs[0] -eq 'agents' -and $CliArgs[1] -eq 'list') {
    $agents = @(@{ id = 'main'; isDefault = $true; workspace = $env:LT_AGENT_TEST_WORKSPACE; agentDir = $env:LT_AGENT_TEST_WORKSPACE })
    if ($env:LT_AGENT_TEST_UNRELATED_AGENT -eq 'true') { $agents += @{ id = 'other-home-agent'; workspace = $env:LT_AGENT_TEST_WORKSPACE; agentDir = $env:LT_AGENT_TEST_WORKSPACE } }
    $agents | ConvertTo-Json -Compress -Depth 8
    exit 0
}
if ($CliArgs[0] -eq 'plugins' -and $CliArgs[1] -eq 'list') { Write-Output '[]'; exit 0 }
if ($CliArgs[0] -eq 'plugins' -and $CliArgs[1] -eq 'build') { exit 0 }
if ($CliArgs[0] -eq 'plugins' -and $CliArgs[1] -in @('install', 'enable')) { exit 0 }
if ($CliArgs[0] -eq 'agents' -and $CliArgs[1] -eq 'add') {
    [System.IO.File]::AppendAllText($env:LT_AGENT_TEST_ADDS, [string]$CliArgs[2] + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    exit 0
}
if ($CliArgs[0] -eq 'config' -and $CliArgs[1] -eq 'get') {
    $path = $CliArgs[$CliArgs.Length - 1]
    switch ($path) {
        'plugins.allow' { Write-Output '["existing-plugin"]'; exit 0 }
        'plugins.entries.device-manager.config.memoryBackend' {
            if ($env:LT_AGENT_TEST_MEMORY_BACKEND) { ConvertTo-Json -InputObject $env:LT_AGENT_TEST_MEMORY_BACKEND -Compress }
            else { Write-Output 'null' }
            exit 0
        }
        'plugins.entries.device-manager.config.memoryDatabasePath' {
            if ($env:LT_AGENT_TEST_MEMORY_DATABASE_PATH) { ConvertTo-Json -InputObject $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH -Compress }
            else { Write-Output 'null' }
            exit 0
        }
        'agents.list' {
            $agents = @(@{ id = 'main'; workspace = $env:LT_AGENT_TEST_WORKSPACE; tools = @{} })
            if ($env:LT_AGENT_TEST_UNRELATED_AGENT -eq 'true') {
                $agentTools = @{}
                if ($env:LT_AGENT_TEST_UNRELATED_DENY -and $env:LT_AGENT_TEST_UNRELATED_DENY -ne '[]') {
                    $parsedDeny = ConvertFrom-Json -InputObject $env:LT_AGENT_TEST_UNRELATED_DENY -ErrorAction Stop
                    $agentTools.deny = [string[]]$parsedDeny
                }
                $agents += @{ id = 'other-home-agent'; workspace = $env:LT_AGENT_TEST_WORKSPACE; tools = $agentTools }
            }
            if (Test-Path -LiteralPath $env:LT_AGENT_TEST_ADDS) {
                $agents += @(
                    @{ id = 'device-manager'; workspace = $env:LT_AGENT_TEST_DEVICE_MANAGER_WORKSPACE; tools = @{} },
                    @{ id = 'energy-saving'; workspace = $env:LT_AGENT_TEST_ENERGY_SAVING_WORKSPACE; tools = @{} },
                    @{ id = 'learning-companion'; workspace = $env:LT_AGENT_TEST_LEARNING_COMPANION_WORKSPACE; tools = @{} }
                )
            }
            $agents | ConvertTo-Json -Compress -Depth 8
            exit 0
        }
        'tools.agentToAgent' { Write-Output $env:LT_AGENT_TEST_A2A; exit 0 }
        'tools.sessions.visibility' { Write-Output '"tree"'; exit 0 }
        default { Write-Output 'null'; exit 0 }
    }
}
if ($CliArgs[0] -eq 'config' -and $CliArgs[1] -eq 'set') {
    if ($CliArgs -notcontains '--strict-json') { Write-Output 'config set must use --strict-json'; exit 96 }
    if ($CliArgs.Count -lt 4) { Write-Output 'config set is missing its JSON value'; exit 96 }
    try { $null = ConvertFrom-Json -InputObject $CliArgs[3] -ErrorAction Stop }
    catch { Write-Output 'config set received malformed JSON'; exit 96 }
    exit 0
}
Write-Error 'Unexpected test command.'
exit 97
'@
    Set-Content -LiteralPath (Join-Path $fakeBin 'fake-tool.ps1') -Value $fakeCli -Encoding UTF8
    foreach ($tool in @('openclaw', 'npm', 'node')) {
        $fakeCmd = '@echo off' + "`r`n" + "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0fake-tool.ps1`" $tool %*" + "`r`n" + 'exit /b %errorlevel%' + "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $fakeBin "$tool.cmd"), $fakeCmd, [System.Text.Encoding]::ASCII)
    }

    $shellCommand = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if (-not $shellCommand) { $shellCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue }
    if (-not $shellCommand) { throw 'PowerShell executable is required for installer PlanOnly verification.' }

    $oldPath = $env:PATH
    $oldConfig = $env:LT_AGENT_TEST_CONFIG
    $oldWorkspace = $env:LT_AGENT_TEST_WORKSPACE
    $oldLog = $env:LT_AGENT_TEST_LOG
    $oldAdds = $env:LT_AGENT_TEST_ADDS
    $oldA2A = $env:LT_AGENT_TEST_A2A
    $oldDeviceManagerWorkspace = $env:LT_AGENT_TEST_DEVICE_MANAGER_WORKSPACE
    $oldEnergySavingWorkspace = $env:LT_AGENT_TEST_ENERGY_SAVING_WORKSPACE
    $oldLearningCompanionWorkspace = $env:LT_AGENT_TEST_LEARNING_COMPANION_WORKSPACE
    $oldUnrelatedAgent = $env:LT_AGENT_TEST_UNRELATED_AGENT
    $oldUnrelatedDeny = $env:LT_AGENT_TEST_UNRELATED_DENY
    $oldNodeVersion = $env:LT_AGENT_TEST_NODE_VERSION
    $oldMemoryBackend = $env:LT_AGENT_TEST_MEMORY_BACKEND
    $oldMemoryDatabasePath = $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH
    $oldLegacyMemoryBackend = $env:FAMILY_MEMORY_BACKEND
    $oldLegacyMemoryPath = $env:FAMILY_MEMORY_DB_PATH
    try {
        $env:PATH = "$fakeBin;$oldPath"
        $env:LT_AGENT_TEST_CONFIG = $fakeConfig
        $env:LT_AGENT_TEST_WORKSPACE = $fakeWorkspace
        $env:LT_AGENT_TEST_LOG = Join-Path $tempRoot 'commands.jsonl'
        $env:LT_AGENT_TEST_ADDS = Join-Path $tempRoot 'agent-adds.txt'
        $env:LT_AGENT_TEST_A2A = '{"enabled":false,"allow":["device-manager"]}'
        $env:LT_AGENT_TEST_DEVICE_MANAGER_WORKSPACE = Join-Path $repoRoot 'device-manager\agent-workspace'
        $env:LT_AGENT_TEST_ENERGY_SAVING_WORKSPACE = Join-Path $repoRoot 'openclaw-agents\energy-saving'
        $env:LT_AGENT_TEST_LEARNING_COMPANION_WORKSPACE = Join-Path $repoRoot 'openclaw-agents\learning-companion'
        $env:LT_AGENT_TEST_UNRELATED_AGENT = $null
        $env:LT_AGENT_TEST_UNRELATED_DENY = $null
        $env:LT_AGENT_TEST_NODE_VERSION = 'v24.19.0'
        $env:LT_AGENT_TEST_MEMORY_BACKEND = $null
        $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH = $null
        $env:FAMILY_MEMORY_BACKEND = $null
        $env:FAMILY_MEMORY_DB_PATH = $null
        $beforeHash = (Get-FileHash -LiteralPath $fakeConfig -Algorithm SHA256).Hash
        $fakeOpenClawPath = Join-Path $fakeBin 'openclaw.ps1'
        $fakeOpenClawCmdPath = Join-Path $fakeBin 'openclaw.cmd'
        $openclawPowerShellShim = '& "$PSScriptRoot\fake-tool.ps1" openclaw @args' + "`r`n" + 'exit $LASTEXITCODE' + "`r`n"
        Set-Content -LiteralPath $fakeOpenClawPath -Value $openclawPowerShellShim -Encoding UTF8
        $invalidJsonOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fakeBin 'fake-tool.ps1') openclaw config set test.invalid '{not-json' --strict-json 2>&1)
        $invalidJsonExitCode = $LASTEXITCODE
        Assert-Condition -Condition ($invalidJsonExitCode -ne 0) -Message 'Fake OpenClaw rejects malformed strict-JSON config values'
        $planOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -OpenClawPath $fakeOpenClawPath 2>&1)
        $planExitCode = $LASTEXITCODE
        $planText = $planOutput -join "`n"
        if ($planExitCode -ne 0) { throw "Installer PlanOnly test failed: $($planText.Substring([Math]::Max(0, $planText.Length - 4500)))" }
        Assert-Condition -Condition ($planText.Contains('User-facing chat Agent: main')) -Message 'Installer identifies the configured default chat Agent'
        Assert-Condition -Condition ($planText.Contains('orchestrate_household_agents')) -Message 'Installer plan includes the platform-level OpenClaw frontdoor tool'
        Assert-Condition -Condition ($planText.Contains('Legacy fixed frontdoor relay: explicitly denied')) -Message 'Installer explicitly disables the old fixed relay on the main Agent'
        $deviceManagerToolCount = @((Get-Content -LiteralPath (Join-Path $repoRoot 'device-manager\openclaw.plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json).contracts.tools).Count
        Assert-Condition -Condition ($planText.Contains("Direct device-manager tools: all $deviceManagerToolCount explicitly denied for the frontdoor")) -Message 'Installer plan denies direct device-manager plugin calls from the main Agent'
        Assert-Condition -Condition ($planText.Contains('Plan only: no packages were installed')) -Message 'PlanOnly mode completes without applying changes'
        $afterHash = (Get-FileHash -LiteralPath $fakeConfig -Algorithm SHA256).Hash
        Assert-Condition -Condition ($beforeHash -eq $afterHash) -Message 'Installer PlanOnly leaves the active profile fixture unchanged'

        $cmdOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -OpenClawPath $fakeOpenClawCmdPath 2>&1)
        $cmdExitCode = $LASTEXITCODE
        $cmdText = $cmdOutput -join "`n"
        Assert-Condition -Condition ($cmdExitCode -ne 0 -and $cmdText.Contains('cannot safely preserve strict JSON arguments')) -Message 'Installer rejects a CMD OpenClaw shim before profile access'

        $env:LT_AGENT_TEST_UNRELATED_AGENT = 'true'
        $env:LT_AGENT_TEST_UNRELATED_DENY = '[]'
        $unprotectedOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -OpenClawPath $fakeOpenClawPath 2>&1)
        $unprotectedExitCode = $LASTEXITCODE
        $unprotectedText = $unprotectedOutput -join "`n"
        if (-not ($unprotectedExitCode -ne 0 -and $unprotectedText.Contains('global expansion') -and $unprotectedText.Contains('other-home-agent'))) {
            Write-Host "Unprotected-agent guard diagnostic (exit $unprotectedExitCode): $unprotectedText" -ForegroundColor Yellow
        }
        Assert-Condition -Condition ($unprotectedExitCode -ne 0 -and $unprotectedText.Contains('global expansion') -and $unprotectedText.Contains('other-home-agent')) -Message 'Installer blocks global session visibility expansion when an unrelated Agent is unprotected'

        $env:LT_AGENT_TEST_UNRELATED_DENY = '["sessions_list","sessions_history","sessions_send","sessions_spawn"]'
        $protectedOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -OpenClawPath $fakeOpenClawPath 2>&1)
        $protectedExitCode = $LASTEXITCODE
        $protectedText = $protectedOutput -join "`n"
        if (-not ($protectedExitCode -eq 0 -and $protectedText.Contains('unrelated Agents were checked for explicit session-tool denial'))) {
            Write-Host "Protected-agent guard diagnostic (exit $protectedExitCode): $protectedText" -ForegroundColor Yellow
        }
        Assert-Condition -Condition ($protectedExitCode -eq 0 -and $protectedText.Contains('unrelated Agents were checked for explicit session-tool denial')) -Message 'Installer allows the visibility change only when unrelated Agents explicitly deny session tools'
        $env:LT_AGENT_TEST_UNRELATED_AGENT = $null
        $env:LT_AGENT_TEST_UNRELATED_DENY = $null

        if ($InstallFlow) {
            $env:LT_AGENT_TEST_A2A = '{"enabled":false,"allow":["unrelated-agent"]}'
            $conflictOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -OpenClawPath $fakeOpenClawPath 2>&1)
            $conflictExitCode = $LASTEXITCODE
            $conflictText = $conflictOutput -join "`n"
            Assert-Condition -Condition ($conflictExitCode -ne 0 -and $conflictText.Contains('will not broaden that shared policy')) -Message 'Installer refuses unrelated pre-existing A2A allowlist entries'

            $env:LT_AGENT_TEST_A2A = '{"enabled":false,"allow":["device-manager"]}'
            $installOutput = @('INSTALL' | & $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -OpenClawPath $fakeOpenClawPath -SkipGatewayRestartPrompt -SkipMockVerification 2>&1)
            $installExitCode = $LASTEXITCODE
            $installText = $installOutput -join "`n"
            if ($installExitCode -ne 0) { throw "Installer fake flow failed: $($installText.Substring([Math]::Max(0, $installText.Length - 4500)))" }
            if (-not $installText.Contains('Deployment steps completed.')) { throw "Installer fake flow returned exit 0 without completing: $installText" }
            Assert-Condition -Condition $true -Message 'Installer completes a fake OpenClaw install flow'

            $records = @(Get-Content -LiteralPath $env:LT_AGENT_TEST_LOG | ForEach-Object { $_ | ConvertFrom-Json })
            $recordText = @($records | ForEach-Object { "$($_.tool) $(@($_.args) -join ' ')" })
            foreach ($agentId in @('device-manager', 'energy-saving', 'learning-companion')) {
                Assert-Condition -Condition (@($recordText | Where-Object { $_ -match "^openclaw agents add $agentId " }).Count -eq 1) -Message "Installer registers missing Agent $agentId"
            }
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw plugins install --link ' }).Count -eq 2) -Message 'Installer links both platform and device-manager plugins'
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw plugins build --root ' }).Count -eq 1) -Message 'Installer generates platform plugin metadata with the active OpenClaw CLI'
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw plugins enable device-manager$' }).Count -eq 1) -Message 'Installer enables the device-manager plugin'
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw plugins enable platform-orchestrator$' }).Count -eq 1) -Message 'Installer enables the platform-orchestrator plugin'
            $deviceManagerFrontdoorWrites = @($recordText | Where-Object { $_ -match '^openclaw config set plugins\.entries\.device-manager\.config\.frontdoorAgentId ' })
            Assert-Condition -Condition ($deviceManagerFrontdoorWrites.Count -eq 2 -and @($deviceManagerFrontdoorWrites | Where-Object { $_ -notmatch 'main' }).Count -eq 0) -Message 'Installer preserves the detected frontdoor ID for the legacy plugin'
            $platformFrontdoorWrites = @($recordText | Where-Object { $_ -match '^openclaw config set plugins\.entries\.platform-orchestrator\.config\.frontdoorAgentId ' })
            Assert-Condition -Condition ($platformFrontdoorWrites.Count -eq 2 -and @($platformFrontdoorWrites | Where-Object { $_ -notmatch 'main' }).Count -eq 0) -Message 'Installer configures the detected frontdoor ID for platform orchestration'
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw config set tools\.agentToAgent\.allow ' }).Count -eq 2) -Message 'Installer dry-runs and applies the additive A2A allowlist'
            Assert-Condition -Condition (@($recordText | Where-Object { $_ -match '^openclaw config set .*--dry-run$' }).Count -gt 0) -Message 'Installer validates config writes before applying them'
            $frontdoorDenyWrite = @($records | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'agents.list[0].tools.deny' })
            $deviceManagerToolNames = @((Get-Content -LiteralPath (Join-Path $repoRoot 'device-manager\openclaw.plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json).contracts.tools)
            $frontdoorDenyLists = @($frontdoorDenyWrite | ForEach-Object { ,@((ConvertFrom-Json -InputObject $_.args[3])) })
            $allDirectToolsDenied = $frontdoorDenyWrite.Count -eq 2
            foreach ($denyList in $frontdoorDenyLists) {
                if ('talk_to_device_manager' -notin $denyList) { $allDirectToolsDenied = $false }
                foreach ($toolName in $deviceManagerToolNames) {
                    if ($toolName -notin $denyList) { $allDirectToolsDenied = $false; break }
                }
            }
            Assert-Condition -Condition $allDirectToolsDenied -Message 'Installer denies every direct device-manager plugin tool on the main Agent'
            Assert-Condition -Condition (@($records | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args -contains '--strict-json' }).Count -gt 0) -Message 'Fake OpenClaw parses every strict-JSON config write instead of accepting it blindly'
            $backupFiles = @(Get-ChildItem -LiteralPath $tempRoot -File -Filter 'openclaw.json.pre-lt-agent-program-*.bak')
            Assert-Condition -Condition ($backupFiles.Count -eq 1) -Message 'Installer preserves a timestamped profile backup before changes'

            $sqliteLog = Join-Path $tempRoot 'sqlite-commands.jsonl'
            $env:LT_AGENT_TEST_LOG = $sqliteLog
            $expectedDatabasePath = [System.IO.Path]::GetFullPath((Join-Path $tempRoot 'device-manager\family-memory.sqlite'))
            $sqlitePlanOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath 2>&1)
            $sqlitePlanExitCode = $LASTEXITCODE
            $sqlitePlanText = $sqlitePlanOutput -join "`n"
            if ($sqlitePlanExitCode -ne 0) { throw "SQLite installer PlanOnly test failed: $sqlitePlanText" }
            Assert-Condition -Condition ($sqlitePlanText.Contains("SQLite enabled (Node.js >=22.5); database: $expectedDatabasePath")) -Message 'SQLite PlanOnly reports the profile-scoped database path and runtime requirement'
            Assert-Condition -Condition (-not (Select-String -LiteralPath $sqliteLog -Pattern 'config set plugins.entries.device-manager.config.memory' -Quiet)) -Message 'SQLite PlanOnly does not write plugin backend settings'
            Assert-Condition -Condition ((Get-FileHash -LiteralPath $fakeConfig -Algorithm SHA256).Hash -eq $beforeHash) -Message 'SQLite PlanOnly leaves the active profile fixture unchanged'

            $customDatabasePath = Join-Path $tempRoot 'custom-memory\household.sqlite'
            $customPlanOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -EnableSQLiteMemory -MemoryDatabasePath $customDatabasePath -OpenClawPath $fakeOpenClawPath 2>&1)
            $customPlanExitCode = $LASTEXITCODE
            $customPlanText = $customPlanOutput -join "`n"
            Assert-Condition -Condition ($customPlanExitCode -eq 0 -and $customPlanText.Contains("SQLite enabled (Node.js >=22.5); database: $customDatabasePath")) -Message 'SQLite installer honors an explicit database path override'
            $relativeDatabaseOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -EnableSQLiteMemory -MemoryDatabasePath 'agent-memory\data\household.sqlite' -OpenClawPath $fakeOpenClawPath 2>&1)
            $relativeDatabaseExitCode = $LASTEXITCODE
            $relativeDatabaseText = $relativeDatabaseOutput -join "`n"
            Assert-Condition -Condition ($relativeDatabaseExitCode -ne 0 -and $relativeDatabaseText.Contains('MemoryDatabasePath must be an absolute path outside the extracted package directory')) -Message 'Installer rejects relative SQLite paths that could land inside the package'
            $insidePackageDatabasePath = Join-Path $repoRoot 'agent-memory\data\household.sqlite'
            $insidePackageOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -EnableSQLiteMemory -MemoryDatabasePath $insidePackageDatabasePath -OpenClawPath $fakeOpenClawPath 2>&1)
            $insidePackageExitCode = $LASTEXITCODE
            $insidePackageText = $insidePackageOutput -join "`n"
            Assert-Condition -Condition ($insidePackageExitCode -ne 0 -and $insidePackageText.Contains('must be outside the extracted package directory')) -Message 'Installer rejects absolute SQLite paths inside the distributable package source'
            $missingOptInOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -MemoryDatabasePath $customDatabasePath -OpenClawPath $fakeOpenClawPath 2>&1)
            $missingOptInExitCode = $LASTEXITCODE
            $missingOptInText = $missingOptInOutput -join "`n"
            Assert-Condition -Condition ($missingOptInExitCode -ne 0 -and $missingOptInText.Contains('Specify -MemoryDatabasePath only together with -EnableSQLiteMemory')) -Message 'Installer refuses a database path unless SQLite is explicitly enabled'

            $existingCustomDatabasePath = Join-Path $tempRoot 'existing-memory\custom.sqlite'
            $env:LT_AGENT_TEST_MEMORY_BACKEND = 'sqlite'
            $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH = $existingCustomDatabasePath
            $env:LT_AGENT_TEST_LOG = Join-Path $tempRoot 'preserve-custom-sqlite.jsonl'
            $preserveCustomOutput = @('INSTALL' | & $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath -SkipGatewayRestartPrompt -SkipMockVerification 2>&1)
            $preserveCustomExitCode = $LASTEXITCODE
            $preserveCustomText = $preserveCustomOutput -join "`n"
            $preserveCustomRecords = @(Get-Content -LiteralPath $env:LT_AGENT_TEST_LOG | ForEach-Object { $_ | ConvertFrom-Json })
            $preserveCustomPathWrites = @($preserveCustomRecords | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'plugins.entries.device-manager.config.memoryDatabasePath' })
            $preservedCustomPath = if ($preserveCustomPathWrites.Count) { ConvertFrom-Json -InputObject $preserveCustomPathWrites[-1].args[3] } else { $null }
            if ($preserveCustomExitCode -ne 0 -or -not $preserveCustomText.Contains($existingCustomDatabasePath) -or $preservedCustomPath -ne $existingCustomDatabasePath) {
                Write-Host "SQLite path preservation diagnostic: exit=$preserveCustomExitCode; plan=$preserveCustomText; pathWrite=$preservedCustomPath" -ForegroundColor Yellow
            }
            Assert-Condition -Condition ($preserveCustomExitCode -eq 0 -and $preserveCustomText.Contains($existingCustomDatabasePath) -and $preservedCustomPath -eq $existingCustomDatabasePath) -Message 'Installer preserves the existing explicit SQLite database path when rerun without an override'

            $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH = $null
            $env:LT_AGENT_TEST_LOG = Join-Path $tempRoot 'preserve-implicit-sqlite.jsonl'
            $preserveImplicitOutput = @('INSTALL' | & $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath -SkipGatewayRestartPrompt -SkipMockVerification 2>&1)
            $preserveImplicitExitCode = $LASTEXITCODE
            $preserveImplicitText = $preserveImplicitOutput -join "`n"
            $preserveImplicitRecords = @(Get-Content -LiteralPath $env:LT_AGENT_TEST_LOG | ForEach-Object { $_ | ConvertFrom-Json })
            $preserveImplicitPathWrites = @($preserveImplicitRecords | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'plugins.entries.device-manager.config.memoryDatabasePath' })
            Assert-Condition -Condition ($preserveImplicitExitCode -eq 0 -and $preserveImplicitText.Contains('existing runtime-default database path is preserved') -and $preserveImplicitPathWrites.Count -eq 0) -Message 'Installer preserves an existing implicit SQLite runtime path when rerun without an override'

            $env:LT_AGENT_TEST_MEMORY_BACKEND = $null
            $env:LT_AGENT_TEST_LOG = Join-Path $tempRoot 'preserve-legacy-sqlite.jsonl'
            $env:FAMILY_MEMORY_BACKEND = 'sqlite'
            $env:FAMILY_MEMORY_DB_PATH = $existingCustomDatabasePath
            $preserveLegacyOutput = @('INSTALL' | & $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath -SkipGatewayRestartPrompt -SkipMockVerification 2>&1)
            $preserveLegacyExitCode = $LASTEXITCODE
            $preserveLegacyText = $preserveLegacyOutput -join "`n"
            $preserveLegacyRecords = @(Get-Content -LiteralPath $env:LT_AGENT_TEST_LOG | ForEach-Object { $_ | ConvertFrom-Json })
            $preserveLegacyPathWrites = @($preserveLegacyRecords | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'plugins.entries.device-manager.config.memoryDatabasePath' })
            $preservedLegacyPath = if ($preserveLegacyPathWrites.Count) { ConvertFrom-Json -InputObject $preserveLegacyPathWrites[-1].args[3] } else { $null }
            Assert-Condition -Condition ($preserveLegacyExitCode -eq 0 -and $preserveLegacyText.Contains($existingCustomDatabasePath) -and $preservedLegacyPath -eq $existingCustomDatabasePath) -Message 'Installer preserves a configured legacy SQLite database path when promoting it to plugin settings'

            $env:LT_AGENT_TEST_MEMORY_BACKEND = $null
            $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH = $null
            $env:FAMILY_MEMORY_BACKEND = $null
            $env:FAMILY_MEMORY_DB_PATH = $null
            $env:LT_AGENT_TEST_LOG = $sqliteLog

            $env:LT_AGENT_TEST_NODE_VERSION = 'v22.4.0'
            $oldRuntimeOutput = @(& $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -PlanOnly -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath 2>&1)
            $oldRuntimeExitCode = $LASTEXITCODE
            $oldRuntimeText = $oldRuntimeOutput -join "`n"
            Assert-Condition -Condition ($oldRuntimeExitCode -ne 0 -and $oldRuntimeText.Contains('SQLite memory requires Node.js 22.5 or newer')) -Message 'SQLite opt-in rejects Node.js versions below 22.5 before profile changes'
            $env:LT_AGENT_TEST_NODE_VERSION = 'v24.19.0'

            $sqliteInstallOutput = @('INSTALL' | & $shellCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'deployment\Install-Agent-Stack.ps1') -EnableSQLiteMemory -OpenClawPath $fakeOpenClawPath -SkipGatewayRestartPrompt -SkipMockVerification 2>&1)
            $sqliteInstallExitCode = $LASTEXITCODE
            $sqliteInstallText = $sqliteInstallOutput -join "`n"
            if ($sqliteInstallExitCode -ne 0) { throw "SQLite fake installer flow failed: $($sqliteInstallText.Substring([Math]::Max(0, $sqliteInstallText.Length - 4500)))" }
            Assert-Condition -Condition ($sqliteInstallText.Contains('Deployment steps completed.')) -Message 'SQLite opt-in completes the fake installer flow'

            $sqliteRecords = @(Get-Content -LiteralPath $sqliteLog | ForEach-Object { $_ | ConvertFrom-Json })
            $backendWrites = @($sqliteRecords | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'plugins.entries.device-manager.config.memoryBackend' })
            $databaseWrites = @($sqliteRecords | Where-Object { $_.tool -eq 'openclaw' -and $_.args[0] -eq 'config' -and $_.args[1] -eq 'set' -and $_.args[2] -eq 'plugins.entries.device-manager.config.memoryDatabasePath' })
            $databaseWriteValues = @($databaseWrites | ForEach-Object { ConvertFrom-Json -InputObject $_.args[3] })
            Assert-Condition -Condition ($backendWrites.Count -eq 2 -and $backendWrites[0].args[3] -eq '"sqlite"') -Message 'SQLite installer validates and applies only the explicit sqlite backend selection'
            Assert-Condition -Condition ($databaseWriteValues.Count -eq 2 -and $databaseWriteValues[0] -eq $expectedDatabasePath -and $databaseWriteValues[1] -eq $expectedDatabasePath) -Message 'SQLite installer validates and applies the profile-scoped database path'
        }
    }
    finally {
        $env:PATH = $oldPath
        $env:LT_AGENT_TEST_CONFIG = $oldConfig
        $env:LT_AGENT_TEST_WORKSPACE = $oldWorkspace
        $env:LT_AGENT_TEST_LOG = $oldLog
        $env:LT_AGENT_TEST_ADDS = $oldAdds
        $env:LT_AGENT_TEST_A2A = $oldA2A
        $env:LT_AGENT_TEST_DEVICE_MANAGER_WORKSPACE = $oldDeviceManagerWorkspace
        $env:LT_AGENT_TEST_ENERGY_SAVING_WORKSPACE = $oldEnergySavingWorkspace
        $env:LT_AGENT_TEST_LEARNING_COMPANION_WORKSPACE = $oldLearningCompanionWorkspace
        $env:LT_AGENT_TEST_UNRELATED_AGENT = $oldUnrelatedAgent
        $env:LT_AGENT_TEST_UNRELATED_DENY = $oldUnrelatedDeny
        $env:LT_AGENT_TEST_NODE_VERSION = $oldNodeVersion
        $env:LT_AGENT_TEST_MEMORY_BACKEND = $oldMemoryBackend
        $env:LT_AGENT_TEST_MEMORY_DATABASE_PATH = $oldMemoryDatabasePath
        $env:FAMILY_MEMORY_BACKEND = $oldLegacyMemoryBackend
        $env:FAMILY_MEMORY_DB_PATH = $oldLegacyMemoryPath
        $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if ($resolvedTemp.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTemp).StartsWith('lt-agent-install-test-')) {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
        }
    }
}

Write-Host "Deployment package checks passed: $passed" -ForegroundColor Green
