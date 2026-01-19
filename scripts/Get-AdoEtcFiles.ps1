param (
    [string[]]$UnitNumbers,                        # e.g. "DV151273","DV151274"
    [string]$LinuxUser = "developer",
    [string]$LinuxPassword = "mobile",
    [string]$Organization = "mdt-software",
    [string]$Project = "MDT",
    [string]$Repository = "Configurations_NexTier",
    [string]$Branch = "master"
)

# make sure these are visible globally
Set-Variable -Name Organization -Value $Organization -Scope Global
Set-Variable -Name Project -Value $Project -Scope Global
Set-Variable -Name Repository -Value $Repository -Scope Global
Set-Variable -Name Branch -Value $Branch -Scope Global

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$envCandidates = @(
    (Join-Path $repoRoot ".env.local"),
    (Join-Path $repoRoot ".env"),
    (Join-Path $scriptRoot ".env.local"),
    (Join-Path $scriptRoot ".env")
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
    exit
}

$base64AuthInfo = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
$headers = @{ Authorization = "Basic $base64AuthInfo" }

# --- API helper ---
function Get-AdoRepoItemList {
    param ([string]$Path)

    $encodedPath = [System.Web.HttpUtility]::UrlEncode($Path)
    $uri = "https://dev.azure.com/$($Organization)/$($Project)/_apis/git/repositories/$($Repository)/items" +
           "?scopePath=$encodedPath&recursionLevel=Full&versionDescriptor.version=$($Branch)&api-version=7.0"

    Write-Host "Requesting URI:`n$uri" -ForegroundColor DarkGray

    try {
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -ErrorAction Stop
        if ($response.value) { return $response.value }
        elseif ($response -is [array]) { return $response }
        else {
            Write-Warning "Unexpected response format (no .value property)"
            return @()
        }
    }
    catch {
        Write-Warning "Failed to get items for $Path — $($_.Exception.Message)"
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            Write-Host "HTTP Status: $($_.Exception.Response.StatusCode.value__) $($_.Exception.Response.StatusDescription)" -ForegroundColor Red
        }
        return @()
    }
}

# --- File download helper ---
function Download-AdoFile {
    param (
        [string]$ItemPath,
        [string]$OutputFolder
    )

    $fileName = Split-Path $ItemPath -Leaf
    $localPath = Join-Path $OutputFolder $fileName

    $encodedFilePath = [System.Web.HttpUtility]::UrlEncode($ItemPath)
    $downloadUrl = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items?path=$encodedFilePath&versionDescriptor.version=$Branch&api-version=7.0&download=true"

    try {
        Invoke-WebRequest -Uri $downloadUrl -Headers $headers -OutFile $localPath -ErrorAction Stop
        Write-Host "Downloaded: $fileName"
    }
    catch {
        Write-Warning "Failed to download $fileName — $($_.Exception.Message)"
    }
}

# --- Main logic ---
Write-Host "`nSearching ADO for ETC files under specified unit numbers..." -ForegroundColor Cyan

foreach ($unit in $UnitNumbers) {
    Write-Host "`n==============================" -ForegroundColor Yellow
    Write-Host "Unit: $unit" -ForegroundColor Yellow
    Write-Host "==============================" -ForegroundColor Yellow

    $path = "/NexTier/$unit"
    $items = Get-AdoRepoItemList -Path $path

    if (-not $items) {
        Write-Warning "No items found under $path"
        continue
    }

    # Filter for etc folder contents
    $etcItems = $items | Where-Object { $_.path -match "/etc/" -and -not $_.isFolder }

    if ($etcItems.Count -eq 0) {
        Write-Warning "No etc folder found for $unit"
        continue
    }

    # Create or reset local unit folder
    $localFolder = Join-Path (Get-Location) $unit
    if (Test-Path $localFolder) {
        Remove-Item -Recurse -Force $localFolder
    }
    New-Item -ItemType Directory -Path $localFolder | Out-Null

    Write-Host "`nDownloading files for $unit..."
    foreach ($file in $etcItems) {
        Download-AdoFile -ItemPath $file.path -OutputFolder $localFolder
    }

    Write-Host "All etc files for $unit downloaded to: $localFolder" -ForegroundColor Green
}
