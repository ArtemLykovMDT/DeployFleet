<#
.SYNOPSIS
  BUILD ARCHITECTURE V2 (Integrated)
  Automatically builds all detected units in staging by running 
  Docker Compose builds remotely on the target host.
#>

param (
    [switch]$CleanBuild,                    # Add --no-cache
    [switch]$Parallel,                      # Run builds concurrently
    [string]$StagingRoot = "",              # Default: .\staging
    [string]$RemotePath = "/home/developer/MDT.Kiwi/docker/fleet/stw"
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $StagingRoot) { $StagingRoot = Join-Path $ScriptRoot "staging" }

Write-Host "--- RUNNING REMOTE BUILD ENGINE V2 ---" -ForegroundColor Magenta

# ==========================================
# 1. LOAD ENVIRONMENT & VALIDATE
# ==========================================
$repoRoot = Split-Path -Parent $ScriptRoot
$envCandidates = @(
    (Join-Path $repoRoot ".env.local"),
    (Join-Path $repoRoot ".env"),
    (Join-Path $ScriptRoot ".env.local"),
    (Join-Path $ScriptRoot ".env")
)
$envPath = $envCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match "^\s*([^#=]+?)\s*=\s*(.+)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim('"').Trim())
        }
    }
}

$LinuxHost     = $env:LinuxHost
$LinuxUser     = $env:LinuxUser
$LinuxPassword = $env:LinuxPassword
$WinSCPPath    = "C:\Program Files (x86)\WinSCP\WinSCP.com"
$WinScpOptions = @(
    "option batch on",
    "option confirm off",
    "option reconnecttime 30"
)

if (-not $LinuxHost -or -not $LinuxUser -or -not $LinuxPassword) {
    Write-Error "Missing credentials. Set LinuxHost/LinuxUser/LinuxPassword in .env.local or environment variables."
    exit 1
}

# ==========================================
# 2. DETECT UNITS
# ==========================================
$unitDirs = Get-ChildItem -Path $StagingRoot -Directory
if (-not $unitDirs) {
    Write-Warning "No units found in $StagingRoot. Nothing to build."
    exit
}

$units = $unitDirs | Select-Object -ExpandProperty Name
Write-Host "Detected Units: $($units -join ', ')" -ForegroundColor Yellow

# ==========================================
# 3. GENERATE REMOTE COMMANDS
# ==========================================
$tempScript = Join-Path $env:TEMP "winscp-build-cmds.txt"
$buildLog   = Join-Path $env:TEMP "winscp-build-log.log"

# Build base command (using modern 'docker compose')
$baseCmd = "docker compose build"
if ($CleanBuild) { $baseCmd += " --no-cache" }

$scriptContent = @()
$scriptContent += $WinScpOptions
$scriptContent += @(
    "open sftp://${LinuxUser}:${LinuxPassword}@${LinuxHost}/ -hostkey=`"*`"",
    "call cd $RemotePath"
)

if ($Parallel) {
    Write-Host "Preparing parallel build..." -ForegroundColor Gray
    $allUnitsLower = ($units | ForEach-Object { $_.ToLower() }) -join " "
    $scriptContent += "call $baseCmd $allUnitsLower"
} else {
    Write-Host "Preparing sequential builds..." -ForegroundColor Gray
    foreach ($unit in $units) {
        $scriptContent += "call cd $RemotePath/$unit && $baseCmd"
    }
}

$scriptContent += "exit"
$scriptContent | Out-File -FilePath $tempScript -Encoding ASCII

# ==========================================
# 4. EXECUTE BUILD
# ==========================================
Write-Host "`n[3/5] Executing Remote Build (This may take several minutes)..." -ForegroundColor Cyan
& $WinSCPPath /script=$tempScript /log=$buildLog

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed. Check log: $buildLog"
    exit 1
}

# ==========================================
# 5. DEPLOYMENT SUMMARY
# ==========================================
Write-Host "`n──────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host " DEPLOYMENT SUMMARY" -ForegroundColor Yellow
Write-Host "──────────────────────────────────────────────" -ForegroundColor Cyan
"{0,-15} | {1,-15} | {2,-20}" -f "Unit", "IP Address", "Status"
"---------------|-----------------|--------------------"

foreach ($unit in $units) {
    $composeFile = Join-Path $StagingRoot $unit "docker-compose.yml"
    $ip = "Unknown"
    
    # Extract IP from the generated docker-compose file if it exists
    if (Test-Path $composeFile) {
        $content = Get-Content $composeFile -Raw
        if ($content -match "ipv4_address:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})") {
            $ip = $matches[1]
        }
    }

    "{0,-15} | {1,-15} | {2,-20}" -f $unit, $ip, "Built & Ready"
}

Write-Host "──────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host "Remote build cycle complete." -ForegroundColor Green

if (Test-Path $tempScript) { Remove-Item $tempScript }
