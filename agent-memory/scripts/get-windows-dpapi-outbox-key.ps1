param(
  [Parameter(Mandatory = $true)]
  [string] $KeyFile
)

$ErrorActionPreference = 'Stop'

function Write-UnprotectedKey {
  param([string] $Path)

  $protectedValue = [System.IO.File]::ReadAllText($Path).Trim()
  $secureValue = ConvertTo-SecureString -String $protectedValue
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    $plainValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    [Console]::Out.Write($plainValue)
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($null -ne $secureValue) {
      $secureValue.Dispose()
    }
  }
}

$resolvedPath = [System.IO.Path]::GetFullPath($KeyFile)
$parentPath = [System.IO.Path]::GetDirectoryName($resolvedPath)
$null = [System.IO.Directory]::CreateDirectory($parentPath)

if ([System.IO.File]::Exists($resolvedPath)) {
  Write-UnprotectedKey -Path $resolvedPath
  exit 0
}

$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$keyBytes = New-Object byte[] 32
$secureKey = $null
$temporaryPath = $null
$racedWithExistingKey = $false
try {
  $random.GetBytes($keyBytes)
  $keyText = [System.Convert]::ToBase64String($keyBytes)
  $secureKey = ConvertTo-SecureString -String $keyText -AsPlainText -Force
  $protectedKey = ConvertFrom-SecureString -SecureString $secureKey
  $temporaryPath = "$resolvedPath.$([Guid]::NewGuid().ToString('N')).tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporaryPath, $protectedKey, $utf8NoBom)

  try {
    [System.IO.File]::Move($temporaryPath, $resolvedPath)
    $temporaryPath = $null
  }
  catch {
    if ([System.IO.File]::Exists($resolvedPath)) {
      [System.IO.File]::Delete($temporaryPath)
      $temporaryPath = $null
      Write-UnprotectedKey -Path $resolvedPath
      $racedWithExistingKey = $true
    }
    else {
      throw
    }
  }

  if (-not $racedWithExistingKey) {
    [Console]::Out.Write($keyText)
  }
}
finally {
  if ($null -ne $temporaryPath -and [System.IO.File]::Exists($temporaryPath)) {
    [System.IO.File]::Delete($temporaryPath)
  }
  if ($null -ne $secureKey) {
    $secureKey.Dispose()
  }
  [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
  $random.Dispose()
}
