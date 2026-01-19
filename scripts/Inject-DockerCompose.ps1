<#
.SYNOPSIS
  MONOLITHIC INJECTOR V2
  - Updates remote docker-compose.yml
  - Adds Volumes (Critical for data persistence)
  - Checks for QTerm existence
  - Reads IP from unit.config instead of guessing
#>

# === Resolve paths ===
$ScriptRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$StagingRoot = Join-Path $ScriptRoot "staging"

# === Load .env/.env.local ===
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
} else {
    Write-Warning ".env/.env.local not found. Falling back to existing environment variables."
}

$LinuxHost     = $env:LinuxHost
$LinuxUser     = $env:LinuxUser
$LinuxPassword = $env:LinuxPassword
# Note: BaseIp is removed because we now read specific IPs from config

if (-not $LinuxHost -or -not $LinuxUser -or -not $LinuxPassword) {
    Write-Error "Missing credentials. Set LinuxHost/LinuxUser/LinuxPassword in .env.local or environment variables."
    exit 1
}

Write-Host "Target: $LinuxHost" -ForegroundColor Cyan

# === Step 1: Build dataset from staging ===
Write-Host "`nScanning $StagingRoot..."
$unitDirs = Get-ChildItem -Path $StagingRoot -Directory
if (-not $unitDirs) { Write-Warning "No staging folders."; exit }

$dataset = @()

foreach ($unit in $unitDirs) {
    $unitName = $unit.Name
    $configPath = Join-Path $unit.FullName "unit.config"
    $qtermPath  = Join-Path $unit.FullName "QTerm"

    # 1. Get Real IP
    $ip = "127.0.0.1" # Default fallback
    if (Test-Path $configPath) {
        try {
            $json = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($json.LocalHMIIp) { $ip = $json.LocalHMIIp }
        } catch { Write-Warning "Error reading config for $unitName" }
    }

    # 2. Check QTerm
    $hasQTerm = Test-Path $qtermPath

    $dataset += [PSCustomObject]@{
        UnitName  = $unitName
        HasQTerm  = $hasQTerm
        IPv4      = $ip
    }
    
    Write-Host "  Found $unitName -> $ip" -ForegroundColor Gray
}

# === Step 2: YAML Generator Helper ===
function Convert-ToComposeYaml {
    param([array]$Dataset)
    $lines = @("# --- AUTO-GENERATED SECTION START ---")
    
    foreach ($item in $Dataset) {
        $svc = $item.UnitName
        
        # Determine Arguments
        $argsBlock = ""
        if ($item.HasQTerm) {
            $argsBlock += "        qterm_dir: ./${svc}/QTerm/.`n"
        }
        $argsBlock += "        simName: ${svc}`n"
        $argsBlock += "        config_dir: ./${svc}"

        $lines += "  ${svc}:"
        $lines += "    build:"
        $lines += "      context: ./stw/."
        $lines += "      args:"
        $lines += $argsBlock
        $lines += "    stdin_open: true"
        $lines += "    tty: true"
        $lines += "    volumes:"
        $lines += "      - ${svc}_etc:/home/developer/Development/test/data/dataflash/etc"
        $lines += "    networks:"
        $lines += "      stwnet:"
        $lines += "        ipv4_address: $($item.IPv4)"
        $lines += ""
    }
    $lines += "# --- AUTO-GENERATED SECTION END ---"
    return $lines
}

$yamlLines = Convert-ToComposeYaml -Dataset $dataset

# === Step 3: WinSCP Download -> Inject -> Upload ===
$tempLocal  = Join-Path $env:TEMP "docker-compose-remote.yml"
$tempScript = Join-Path $env:TEMP "winscp-compose.txt"
$winscpPath = "C:\Program Files (x86)\WinSCP\WinSCP.com"
$winScpOptions = @(
    "option batch on",
    "option confirm off",
    "option reconnecttime 30"
)

# CHECK THIS PATH: Your previous scripts had different paths. 
# Ensure this matches your Linux server structure.
$remotePath = "/home/developer/Deployment/docker/fleet/docker-compose.yml" 

Write-Host "`nUpdating Remote Compose File..." -ForegroundColor Yellow

# Download
$downloadScript = @()
$downloadScript += $winScpOptions
$downloadScript += @(
    "open sftp://${LinuxUser}:${LinuxPassword}@$LinuxHost/ -hostkey=`"*`"",
    "get `"$remotePath`" `"$tempLocal`"",
    "exit"
)
$downloadScript | Out-File -Encoding ASCII $tempScript
& "$winscpPath" "/script=$tempScript" | Out-Null

if (-not (Test-Path $tempLocal)) { Write-Error "Download failed."; exit 1 }

# Inject Services
$content = Get-Content $tempLocal -Raw
$pattern = '(?s)# --- AUTO-GENERATED SECTION START ---.*?# --- AUTO-GENERATED SECTION END ---'
$cleaned = [regex]::Replace($content, $pattern, '').TrimEnd()

# Check for 'services:' block
if ($cleaned -notmatch '(?m)^\s*services:') { $cleaned += "`nservices:`n" }

# Insert new YAML under 'services:'
$finalLines = @()
$injected = $false
foreach ($line in ($cleaned -split "`n")) {
    $finalLines += $line
    if (-not $injected -and $line -match '^\s*services:\s*$') {
        $finalLines += $yamlLines
        $injected = $true
    }
}
if (-not $injected) { $finalLines += "services:"; $finalLines += $yamlLines }

# === IMPORTANT: Inject Named Volumes at bottom ===
# The script above adds volume references (service_etc), 
# but they must be declared at the bottom of the file too.
$volChunk = @()
foreach ($item in $dataset) {
    $volChunk += "  $($item.UnitName)_etc:"
}
# Simple append to end of file if not exists
$finalString = $finalLines -join "`n"
if ($finalString -notmatch "volumes:") {
    $finalString += "`n`nvolumes:"
}
$finalString += "`n" + ($volChunk -join "`n")

# Save & Upload
Set-Content -Path $tempLocal -Value $finalString -Encoding UTF8
$uploadScript = @()
$uploadScript += $winScpOptions
$uploadScript += @(
    "open sftp://${LinuxUser}:${LinuxPassword}@$LinuxHost/ -hostkey=`"*`"",
    "put `"$tempLocal`" `"$remotePath`"",
    "exit"
)
$uploadScript | Out-File -Encoding ASCII $tempScript
& "$winscpPath" "/script=$tempScript" | Out-Null

Write-Host "Success. Updated $remotePath" -ForegroundColor Green
