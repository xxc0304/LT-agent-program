[CmdletBinding()]
param(
    [string]$FrontdoorAgentId,
    [string]$OpenClawPath,
    [switch]$EnableSQLiteMemory,
    [string]$MemoryDatabasePath,
    [switch]$PlanOnly,
    [switch]$SkipMockVerification,
    [switch]$SkipGatewayRestartPrompt
)

$ErrorActionPreference = 'Stop'
$requiredOpenClawVersion = '2026.7.1-2'
$projectAgentIds = @('device-manager', 'energy-saving', 'learning-companion')
$restrictedSessionTools = @('sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn')
$repoRoot = Split-Path -Parent $PSScriptRoot
$backupPath = $null

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
}
catch {}

function Get-ExecutablePath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "$Name was not found on PATH." }
    if ($command.Source) { return $command.Source }
    return $command.Definition
}

function Assert-SafeOpenClawExecutable {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $extension = [System.IO.Path]::GetExtension($Executable)
    if ($extension -in @('.cmd', '.bat')) {
        throw "The OpenClaw entry point resolves to a $extension shim, which cannot safely preserve strict JSON arguments on Windows PowerShell. No profile changes were made. Re-run with -OpenClawPath pointing to OpenClaw's .ps1 or .exe entry point (Get-Command openclaw -All)."
    }
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $output = @(& $Executable @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Label failed (exit code $exitCode). No OpenClaw configuration changes were intentionally made by this step."
    }
    return ,([string[]]($output | ForEach-Object { [string]$_ }))
}

function ConvertFrom-JsonCommandOutput {
    param([Parameter(Mandatory = $true)][string[]]$Lines)

    $text = $Lines -join "`n"
    try { return ,(ConvertFrom-Json -InputObject $text -ErrorAction Stop) } catch {}

    # Some CLI builds write a short banner before --json output. Try each JSON
    # opening point and progressively trim trailing diagnostic text.
    for ($start = 0; $start -lt $text.Length; $start++) {
        if ($text[$start] -notin @('{', '[')) { continue }
        for ($end = $text.Length - 1; $end -gt $start; $end--) {
            if ($text[$end] -notin @('}', ']')) { continue }
            $candidate = $text.Substring($start, $end - $start + 1)
            try { return ,(ConvertFrom-Json -InputObject $candidate -ErrorAction Stop) } catch {}
        }
    }
    throw 'Could not read structured output from the OpenClaw CLI. No profile changes were made.'
}

function Get-OpenClawJson {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $lines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments $Arguments -Label $Label
    return ,(ConvertFrom-JsonCommandOutput -Lines $lines)
}

function Get-ObjectRows {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return @($Value) }
    foreach ($propertyName in @('agents', 'plugins', 'items', 'entries', 'results')) {
        $property = $Value.PSObject.Properties[$propertyName]
        if ($property) { return @(Get-ObjectRows -Value $property.Value) }
    }
    return @($Value)
}

function Get-PropertyValue {
    param($Object, [string[]]$Names)
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($property) { return ,$property.Value }
    }
    return $null
}

function ConvertTo-StringArray {
    param($Value, [string]$SettingName)
    if ($null -eq $Value) { return @() }
    if ($Value -isnot [System.Array] -and $Value -isnot [System.Collections.IList]) {
        throw "OpenClaw setting '$SettingName' is not a list (value type: $($Value.GetType().FullName)); the installer will not replace it."
    }
    $values = @()
    foreach ($item in $Value) {
        if ($item -isnot [string]) { throw "OpenClaw setting '$SettingName' contains a non-text item; the installer will not replace it." }
        if (-not [string]::IsNullOrWhiteSpace($item)) { $values += $item }
    }
    return ,$values
}

function Add-UniqueStrings {
    param([string[]]$Existing, [string[]]$Additions)
    $result = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in @($Existing) + @($Additions)) {
        if ($seen.Add($item)) { $result.Add($item) }
    }
    return ,([string[]]$result.ToArray())
}

function Get-ConfigValue {
    param([string]$Path, [switch]$Optional)
    $lines = @(& $script:openclawPath config get --json $Path 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        if ($Optional) { return $null }
        throw "Could not read OpenClaw setting '$Path'. No profile changes were made."
    }
    return ,(ConvertFrom-JsonCommandOutput -Lines ([string[]]($lines | ForEach-Object { [string]$_ })))
}

function Resolve-ComparablePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Find-AgentRow {
    param([object[]]$Rows, [string]$Id)
    foreach ($row in $Rows) {
        $rowId = [string](Get-PropertyValue -Object $row -Names @('id', 'agentId'))
        if ([string]::Equals($rowId, $Id, [System.StringComparison]::OrdinalIgnoreCase)) { return $row }
    }
    return $null
}

function Find-AgentConfigIndex {
    param([object[]]$Rows, [string]$Id)
    for ($index = 0; $index -lt $Rows.Count; $index++) {
        $rowId = [string](Get-PropertyValue -Object $Rows[$index] -Names @('id', 'agentId'))
        if ([string]::Equals($rowId, $Id, [System.StringComparison]::OrdinalIgnoreCase)) { return $index }
    }
    return -1
}

function Get-PluginSourcePath {
    param($Record)
    if ($null -eq $Record) { return $null }
    $pathNames = @('resolvedPath', 'pluginPath', 'packagePath', 'sourcePath', 'installPath', 'rootDir', 'path')
    foreach ($property in $Record.PSObject.Properties) {
        if ($property.Name -in $pathNames -and $property.Value -is [string] -and $property.Value -match '^(?:[A-Za-z]:[\\/]|\\\\|/)') {
            return [string]$property.Value
        }
        if ($property.Value -is [System.Management.Automation.PSCustomObject]) {
            $nested = Get-PluginSourcePath -Record $property.Value
            if ($nested) { return $nested }
        }
    }
    return $null
}

function Select-FrontdoorAgent {
    param([object[]]$Rows, [string]$RequestedId, [switch]$Planning)

    if ($RequestedId) {
        $requested = Find-AgentRow -Rows $Rows -Id $RequestedId
        if (-not $requested) { throw "Frontdoor Agent '$RequestedId' is not present in the active OpenClaw profile." }
        return [string](Get-PropertyValue -Object $requested -Names @('id', 'agentId'))
    }

    $defaults = @($Rows | Where-Object { (Get-PropertyValue -Object $_ -Names @('isDefault', 'default')) -eq $true })
    if ($defaults.Count -eq 1) { return [string](Get-PropertyValue -Object $defaults[0] -Names @('id', 'agentId')) }

    $dev = Find-AgentRow -Rows $Rows -Id 'dev'
    if ($dev) { return 'dev' }
    $main = Find-AgentRow -Rows $Rows -Id 'main'
    if ($main) { return 'main' }

    $candidates = @($Rows | Where-Object {
        $id = [string](Get-PropertyValue -Object $_ -Names @('id', 'agentId'))
        $id -and $id -notin $script:projectAgentIds
    })
    if ($candidates.Count -eq 1) { return [string](Get-PropertyValue -Object $candidates[0] -Names @('id', 'agentId')) }
    if ($Planning) { throw 'Could not uniquely select a user-facing Agent. Re-run with -FrontdoorAgentId <id>.' }

    $ids = @($candidates | ForEach-Object { [string](Get-PropertyValue -Object $_ -Names @('id', 'agentId')) })
    if ($ids.Count -eq 0) { throw 'The active profile has no user-facing Agent. Create one in OpenClaw first.' }
    Write-Host "Choose the Agent that receives your normal OpenClaw chat. Available: $($ids -join ', ')"
    $entered = Read-Host 'Agent ID'
    $chosen = Find-AgentRow -Rows $Rows -Id $entered
    if (-not $chosen -or $entered -in $script:projectAgentIds) { throw 'The selected frontdoor Agent is invalid.' }
    return [string](Get-PropertyValue -Object $chosen -Names @('id', 'agentId'))
}

function Add-ConfigWrite {
    param([System.Collections.Generic.List[object]]$Writes, [string]$Path, $Value)
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 100
    $Writes.Add([pscustomobject]@{ Path = $Path; Json = $json })
}

try {
    if ($MemoryDatabasePath -and -not $EnableSQLiteMemory) {
        throw 'Specify -MemoryDatabasePath only together with -EnableSQLiteMemory.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'device-manager\openclaw.plugin.json'))) {
        throw 'Run this installer from the extracted LT-agent-program package root.'
    }
    foreach ($requiredPath in @(
        'device-manager\agent-workspace\AGENTS.md',
        'openclaw-agents\energy-saving\AGENTS.md',
        'openclaw-agents\learning-companion\AGENTS.md',
        'Verify-Agent-Stack.ps1'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $requiredPath))) {
            throw "The package is incomplete: missing $requiredPath"
        }
    }

    if ($OpenClawPath) {
        if (-not (Test-Path -LiteralPath $OpenClawPath -PathType Leaf)) { throw "OpenClaw CLI was not found at the supplied path: $OpenClawPath" }
        $script:openclawPath = (Resolve-Path -LiteralPath $OpenClawPath).Path
    }
    else {
        $script:openclawPath = Get-ExecutablePath -Name 'openclaw'
    }
    Assert-SafeOpenClawExecutable -Executable $script:openclawPath
    $npmPath = Get-ExecutablePath -Name 'npm'
    $nodePath = Get-ExecutablePath -Name 'node'

    $versionLines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('--version') -Label 'Checking OpenClaw version'
    $versionText = $versionLines -join "`n"
    if ($versionText -notmatch '(?i)OpenClaw\s+(?<version>\d{4}\.\d+\.\d+(?:-\d+)?)') {
        throw 'Could not read the installed OpenClaw version.'
    }
    $openClawVersion = $Matches.version
    if ($openClawVersion -ne $requiredOpenClawVersion) {
        throw "This package requires OpenClaw $requiredOpenClawVersion; found $openClawVersion. The installer will not upgrade or switch profiles."
    }

    $nodeLines = Invoke-NativeCommand -Executable $nodePath -Arguments @('--version') -Label 'Checking Node.js version'
    $nodeVersionText = ($nodeLines -join '').Trim()
    if ($nodeVersionText -notmatch '^v(?<major>\d+)\.' -or [int]$Matches.major -lt 20) {
        throw "Node.js 20 or newer is required; found $nodeVersionText."
    }
    if ($EnableSQLiteMemory) {
        if ($nodeVersionText -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)') {
            throw "Could not parse the Node.js version required for SQLite memory: $nodeVersionText."
        }
        $nodeMajor = [int]$Matches.major
        $nodeMinor = [int]$Matches.minor
        if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
            throw "SQLite memory requires Node.js 22.5 or newer; found $nodeVersionText. JSON memory still supports Node.js 20+."
        }
    }

    $configFileLines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('config', 'file') -Label 'Checking active OpenClaw profile'
    $configFileOutput = $configFileLines -join "`n"
    if ($configFileOutput -notmatch '(?i)(?<path>(?:[A-Z]:\\|\\\\)[^\r\n"]*openclaw\.json)') {
        throw 'Could not identify the active OpenClaw config file. No profile changes were made.'
    }
    $configPath = $Matches.path.Trim()
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "The active OpenClaw config does not exist at the reported path. Complete OpenClaw setup first; no profile was initialized."
    }
    $resolvedMemoryDatabasePath = $null
    $preserveImplicitMemoryDatabasePath = $false
    if ($EnableSQLiteMemory) {
        $configuredMemoryBackend = Get-ConfigValue -Path 'plugins.entries.device-manager.config.memoryBackend' -Optional
        $configuredMemoryDatabasePath = Get-ConfigValue -Path 'plugins.entries.device-manager.config.memoryDatabasePath' -Optional
        $legacySQLiteBackend = -not $configuredMemoryBackend -and $env:FAMILY_MEMORY_BACKEND -eq 'sqlite'

        if (-not [string]::IsNullOrWhiteSpace($MemoryDatabasePath)) {
            if (-not [System.IO.Path]::IsPathRooted($MemoryDatabasePath)) {
                throw 'MemoryDatabasePath must be an absolute path outside the extracted package directory.'
            }
            $resolvedMemoryDatabasePath = [System.IO.Path]::GetFullPath($MemoryDatabasePath)
        }
        elseif ($configuredMemoryBackend -eq 'sqlite') {
            if ([string]::IsNullOrWhiteSpace([string]$configuredMemoryDatabasePath)) {
                $preserveImplicitMemoryDatabasePath = $true
            }
            elseif ($configuredMemoryDatabasePath -isnot [string] -or -not [System.IO.Path]::IsPathRooted($configuredMemoryDatabasePath)) {
                throw 'The active profile has a non-absolute SQLite database path. No profile changes were made; review it and pass an explicit absolute -MemoryDatabasePath if a path change is intended.'
            }
            else {
                $resolvedMemoryDatabasePath = [System.IO.Path]::GetFullPath($configuredMemoryDatabasePath)
            }
        }
        elseif ($legacySQLiteBackend -and [string]::IsNullOrWhiteSpace($env:FAMILY_MEMORY_DB_PATH)) {
            $preserveImplicitMemoryDatabasePath = $true
        }
        elseif ($legacySQLiteBackend) {
            if (-not [System.IO.Path]::IsPathRooted($env:FAMILY_MEMORY_DB_PATH)) {
                throw 'FAMILY_MEMORY_DB_PATH selects a relative legacy SQLite path. No profile changes were made; use an absolute -MemoryDatabasePath after confirming the intended database.'
            }
            $resolvedMemoryDatabasePath = [System.IO.Path]::GetFullPath($env:FAMILY_MEMORY_DB_PATH)
        }
        elseif ([string]::IsNullOrWhiteSpace($MemoryDatabasePath)) {
            $memoryStateDirectory = Join-Path (Split-Path -Parent $configPath) 'device-manager'
            $resolvedMemoryDatabasePath = [System.IO.Path]::GetFullPath((Join-Path $memoryStateDirectory 'family-memory.sqlite'))
        }

        if ($resolvedMemoryDatabasePath) {
            $resolvedPackageRoot = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\', '/')
            $packageRootPrefix = $resolvedPackageRoot + [System.IO.Path]::DirectorySeparatorChar
            if ([string]::Equals($resolvedMemoryDatabasePath, $resolvedPackageRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                $resolvedMemoryDatabasePath.StartsWith($packageRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The SQLite database must be outside the extracted package directory so household data cannot be included in a later package build.'
            }
            if (Test-Path -LiteralPath $resolvedMemoryDatabasePath -PathType Container) {
                throw "The SQLite memory path points to a directory, not a database file: $resolvedMemoryDatabasePath"
            }
        }
    }

    $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('config', 'validate') -Label 'Validating the current OpenClaw profile'
    $agentSummaryValue = Get-OpenClawJson -Arguments @('agents', 'list', '--json') -Label 'Reading configured Agent names'
    $agentSummaries = @(Get-ObjectRows -Value $agentSummaryValue)
    $frontdoorId = Select-FrontdoorAgent -Rows $agentSummaries -RequestedId $FrontdoorAgentId -Planning:$PlanOnly
    if ($frontdoorId -in $projectAgentIds) { throw 'The frontdoor Agent cannot be one of the project business Agents.' }

    $pluginDocument = Get-Content -LiteralPath (Join-Path $repoRoot 'device-manager\openclaw.plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $pluginTools = @($pluginDocument.contracts.tools | ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($pluginTools -notcontains 'talk_to_device_manager') { throw 'The package plugin is missing talk_to_device_manager.' }
    $platformPluginDocument = Get-Content -LiteralPath (Join-Path $repoRoot 'multi-agent-orchestrator\openclaw.plugin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $platformTool = [string]($platformPluginDocument.contracts.tools | Where-Object { [string]$_ -eq 'orchestrate_household_agents' } | Select-Object -First 1)
    if (-not $platformTool) { throw 'The platform plugin is missing orchestrate_household_agents.' }

    $pluginListValue = Get-OpenClawJson -Arguments @('plugins', 'list', '--verbose', '--json') -Label 'Checking installed OpenClaw plugins'
    $pluginRows = @(Get-ObjectRows -Value $pluginListValue)
    $registeredPlugin = $null
    foreach ($row in $pluginRows) {
        $id = [string](Get-PropertyValue -Object $row -Names @('id', 'pluginId', 'name'))
        if ([string]::Equals($id, 'device-manager', [System.StringComparison]::OrdinalIgnoreCase)) { $registeredPlugin = $row; break }
    }
    $pluginSourcePath = $null
    if ($registeredPlugin) {
        $pluginSourcePath = Get-PluginSourcePath -Record $registeredPlugin
        if (-not $pluginSourcePath) {
            $inspectLines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'inspect', 'device-manager', '--json') -Label 'Checking the existing device-manager plugin path'
            $inspectValue = ConvertFrom-JsonCommandOutput -Lines $inspectLines
            $pluginSourcePath = Get-PluginSourcePath -Record $inspectValue
        }
        if (-not $pluginSourcePath -or (Resolve-ComparablePath $pluginSourcePath) -ne (Resolve-ComparablePath (Join-Path $repoRoot 'device-manager'))) {
            throw 'A different device-manager plugin is already registered. It was not overwritten; review it or remove it using the OpenClaw CLI before retrying.'
        }
    }

    $registeredPlatformPlugin = $null
    foreach ($row in $pluginRows) {
        $id = [string](Get-PropertyValue -Object $row -Names @('id', 'pluginId', 'name'))
        if ([string]::Equals($id, 'platform-orchestrator', [System.StringComparison]::OrdinalIgnoreCase)) { $registeredPlatformPlugin = $row; break }
    }
    if ($registeredPlatformPlugin) {
        $platformPluginSourcePath = Get-PluginSourcePath -Record $registeredPlatformPlugin
        if (-not $platformPluginSourcePath) {
            $inspectLines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'inspect', 'platform-orchestrator', '--json') -Label 'Checking the existing platform-orchestrator plugin path'
            $inspectValue = ConvertFrom-JsonCommandOutput -Lines $inspectLines
            $platformPluginSourcePath = Get-PluginSourcePath -Record $inspectValue
        }
        if (-not $platformPluginSourcePath -or (Resolve-ComparablePath $platformPluginSourcePath) -ne (Resolve-ComparablePath (Join-Path $repoRoot 'multi-agent-orchestrator'))) {
            throw 'A different platform-orchestrator plugin is already registered. It was not overwritten; review it or remove it using the OpenClaw CLI before retrying.'
        }
    }

    $workspaceMap = @{
        'device-manager' = Join-Path $repoRoot 'device-manager\agent-workspace'
        'energy-saving' = Join-Path $repoRoot 'openclaw-agents\energy-saving'
        'learning-companion' = Join-Path $repoRoot 'openclaw-agents\learning-companion'
    }
    $createAgents = [System.Collections.Generic.List[string]]::new()
    foreach ($agentId in $projectAgentIds) {
        $row = Find-AgentRow -Rows $agentSummaries -Id $agentId
        if (-not $row) {
            $createAgents.Add($agentId)
            continue
        }
        $existingWorkspace = [string](Get-PropertyValue -Object $row -Names @('workspace', 'workspaceDir'))
        if (-not $existingWorkspace -or (Resolve-ComparablePath $existingWorkspace) -ne (Resolve-ComparablePath $workspaceMap[$agentId])) {
            throw "Agent '$agentId' already exists with a different workspace. It was left unchanged; resolve the workspace choice before retrying."
        }
    }

    $currentPluginAllowValue = Get-ConfigValue -Path 'plugins.allow' -Optional
    $hasExplicitPluginAllow = $null -ne $currentPluginAllowValue
    $currentPluginAllow = ConvertTo-StringArray -Value $currentPluginAllowValue -SettingName 'plugins.allow'
    $currentA2A = Get-ConfigValue -Path 'tools.agentToAgent' -Optional
    $currentA2AAllow = ConvertTo-StringArray -Value (Get-PropertyValue -Object $currentA2A -Names @('allow')) -SettingName 'tools.agentToAgent.allow'
    $requiredA2AIds = @($frontdoorId) + $projectAgentIds
    $unexpectedA2AIds = @($currentA2AAllow | Where-Object { $_ -notin $requiredA2AIds })
    if ($unexpectedA2AIds.Count -gt 0) {
        throw "The active profile already allows other Agent IDs through tools.agentToAgent.allow ($($unexpectedA2AIds -join ', ')). The installer will not broaden that shared policy; review it before retrying."
    }
    $preflightAgentListValue = Get-ConfigValue -Path 'agents.list' -Optional
    $preflightAgentList = @(Get-ObjectRows -Value $preflightAgentListValue)
    $frontdoorIndex = Find-AgentConfigIndex -Rows $preflightAgentList -Id $frontdoorId
    if ($frontdoorIndex -ge 0) {
        $frontdoorTools = Get-PropertyValue -Object $preflightAgentList[$frontdoorIndex] -Names @('tools')
        $frontdoorDeny = ConvertTo-StringArray -Value (Get-PropertyValue -Object $frontdoorTools -Names @('deny')) -SettingName "agents.list[$frontdoorIndex].tools.deny"
        if ($frontdoorDeny -contains $platformTool) {
            throw "The selected frontdoor Agent '$frontdoorId' explicitly denies $platformTool. It was not overridden."
        }
    }
    $existingDeviceManager = Find-AgentConfigIndex -Rows $preflightAgentList -Id 'device-manager'
    if ($existingDeviceManager -ge 0) {
        $managerTools = Get-PropertyValue -Object $preflightAgentList[$existingDeviceManager] -Names @('tools')
        $managerDeny = ConvertTo-StringArray -Value (Get-PropertyValue -Object $managerTools -Names @('deny')) -SettingName "agents.list[$existingDeviceManager].tools.deny"
        $blockedPluginTools = @($pluginTools | Where-Object { $_ -in $managerDeny })
        if ($blockedPluginTools.Count -gt 0) {
            throw "The existing device-manager Agent explicitly denies required plugin tools ($($blockedPluginTools -join ', ')). It was not overridden."
        }
    }
    $currentVisibility = Get-ConfigValue -Path 'tools.sessions.visibility' -Optional
    if ($null -eq $currentVisibility) { $currentVisibility = 'tree' }
    $visibilityNeedsWidening = [string]$currentVisibility -ne 'all'
    $unprotectedAgents = [System.Collections.Generic.List[string]]::new()
    if ($visibilityNeedsWidening) {
        foreach ($summary in $agentSummaries) {
            $agentId = [string](Get-PropertyValue -Object $summary -Names @('id', 'agentId'))
            if (-not $agentId -or $agentId -in $projectAgentIds -or $agentId -eq $frontdoorId) { continue }
            $configIndex = Find-AgentConfigIndex -Rows $preflightAgentList -Id $agentId
            if ($configIndex -lt 0) {
                $unprotectedAgents.Add("$agentId (no readable agents.list entry)")
                continue
            }
            $agentTools = Get-PropertyValue -Object $preflightAgentList[$configIndex] -Names @('tools')
            $agentDeny = ConvertTo-StringArray -Value (Get-PropertyValue -Object $agentTools -Names @('deny')) -SettingName "agents.list[$configIndex].tools.deny"
            $missingDeny = @($restrictedSessionTools | Where-Object { $_ -notin $agentDeny })
            if ($missingDeny.Count -gt 0) {
                $unprotectedAgents.Add("$agentId (does not explicitly deny: $($missingDeny -join ', '))")
            }
        }
        if ($unprotectedAgents.Count -gt 0) {
            throw "Changing tools.sessions.visibility from '$currentVisibility' to 'all' is a global expansion. These unrelated Agents are not proven to have session tools disabled: $($unprotectedAgents -join '; '). No backup or profile changes were made. Explicitly deny all sessions_list/sessions_history/sessions_send/sessions_spawn tools for those Agents, or have the profile owner review a different deployment plan."
        }
    }

    Write-Host ''
    Write-Host 'LT Agent stack deployment plan' -ForegroundColor Cyan
    Write-Host "  Active OpenClaw profile: $configPath"
    Write-Host "  OpenClaw version: $openClawVersion"
    Write-Host "  User-facing chat Agent: $frontdoorId"
    Write-Host "  Device-manager plugin source: $(Join-Path $repoRoot 'device-manager')"
    Write-Host "  Platform-orchestrator plugin source: $(Join-Path $repoRoot 'multi-agent-orchestrator')"
    Write-Host "  New Agent workspaces: $(if ($createAgents.Count) { $createAgents -join ', ' } else { 'none; existing matching workspaces will be reused' })"
    Write-Host "  Plugin tools made available to device-manager: $($pluginTools.Count)"
    Write-Host "  Main chat orchestration tool: $platformTool"
    Write-Host '  Legacy fixed frontdoor relay: explicitly denied for the main Agent'
    Write-Host "  Direct device-manager tools: all $($pluginTools.Count) explicitly denied for the frontdoor; household requests must use the platform orchestrator"
    if ($EnableSQLiteMemory) {
        if ($preserveImplicitMemoryDatabasePath) {
            Write-Host '  Household memory: SQLite enabled; existing runtime-default database path is preserved'
        }
        else {
            Write-Host "  Household memory: SQLite enabled (Node.js >=22.5); database: $resolvedMemoryDatabasePath"
        }
    }
    else {
        Write-Host '  Household memory: existing backend is preserved; JSON remains the default for new profiles'
    }
    if ($hasExplicitPluginAllow) {
        Write-Host "  Existing OpenClaw plugin allow entries preserved: $($currentPluginAllow.Count); device-manager and platform-orchestrator will be appended"
    }
    else {
        Write-Host '  OpenClaw has no explicit plugin allow list; its current default policy will be preserved'
    }
    Write-Host '  Multi-Agent access: project IDs will be added; unexpected existing Agent IDs are rejected'
    Write-Host '  Session tools: the frontdoor and child Agents will not get session list/history/send/spawn; device-manager keeps send only'
    if ($visibilityNeedsWidening) {
        Write-Host "  Session visibility change: $currentVisibility -> all (required by this A2A path); unrelated Agents were checked for explicit session-tool denial"
    }
    else {
        Write-Host '  Session visibility: already all; existing value will be preserved'
    }
    Write-Host '  Verification: local unit/Mock tests only; model and HA credentials are not used'

    if ($PlanOnly) {
        Write-Host 'Plan only: no packages were installed and no OpenClaw profile or workspace was modified.' -ForegroundColor Yellow
        exit 0
    }

    $confirmation = Read-Host 'To back up and apply this plan to the active OpenClaw profile, type INSTALL'
    if ($confirmation -cne 'INSTALL') {
        Write-Host 'Cancelled; nothing was installed.' -ForegroundColor Yellow
        exit 0
    }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backupPath = "$configPath.pre-lt-agent-program-$timestamp.bak"
    if (Test-Path -LiteralPath $backupPath) { throw 'The timestamped OpenClaw backup path already exists; refusing to overwrite it.' }
    Copy-Item -LiteralPath $configPath -Destination $backupPath
    Write-Host "OpenClaw config backup created: $backupPath" -ForegroundColor Green

    Write-Host 'Installing the device-manager Node.js dependency (scripts disabled)...' -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot 'device-manager')
    try {
        $null = Invoke-NativeCommand -Executable $npmPath -Arguments @('install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', '--package-lock=false') -Label 'Installing project dependencies'
    }
    finally { Pop-Location }

    Write-Host 'Installing the platform-orchestrator Node.js dependency (scripts disabled)...' -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot 'multi-agent-orchestrator')
    try {
        $null = Invoke-NativeCommand -Executable $npmPath -Arguments @('install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', '--package-lock=false') -Label 'Installing platform-orchestrator dependencies'
    }
    finally { Pop-Location }

    Write-Host 'Generating the OpenClaw platform-plugin metadata with the active Gateway CLI...' -ForegroundColor Cyan
    $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @(
        'plugins', 'build', '--root', (Join-Path $repoRoot 'multi-agent-orchestrator'), '--entry', './src/openclaw-platform-plugin.js'
    ) -Label 'Building platform-orchestrator plugin metadata'

    if (-not $registeredPlugin) {
        Write-Host 'Registering the linked device-manager plugin...' -ForegroundColor Cyan
        $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'install', '--link', (Join-Path $repoRoot 'device-manager')) -Label 'Installing the device-manager plugin'
    }
    $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'enable', 'device-manager') -Label 'Enabling the device-manager plugin'

    if (-not $registeredPlatformPlugin) {
        Write-Host 'Registering the linked platform-orchestrator plugin...' -ForegroundColor Cyan
        $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'install', '--link', (Join-Path $repoRoot 'multi-agent-orchestrator')) -Label 'Installing the platform-orchestrator plugin'
    }
    $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'enable', 'platform-orchestrator') -Label 'Enabling the platform-orchestrator plugin'

    foreach ($agentId in $createAgents) {
        Write-Host "Registering Agent workspace: $agentId" -ForegroundColor Cyan
        $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('agents', 'add', $agentId, '--workspace', $workspaceMap[$agentId], '--non-interactive') -Label "Registering $agentId"
    }

    # Re-read after plugin/Agent registration, which are themselves OpenClaw
    # config mutations, then build additive policy writes against fresh state.
    $freshAgentListValue = Get-ConfigValue -Path 'agents.list'
    $freshAgentList = @(Get-ObjectRows -Value $freshAgentListValue)
    $writes = [System.Collections.Generic.List[object]]::new()

    $freshPluginAllowValue = Get-ConfigValue -Path 'plugins.allow' -Optional
    if ($null -ne $freshPluginAllowValue) {
        $pluginAllow = Add-UniqueStrings -Existing (ConvertTo-StringArray -Value $freshPluginAllowValue -SettingName 'plugins.allow') -Additions @('device-manager', 'platform-orchestrator')
        Add-ConfigWrite -Writes $writes -Path 'plugins.allow' -Value $pluginAllow
    }

    Add-ConfigWrite -Writes $writes -Path 'plugins.entries.device-manager.config.frontdoorAgentId' -Value $frontdoorId
    if ($EnableSQLiteMemory) {
        Add-ConfigWrite -Writes $writes -Path 'plugins.entries.device-manager.config.memoryBackend' -Value 'sqlite'
        if (-not $preserveImplicitMemoryDatabasePath) {
            Add-ConfigWrite -Writes $writes -Path 'plugins.entries.device-manager.config.memoryDatabasePath' -Value $resolvedMemoryDatabasePath
        }
    }
    Add-ConfigWrite -Writes $writes -Path 'plugins.entries.platform-orchestrator.config.frontdoorAgentId' -Value $frontdoorId

    $freshA2A = Get-ConfigValue -Path 'tools.agentToAgent' -Optional
    $a2aAdditions = @($frontdoorId) + $projectAgentIds
    $a2aAllow = Add-UniqueStrings -Existing (ConvertTo-StringArray -Value (Get-PropertyValue -Object $freshA2A -Names @('allow')) -SettingName 'tools.agentToAgent.allow') -Additions $a2aAdditions
    Add-ConfigWrite -Writes $writes -Path 'tools.agentToAgent.enabled' -Value $true
    Add-ConfigWrite -Writes $writes -Path 'tools.agentToAgent.allow' -Value $a2aAllow
    Add-ConfigWrite -Writes $writes -Path 'tools.sessions.visibility' -Value 'all'

    $agentToolPolicy = @(
        # The main Agent must not bypass orchestration by calling device-manager tools directly.
        @{ Id = $frontdoorId; Allow = @($platformTool); Deny = @('talk_to_device_manager') + $pluginTools + $restrictedSessionTools },
        @{ Id = 'device-manager'; Allow = $pluginTools; Deny = @('sessions_list', 'sessions_history', 'sessions_spawn') },
        @{ Id = 'energy-saving'; Allow = @(); Deny = $restrictedSessionTools },
        @{ Id = 'learning-companion'; Allow = @(); Deny = $restrictedSessionTools }
    )
    foreach ($policy in $agentToolPolicy) {
        $index = Find-AgentConfigIndex -Rows $freshAgentList -Id $policy.Id
        if ($index -lt 0) { throw "OpenClaw did not expose Agent '$($policy.Id)' in agents.list after registration; config changes were not applied. Backup: $backupPath" }
        $entry = $freshAgentList[$index]
        $tools = Get-PropertyValue -Object $entry -Names @('tools')
        $alsoAllow = ConvertTo-StringArray -Value (Get-PropertyValue -Object $tools -Names @('alsoAllow')) -SettingName "agents.list[$index].tools.alsoAllow"
        $deny = ConvertTo-StringArray -Value (Get-PropertyValue -Object $tools -Names @('deny')) -SettingName "agents.list[$index].tools.deny"
        if ($policy.Allow.Count -gt 0) {
            $mergedAllow = Add-UniqueStrings -Existing $alsoAllow -Additions $policy.Allow
            Add-ConfigWrite -Writes $writes -Path "agents.list[$index].tools.alsoAllow" -Value $mergedAllow
        }
        $mergedDeny = Add-UniqueStrings -Existing $deny -Additions $policy.Deny
        Add-ConfigWrite -Writes $writes -Path "agents.list[$index].tools.deny" -Value $mergedDeny
    }

    Write-Host 'Validating the planned OpenClaw config changes...' -ForegroundColor Cyan
    foreach ($write in $writes) {
        $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('config', 'set', $write.Path, $write.Json, '--strict-json', '--dry-run') -Label "Validating $($write.Path)"
    }
    foreach ($write in $writes) {
        $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('config', 'set', $write.Path, $write.Json, '--strict-json') -Label "Updating $($write.Path)"
    }
    $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('config', 'validate') -Label 'Validating the installed OpenClaw configuration'
    Write-Host 'OpenClaw plugin, Agent workspaces and additive tool policies are configured.' -ForegroundColor Green

    $gatewayReloaded = $false
    if (-not $SkipGatewayRestartPrompt) {
        $restartAnswer = Read-Host '需要现在安全重启 Gateway 以加载插件吗？活动任务会先等待排空 [y/N]'
        if ($restartAnswer -match '^(?i)y(es)?$') {
            try {
                $null = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('gateway', 'restart', '--safe') -Label 'Safely restarting the OpenClaw Gateway'
                $gatewayReloaded = $true
                $inspectLines = Invoke-NativeCommand -Executable $script:openclawPath -Arguments @('plugins', 'inspect', 'platform-orchestrator', '--runtime') -Label 'Checking platform plugin runtime registration'
                $inspectText = $inspectLines -join "`n"
                if ($inspectText -match '(?i)\bloaded\b') {
                    Write-Host 'Runtime inspection reports the platform-orchestrator plugin loaded.' -ForegroundColor Green
                }
                else {
                    Write-Host 'Runtime inspection completed; review OpenClaw plugin status if tools are not visible.' -ForegroundColor Yellow
                }
            }
            catch {
                Write-Host 'Gateway restart/runtime check did not complete. The install remains configured; restart it later with: openclaw gateway restart --safe' -ForegroundColor Yellow
            }
        }
        else {
            Write-Host 'Gateway was not restarted. The next safe Gateway restart is needed before the new tools become visible.' -ForegroundColor Yellow
        }
    }

    if (-not $SkipMockVerification) {
        Write-Host 'Running the project local/Mock verification with the Mock backend forced for this process...' -ForegroundColor Cyan
        $environmentNames = @('DEVICE_MANAGER_BACKEND', 'HA_URL', 'HA_TOKEN', 'HA_ENTITY_ALLOWLIST', 'HA_CONFIRMATION_REQUIRED_ENTITIES')
        $oldEnvironment = @{}
        foreach ($name in $environmentNames) {
            $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
        try {
            [Environment]::SetEnvironmentVariable('DEVICE_MANAGER_BACKEND', 'mock', 'Process')
            foreach ($name in @('HA_URL', 'HA_TOKEN', 'HA_ENTITY_ALLOWLIST', 'HA_CONFIRMATION_REQUIRED_ENTITIES')) {
                [Environment]::SetEnvironmentVariable($name, $null, 'Process')
            }
            $powershellPath = Get-ExecutablePath -Name 'powershell'
            $verifyArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'Verify-Agent-Stack.ps1'))
            $null = Invoke-NativeCommand -Executable $powershellPath -Arguments $verifyArgs -Label 'Running local/Mock verification'
        }
        finally {
            foreach ($name in $environmentNames) {
                [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
            }
        }
        Write-Host 'Local/Mock verification passed.' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host 'Deployment steps completed.' -ForegroundColor Green
    Write-Host "Config backup: $backupPath"
    if (-not $gatewayReloaded) { Write-Host 'Gateway reload: pending; run openclaw gateway restart --safe when ready.' -ForegroundColor Yellow }
    Write-Host 'No model API was called. Device backend remains Mock unless separately changed by the operator.'
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    if ($backupPath) { Write-Warning "OpenClaw backup retained at: $backupPath. No automatic rollback was attempted." }
    exit 1
}
