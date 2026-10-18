# Build a throwaway DSH_HOME for the end-to-end tests.
#
# `Copy-Item -Recurse` is the obvious way to do this and it is a trap: a profile's
# node_modules holds junctions into the harness install and the pnpm store, so
# copying a 3 MB home silently becomes ~900 MB across 50k files and takes
# minutes. The end-to-end runs need the credentials, the profile's own files and
# the single junction that points at this plugin -- nothing else.
#
# Usage:
#   pwsh -File test/mk-test-home.ps1 -Path D:\A\DSH-L\agent\home-mini-t
#
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Source = 'D:\A\DSH-L\agent\home',
  [string]$Profile = 'call',
  [string]$Plugin = 'D:\A\DSH-L\projects\dsh-hippo'
)

$ErrorActionPreference = 'Stop'

if (Test-Path $Path) { Remove-Item $Path -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $Path "profiles\$Profile") -Force | Out-Null

Copy-Item (Join-Path $Source '.credentials.yaml') $Path -Force
foreach ($extra in @('.anonymous-user-id')) {
  $from = Join-Path $Source $extra
  if (Test-Path $from) { Copy-Item $from $Path -Force }
}

# The profile's own files, without anything under node_modules.
$from = Join-Path $Source "profiles\$Profile"
$to = Join-Path $Path "profiles\$Profile"
& robocopy $from $to /E /XD node_modules /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }

New-Item -ItemType Directory -Path (Join-Path $to 'node_modules') -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $to 'node_modules\dsh-hippo') -Target $Plugin | Out-Null

$size = (Get-ChildItem $Path -Recurse -Force | Measure-Object -Property Length -Sum)
Write-Host "$Path ready: $([math]::Round($size.Sum / 1MB, 2)) MB / $($size.Count) files"
Get-ChildItem $Path -Force | Select-Object -ExpandProperty Name