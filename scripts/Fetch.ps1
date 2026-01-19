
<#
    NexTier FPC Scraper & Compliance Engine
    FINAL VERSION — Single File

    Features:
      - Scans ADO repo for all NexTier unit.config files
      - Reads manifest.json for powertrain/add-on info
      - Classifies units by TruckNature / UnitType
      - Exports NexTierUnitList.csv and core analytics
      - Auto-discovers Kiwi FPC 4.5 family templates from:
            C:\Automation\NexTier FPC\FPC 4.5\<Family>\kiwi\alarms\alarms.config
      - For every family found, runs alarms.config compliance
        against matching frac pumps and writes:
            Analytics\AlarmsNonCompliant_<FamilySafeName>.csv
#>

# ======================================================
# Parse all NexTier unit.config files and group by type
# ======================================================

$organization = "mdt-software"
$project      = "MDT"
$repository   = "Configurations_NexTier"
$branch       = "master"      # If this 404s, try "main" or your actual branch name
$rootPath     = "/NexTier"    # From ?path=/NexTier in your URL

$FpcRootLocal = "C:\Automation\NexTier FPC\FPC 4.5"

# --- Repository configuration ---
# PAT is loaded from .env/.env.local or environment variables (do not hardcode).
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
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim('"').Trim())
        }
    }
}

$pat = $env:PAT
if (-not $pat) {
    Write-Error "PAT not loaded. Set PAT in .env.local or environment variables."
    exit 1
}
$base64AuthInfo = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
$headers = @{ Authorization = "Basic $base64AuthInfo" }


Write-Host "`n--- NexTier FPC Scraper (FINAL VERSION) ---`n" -ForegroundColor Cyan

# ======================================================
# Known MPC truck projects (project-level folders)
# ======================================================
$mpcProjects = @(
    "CAT_-_CAT_-_Clutch_Pack_E70",
    "CAT_-_CAT_-_Clutch_Pack_E90",
    "CAT_-_CAT_-_KidneyLoop_-_Warm_Start_-_DGB",
    "CAT_-_CAT_-_PE_Lube_-_Warm_Start",
    "CAT_3512E_-_CAT_-_PE_Lube_-_Warm_Start_-_DGB",
    "CAT_3512E_-_TwinDisc_-_TDEC501_-_PE_Lube_-_Warm_Start_-_DGB",
    "CAT_CAT",
    "CAT_CAT_WS",
    "CAT_CAT_WS_DGB",
    "CAT3512B_CATTH48",
    "CAT3512C_CAT_DGB",
    "CAT3512C_CAT_WS_DGB",
    "CAT3512C_CATTH55E90",
    "CAT3512E_CAT_WS",
    "CAT3512E_CAT_WS_DGB",
    "CAT3512E_TwinDiscTDec501_WS_DGB",
    "CumminsQSK50_AllisonCEC5",
    "CumminsQSK50_CAT",
    "CumminsQSK50_CATCX48",
    "CumminsQSK50_TwinDisc908501",
    "CumminsQSK50_TwinDisc908501_WS",
    "CumminsQSK50Tier4_TH55",
    "Jereh_EFrac",
    "MTU_Allison",
    "MTU_Tier4_CEC5",
    "MTUTier1_AllisonCEC5_ASOV",
    "MTUTier1_AllisonS9820M",
    "MTUTier1_AllisonS9820M_ASOV",
    "MTUTier1_TwinDiscTD501_ASOV",
    "MTUTier2_AllisonCEC3",
    "MTUTier2_AllisonCEC5_ASOV",
    "Turbine_DD35"
)

# ======================================================
# ADO Helper Functions
# ======================================================
function Get-AdoItemsRecursive {
    param([string]$Path)

    $encodedPath = [System.Net.WebUtility]::UrlEncode($Path)
    $uri = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items" +
           "?scopePath=$encodedPath&recursionLevel=Full&versionDescriptor.version=$Branch&api-version=7.0"

    try {
        return (Invoke-RestMethod -Uri $uri -Headers $headers -ErrorAction Stop).value
    }
    catch {
        Write-Warning "Error fetching $Path : $($_.Exception.Message)"
        return @()
    }
}

function Get-AdoFileContent {
    param([string]$Path)

    $encodedPath = [System.Web.HttpUtility]::UrlEncode($Path)
    $uri = "https://dev.azure.com/$Organization/$Project/_apis/git/repositories/$Repository/items" +
           "?path=$encodedPath&versionType=Branch&version=$Branch&api-version=7.0"

    try {
        $resp = Invoke-RestMethod -Uri $uri -Headers $headers -ErrorAction Stop
        if ($resp -isnot [string]) {
            return ($resp | ConvertTo-Json -Depth 50)
        }
        return $resp
    }
    catch {
        return $null
    }
}

# ======================================================
# JSON Normalization Helpers (stable stringify)
# ======================================================
function Normalize-Object {
    param($Obj)

    if ($null -eq $Obj) { return $null }

    if ($Obj -is [System.Collections.IDictionary]) {
        $ordered = New-Object 'System.Collections.Specialized.OrderedDictionary'
        foreach ($key in ($Obj.Keys | Sort-Object)) {
            $ordered[$key] = Normalize-Object $Obj[$key]
        }
        return $ordered
    }
    elseif ($Obj -is [System.Collections.IEnumerable] -and -not ($Obj -is [string])) {
        $list = @($Obj)

        if ($list.Count -gt 0 -and $list[0] -is [System.Collections.IDictionary] -and $list[0].Contains('name')) {
            $sorted = $list | Sort-Object { $_.name }
            return @($sorted | ForEach-Object { Normalize-Object $_ })
        }
        else {
            return @($list | ForEach-Object { Normalize-Object $_ })
        }
    }
    else {
        # Normalize numeric noise a bit
        if ($Obj -is [double] -or $Obj -is [float] -or $Obj -is [decimal]) {
            return [double]$Obj
        }
        return $Obj
    }
}

function Get-NormalizedJson {
    param($Obj)
    $norm = Normalize-Object $Obj
    return ($norm | ConvertTo-Json -Depth 99 -Compress)
}

# ======================================================
# Flatten & diff helpers (for path-level diffs)
# ======================================================
function ConvertTo-FlatMap {
    param(
        [Parameter(Mandatory)]$Obj,
        [string]$Prefix = ""
    )

    $map = @{}
    if ($null -eq $Obj) { return $map }

    if ($Obj -is [System.Collections.IDictionary]) {
        foreach ($k in $Obj.Keys) {
            $p = if ($Prefix) { "$Prefix.$k" } else { "$k" }
            $child = ConvertTo-FlatMap -Obj $Obj[$k] -Prefix $p
            foreach ($ck in $child.Keys) { $map[$ck] = $child[$ck] }
        }
        return $map
    }

    if ($Obj -is [System.Collections.IEnumerable] -and -not ($Obj -is [string])) {
        $i = 0
        foreach ($item in $Obj) {
            $p = "$Prefix[$i]"
            $child = ConvertTo-FlatMap -Obj $item -Prefix $p
            foreach ($ck in $child.Keys) { $map[$ck] = $child[$ck] }
            $i++
        }
        return $map
    }

    # leaf
    if ($Obj -is [double] -or $Obj -is [float] -or $Obj -is [decimal]) {
        $map[$Prefix] = [double]$Obj
    } else {
        $map[$Prefix] = $Obj
    }
    return $map
}

function Get-FlatDiff {
    param(
        [Parameter(Mandatory)][hashtable]$Baseline,
        [Parameter(Mandatory)][hashtable]$Actual
    )

    $rows = @()
    $allKeys = @($Baseline.Keys + $Actual.Keys | Sort-Object -Unique)

    foreach ($k in $allKeys) {
        $hasB = $Baseline.ContainsKey($k)
        $hasA = $Actual.ContainsKey($k)

        if (-not $hasB -and $hasA) {
            $rows += [PSCustomObject]@{ Path=$k; ChangeType="Added"; BaselineValue=$null; ActualValue=$Actual[$k] }
            continue
        }
        if ($hasB -and -not $hasA) {
            $rows += [PSCustomObject]@{ Path=$k; ChangeType="Removed"; BaselineValue=$Baseline[$k]; ActualValue=$null }
            continue
        }

        $bv = $Baseline[$k]
        $av = $Actual[$k]

        if (($bv -is [double]) -and ($av -is [double])) {
            if ([Math]::Abs($bv - $av) -gt 1e-9) {
                $rows += [PSCustomObject]@{ Path=$k; ChangeType="Modified"; BaselineValue=$bv; ActualValue=$av }
            }
        }
        elseif ($bv -ne $av) {
            $rows += [PSCustomObject]@{ Path=$k; ChangeType="Modified"; BaselineValue=$bv; ActualValue=$av }
        }
    }

    return $rows
}

# ======================================================
# Classification Helpers
# ======================================================
function Get-UnitType {
    param([string]$Folder,[string]$Desc,[string]$Name)
    $combined = "$Folder $Desc $Name".ToLower()

    switch -regex ($combined) {
        'fpc'                    { return "FPC" }
        'dvs'                    { return "DVS" }
        'blender'                { return "Blender" }
        'eng|engine'             { return "Blender Engine" }
        'adds'                   { return "Blender Adds" }
        '\bctu\b'                { return "CTU" }
        'hydration'              { return "Hydration" }
        'e[- ]?chem'             { return "E-Chem" }
        '\bprs\b'                { return "PRS" }
        'c6'                     { return "C6" }
        'genset'                 { return "Genset" }
        default                  { return "Unknown" }
    }
}

function Get-TruckNature {
    param(
        [string]$productFileName,
        [string]$engine,
        [string]$transmission,
        [string]$mpcTemplate,
        [string]$configProject,
        [string]$registrationDescription,
        [string]$unitType,
        [bool]  $isMpcTruck
    )

    $combined = "$productFileName $engine $transmission $mpcTemplate $configProject $registrationDescription $unitType".ToLower()

    if     ($combined -match 'fpc')       { $nature = "Frac Pump" }
    elseif ($combined -match 'dvs')       { $nature = "Data Van" }
    elseif ($combined -match 'blender')   { $nature = "Blender" }
    elseif ($combined -match '\bprs\b')   { $nature = "PRS" }
    elseif ($combined -match 'hydration') { $nature = "Hydration" }
    elseif ($combined -match 'e[- ]?chem'){ $nature = "E-Chem" }
    elseif ($combined -match '\bctu\b')   { $nature = "CTU" }
    elseif ($combined -match 'genset')    { $nature = "Genset" }
    else                                  { $nature = $unitType }

    if ($isMpcTruck) {
        if ($nature -eq "Unknown" -or $nature -eq "FPC") {
            return "Frac Pump (MPC Truck)"
        }
        return "$nature (MPC Truck)"
    }

    return $nature
}

function Get-ConfigProjectRole {
    param([string]$ConfigProject)
    if ($script:addonProjects -contains $ConfigProject) { "Addon" } else { "Main" }
}

# Fuzzy family/row matcher for alarms templates
function Test-FamilyMatch {
    param($Row,[string]$FamilyName)

    $familyLower = $FamilyName.ToLower()
    $hint = ("{0} {1} {2} {3}" -f $Row.Engine, $Row.Transmission, $Row.ConfigProject, $Row.MpcTemplate).ToLower()

    if ($Row.ConfigProject -eq $FamilyName) { return $true }

    $tokens = [regex]::Split($familyLower, '[^a-z0-9]+') | Where-Object { $_ -ne "" }
    if ($tokens.Count -eq 0) { return $false }

    $matched = 0
    foreach ($t in $tokens) {
        if ($hint -like "*$t*") { $matched++ }
    }

    $required = [Math]::Ceiling($tokens.Count * 0.6)
    return ($matched -ge $required)
}

function Get-FamilyForRow {
    param($Row,[string[]]$FamilyNames)

    foreach ($f in $FamilyNames) {
        if (Test-FamilyMatch -Row $Row -FamilyName $f) { return $f }
    }
    return $null
}

# ======================================================
# Manifest parsing helper (adds a human-readable comment)
# ======================================================
function Read-Manifest {
    param([string]$ManifestContent)

    $out = [PSCustomObject]@{
        Status  = "Missing"   # OK / Missing / Invalid
        Obj     = $null
        Comment = $null
    }

    if ([string]::IsNullOrWhiteSpace($ManifestContent)) {
        $out.Status  = "Missing"
        $out.Comment = "Manifest file missing or empty."
        return $out
    }

    $trim = $ManifestContent.TrimStart()
    if (-not $trim.StartsWith("{")) {
        $out.Status  = "Invalid"
        $out.Comment = "Manifest content does not start with '{' (not a JSON object)."
        return $out
    }

    try {
        $obj = $ManifestContent | ConvertFrom-Json -ErrorAction Stop

        if ($null -eq $obj -or ($obj.PSObject.Properties.Count -eq 0)) {
            $out.Status  = "Invalid"
            $out.Comment = "Manifest JSON parsed but is empty."
            return $out
        }

        if (-not $obj.PSObject.Properties.Match('powertrainSummary').Count -and
            -not $obj.PSObject.Properties.Match('productFileName').Count) {
            $out.Status  = "OK"
            $out.Comment = "Manifest parsed, but expected fields (powertrainSummary/productFileName) are missing."
            $out.Obj     = $obj
            return $out
        }

        $out.Status = "OK"
        $out.Obj    = $obj
        return $out
    }
    catch {
        $msg = $_.Exception.Message
        if ($msg.Length -gt 300) { $msg = $msg.Substring(0,300) + "..." }
        $out.Status  = "Invalid"
        $out.Comment = "Manifest JSON parse error: $msg"
        return $out
    }
}

# ======================================================
# Alarm sensor extraction helpers
# ======================================================
function Add-Sensor {
    param([hashtable]$Set,[string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return }
    $n = $Name.Trim()
    if ($n) { $Set[$n] = $true }
}

function Get-AlarmSensorSet {
    param($alarmsObj)

    $set = @{}

    if ($null -eq $alarmsObj) { return $set }

    # constraints array elements may have: sensor, sensors, calculatedSensor, registrySensorName
    if ($alarmsObj.constraints) {
        foreach ($c in @($alarmsObj.constraints)) {
            if ($null -eq $c) { continue }

            Add-Sensor -Set $set -Name $c.sensor
            Add-Sensor -Set $set -Name $c.calculatedSensor
            Add-Sensor -Set $set -Name $c.registrySensorName

            if ($c.sensors) {
                foreach ($s in @($c.sensors)) { Add-Sensor -Set $set -Name $s }
            }
        }
    }

    # alarms[].actions may include outputChannel (not really a sensor, but track anyway)
    if ($alarmsObj.alarms) {
        foreach ($a in @($alarmsObj.alarms)) {
            if ($a.actions) {
                foreach ($act in @($a.actions)) {
                    Add-Sensor -Set $set -Name $act.outputChannel
                }
            }
        }
    }

    return $set
}

function Get-UnitConfigSensorKeysFromUnitConfig {
    param($unitConfigObj)

    # In unit.config, user modifications appear in "configs" section keys like:
    #   PRES_DISCHARGE_01_CONFIG -> sensor PRES_DISCHARGE_01
    $map = @{}  # sensorName -> configKeyName

    if ($null -eq $unitConfigObj -or $null -eq $unitConfigObj.configs) { return $map }

    $cfg = $unitConfigObj.configs
    if ($cfg -isnot [System.Collections.IDictionary]) {
        # ConvertFrom-Json usually yields PSCustomObject
        $cfg = $cfg.PSObject.Properties | ForEach-Object { @{ Name = $_.Name; Value = $_.Value } }
    }

    # Handle PSCustomObject form
    if ($unitConfigObj.configs -is [PSCustomObject]) {
        foreach ($p in $unitConfigObj.configs.PSObject.Properties) {
            $key = $p.Name
            if ($key -match '^(?<sensor>.+)_CONFIG$') {
                $sensor = $matches['sensor']
                $map[$sensor] = $key
            }
        }
        return $map
    }

    # Fallback (rare)
    return $map
}

function Safe-Truncate {
    param([string]$s,[int]$max=1500)
    if ($null -eq $s) { return $null }
    if ($s.Length -le $max) { return $s }
    return ($s.Substring(0,$max) + "...")
}

# ======================================================
# Local KIWI FPC 4.5 Template Auto-Discovery (alarms.config)
# ======================================================
Write-Host "Scanning local FPC 4.5 template library..." -ForegroundColor Cyan

$familyTemplates = @{}  # familyName -> local alarms.config path

if (-not (Test-Path $FpcRootLocal)) {
    Write-Warning "Local FPC path not found: $FpcRootLocal. No alarms compliance will run."
}
else {
    Get-ChildItem -Path $FpcRootLocal -Directory | ForEach-Object {
        $familyName = $_.Name
        $alarmsPath = Join-Path $_.FullName "kiwi\alarms\alarms.config"
        if (Test-Path $alarmsPath) {
            $familyTemplates[$familyName] = $alarmsPath
            Write-Host ("  Found family '{0}' template at {1}" -f $familyName, $alarmsPath) -ForegroundColor Green
        }
        else {
            Write-Host ("  No alarms.config in '{0}'" -f $familyName) -ForegroundColor Yellow
        }
    }
}

$familyNames = @($familyTemplates.Keys | Sort-Object)

# ======================================================
# Step 1: Single scan of /NexTier for all items
# ======================================================
Write-Host "`nScanning $RootPath recursively for repository items..." -ForegroundColor Cyan
$items = Get-AdoItemsRecursive -Path $RootPath

if (-not $items -or $items.Count -eq 0) {
    Write-Warning "No items returned from ADO under $RootPath."
    return
}

# Auto-discover Add-On projects based on *_manifest.json
$script:addonProjects =
    $items |
    Where-Object { $_.path -match "_manifest\.json$" } |
    ForEach-Object {
        $rel = ($_."path" -replace "^/NexTier/", "") -replace "_manifest\.json$", ""
        ($rel -split "/")[-1]
    } |
    Sort-Object -Unique

Write-Host "`nDiscovered Add-On modules:" -ForegroundColor Yellow
$addonProjects | ForEach-Object { Write-Host "  - $_" }

# Filter down to unit.config files
$unitConfigs = $items | Where-Object { $_.path -match "/etc/unit\.config$" }

if (-not $unitConfigs -or $unitConfigs.Count -eq 0) {
    Write-Warning "No unit.config files found under $RootPath."
    return
}

Write-Host "`nFound $($unitConfigs.Count) unit.config files.`n"

# ======================================================
# Step 2: Read unit.config + manifest.json and classify
# ======================================================
$result       = @()
$successCount = 0
$failCount    = 0

# NEW: alarm sensor override tracking
$alarmSensorOverrides      = @()  # high-level (per unit per sensor)
$alarmSensorOverrideDiffs  = @()  # detailed per-path diffs (per unit per configKey)

# Cache alarms.config per unit folder to avoid repeated ADO calls in later steps
$alarmsCache = @{}  # folder -> alarmsObj or $null

foreach ($file in $unitConfigs) {

    $path  = $file.path
    $short = ($path -replace "^/NexTier/", "") -replace "/etc/unit\.config$", ""
    $configProject = ($short -split '/')[0]
    $configRole    = Get-ConfigProjectRole -ConfigProject $configProject

    Write-Host " Reading $path..."

    $content = Get-AdoFileContent -Path $path
    if (-not $content) {
        Write-Warning " Could not read $path"
        $failCount++
        continue
    }

    try {
        $json = $content | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Warning " Invalid JSON in $path : $($_.Exception.Message)"
        $failCount++
        continue
    }

    $name = $json.RegistrationName
    $desc = $json.RegistrationDescription

    $unitType = Get-UnitType -Folder $short -Desc $desc -Name $name

    $isMpcTruck = $mpcProjects -contains $configProject
    if ($isMpcTruck -and $unitType -eq "Unknown") {
        $unitType = "FPC"
    }

    # Manifest handling
    $manifestPath    = $path -replace "/unit\.config$", "/manifest.json"
    $manifestContent = Get-AdoFileContent -Path $manifestPath

    $manifestRead    = Read-Manifest -ManifestContent $manifestContent
    $manifestStatus  = $manifestRead.Status
    $manifest        = $manifestRead.Obj
    $manifestComment = $manifestRead.Comment

    $productFileName = $null
    $engine          = $null
    $transmission    = $null
    $mpcTemplate     = $null
    $addonSummary    = $null
    $installerVer    = $null
    $modifiedOnUtc   = $null

    if ($manifestStatus -eq "OK" -and $manifest) {
        $productFileName = $manifest.productFileName
        $engine          = $manifest.powertrainSummary.engine
        $transmission    = $manifest.powertrainSummary.transmission
        $mpcTemplate     = $manifest.powertrainSummary.mpcTemplate
        $addonSummary    = if ($manifest.addonSummary) { $manifest.addonSummary -join '; ' } else { $null }
        $installerVer    = $manifest.installerVersion
        $modifiedOnUtc   = $manifest.modifiedOnUtc
    }

    $manifestPowertrainKnown =
        -not [string]::IsNullOrWhiteSpace($engine)       -or
        -not [string]::IsNullOrWhiteSpace($transmission) -or
        -not [string]::IsNullOrWhiteSpace($mpcTemplate)  -or
        -not [string]::IsNullOrWhiteSpace($productFileName)

    $truckNature = Get-TruckNature `
        -productFileName $productFileName `
        -engine $engine `
        -transmission $transmission `
        -mpcTemplate $mpcTemplate `
        -configProject $configProject `
        -registrationDescription $desc `
        -unitType $unitType `
        -isMpcTruck $isMpcTruck

    # RULE: if TruckNature is Frac Pump then UnitType is FPC
    if ($truckNature -like "Frac Pump*") {
        $unitType = "FPC"
    }

    # Determine family for this unit (based on discovered family names)
    $family = $null
    if ($familyNames.Count -gt 0) {
        $tempRowForFamily = [PSCustomObject]@{
            Engine       = $engine
            Transmission = $transmission
            ConfigProject= $configProject
            MpcTemplate  = $mpcTemplate
        }
        $family = Get-FamilyForRow -Row $tempRowForFamily -FamilyNames $familyNames
    }

    # Read alarms.config for this unit folder (repo-side)
    $alarmsObj = $null
    if (-not $alarmsCache.ContainsKey($short)) {
        $repoAlarmsPath = "$RootPath/$short/alarms.config"
        $alarmsContent  = Get-AdoFileContent -Path $repoAlarmsPath
        if ($alarmsContent) {
            try { $alarmsObj = $alarmsContent | ConvertFrom-Json -ErrorAction Stop } catch { $alarmsObj = $null }
        }
        $alarmsCache[$short] = $alarmsObj
    } else {
        $alarmsObj = $alarmsCache[$short]
    }

    # Alarm sensor -> unit.config modification detection:
    # If sensor referenced by alarms exists in unit.config "configs" (sensorName + "_CONFIG"), treat as user-modified.
    if ($alarmsObj -and $json -and $json.configs) {
        $alarmSensors = Get-AlarmSensorSet -alarmsObj $alarmsObj         # set of sensor names from alarms file
        $unitSensorToConfigKey = Get-UnitConfigSensorKeysFromUnitConfig -unitConfigObj $json  # sensor -> configKey

        foreach ($sensorName in $alarmSensors.Keys) {
            if ($unitSensorToConfigKey.ContainsKey($sensorName)) {
                $configKey = $unitSensorToConfigKey[$sensorName]
                $configObj = $json.configs.$configKey

                $alarmSensorOverrides += [PSCustomObject]@{
                    Folder           = $short
                    RegistrationName = $name
                    ConfigProject    = $configProject
                    Family           = $family
                    TruckNature      = $truckNature
                    SensorName       = $sensorName
                    UnitConfigKey    = $configKey
                    UnitConfigValue  = Safe-Truncate (Get-NormalizedJson $configObj) 2000
                }
            }
        }
    }

    $result += [PSCustomObject]@{
        ConfigProjectRole        = $configRole
        ConfigProject            = $configProject
        IsMpcTruck               = $isMpcTruck
        Folder                   = $short
        RegistrationName         = $name
        RegistrationDescription  = $desc
        UnitType                 = $unitType
        TruckNature              = $truckNature
        Family                   = $family

        ManifestStatus           = $manifestStatus
        ManifestIssueComment     = $manifestComment
        ManifestPowertrainKnown  = $manifestPowertrainKnown

        ProductFileName          = $productFileName
        Engine                   = $engine
        Transmission             = $transmission
        MpcTemplate              = $mpcTemplate
        AddonSummary             = $addonSummary
        InstallerVersion         = $installerVer
        ModifiedOnUtc            = $modifiedOnUtc
    }

    $successCount++
}

# ======================================================
# Step 3: Summary
# ======================================================
Write-Host "`nSummary:`n"
Write-Host (" Successfully read: {0}" -f $successCount) -ForegroundColor Green
Write-Host (" Failed to read:    {0}" -f $failCount) -ForegroundColor Red
Write-Host ""

$result | Group-Object TruckNature | ForEach-Object {
    Write-Host (" {0} ({1})" -f $_.Name, $_.Count) -ForegroundColor Cyan
}

# ======================================================
# Step 4: Detect Twin DVS structures
# ======================================================
$twinDvs = @()

$dvsGroups = $result |
    Where-Object { $_.UnitType -eq "DVS" } |
    Group-Object { ($_."Folder" -split '/')[0] }

foreach ($g in $dvsGroups) {
    $ipCount = ($g.Group | Where-Object { $_.Folder -match '10\.\d+\.\d+\.\d+' }).Count
    if ($ipCount -ge 2) {
        foreach ($item in $g.Group) {
            $suffix = if     ($item.Folder -match '10\.10\.138\.') { "A" }
                      elseif ($item.Folder -match '10\.10\.139\.') { "B" }
                      else                                        { "" }

            $twinDvs += [PSCustomObject]@{
                TwinGroup   = $g.Name
                Side        = $suffix
                Folder      = $item.Folder
                Description = $item.RegistrationDescription
            }
        }
    }
}

# ======================================================
# Step 5: Export core CSVs
# ======================================================
$result  | Export-Csv -NoTypeInformation -Encoding UTF8 -Path ".\NexTierUnitList.csv"
$twinDvs | Export-Csv -NoTypeInformation -Encoding UTF8 -Path ".\TwinDVS.csv"

$manifestUnknown = $result | Where-Object {
    $_.ManifestStatus -ne "OK" -or -not $_.ManifestPowertrainKnown
}
$manifestUnknown | Export-Csv -NoTypeInformation -Encoding UTF8 -Path ".\NexTierUnitList_ManifestUnknown.csv"

Write-Host "`nCore results saved to:"
Write-Host "  NexTierUnitList.csv"
Write-Host "  NexTierUnitList_ManifestUnknown.csv"
Write-Host "  TwinDVS.csv"

# ======================================================
# Step 6: Analytics (saved under .\Analytics)
# ======================================================
$analyticsDir = ".\Analytics"
if (!(Test-Path $analyticsDir)) {
    New-Item -ItemType Directory -Path $analyticsDir | Out-Null
}

# 6.1 Fleet composition
$fleetComposition = $result |
    Group-Object TruckNature, UnitType |
    Sort-Object Count -Descending |
    Select-Object @{n='TruckNature';e={$_.Group[0].TruckNature}},
                  @{n='UnitType';e={$_.Group[0].UnitType}},
                  Count
$fleetComposition | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "FleetComposition.csv")

# 6.2 Powertrain distribution
$powertrain = $result |
    Group-Object Engine, Transmission, MpcTemplate |
    Sort-Object Count -Descending |
    Select-Object @{n='Engine';e={$_.Group[0].Engine}},
                  @{n='Transmission';e={$_.Group[0].Transmission}},
                  @{n='MpcTemplate';e={$_.Group[0].MpcTemplate}},
                  Count
$powertrain | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "PowertrainDistribution.csv")

# 6.3 Add-on adoption (summary + detail)
$addonDetail = @()
$result | Where-Object { $_.AddonSummary } | ForEach-Object {
    $row = $_
    $row.AddonSummary -split ';' | ForEach-Object {
        $name = $_.Trim()
        if ($name) {
            $addonDetail += [PSCustomObject]@{
                AddonName     = $name
                Engine        = $row.Engine
                TruckNature   = $row.TruckNature
                ConfigProject = $row.ConfigProject
                Folder        = $row.Folder
            }
        }
    }
}
$addonSummary = $addonDetail |
    Group-Object AddonName |
    Sort-Object Count -Descending |
    Select-Object @{n='AddonName';e={$_.Name}}, Count
$addonSummary | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AddonUsageSummary.csv")
$addonDetail  | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AddonUsageDetail.csv")

# 6.4 Installer version compliance
$installerVersions = $result |
    Group-Object InstallerVersion |
    Sort-Object Count -Descending |
    Select-Object @{n='InstallerVersion';e={$_.Name}}, Count
$installerVersions | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "InstallerVersions.csv")

# 6.5 Registration issues
$registrationIssues = $result | Where-Object {
    [string]::IsNullOrWhiteSpace($_.RegistrationDescription) -or
    $_.RegistrationDescription -match 'REPLACE ME'
}
$registrationIssues | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "RegistrationIssues.csv")

$weakDescriptions = $result | Where-Object {
    $_.RegistrationDescription -and
    (
        $_.RegistrationDescription -match '^[0-9 ]+$' -or
        $_.RegistrationDescription.Length -lt 5
    )
}
$weakDescriptions |
  Select-Object Folder, RegistrationDescription, Engine, TruckNature |
  Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "WeakDescriptions.csv")

# 6.6 Manifest issues summary + detail
$manifestIssuesSummary = $result |
    Group-Object ManifestStatus, ManifestPowertrainKnown |
    Sort-Object Count -Descending |
    Select-Object @{n='ManifestStatus';e={$_.Group[0].ManifestStatus}},
                  @{n='ManifestPowertrainKnown';e={$_.Group[0].ManifestPowertrainKnown}},
                  Count
$manifestIssuesSummary | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "ManifestIssuesSummary.csv")

$manifestIssueDetail = $result |
  Where-Object { $_.ManifestStatus -ne "OK" } |
  Select-Object Folder, ConfigProject, TruckNature, ManifestStatus, ManifestIssueComment
$manifestIssueDetail | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "ManifestIssues_Detail.csv")

# ======================================================
# 6.21 Alarms template compliance — ALL families in FPC 4.5
# ======================================================
if ($familyTemplates.Count -gt 0) {

    Write-Host "`nRunning alarms.config compliance checks for all discovered families..." -ForegroundColor Cyan

    foreach ($familyName in $familyTemplates.Keys) {

        $templatePath = $familyTemplates[$familyName]

        Write-Host " Family: $familyName" -ForegroundColor Cyan
        Write-Host "   Template: $templatePath"

        # Load and normalize template
        $refNorm = $null
        try {
            $refContent = Get-Content -Raw -Path $templatePath
            $refJson    = $refContent | ConvertFrom-Json
            $refNorm    = Get-NormalizedJson $refJson
        }
        catch {
            Write-Warning "  Failed to parse template for '$familyName' at $templatePath : $($_.Exception.Message)"
            continue
        }

        $nonCompliant = @()

        foreach ($row in $result) {

            if ($row.TruckNature -notlike "Frac Pump*") { continue }
            if (-not (Test-FamilyMatch -Row $row -FamilyName $familyName)) { continue }

            $alarmsPath    = "$RootPath/$($row.Folder)/alarms.config"
            $alarmsContent = Get-AdoFileContent -Path $alarmsPath

            $isMatch = $false
            $reason  = $null

            if (-not $alarmsContent) {
                $reason = "Missing alarms.config"
            }
            else {
                try {
                    $alarmsObj  = $alarmsContent | ConvertFrom-Json
                    $alarmsNorm = Get-NormalizedJson $alarmsObj

                    if ($alarmsNorm -eq $refNorm) {
                        $isMatch = $true
                        $reason  = "Match"
                    }
                    else {
                        $reason = "Content differs from family template"
                    }
                }
                catch {
                    $reason = "Invalid alarms.config JSON: $($_.Exception.Message)"
                }
            }

            if (-not $isMatch) {
                $nonCompliant += [PSCustomObject]@{
                    Folder        = $row.Folder
                    ConfigProject = $row.ConfigProject
                    TruckNature   = $row.TruckNature
                    Engine        = $row.Engine
                    Transmission  = $row.Transmission
                    MpcTemplate   = $row.MpcTemplate
                    Family        = $familyName
                    AlarmsPath    = $alarmsPath
                    Reason        = $reason
                }
            }
        }

        $safeFamily = ($familyName -replace '[^a-zA-Z0-9]+', '_').Trim('_')
        $outFile    = "AlarmsNonCompliant_{0}.csv" -f $safeFamily
        $outPath    = Join-Path $analyticsDir $outFile

        if ($nonCompliant.Count -gt 0) {
            $nonCompliant | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $outPath
            Write-Host "   Non-compliant units: $($nonCompliant.Count) [saved to $outFile]" -ForegroundColor Yellow
        }
        else {
            Write-Host "   All matching frac pumps compliant for this family." -ForegroundColor Green
        }
    }
}
else {
    Write-Host "`nNo family templates discovered — skipping alarms compliance." -ForegroundColor Yellow
}

# ======================================================
# 6.22 Alarm Sensor -> unit.config override insights + diffs
# ======================================================
# Baseline strategy:
#   For each Family + UnitConfigKey (e.g., PRES_DISCHARGE_01_CONFIG), compute the most common normalized JSON
#   across all units in that family that have the override present. That becomes "baseline".
# Then for each unit, diff its override vs baseline and export both summary and detailed diffs.

Write-Host "`nBuilding alarm sensor override insights..." -ForegroundColor Cyan

# Export raw detections first (even if baseline cannot be computed)
if ($alarmSensorOverrides.Count -gt 0) {
    $alarmSensorOverrides |
      Sort-Object Family, Folder, SensorName |
      Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AlarmSensorOverrides_Raw.csv")
} else {
    # still create an empty file for consistency
    @() | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AlarmSensorOverrides_Raw.csv")
}

# Build baseline map: (Family|UnitConfigKey) -> BaselineJson
$baselineMap = @{}  # key -> baselineJson
$baselineStats = @() # for reporting counts

# Group by Family + UnitConfigKey
$groups = $alarmSensorOverrides |
    Where-Object { $_.Family } |
    Group-Object Family, UnitConfigKey

foreach ($g in $groups) {
    $family = $g.Group[0].Family
    $unitConfigKey = $g.Group[0].UnitConfigKey
    $k = "$family|$unitConfigKey"

    # Count occurrences of each normalized JSON
    $counts = @{}  # json -> count
    foreach ($row in $g.Group) {
        $j = $row.UnitConfigValue
        if ([string]::IsNullOrWhiteSpace($j)) { continue }
        if (-not $counts.ContainsKey($j)) { $counts[$j] = 0 }
        $counts[$j]++
    }

    if ($counts.Count -eq 0) { continue }

    # Pick mode (most common) as baseline
    $baselineJson = ($counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
    $baselineMap[$k] = $baselineJson

    $baselineStats += [PSCustomObject]@{
        Family        = $family
        UnitConfigKey = $unitConfigKey
        BaselineCount = $counts[$baselineJson]
        TotalCount    = $g.Count
        DistinctCount = $counts.Count
    }
}

$baselineStats |
  Sort-Object TotalCount -Descending |
  Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AlarmSensorOverride_Baselines.csv")

# Now compute diffs (summary + path-level)
$overrideDiffSummary = @()
$overrideDiffDetail  = @()

foreach ($row in $alarmSensorOverrides) {

    if ([string]::IsNullOrWhiteSpace($row.Family)) { continue }
    $k = "$($row.Family)|$($row.UnitConfigKey)"
    if (-not $baselineMap.ContainsKey($k)) { continue }

    $baselineJson = $baselineMap[$k]
    $actualJson   = $row.UnitConfigValue

    $sameAsBaseline = ($baselineJson -eq $actualJson)

    $overrideDiffSummary += [PSCustomObject]@{
        Folder           = $row.Folder
        RegistrationName = $row.RegistrationName
        ConfigProject    = $row.ConfigProject
        Family           = $row.Family
        TruckNature      = $row.TruckNature
        SensorName       = $row.SensorName
        UnitConfigKey    = $row.UnitConfigKey
        SameAsFamilyMode = $sameAsBaseline
        BaselineJson     = Safe-Truncate $baselineJson 2000
        ActualJson       = Safe-Truncate $actualJson   2000
    }

    if (-not $sameAsBaseline) {
        # Parse baseline/actual into objects so we can do path-level diffs
        $bObj = $null
        $aObj = $null
        try { $bObj = $baselineJson | ConvertFrom-Json -ErrorAction Stop } catch { $bObj = $null }
        try { $aObj = $actualJson   | ConvertFrom-Json -ErrorAction Stop } catch { $aObj = $null }

        if ($bObj -and $aObj) {
            $bMap = ConvertTo-FlatMap -Obj $bObj -Prefix $row.UnitConfigKey
            $aMap = ConvertTo-FlatMap -Obj $aObj -Prefix $row.UnitConfigKey
            $diffRows = Get-FlatDiff -Baseline $bMap -Actual $aMap

            foreach ($d in $diffRows) {
                $overrideDiffDetail += [PSCustomObject]@{
                    Folder           = $row.Folder
                    RegistrationName = $row.RegistrationName
                    Family           = $row.Family
                    SensorName       = $row.SensorName
                    UnitConfigKey    = $row.UnitConfigKey
                    Path             = $d.Path
                    ChangeType       = $d.ChangeType
                    BaselineValue    = $d.BaselineValue
                    ActualValue      = $d.ActualValue
                }
            }
        }
        else {
            # If parsing fails, still record that we couldn't diff structure
            $overrideDiffDetail += [PSCustomObject]@{
                Folder           = $row.Folder
                RegistrationName = $row.RegistrationName
                Family           = $row.Family
                SensorName       = $row.SensorName
                UnitConfigKey    = $row.UnitConfigKey
                Path             = ""
                ChangeType       = "UnDiffable"
                BaselineValue    = "BaselineJson or ActualJson could not be parsed as JSON"
                ActualValue      = ""
            }
        }
    }
}

$overrideDiffSummary |
  Sort-Object Family, Folder, SensorName |
  Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AlarmSensorOverrides_DiffSummary.csv")

$overrideDiffDetail |
  Sort-Object Family, Folder, SensorName, UnitConfigKey, Path |
  Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $analyticsDir "AlarmSensorOverrides_DiffDetail.csv")

# ======================================================
# Done
# ======================================================
Write-Host "`nOutputs:" -ForegroundColor Cyan
Write-Host "  .\NexTierUnitList.csv"
Write-Host "  .\NexTierUnitList_ManifestUnknown.csv"
Write-Host "  .\TwinDVS.csv"
Write-Host "  .\Analytics\AlarmsNonCompliant_<Family>.csv (per family)"
Write-Host "  .\Analytics\AlarmSensorOverrides_Raw.csv"
Write-Host "  .\Analytics\AlarmSensorOverride_Baselines.csv"
Write-Host "  .\Analytics\AlarmSensorOverrides_DiffSummary.csv"
Write-Host "  .\Analytics\AlarmSensorOverrides_DiffDetail.csv"
Write-Host "`nDone." -ForegroundColor Cyan
