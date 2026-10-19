[CmdletBinding()]
param(
  [string]$FrontendPath = (Join-Path (Split-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path -Parent) 'NextFrontend-Ecommerce')
)

$ErrorActionPreference = 'Stop'
$BackendRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$FrontendRoot = (Resolve-Path $FrontendPath).Path
$BundleRoot = Join-Path $env:TEMP ("belorella-release-" + [guid]::NewGuid().ToString('N'))
$BackendStage = Join-Path $BundleRoot 'backend'
$FrontendStage = Join-Path $BundleRoot 'frontend'
$ZipPath = Join-Path $env:TEMP ("belorella-release-" + [guid]::NewGuid().ToString('N') + '.zip')

function Copy-TrackedWorkspaceFiles([string]$RepoRoot, [string]$StageRoot, [string]$Kind) {
  New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
  $files = & git -C $RepoRoot ls-files --cached --others --exclude-standard
  if ($LASTEXITCODE -ne 0) { throw "Could not list $Kind workspace files." }

  foreach ($relativePath in $files) {
    $normalized = $relativePath.Replace('\', '/')
    $fileName = [System.IO.Path]::GetFileName($normalized)
    if ($fileName -eq '.env' -or ($fileName.StartsWith('.env.') -and $fileName -ne '.env.example') -or
        $normalized -match '(^|/)(node_modules|\.next|\.git|coverage|\.turbo)(/|$)' -or
        $normalized -match '(^|/)AGENTS\.md$' -or
        $normalized -match '(^|/)\.codex(/|$)' -or
        $normalized -match '\.(pem|p12|pfx|key)$' -or
        $normalized -eq 'public/2026-10-18 23-45-25.mp4') {
      continue
    }

    $source = Join-Path $RepoRoot $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $destination = Join-Path $StageRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    if ($destinationDirectory) { New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}

try {
  Copy-TrackedWorkspaceFiles $BackendRoot $BackendStage 'backend'
  Copy-TrackedWorkspaceFiles $FrontendRoot $FrontendStage 'frontend'
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $BundleRoot -Recurse -File | ForEach-Object {
      $relativePath = $_.FullName.Substring($BundleRoot.Length).TrimStart([char[]]@(92, 47)).Replace([string][char]92, '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $relativePath,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
  $item = Get-Item -LiteralPath $ZipPath
  Write-Output "BundlePath=$($item.FullName)"
  Write-Output "BundleSizeBytes=$($item.Length)"
} catch {
  if (Test-Path -LiteralPath $BundleRoot) { Remove-Item -LiteralPath $BundleRoot -Recurse -Force }
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  throw
}
