function Test-ExcludedPackageFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/')
    $name = [System.IO.Path]::GetFileName($normalized)
    $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()

    if ($normalized -eq 'device-manager/package-lock.json') {
        return $true
    }
    if ($normalized -match '^device-manager/agent-workspace/(DREAMS|MEMORY)\.md$' -or
        $normalized -match '^(?:device-manager/agent-workspace|openclaw-agents/[^/]+)/USER\.md$') {
        return $true
    }
    if ($name -eq 'openclaw-workspace-state.json') {
        return $true
    }
    if ($name -match '^(\.env($|\.)|credentials\.json$|family-memory.*|.*\.(log|pem|key)$)') {
        return $true
    }
    if ($name -match '(?i)(?:\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm|journal))?|-wal|-shm|-journal)$') {
        return $true
    }
    if ($normalized -match '^(learning-behavior/README\.md|multi-agent-orchestrator/README\.md)$' -or
        $normalized -match '(^|/)(ACCEPTANCE_REPORT|SCENE_PILOT_REVIEW|EVALUATION_REVIEW).*\.md$') {
        return $true
    }
    if ($extension -in @('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.mp4', '.mov', '.avi', '.zip', '.xlsx', '.docx', '.pdf')) {
        return $true
    }
    return $false
}
