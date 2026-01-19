<#
.SYNOPSIS
  SELECTIVE DOWNLOADER V2.2
  1. SURGICAL DOWNLOAD: Only fetches the 13 specific config files + QTerm folder.
  2. DYNAMIC PATHING: Finds files anywhere in the repo path (NexTier/$unit).
  3. QTERM RECURSIVE: Preserves internal folder structure for QTerm files.
  4. ZERO JUNK: Prevents .zip, .tar.gz, and .bak files from reaching your disk.
#>

param (
    [Parameter(Mandatory=$true)]
    [string[]]$UnitNumber,                        # e.g. "621093","620444"
    [string]$DownloadRoot = "",
    [string]$Organization = "mdt-software",
    [string]$Project      = "MDT",
    [string]$Repository   = "Configurations_NexTier",
    [string]$Branch       = "master"
)

# === THE SURGICAL WHITELIST ===
$FileWhitelist = @(
    "alarms.config", "calculatedSensors.config", "eb07.config", "hmiSettings.config",
    "j1939.config", "mainboard.config", "pidParameters.config", "powertrains.config",
    "Readme.txt", "sensorConfig.json", "sensorMetadata.json", "simulator.config", "unit.config","blender.config" 
)

Add-Type -AssemblyName System.Web

# === Resolve script root and staging folder ===
$scriptRoot = if ($PSScriptRoot) {
    $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    (Get-Location).Path
}

if (-not $DownloadRoot) {
    $DownloadRoot = Join-Path $scriptRoot "staging"
}

if (-not (Test-Path $DownloadRoot)) {
    New-Item -ItemType Directory -Path $DownloadRoot -Force | Out-Null
}

# === Load .env/.env.local for PAT (prefer repo root) ===
$repoRoot = Split-Path -Parent $scriptRoot
$envCandidates = @(
    (Join-Path $repoRoot ".env.local"),
    (Join-Path $repoRoot ".env"),
    (Join-Path $scriptRoot ".env.local"),
    (Join-Path $scriptRoot ".env")
)
$envPath = $envCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match "^\s*([^#=]+?)\s*=\s*(.+)$") {
            $name  = $matches[1].Trim()
            $value = $matches[2].Trim('"').Trim()
            [System.Environment]::SetEnvironmentVariable($name, $value)
        }
    }
} else {
    Write-Warning ".env/.env.local not found. Falling back to existing environment variables."
}

$pat = $env:PAT
if (-not $pat) { Write-Error "PAT not loaded. Set PAT in .env.local or environment variables."; exit 1 }

$base64AuthInfo = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
$headers = @{ Authorization = "Basic $base64AuthInfo" }

# === Helper: Get all repo items recursively ===
function Get-AdoRepoItemList {
    param ([string]$Path)
    $uri = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items" +
           "?scopePath=$Path&recursionLevel=Full&versionDescriptor.version=$Branch&api-version=7.0"
    try {
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -ErrorAction Stop
        if ($response.value) { return $response.value }
        else { return @() }
    }
    catch {
        Write-Warning "   Failed to reach ADO path: $Path"
        return @()
    }
}

# === Helper: Download file with Path Preservation ===
function Download-AdoFile {
    param (
        [string]$ItemPath,
        [string]$LocalPath
    )

    $parentDir = Split-Path $LocalPath
    if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }

    $encodedPath = [System.Web.HttpUtility]::UrlEncode($ItemPath)
    $downloadUrl = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items?path=$encodedPath&versionDescriptor.version=$Branch&api-version=7.0&download=true"

    try {
        Invoke-WebRequest -Uri $downloadUrl -Headers $headers -OutFile $LocalPath -ErrorAction Stop
        Write-Host "      [OK] $(Split-Path $ItemPath -Leaf)" -ForegroundColor Gray
    }
    catch {
        Write-Warning "      [FAIL] $ItemPath"
    }
}

# === Main logic ===
Write-Host "`n--- STARTING SELECTIVE DOWNLOAD V2.2 ---" -ForegroundColor Cyan

$totalDownloadedUnits = 0

foreach ($unit in $UnitNumber) {
    Write-Host "`nUnit: $unit" -ForegroundColor Yellow
    $unitFolder = Join-Path $DownloadRoot $unit
    
    # 1. Clean local staging for this unit
    if (Test-Path $unitFolder) { Remove-Item -Recurse -Force $unitFolder }
    New-Item -ItemType Directory -Path $unitFolder | Out-Null

    # 2. Search ADO recursively for ALL items under the unit folder
    $path = "/NexTier/$unit"
    $items = Get-AdoRepoItemList -Path $path

    if ($items.Count -eq 0) {
        Write-Warning "   No files found for unit $unit in ADO."
        continue
    }

    # 3. Filter and Download only what matches the Whitelist or QTerm
    $foundFiles = 0
    foreach ($item in $items) {
        if ($item.isFolder) { continue }

        $fileName = Split-Path $item.path -Leaf
        $relativePath = $item.path.Substring($path.Length).TrimStart('/')
        $destPath = Join-Path $unitFolder $relativePath
        
        # LOGIC:
        # A. If filename matches our Whitelist exactly
        if ($FileWhitelist -contains $fileName) {
            Download-AdoFile -ItemPath $item.path -LocalPath $destPath
            $foundFiles++
        }
        # B. OR if the file is inside a QTerm folder (Preserve QTerm subfolders)
        elseif ($item.path -match "/QTerm/") {
            Download-AdoFile -ItemPath $item.path -LocalPath $destPath
            $foundFiles++
        }
    }

    if ($foundFiles -gt 0) {
        Write-Host "   Total: $foundFiles files downloaded for $unit" -ForegroundColor Green
        $totalDownloadedUnits++
    } else {
        Write-Warning "   No whitelisted files or QTerm folder found for $unit"
    }
}

if ($totalDownloadedUnits -gt 0) {
    Write-Host "`nSelective Download Complete. $totalDownloadedUnits unit(s) ready.`n" -ForegroundColor Green
    exit 0
} else {
    Write-Error "No units were processed successfully."
    exit 1
}
