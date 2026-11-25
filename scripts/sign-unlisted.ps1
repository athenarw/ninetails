# Sign Ninetails as a private (unlisted) add-on through addons.mozilla.org.
#
# Mozilla checks the code automatically and returns a signed .xpi. The add-on is
# NOT listed publicly; only people you give the file to can install it.
# Your API key/secret are asked for each time and never written to disk.
# Get them at https://addons.mozilla.org/developers/addon/api/key/
#
# Needs Node.js (https://nodejs.org or: winget install -e --id OpenJS.NodeJS.LTS)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# A window opened before Node was installed has an old PATH; reload it from the system.
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (Test-Path "$env:ProgramFiles\nodejs\npx.cmd") { $env:Path = "$env:ProgramFiles\nodejs;" + $env:Path }
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Install it with:  winget install -e --id OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    exit 1
}

function Read-Secret($prompt) {
    $s = Read-Host $prompt -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$manifest = Get-Content extension\manifest.json -Raw | ConvertFrom-Json
Write-Host "Signing Ninetails $($manifest.version) (unlisted)." -ForegroundColor Cyan
Write-Host "Every upload needs a new version number in extension\manifest.json."

$env:WEB_EXT_API_KEY = Read-Host "AMO JWT issuer (API key)"
$env:WEB_EXT_API_SECRET = Read-Secret "AMO JWT secret"
try {
    npx --yes web-ext@8 sign --source-dir extension --artifacts-dir dist --channel unlisted
} finally {
    Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
}
Write-Host ""
Write-Host "Done. Install the .xpi in dist\ via Firefox: about:addons -> gear icon -> Install Add-on From File." -ForegroundColor Green
