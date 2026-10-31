param(
    [string]$PackageVersion = "0.1.34"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $repoRoot "output\deployment"
$packageName = "LT-agent-program-deployment-v$PackageVersion"
$finalDirectory = Join-Path $artifactRoot $packageName
$archivePath = Join-Path $artifactRoot "$packageName.zip"
$buildDirectory = Join-Path $artifactRoot "$packageName.building"
$buildingArchive = Join-Path $artifactRoot "$packageName.building.zip"
. (Join-Path $PSScriptRoot 'Package-Exclusions.ps1')
. (Join-Path $PSScriptRoot 'Package-Archive.ps1')

foreach ($path in @($finalDirectory, $archivePath, $buildDirectory, $buildingArchive)) {
    if (Test-Path -LiteralPath $path) {
        throw "Refusing to overwrite an existing package artifact: $path"
    }
}

$null = New-Item -ItemType Directory -Path $artifactRoot -Force
$null = New-Item -ItemType Directory -Path $buildDirectory

function Test-ExcludedDirectory {
    param([string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/')
    $segments = $normalized.Split('/')
    if ($segments | Where-Object { $_ -in @('.git', 'node_modules', 'node-compile-cache', 'output', 'outputs', 'tmp', 'extracted', 'rendered_ppt') }) {
        return $true
    }
    if ($normalized -match '^device-manager/agent-workspace/memory(?:/|$)') {
        return $true
    }
    return $false
}

function Copy-FilteredTree {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$RelativeDirectory
    )

    $sourcePath = Join-Path $repoRoot $RelativeDirectory
    $destinationPath = Join-Path $buildDirectory $RelativeDirectory
    $null = New-Item -ItemType Directory -Path $destinationPath -Force

    foreach ($item in Get-ChildItem -LiteralPath $sourcePath -Force) {
        $relativePath = "$RelativeDirectory/$($item.Name)"
        if ($item.PSIsContainer) {
            if (Test-ExcludedDirectory -RelativePath $relativePath) { continue }
            Copy-FilteredTree -SourceDirectory $item.FullName -RelativeDirectory $relativePath
            continue
        }

        if (Test-ExcludedPackageFile -RelativePath $relativePath) { continue }
        $targetPath = Join-Path $buildDirectory $relativePath
        $targetParent = Split-Path -Parent $targetPath
        $null = New-Item -ItemType Directory -Path $targetParent -Force
        Copy-Item -LiteralPath $item.FullName -Destination $targetPath
    }
}

try {
    $sourceTrees = @(
        "common-contracts",
        "device-manager",
        "energy-saving",
        "agent-memory",
        "multi-agent-orchestrator",
        "openclaw-agents"
    )
    foreach ($tree in $sourceTrees) {
        Copy-FilteredTree -SourceDirectory (Join-Path $repoRoot $tree) -RelativeDirectory $tree
    }

    # Pin deployment copies of both OpenClaw plugins to the team's agreed
    # runtime without mutating the source package metadata.
    $deviceManagerPackage = Join-Path $buildDirectory "device-manager\package.json"
    $deviceManagerPackageText = [System.IO.File]::ReadAllText($deviceManagerPackage)
    $sourcePeerVersion = '"openclaw": ">=2026.5.17"'
    $pinnedPeerVersion = '"openclaw": "2026.7.1-2"'
    $pinnedPackageText = $deviceManagerPackageText.Replace($sourcePeerVersion, $pinnedPeerVersion)
    if ($pinnedPackageText -eq $deviceManagerPackageText) {
        throw "Could not pin bundled device-manager peer dependency to OpenClaw 2026.7.1-2."
    }
    [System.IO.File]::WriteAllText($deviceManagerPackage, $pinnedPackageText, [System.Text.UTF8Encoding]::new($false))

    $platformPackage = Join-Path $buildDirectory "multi-agent-orchestrator\package.json"
    $platformPackageText = [System.IO.File]::ReadAllText($platformPackage)
    $platformSourcePeer = '"openclaw": ">=2026.7.1-2"'
    $platformPinnedPeer = '"openclaw": "2026.7.1-2"'
    $platformPinnedPackageText = $platformPackageText.Replace($platformSourcePeer, $platformPinnedPeer)
    if ($platformPinnedPackageText -eq $platformPackageText) {
        throw "Could not pin bundled platform-orchestrator peer dependency to OpenClaw 2026.7.1-2."
    }
    [System.IO.File]::WriteAllText($platformPackage, $platformPinnedPackageText, [System.Text.UTF8Encoding]::new($false))

    foreach ($relativePath in @(
        "learning-behavior/package.json"
    )) {
        $sourcePath = Join-Path $repoRoot $relativePath
        $targetPath = Join-Path $buildDirectory $relativePath
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }
    foreach ($tree in @("learning-behavior/src", "learning-behavior/test")) {
        Copy-FilteredTree -SourceDirectory (Join-Path $repoRoot $tree) -RelativeDirectory $tree
    }

    Copy-Item -LiteralPath (Join-Path $repoRoot "Verify-Agent-Stack.ps1") -Destination $buildDirectory
    Copy-Item -LiteralPath (Join-Path $repoRoot "Install-Agent-Stack.cmd") -Destination $buildDirectory
    $quickStartFile = Get-Item -LiteralPath (Join-Path $PSScriptRoot "README-快速开始.md") -ErrorAction SilentlyContinue
    if (-not $quickStartFile) { $quickStartFile = Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter "README-*.md" | Select-Object -First 1 }
    if (-not $quickStartFile) { throw "Deployment quick-start document README-*.md is missing." }
    Copy-Item -LiteralPath $quickStartFile.FullName -Destination (Join-Path $buildDirectory $quickStartFile.Name)
    foreach ($markdownFile in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter "*.md") {
        $targetPath = Join-Path $buildDirectory $markdownFile.Name
        Copy-Item -LiteralPath $markdownFile.FullName -Destination $targetPath
    }
    foreach ($relativePath in @(
        "deployment/Install-Agent-Stack.ps1",
        "deployment/install-agent-stack.mjs",
        "deployment/install-agent-stack.test.mjs",
        "deployment/verify-agent-stack.mjs",
        "deployment/Package-Exclusions.ps1",
        "deployment/Package-Archive.ps1",
        "deployment/Run-Agent-Integration-Demo.ps1",
        "deployment/Verify-Agent-Integration.ps1",
        "deployment/Test-DeploymentPackage.ps1"
    )) {
        $sourcePath = Join-Path $repoRoot $relativePath
        $targetPath = Join-Path $buildDirectory $relativePath
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }
    $deliverableDocs = @(
        "docs/agent-action-confirmation-policy-v0.1.md",
        "docs/agent-plan-validation-v0.1.md",
        "docs/agent-trigger-and-memory-policy.md",
        "docs/device-inventory-onboarding-v0.1.md",
        "docs/device-manager-energy-agent-functional-spec-v0.1.md",
        "docs/energy-operations-and-maintenance-mock-mvp-v0.1.md",
        "docs/energy-operations-openclaw-tools-and-maintenance-store-v0.1.md",
        "docs/household-memory-sqlite-backend-v0.1.md",
        "docs/household-memory-sqlite-backup-v0.1.md",
        "docs/linux-development-and-validation.md",
        "docs/openclaw-independent-agent-orchestration-v0.1.md",
        "docs/openclaw-platform-multi-agent-orchestration-v0.1.md",
        "docs/persistent-device-event-ledger-v0.1.md"
    )
    foreach ($relativePath in $deliverableDocs) {
        $sourcePath = Join-Path $repoRoot $relativePath
        $targetPath = Join-Path $buildDirectory $relativePath
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }

    # Make bundled component documentation portable without editing source files.
    $legacyRepositoryPath = 'C:\Users\QVQ\Documents\ChatGPT\LT-agent-program'
    $legacyOpenClawCommand = '$deviceManagerOpenClaw = "C:\Users\QVQ\AppData\Roaming\npm\openclaw.cmd"'
    $portableOpenClawCommand = '$deviceManagerOpenClaw = (Get-Command openclaw -ErrorAction Stop).Source'
    foreach ($markdownFile in Get-ChildItem -LiteralPath $buildDirectory -Recurse -File -Filter "*.md") {
        $content = [System.IO.File]::ReadAllText($markdownFile.FullName)
        $content = $content.Replace($legacyRepositoryPath, ".")
        $content = $content.Replace($legacyOpenClawCommand, $portableOpenClawCommand)
        [System.IO.File]::WriteAllText($markdownFile.FullName, $content, [System.Text.UTF8Encoding]::new($false))
    }

    $excludedSummary = @(
        "LT-agent-program deployment package v$PackageVersion",
        "Source: current repository working tree at packaging time (may include uncommitted code changes).",
        "Included: common-contracts, device-manager, energy-saving, agent-memory, multi-agent-orchestrator, learning-behavior source/tests, OpenClaw agent templates, Linux and Windows local verification/install scripts, deployment handbooks, and selected technical acceptance documents.",
        "Excluded: Git metadata; local credentials/config/logs; SQLite databases and WAL/SHM/journal sidecars; node_modules and caches; household and OpenClaw workspace diary/profile memory; SCB images/raw archives/annotation workbooks/results; generated reports; project meeting and task-allocation source documents; the source lockfile that resolved a different OpenClaw version.",
        "No API keys, Home Assistant tokens, OpenClaw state, or real household data are intentionally included.",
        "",
        "Files in this package:"
    )
    $fileList = Get-ChildItem -LiteralPath $buildDirectory -Recurse -File |
        ForEach-Object { $_.FullName.Substring($buildDirectory.Length + 1).Replace('\', '/') } |
        Sort-Object
    $fileList = @($fileList) + "PACKAGE_MANIFEST.txt"
    [System.IO.File]::WriteAllLines(
        (Join-Path $buildDirectory "PACKAGE_MANIFEST.txt"),
        [string[]]($excludedSummary + $fileList),
        [System.Text.UTF8Encoding]::new($false)
    )

    New-PortableZipArchive -SourceDirectory $buildDirectory -ArchivePath $buildingArchive
    Move-Item -LiteralPath $buildDirectory -Destination $finalDirectory
    Move-Item -LiteralPath $buildingArchive -Destination $archivePath

    $archiveInfo = Get-Item -LiteralPath $archivePath
    $includedFileCount = (Get-ChildItem -LiteralPath $finalDirectory -Recurse -File | Measure-Object).Count
    Write-Host "Package directory: $finalDirectory"
    Write-Host "ZIP archive: $archivePath"
    Write-Host "Files: $includedFileCount"
    Write-Host "ZIP size (MB): $([math]::Round($archiveInfo.Length / 1MB, 2))"
}
catch {
    Write-Error "Package build failed. Any .building artifacts were preserved for inspection: $($_.Exception.Message)"
    throw
}
