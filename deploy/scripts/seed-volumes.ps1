# Copy data you already have on this machine into the Docker volumes, so the
# stack starts without re-downloading ~6 GB of models or re-indexing textbooks:
#   - Ollama models        %USERPROFILE%\.ollama\models  -> volume "ollama"
#   - NCERT ChromaDB index data\chroma                   -> volume "ncert-chroma"
#   - NCERT PDFs           data\ncert_pdfs               -> volume "ncert-pdfs"
#   - Kokoro voice model   data\kokoro                   -> volume "voice-kokoro"
# Safe to re-run: it only fills volumes that are still empty.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File deploy\scripts\seed-volumes.ps1
# Copyright (c) 2026 PacificAI. All rights reserved.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = 'hellocrew'

# Volume -> source folder on this machine, the path inside the volume, and the owner uid.
$seeds = @(
  @{ Volume = 'ollama';       Source = Join-Path $env:USERPROFILE '.ollama\models'; Dest = 'models'; Owner = '0' },
  @{ Volume = 'ncert-chroma'; Source = Join-Path $root 'data\chroma';               Dest = '';       Owner = '10001' },
  @{ Volume = 'ncert-pdfs';   Source = Join-Path $root 'data\ncert_pdfs';           Dest = '';       Owner = '10001' },
  @{ Volume = 'voice-kokoro'; Source = Join-Path $root 'data\kokoro';               Dest = '';       Owner = '10001' }
)

foreach ($s in $seeds) {
  $name = "${project}_$($s.Volume)"
  if (-not (Test-Path $s.Source)) { Write-Host "skip  $name (no $($s.Source))"; continue }
  docker volume create --label "com.docker.compose.project=$project" --label "com.docker.compose.volume=$($s.Volume)" $name | Out-Null
  $count = docker run --rm -v "${name}:/dst" alpine sh -c 'find /dst -mindepth 1 | head -1 | wc -l'
  if ([int]$count -gt 0) { Write-Host "keep  $name (already has data)"; continue }
  Write-Host "seed  $name  <-  $($s.Source)"
  docker run --rm -v "${name}:/dst" -v "$($s.Source):/src:ro" alpine sh -c "mkdir -p /dst/$($s.Dest) && cp -a /src/. /dst/$($s.Dest)/ && chown -R $($s.Owner):$($s.Owner) /dst"
  if ($LASTEXITCODE -ne 0) { throw "Copying into $name failed" }
}
Write-Host 'Done. Start the stack with: docker compose up -d'
