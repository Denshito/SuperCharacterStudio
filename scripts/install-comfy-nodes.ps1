param(
  [string]$CustomNodesPath = 'D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes'
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\integrations\comfy\ComfyUI-TACharacterTools')).Path
$target = Join-Path $CustomNodesPath 'ComfyUI-TACharacterTools'
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Node source not found: $source" }
if (-not (Test-Path -LiteralPath $CustomNodesPath -PathType Container)) { throw "ComfyUI custom_nodes directory not found: $CustomNodesPath" }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object { $_.FullName -notmatch '\\__pycache__\\|\.pyc$' } | ForEach-Object {
  $relative = $_.FullName.Substring($source.Length).TrimStart('\')
  $destination = Join-Path $target $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
Write-Host "Synced to $target. Fully exit and restart Comfy Desktop to load the update."
