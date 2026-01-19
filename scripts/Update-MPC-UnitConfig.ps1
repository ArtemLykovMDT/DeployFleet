param (
    [Parameter(Mandatory)]
    [string[]]$UnitNumber,                # e.g. "621093","FPC1728"
    [string]$SearchRoot = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'staging'),
    [string]$TargetPattern = "unit.config",
    [string]$BackupSuffix = ".bak"
)

# --- Determine script directory and staging root ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

Write-Host "Using SearchRoot: $SearchRoot" -ForegroundColor DarkGray

# === Load environment variables (.env.local preferred) ===
$envCandidates = @(
    (Join-Path $RepoRoot ".env.local"),
    (Join-Path $RepoRoot ".env"),
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
    Write-Host "Loaded env file from $envPath" -ForegroundColor Green
} else {
    Write-Warning ".env/.env.local not found. Falling back to existing environment variables."
}

# === Load replacement values from environment ===
$MPC_DataVanHMIIp   = $env:MPC_DataVanHMIIp
$MPC_LocalHMIIp     = $env:MPC_LocalHMIIp
$MPC_MPCSecondaryIp = $env:MPC_MPCSecondaryIp

if (-not $MPC_DataVanHMIIp -or -not $MPC_LocalHMIIp) {
    Write-Error "Missing MPC_DataVanHMIIp or MPC_LocalHMIIp. Set them in .env.local or environment variables."
    exit
}

Write-Host "Using:" -ForegroundColor DarkGray
Write-Host "  MPC_DataVanHMIIp   = $MPC_DataVanHMIIp"
Write-Host "  MPC_LocalHMIIp     = $MPC_LocalHMIIp"
if ($MPC_MPCSecondaryIp) { Write-Host "  MPC_MPCSecondaryIp = $MPC_MPCSecondaryIp" }

function Get-EnvValue {
    param([string]$name)
    return [System.Environment]::GetEnvironmentVariable($name)
}

function Get-JsonLiteral {
    param($value)
    if ($null -eq $value) { return 'null' }
    if ($value -is [bool]) { return ($value.ToString().ToLower()) }
    if ($value -is [int] -or $value -is [long] -or $value -is [int16] -or $value -is [byte]) {
        return [System.Convert]::ToString($value, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($value -is [double] -or $value -is [single] -or $value -is [decimal]) {
        return [System.Convert]::ToString($value, [System.Globalization.CultureInfo]::InvariantCulture)
    }
    $text = [string]$value
    $text = $text -replace '\\', '\\\\'
    $text = $text -replace '"', '\"'
    return '"' + $text + '"'
}

function Replace-JsonKeyValue {
    param(
        [string]$Content,
        [string]$Key,
        $Value,
        [ref]$DidReplace
    )
    $escaped = [regex]::Escape($Key)
    $pattern = '("{0}"\s*:\s*)("(?:\\.|[^"])*"|[-]?\d+(?:\.\d+)?|true|false|null)' -f $escaped
    $literal = Get-JsonLiteral $Value
    $updated = [regex]::Replace($Content, $pattern, {
        param($m)
        $DidReplace.Value = $true
        return $m.Groups[1].Value + $literal
    })
    return $updated
}

# === Iterate through each unit folder under staging ===
foreach ($unit in $UnitNumber) {
    $unitPath = Join-Path $SearchRoot $unit
    if (-not (Test-Path $unitPath)) {
        Write-Warning "Skipping: $unitPath not found"
        continue
    }

    $unitPrefix = "UNIT_${unit}_"
    $unitDataVan = Get-EnvValue "${unitPrefix}MPC_DataVanHMIIp"
    $unitLocal = Get-EnvValue "${unitPrefix}MPC_LocalHMIIp"
    $unitSecondary = Get-EnvValue "${unitPrefix}MPC_MPCSecondaryIp"
    $unitConfigOverridesRaw = Get-EnvValue "${unitPrefix}CONFIG_OVERRIDES"
    $unitConfigOverrides = $null
    if ($unitConfigOverridesRaw) {
        try {
            $unitConfigOverrides = $unitConfigOverridesRaw | ConvertFrom-Json
        } catch {
            Write-Warning "Invalid UNIT_${unit}_CONFIG_OVERRIDES JSON. Skipping overrides."
        }
    }

    $effectiveDataVan = if ($unitDataVan) { $unitDataVan } else { $MPC_DataVanHMIIp }
    $effectiveLocal = if ($unitLocal) { $unitLocal } else { $MPC_LocalHMIIp }
    $effectiveSecondary = if ($unitSecondary) { $unitSecondary } else { $MPC_MPCSecondaryIp }

    Write-Host "`n===============================" -ForegroundColor Yellow
    Write-Host "Processing unit folder: $unitPath" -ForegroundColor Cyan
    Write-Host "===============================" -ForegroundColor Yellow

    $files = Get-ChildItem -Path $unitPath -Recurse -Filter $TargetPattern -ErrorAction SilentlyContinue
    if (-not $files) {
        Write-Warning "No unit.config files found under $unitPath"
        continue
    }

    foreach ($file in $files) {
        Write-Host "`n  File: $($file.FullName)" -ForegroundColor White

        # Create backup
        $backupPath = "$($file.FullName)$BackupSuffix"
        Copy-Item -Path $file.FullName -Destination $backupPath -Force
        Write-Host "  Backup created: $backupPath" -ForegroundColor DarkGray

        # Read and modify
        $content = Get-Content -Path $file.FullName -Raw
		# Strip UTF-8 BOM if present
		if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
			$content = $content.TrimStart([char]0xFEFF)
		}

        $modified = $false
        $relativePath = $file.FullName.Substring($unitPath.Length).TrimStart('\', '/')
        $overrideRoot = Join-Path $SearchRoot ".unit-config-overrides"
        $overridePath = Join-Path (Join-Path $overrideRoot $unit) $relativePath
        $skipEnvOverrides = $false
        if (Test-Path $overridePath) {
            $content = Get-Content -Path $overridePath -Raw
            if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
                $content = $content.TrimStart([char]0xFEFF)
            }
            $modified = $true
            $skipEnvOverrides = $true
            Write-Host "    Using UI override file for $relativePath" -ForegroundColor DarkGray
        }
        $overrideForFile = $null
        if ($unitConfigOverrides -and $unitConfigOverrides.PSObject.Properties.Name -contains $relativePath) {
            $overrideForFile = $unitConfigOverrides.$relativePath
        }

        if ($unitDataVan -or $unitLocal -or $unitSecondary -or $overrideForFile) {
            Write-Host "  Using unit-specific overrides for $unit" -ForegroundColor DarkGray
        }

        if ($overrideForFile -and -not $skipEnvOverrides) {
            foreach ($prop in $overrideForFile.PSObject.Properties) {
                $replaceHit = $false
                if ($prop.Value -is [System.Collections.IDictionary] -or ($prop.Value -is [System.Collections.IEnumerable] -and -not ($prop.Value -is [string]))) {
                    Write-Host "    Override $($prop.Name) is non-scalar. Skipping to preserve formatting." -ForegroundColor DarkGray
                    continue
                }
                $content = Replace-JsonKeyValue -Content $content -Key $prop.Name -Value $prop.Value -DidReplace ([ref]$replaceHit)
                if ($replaceHit) {
                    $modified = $true
                } else {
                    Write-Host "    Override key $($prop.Name) not found in file. Skipping." -ForegroundColor DarkGray
                }
            }
        }

        $replaceHit = $false
        if (-not $skipEnvOverrides -and $effectiveDataVan -and -not ($overrideForFile -and $overrideForFile.PSObject.Properties.Name -contains 'DataVanHMIIp')) {
            $content = Replace-JsonKeyValue -Content $content -Key 'DataVanHMIIp' -Value $effectiveDataVan -DidReplace ([ref]$replaceHit)
            if ($replaceHit) {
                Write-Host "    Updated DataVanHMIIp  $effectiveDataVan" -ForegroundColor Green
                $modified = $true
            }
        }
        $replaceHit = $false
        if (-not $skipEnvOverrides -and $effectiveLocal -and -not ($overrideForFile -and $overrideForFile.PSObject.Properties.Name -contains 'LocalHMIIp')) {
            $content = Replace-JsonKeyValue -Content $content -Key 'LocalHMIIp' -Value $effectiveLocal -DidReplace ([ref]$replaceHit)
            if ($replaceHit) {
                Write-Host "    Updated LocalHMIIp  $effectiveLocal" -ForegroundColor Green
                $modified = $true
            }
        }
        $replaceHit = $false
        if (-not $skipEnvOverrides -and $effectiveSecondary -and -not ($overrideForFile -and $overrideForFile.PSObject.Properties.Name -contains 'MPCSecondaryIp')) {
            $content = Replace-JsonKeyValue -Content $content -Key 'MPCSecondaryIp' -Value $effectiveSecondary -DidReplace ([ref]$replaceHit)
            if ($replaceHit) {
                Write-Host "    Updated MPCSecondaryIp  $effectiveSecondary" -ForegroundColor Green
                $modified = $true
            }
        }

        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($file.FullName, $content, $utf8NoBom)
        if ($modified) {
            Write-Host "    Saved updated configuration (UTF-8 no BOM)." -ForegroundColor Yellow
        } else {
            Write-Host "    Saved configuration (UTF-8 no BOM). No content changes." -ForegroundColor DarkGray
        }

    }
}

Write-Host "`nUpdate complete for all specified units." -ForegroundColor Cyan

