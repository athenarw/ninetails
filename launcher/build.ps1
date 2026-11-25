# Rebuild NinetailsSettings.exe and NinetailsTidy.exe on Windows.
# Needs Zig (a self-contained C compiler):  winget install -e --id zig.zig
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command zig -ErrorAction SilentlyContinue)) {
    Write-Host "Zig not found. Install it with:  winget install -e --id zig.zig" -ForegroundColor Yellow
    exit 1
}
$tmp = Join-Path $env:TEMP ("ninetails-build-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
function Build($name, $define, $rc) {
    $zargs = @("cc", "-target", "x86_64-windows-gnu", "-O2", "-s", "-municode", "-Wl,--subsystem,windows")
    if ($define) { $zargs += $define }
    $zargs += @("ninetails-settings.c", $rc, "-lshell32", "-luser32", "-o", (Join-Path $tmp $name))
    & zig @zargs
    Copy-Item (Join-Path $tmp $name) (Join-Path .. $name) -Force
    Write-Host "Built ..\$name"
}
Build "NinetailsSettings.exe" $null "ninetails-settings.rc"
Build "NinetailsTidy.exe" "-DNT_TIDY" "ninetails-tidy.rc"
Remove-Item $tmp -Recurse -Force
