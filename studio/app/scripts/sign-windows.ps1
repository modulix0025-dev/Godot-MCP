# SPDX-License-Identifier: Apache-2.0
#
# Authenticode signing for every binary Tauri bundles (bundle.windows.signCommand -> this script with the file).
# The certificate comes from the CI secret store only: MODULEX_SIGN_PFX (a temp file decoded from the
# WINDOWS_SIGNING_PFX_BASE64 secret) and MODULEX_SIGN_PFX_PASSWORD. Nothing here is ever committed or logged.
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

if (-not $env:MODULEX_SIGN_PFX -or -not (Test-Path $env:MODULEX_SIGN_PFX)) { throw 'MODULEX_SIGN_PFX is not set' }
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found (Windows SDK)' }

& $signtool.FullName sign /f $env:MODULEX_SIGN_PFX /p $env:MODULEX_SIGN_PFX_PASSWORD `
  /fd sha256 /tr 'http://timestamp.digicert.com' /td sha256 /d 'ModuleX Game Studio' $File | Out-Null
if ($LASTEXITCODE -ne 0) { throw "signtool failed for $File (exit $LASTEXITCODE)" }
$sig = Get-AuthenticodeSignature $File
if ($sig.Status -ne 'Valid') { throw "signature on $File is $($sig.Status)" }
"signed: $(Split-Path $File -Leaf)"
