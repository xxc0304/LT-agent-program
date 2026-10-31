function New-PortableZipArchive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$ArchivePath
    )

    $sourcePath = [System.IO.Path]::GetFullPath($SourceDirectory)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "ZIP source directory does not exist: $sourcePath"
    }
    $destinationPath = [System.IO.Path]::GetFullPath($ArchivePath)
    if (Test-Path -LiteralPath $destinationPath) {
        throw "Refusing to overwrite an existing ZIP archive: $destinationPath"
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open(
        $destinationPath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($file in Get-ChildItem -LiteralPath $sourcePath -Recurse -File) {
            $entryName = $file.FullName.Substring($sourcePath.Length + 1).Replace('\', '/')
            if ($entryName.Contains('\')) {
                throw "ZIP entry path was not normalized: $entryName"
            }
            $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $file.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
        }
    }
    finally {
        $archive.Dispose()
    }
}
