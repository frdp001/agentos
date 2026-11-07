# Alaye OS - Windows engine bundler.
#
# Produces a self-contained Hermes engine under apps/desktop/engine-bundle so
# electron-builder can ship it at resources/engine inside the NSIS payload.
# End users then need no Python, git, or network.
#
# Layout produced:
#   engine-bundle/
#     python/                 embeddable CPython (no system install required)
#     python/Lib/site-packages/hermes-agent + deps
#     hermes_launcher.py      generated entrypoint shim
#     hermes.cmd              CLI shim (calls the bundled python)
#     bundle-manifest.json    build metadata
#
# Run on a Windows build host:
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-engine.ps1
#
[CmdletBinding()]
param(
    [string]$HermesRepo = $(if ($env:ALAYE_HERMES_REPO) { $env:ALAYE_HERMES_REPO } else { "https://github.com/nousresearch/hermes-agent.git" }),
    [string]$HermesRef = $(if ($env:ALAYE_HERMES_REF) { $env:ALAYE_HERMES_REF } else { "main" }),
    [string]$PythonVersion = "",
    [string]$OutDir = "",
    [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "apps\desktop\engine-bundle" }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

function Step($m) { Write-Host "[bundle] $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "[bundle] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "[bundle] $m" -ForegroundColor Red; exit 1 }

# --- resolve a base Python (build host only; not shipped verbatim) ----------
$PyLauncher = $null
foreach ($cand in @("python", "py")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $PyLauncher = $cand; break }
}
if (-not $PyLauncher) { Fail "Python 3.10+ is required on the build host (winget install Python.Python.3.12)" }

if (-not $PythonVersion) {
    $PythonVersion = & $PyLauncher -c "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"
}
$Major, $Minor = $PythonVersion.Split(".")
if ([int]$Major -lt 3 -or ([int]$Major -eq 3 -and [int]$Minor -lt 10)) {
    Fail "Python $PythonVersion is too old; need >= 3.10"
}
Step "build host Python $PythonVersion"

# --- prepare output --------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem -Path $OutDir -Force | Where-Object { $_.Name -notin @(".gitkeep", ".gitignore") } |
    Remove-Item -Recurse -Force
$PyDir = Join-Path $OutDir "python"
New-Item -ItemType Directory -Force -Path $PyDir | Out-Null

# --- fetch embeddable Python ----------------------------------------------
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$PyZipName = "python-$PythonVersion-embed-$Arch.zip"
$PyZipUrl = "https://www.python.org/ftp/python/$PythonVersion/$PyZipName"
$Tmp = Join-Path $env:TEMP "alaye-engine-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

try {
    $PyZip = Join-Path $Tmp $PyZipName
    Step "downloading embeddable Python $PythonVersion ($Arch)"
    Invoke-WebRequest -Uri $PyZipUrl -OutFile $PyZip -UseBasicParsing
    Expand-Archive -Path $PyZip -DestinationPath $PyDir -Force

    # Enable site-packages in the embeddable interpreter.
    $Pth = Get-ChildItem -Path $PyDir -Filter "python*._pth" | Select-Object -First 1
    if (-not $Pth) { Fail "python ._pth file not found in embeddable distribution" }
    $Lines = Get-Content $Pth.FullName
    $Lines = $Lines -replace '^\s*#\s*import site\s*$', 'import site'
    if ($Lines -notcontains 'Lib\site-packages') { $Lines += 'Lib\site-packages' }
    if ($Lines -notcontains '.') { $Lines = @('.') + $Lines }
    Set-Content -Path $Pth.FullName -Value $Lines -Encoding ASCII
    New-Item -ItemType Directory -Force -Path (Join-Path $PyDir "Lib\site-packages") | Out-Null

    $PyExe = Join-Path $PyDir "python.exe"

    # --- bootstrap pip into the bundled interpreter ------------------------
    Step "bootstrapping pip"
    $GetPip = Join-Path $Tmp "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPip -UseBasicParsing
    & $PyExe $GetPip --no-warn-script-location --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Fail "pip bootstrap failed" }

    # --- clone + install hermes-agent into the bundled site-packages ------
    $Src = Join-Path $Tmp "hermes-agent"
    Step "cloning $HermesRepo@$HermesRef"
    git clone --depth 1 --branch $HermesRef $HermesRepo $Src
    if ($LASTEXITCODE -ne 0) { Fail "git clone of hermes-agent failed" }

    $SitePackages = Join-Path $PyDir "Lib\site-packages"
    Step "installing hermes-agent (and dependencies) into the bundle"
    & $PyExe -m pip install --no-warn-script-location --disable-pip-version-check --target $SitePackages $Src
    if ($LASTEXITCODE -ne 0) { Fail "pip install of hermes-agent failed" }

    # --- generate the CLI launcher from console_scripts metadata ----------
    Step "generating hermes launcher"
    $EntryModule = $null
    $EntryFunc = $null
    foreach ($di in (Get-ChildItem -Path $SitePackages -Directory -Filter "*.dist-info")) {
        $Ep = Join-Path $di.FullName "entry_points.txt"
        if (-not (Test-Path $Ep)) { continue }
        $InConsole = $false
        foreach ($line in Get-Content $Ep) {
            if ($line -match '^\s*\[console_scripts\]') { $InConsole = $true; continue }
            if ($line -match '^\s*\[') { $InConsole = $false; continue }
            if ($InConsole -and $line -match '^\s*hermes\s*=\s*([^:\s]+)\s*(?::\s*(\S+))?') {
                $EntryModule = $Matches[1]
                $EntryFunc = $Matches[2]
                break
            }
        }
        if ($EntryModule) { break }
    }

    $Launcher = Join-Path $OutDir "hermes_launcher.py"
    if ($EntryModule) {
        if ($EntryFunc) {
            $FuncParts = $EntryFunc.Split(".")
            $Resolve = "_entry = importlib.import_module('$EntryModule')`n"
            foreach ($p in $FuncParts) { $Resolve += "_entry = getattr(_entry, '$p')`n" }
            $Body = "import importlib, sys`n$Resolve`nif __name__ == '__main__':`n    sys.exit(_entry())`n"
        } else {
            $Body = "import runpy, sys`nsys.argv[0] = 'hermes'`nrunpy.run_module('$EntryModule', run_name='__main__')`n"
        }
    } else {
        Step "no console_scripts entry found; using module fallback"
        $Body = @"
import runpy, sys
sys.argv[0] = 'hermes'
for _mod in ('hermes', 'hermes_agent', 'hermes_cli', 'hermes_agent.__main__'):
    try:
        runpy.run_module(_mod, run_name='__main__')
        break
    except ModuleNotFoundError:
        continue
else:
    raise SystemExit('hermes entrypoint not found in bundled site-packages')
"@
    }
    Set-Content -Path $Launcher -Value $Body -Encoding ASCII

    $Cmd = @'
@echo off
setlocal
"%~dp0python\python.exe" "%~dp0hermes_launcher.py" %*
'@
    $Cmd = $Cmd -replace "`r?`n", "`r`n"
    Set-Content -Path (Join-Path $OutDir "hermes.cmd") -Value $Cmd -Encoding ASCII

    # --- record metadata + smoke test -------------------------------------
    $Manifest = [ordered]@{
        bundledAt = (Get-Date).ToUniversalTime().ToString("o")
        python = $PythonVersion
        arch = $Arch
        hermesRepo = $HermesRepo
        hermesRef = $HermesRef
        entry = if ($EntryModule) { "${EntryModule}:${EntryFunc}" } else { "module-fallback" }
    }
    $Manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutDir "bundle-manifest.json") -Encoding ASCII

    Step "smoke-testing bundled hermes"
    & $PyExe $Launcher --version 2>&1 | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[bundle] warning: 'hermes --version' returned $LASTEXITCODE; verify the entrypoint manually" -ForegroundColor Yellow
    }

    $SizeMb = [math]::Round((Get-ChildItem -Recurse -File $OutDir | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    Good "engine bundle ready at $OutDir ($SizeMb MB)"
    Good "ship via: npm run dist:win"
}
finally {
    if (-not $KeepTemp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
}