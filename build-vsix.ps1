param(
  [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

npm run build:vsix

$vsix = Get-ChildItem -Path $OutputDir -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
  throw "No VSIX file found in $OutputDir"
}

Write-Host "VSIX generated:" -ForegroundColor Green
Write-Host $vsix.FullName
