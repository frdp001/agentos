# Alaye OS - Windows installer.
#
# Provisions an isolated runtime under %LOCALAPPDATA%\alaye-os, registers an
# auto-start logon task for the Hermes gateway daemon, and creates Start Menu
# plus Desktop shortcuts.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version TAG] [-NoService] [-NoDesktop]
#
[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$RepoUrl = "https://github.com/alaye-systems/alaye-os.git",
    [string]$HermesRepo = $(if ($env:ALAYE_HERMES_REPO) { $env:ALAYE_HERMES_REPO } else { "https://github.com/alaye-systems/hermes-agent.git" }),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "alaye-os"),
    [switch]$NoService,
    [switch]$NoDesktop
)

$ErrorActionPreference = "Stop"
$AppName = "Alaye OS"
$NodeMinMajor = 20
$BinDir = Join-Path $InstallRoot "bin"
$SourceDir = Join-Path $InstallRoot "src"
$LogFile = Join-Path $InstallRoot "install.log"
$EngineDir = Join-Path $InstallRoot "engine"
$HermesDir = Join-Path $EngineDir "hermes-agent"
$VenvDir = Join-Path $EngineDir "venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$HermesExe = Join-Path $VenvDir "Scripts\hermes.exe"
$DistDir = Join-Path $InstallRoot "release"

# -- logging -----------------------------------------------------------------
function Write-Info  { param($m) Write-Host "[info] $m" -ForegroundColor Cyan;   Add-Content -Path $LogFile -Value "$(Get-Date -Format o) [info] $m" }
function Write-Ok    { param($m) Write-Host "[ ok ] $m" -ForegroundColor Green;  Add-Content -Path $LogFile -Value "$(Get-Date -Format o) [ ok ] $m" }
function Write-Warn2 { param($m) Write-Host "[warn] $m" -ForegroundColor Yellow; Add-Content -Path $LogFile -Value "$(Get-Date -Format o) [warn] $m" }
function Die         { param($m) Write-Host "[fail] $m" -ForegroundColor Red;    Add-Content -Path $LogFile -Value "$(Get-Date -Format o) [fail] $m"; exit 1 }

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
"=== Alaye OS install $(Get-Date -Format o) ===" | Add-Content -Path $LogFile

# -- architecture ------------------------------------------------------------
$Arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
} else { Die "32-bit Windows is not supported" }
Write-Info "platform detected: windows/$Arch"

# -- requirements ------------------------------------------------------------
function Test-Command { param($n) [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Get-NodeMajor {
    if (-not (Test-Command "node")) { return 0 }
    try { return [int]((node -p "process.versions.node.split('.')[0]")) } catch { return 0 }
}

if ((Get-NodeMajor) -lt $NodeMinMajor) {
    Write-Warn2 "Node.js >= $NodeMinMajor not found; provisioning a portable runtime"
    $NodeVer = "v22.11.0"
    $NodeDir = Join-Path $InstallRoot "runtime\node"
    if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) {
        $Zip = Join-Path $InstallRoot "runtime\node-$NodeVer-$Arch.zip"
        $Url = "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-$Arch.zip"
        New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "runtime") | Out-Null
        Write-Info "downloading Node.js $NodeVer"
        Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
        Expand-Archive -Path $Zip -DestinationPath (Join-Path $InstallRoot "runtime") -Force
        Remove-Item $Zip -Force
        Move-Item -Force (Join-Path $InstallRoot "runtime\node-$NodeVer-win-$Arch") $NodeDir
    }
    $env:PATH = "$NodeDir;$env:PATH"
}
Write-Ok "node $(node -v)"

# -- source ------------------------------------------------------------------
if (Test-Path (Join-Path $SourceDir ".git")) {
    Write-Info "updating existing checkout"
    git -C $SourceDir fetch --depth 1 origin
    git -C $SourceDir checkout -q FETCH_HEAD
} else {
    Write-Info "cloning $RepoUrl"
    if (Test-Path $SourceDir) { Remove-Item -Recurse -Force $SourceDir }
    git clone --depth 1 $RepoUrl $SourceDir
    if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
}

# -- dependencies ------------------------------------------------------------
Write-Info "installing Node dependencies"
Push-Location $SourceDir
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
Pop-Location

Write-Info "building renderer bundle"
Push-Location (Join-Path $SourceDir "apps\desktop")
npm install --no-audit --no-fund
npm run build:renderer
if ($LASTEXITCODE -ne 0) { Die "renderer build failed" }
Pop-Location

# -- Hermes Agent engine -----------------------------------------------------
Write-Info "provisioning Hermes Agent engine into $EngineDir"
$Python = if (Test-Command "python") { "python" } elseif (Test-Command "py") { "py" } else {
    Die "Python 3 is required to provision the Hermes engine (winget install Python.Python.3.12)"
}
New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null

if (Test-Path (Join-Path $HermesDir ".git")) {
    Write-Info "updating hermes-agent checkout"
    git -C $HermesDir fetch --depth 1 origin
    git -C $HermesDir checkout -q FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { Die "hermes-agent update failed" }
} else {
    Write-Info "cloning hermes-agent from $HermesRepo"
    if (Test-Path $HermesDir) { Remove-Item -Recurse -Force $HermesDir }
    git clone --depth 1 $HermesRepo $HermesDir
    if ($LASTEXITCODE -ne 0) { Die "git clone of hermes-agent failed" }
}
Write-Ok "hermes-agent source ready"

if (-not (Test-Path $VenvPython)) {
    Write-Info "creating isolated venv at $VenvDir"
    & $Python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Die "failed to create virtualenv at $VenvDir" }
}
& $VenvPython -m pip install --quiet --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { Die "pip bootstrap failed" }

Write-Info "installing hermes-agent in editable mode"
& $VenvPython -m pip install --quiet -e $HermesDir
if ($LASTEXITCODE -ne 0) { Die "pip install -e hermes-agent failed" }

if (-not (Test-Path $HermesExe)) { Die "hermes CLI not found at $HermesExe after install" }
Write-Ok "hermes CLI ready at $HermesExe"

# -- production distribution artifacts --------------------------------------
$ReleaseSrc = Join-Path $SourceDir "release"
$PackagedExe = Join-Path $DistDir "win-unpacked\Alaye OS.exe"
if (Test-Path $ReleaseSrc) {
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    Copy-Item (Join-Path $ReleaseSrc "*") $DistDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "production artifacts staged in $DistDir"
} else {
    Write-Info "no packaged artifacts; launcher will fall back to Electron"
}

# -- launchers ---------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Launcher = Join-Path $BinDir "alaye-os.cmd"
@"
@echo off
setlocal
set "HERMES_HOME=$EngineDir"
set "HERMES_BIN=$HermesExe"
set "PATH=$VenvDir\Scripts;%PATH%"
if exist "$PackagedExe" (
  "$PackagedExe" %*
) else (
  "$SourceDir\node_modules\.bin\electron.cmd" "$SourceDir\apps\desktop" %*
)
"@ | Set-Content -Path $Launcher -Encoding ASCII

$DaemonLauncher = Join-Path $BinDir "alaye-daemon.cmd"
@"
@echo off
setlocal
set "HERMES_HOME=$EngineDir"
set "HERMES_BIN=$HermesExe"
set "PATH=$VenvDir\Scripts;%PATH%"
node "$SourceDir\core\daemon\index.js" %*
"@ | Set-Content -Path $DaemonLauncher -Encoding ASCII

# Keep the embedded venv on PATH for the optional direct engine wrapper too.
$HermesLauncher = Join-Path $BinDir "alaye-hermes.cmd"
@"
@echo off
setlocal
set "HERMES_HOME=$EngineDir"
"$HermesExe" %*
"@ | Set-Content -Path $HermesLauncher -Encoding ASCII
Write-Ok "launchers written to $BinDir"

# -- auto-start logon task ---------------------------------------------------
if (-not $NoService) {
    $TaskName = "AlayeOS Hermes Gateway"
    # Launch through the wrapper so HERMES_HOME / PATH / HERMES_BIN are set to
    # the embedded virtual environment at logon.
    $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$DaemonLauncher`"" -WorkingDirectory $SourceDir
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
    Write-Ok "logon task '$TaskName' registered against $DaemonLauncher"
}

# -- shortcuts ---------------------------------------------------------------
if (-not $NoDesktop) {
    $Shell = New-Object -ComObject WScript.Shell
    $Targets = @(
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
        ([Environment]::GetFolderPath("Desktop"))
    )
    foreach ($Dir in $Targets) {
        $Lnk = $Shell.CreateShortcut((Join-Path $Dir "$AppName.lnk"))
        $Lnk.TargetPath = Join-Path $BinDir "alaye-os.cmd"
        $Lnk.WorkingDirectory = $SourceDir
        $Lnk.Description = "B2B outreach agent console"
        if (Test-Path (Join-Path $SourceDir "apps\desktop\build\icon.ico")) {
            $Lnk.IconLocation = Join-Path $SourceDir "apps\desktop\build\icon.ico"
        }
        $Lnk.Save()
    }
    Write-Ok "Start Menu and Desktop shortcuts created"
}

Write-Host ""
Write-Ok "$AppName installed successfully"
Write-Info "launch the app: $Launcher"
Write-Info "hermes CLI:     $HermesExe"
Write-Info "daemon status:  Get-ScheduledTask -TaskName 'AlayeOS Hermes Gateway'"
Write-Info "logs:           $LogFile"
