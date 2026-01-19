param (
    [Parameter(Mandatory)]
    [string[]]$UnitNumber,                        # e.g. "621093","FPC1728"
    [string]$DownloadRoot = "",                   # Will be set automatically if left blank
    [string]$Organization = "mdt-software",
    [string]$Project = "MDT",
    [string]$Repository = "Configurations_NexTier",
    [string]$Branch = "master"
)

# ==========================================
# 1. PATH RESOLUTION (Fixed for Null Error)
# ==========================================
# We use $PSScriptRoot which is the standard way to get the current folder in PowerShell
if (-not $PSScriptRoot) {
    # Fallback if PSScriptRoot is empty (rare)
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
} else {
    $ScriptDir = $PSScriptRoot
}

# Set DownloadRoot default if user didn't provide one
if ([string]::IsNullOrWhiteSpace($DownloadRoot)) {
    $DownloadRoot = Join-Path $ScriptDir "staging"
}

# ==========================================
# 2. SETUP & CREDENTIALS
# ==========================================

# Ensure staging folder exists
if (-not (Test-Path $DownloadRoot)) {
    New-Item -ItemType Directory -Path $DownloadRoot | Out-Null
    Write-Host "Created staging folder: $DownloadRoot" -ForegroundColor DarkGray
}

# Load .env/.env.local for PAT (prefer repo root)
$repoRoot = Split-Path -Parent $ScriptDir
$envCandidates = @(
    (Join-Path $repoRoot ".env.local"),
    (Join-Path $repoRoot ".env"),
    (Join-Path $ScriptDir ".env.local"),
    (Join-Path $ScriptDir ".env")
)
$envPath = $envCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match "^\s*([^#=]+?)\s*=\s*(.+)$") {
            $name  = $matches[1].Trim()
            $value = $matches[2].Trim('"').Trim()
            [System.Environment]::SetEnvironmentVariable($name, $value)
        }
    }
    Write-Host "Loaded env file" -ForegroundColor Green
} else {
    Write-Warning ".env/.env.local not found. Falling back to existing environment variables."
}

$pat = $env:PAT
if (-not $pat) {
    Write-Error "PAT not loaded. Set PAT in .env.local or environment variables."
    exit 1
}

$base64AuthInfo = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
$headers = @{ Authorization = "Basic $base64AuthInfo" }

# ==========================================
# 3. HELPER FUNCTIONS
# ==========================================

function Get-AdoRepoItemList {
    param ([string]$Path)

    $uri = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items" +
       "?scopePath=$Path&recursionLevel=Full&versionDescriptor.version=$Branch&api-version=7.0"

    Write-Host "`nRequesting URI:`n$uri" -ForegroundColor DarkGray
    try {
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -ErrorAction Stop
        if ($response.value) { return $response.value }
        elseif ($response -is [array]) { return $response }
        else { return @() }
    }
    catch {
        Write-Warning "Failed to get items for $Path — $($_.Exception.Message)"
        return @()
    }
}

function Download-AdoFile {
    param (
        [string]$ItemPath,
        [string]$OutputFolder
    )

    $fileName = Split-Path $ItemPath -Leaf
    $localPath = Join-Path $OutputFolder $fileName
    # Encoding fix for special chars
    $encodedPath = [System.Web.HttpUtility]::UrlEncode($ItemPath)
    $downloadUrl = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items?path=$encodedPath&versionDescriptor.version=$Branch&api-version=7.0&download=true"

    try {
        Invoke-WebRequest -Uri $downloadUrl -Headers $headers -OutFile $localPath -ErrorAction Stop
        Write-Host "   Downloaded: $fileName"
    }
    catch {
        Write-Warning "   Failed to download $fileName — $($_.Exception.Message)"
    }
}

# ==========================================
# 4. MAIN EXECUTION
# ==========================================

Write-Host "`n Searching ADO for ETC files under specified unit folders..." -ForegroundColor Cyan

$totalDownloaded = 0

foreach ($unit in $UnitNumber) {
    # Sanitize input (remove quotes)
    $unit = $unit.Trim().Trim('"').Trim("'")
    
    Write-Host "`n==============================" -ForegroundColor Yellow
    Write-Host " Unit: $unit" -ForegroundColor Yellow
    Write-Host "==============================" -ForegroundColor Yellow

    $path = "/NexTier/$unit"
    $items = Get-AdoRepoItemList -Path $path
    if (-not $items -or $items.Count -eq 0) {
        Write-Warning " No items found under $path"
        continue
    }

    $etcItems = $items | Where-Object { $_.path -match "/etc/" -and -not $_.isFolder }
    if (-not $etcItems -or $etcItems.Count -eq 0) {
        Write-Warning " No etc folder found for $unit"
        continue
    }

    $unitFolder = Join-Path $DownloadRoot $unit
    if (Test-Path $unitFolder) {
        Remove-Item -Recurse -Force $unitFolder
        Write-Host "Cleared existing folder: $unitFolder" -ForegroundColor DarkGray
    }
    New-Item -ItemType Directory -Path $unitFolder | Out-Null

    Write-Host "`n⬇️ Downloading files for $unit..."
    foreach ($file in $etcItems) {
        Download-AdoFile -ItemPath $file.path -OutputFolder $unitFolder
    }

    Write-Host " All etc files for $unit downloaded to: $unitFolder" -ForegroundColor Green
    $totalDownloaded++
}

if ($totalDownloaded -gt 0) {
    Write-Host "`n Successfully downloaded $totalDownloaded unit(s)." -ForegroundColor Green
    exit 0
} else {
    Write-Warning "`n No units were downloaded successfully."
    exit 1
}
