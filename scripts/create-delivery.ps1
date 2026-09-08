param(
  [string]$DeliveryRoot = 'E:\AIEval\Delivery'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$msi = Join-Path $repo 'src-tauri\target\release\bundle\msi\TA Character Studio_0.1.0_x64_en-US.msi'
$nsis = Join-Path $repo 'src-tauri\target\release\bundle\nsis\TA Character Studio_0.1.0_x64-setup.exe'
if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or -not (Test-Path -LiteralPath $nsis -PathType Leaf)) { throw 'Build MSI and NSIS with npm.cmd run bundle first.' }

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$staging = Join-Path ([IO.Path]::GetTempPath()) "ta-character-delivery-$stamp"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $sourceStage = Join-Path $staging 'TACharacterStudio'
  New-Item -ItemType Directory -Path $sourceStage | Out-Null
  $files = & git -C $repo ls-files --cached --others --exclude-standard
  foreach ($relative in $files) {
    $source = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $target = Join-Path $sourceStage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }

  $installers = Join-Path $DeliveryRoot 'Installers'
  $sources = Join-Path $DeliveryRoot 'Source'
  $documentation = Join-Path $DeliveryRoot 'Documentation'
  $finalAnswer = Join-Path $DeliveryRoot 'FinalAnswer'
  $demoVideo = Join-Path $DeliveryRoot 'DemoVideo'
  New-Item -ItemType Directory -Force -Path $installers, $sources, $documentation, $finalAnswer, $demoVideo | Out-Null
  Copy-Item -LiteralPath $msi -Destination (Join-Path $installers 'TACharacterStudio_x64.msi') -Force
  Copy-Item -LiteralPath $nsis -Destination (Join-Path $installers 'TACharacterStudio_x64-setup.exe') -Force
  Compress-Archive -Path $sourceStage -DestinationPath (Join-Path $sources 'TACharacterStudio-source.zip') -Force
  Compress-Archive -Path (Join-Path $sourceStage 'pipeline\*') -DestinationPath (Join-Path $sources 'TACharacterPipeline-source.zip') -Force
  $ueRoot = Join-Path (Split-Path -Parent $repo) 'Eval_Commiting'
  if (Test-Path -LiteralPath (Join-Path $ueRoot 'Eval_Commiting.uproject') -PathType Leaf) {
    $ueStage = Join-Path $staging 'Eval_Commiting'
    New-Item -ItemType Directory -Path $ueStage | Out-Null
    Copy-Item -LiteralPath (Join-Path $ueRoot 'Eval_Commiting.uproject') -Destination $ueStage
    foreach ($folder in 'Config', 'Content') {
      $sourceFolder = Join-Path $ueRoot $folder
      if (Test-Path -LiteralPath $sourceFolder -PathType Container) { Copy-Item -LiteralPath $sourceFolder -Destination $ueStage -Recurse }
    }
    Compress-Archive -Path $ueStage -DestinationPath (Join-Path $sources 'Eval_Commiting-UE.zip') -Force
  }
  Copy-Item -LiteralPath (Join-Path $repo 'README.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'PROJECT_STATUS_AND_ROADMAP.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'THIRD_PARTY_NOTICES.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'docs\ARTIST_GUIDE.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'docs\TROUBLESHOOTING.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'docs\MANUAL_ACCEPTANCE.md') -Destination $documentation -Force
  Copy-Item -LiteralPath (Join-Path $repo 'PROJECT_STATUS_AND_ROADMAP.md') -Destination (Join-Path $finalAnswer 'PROJECT_STATUS_AND_ROADMAP.md') -Force
  Copy-Item -LiteralPath (Join-Path $repo 'docs\MANUAL_ACCEPTANCE.md') -Destination (Join-Path $demoVideo 'RECORDING_AND_ACCEPTANCE_CHECKLIST.md') -Force

  $hashes = Get-ChildItem -LiteralPath $installers, $sources -File | Sort-Object FullName | ForEach-Object { '{0} *{1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(), $_.Name }
  [IO.File]::WriteAllLines((Join-Path $DeliveryRoot 'checksums.sha256'), $hashes, [Text.UTF8Encoding]::new($false))
  Write-Host "Delivery created at $DeliveryRoot"
}
finally {
  if (Test-Path -LiteralPath $staging) {
    $resolvedStage = (Resolve-Path -LiteralPath $staging).Path
    $resolvedTemp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
    if (-not $resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe staging path: $resolvedStage" }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
