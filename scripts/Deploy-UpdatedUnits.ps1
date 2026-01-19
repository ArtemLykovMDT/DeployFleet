<#
.SYNOPSIS
  ROBUST ARCHITECTURE V33 (Final)
  - Uses *stwnet* everywhere (external network on the Linux host)
  - Quotes numeric service keys ("621696":) to satisfy docker compose YAML parsing
  - Auto-selects free IPs on stwnet to avoid MAC/IP collisions
  - Centralized: modifies staging/docker-compose.yml then uploads to /home/developer/MDT.Kiwi/docker/fleet/docker-compose.yml
#>

param(
  [Parameter(Mandatory=$true)]
  [string]$UnitNumber,

  [string]$LinuxHost = $env:LinuxHost,
  [string]$LinuxUser = $env:LinuxUser,
  [string]$LinuxPassword = $env:LinuxPassword,
  [int]$SshPort = 22,

  [string]$Subnet = "172.18.1.0/24",
  [string]$Gateway = "172.18.1.1",
  [int]$StartIpOctet = 110
)

# Normalize input:
# - supports: -UnitNumber 621696,621822
# - supports: -UnitNumber "621696, 621822"
# - supports: -UnitNumber "621696" "621822"
$UnitNumber = @(
  $UnitNumber |
    ForEach-Object { $_ -split '\s*,\s*' } |
    ForEach-Object { $_.Trim() } |
    Where-Object  { $_ -ne "" } |
    Select-Object -Unique
)

Write-Host "Units: $($UnitNumber -join ', ')" -ForegroundColor DarkGray



function Out-LinuxFile {
    param([string]$path, $content)
    $parent = Split-Path $path
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

    if ($content -is [array]) { $strContent = $content -join "`n" } else { $strContent = [string]$content }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $strContent, $utf8NoBom)
}

Write-Host "--- RUNNING DEPLOY SCRIPT V33 (stwnet everywhere + auto IP) ---" -ForegroundColor Magenta

# ==========================================
# 1. SETUP & INFRASTRUCTURE PREP
# ==========================================
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath   = Join-Path $ScriptDir ".env"
if (Test-Path $EnvPath) {
    Get-Content $EnvPath | ForEach-Object {
        if ($_ -match "^\s*([^#=]+?)\s*=\s*(.+)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim('"').Trim())
        }
    }
}

$LinuxHost       = $env:LinuxHost
$LinuxUser       = $env:LinuxUser
$LinuxPassword   = $env:LinuxPassword
$WinSCPPath      = "C:\Program Files (x86)\WinSCP\WinSCP.com"

$RemoteFleetRoot = "/home/developer/MDT.Kiwi/docker/fleet"
$RemoteSTWPath   = "$RemoteFleetRoot/stw"

$LocalComposeDir = Join-Path $ScriptDir "staging"
$LocalCompose    = Join-Path $LocalComposeDir "docker-compose.yml"

$ComposeNetworkKey = "stwnet"
$DockerNetworkName = "stwnet"
$MacvlanParentIf   = "br0"
$WinScpOptions = @(
    "option batch on",
    "option confirm off",
    "option reconnecttime 30"
)
$WinScpLogDir = Join-Path $env:TEMP "winscp-logs"
if (-not (Test-Path $WinScpLogDir)) { New-Item -ItemType Directory -Path $WinScpLogDir -Force | Out-Null }
$ipFormat = '{{range $k,$v := .Containers}}{{$v.IPv4Address}}{{println}}{{end}}'

# ==========================================
# 0/5 PRE-FLIGHT
# - Ensure staging dir exists
# - Ensure docker network exists on host
# - Download current docker-compose.yml
# - Fetch used IPs on stwnet so we can avoid collisions
# ==========================================
Write-Host "`n[0/5] Pre-Flight: Verify stwnet + Fetch compose + Read used IPs..." -ForegroundColor Cyan
if (-not (Test-Path $LocalComposeDir)) { New-Item -ItemType Directory -Path $LocalComposeDir -Force | Out-Null }

$netScript = Join-Path $env:TEMP "winscp_net_prep.txt"
$remoteIpDump = "/tmp/stwnet_ips.txt"
$remoteContainerDump = "/tmp/stwnet_containers.json"

$netCmds = @()
$netCmds += $WinScpOptions
$netCmds += @(
    "open sftp://${LinuxUser}:${LinuxPassword}@${LinuxHost}/ -hostkey=`"*`" -timeout=60",

    # Ensure network exists (do NOT delete it)
    "call docker network inspect $DockerNetworkName > /dev/null 2>&1 || (docker network create -d macvlan --subnet=$Subnet --gateway=$Gateway -o parent=$MacvlanParentIf $DockerNetworkName)",

    # Ensure fleet root exists on remote
    "call mkdir -p ""$RemoteFleetRoot""",

    # Download master compose
    "get ""$RemoteFleetRoot/docker-compose.yml"" ""$LocalCompose""",

    # Dump used IPs on stwnet (one per line)
    "call docker network inspect $DockerNetworkName --format '$ipFormat' | cut -d/ -f1 > $remoteIpDump",
    "call docker network inspect $DockerNetworkName --format '{{json .Containers}}' > $remoteContainerDump",

    # Download IP dump
    "get ""$remoteIpDump"" ""$($LocalComposeDir)\stwnet_ips.txt""",
    "get ""$remoteContainerDump"" ""$($LocalComposeDir)\stwnet_containers.json""",

    "exit"
)
Out-LinuxFile -path $netScript -content $netCmds
$netLog = Join-Path $WinScpLogDir "winscp-preflight.log"
& $WinSCPPath /script=$netScript /log=$netLog /loglevel=2 | Out-Null
if ($LASTEXITCODE -ne 0) {
    if (Test-Path $netLog) {
        Write-Host "WinSCP preflight log (tail):" -ForegroundColor DarkYellow
        Get-Content $netLog -Tail 60 | ForEach-Object { Write-Host $_ }
    }
    throw "Pre-flight failed. WinSCP exit code: $LASTEXITCODE"
}

if (-not (Test-Path $LocalCompose)) {
    $skeleton = @"
version: '3.9'
services:
networks:
  stwnet:
    external: true
volumes:
"@
    Out-LinuxFile -path $LocalCompose -content $skeleton
}

# Load used IPs
$UsedIps = @()
$ipDumpLocal = Join-Path $LocalComposeDir "stwnet_ips.txt"
if (Test-Path $ipDumpLocal) {
    $UsedIps = Get-Content $ipDumpLocal | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }
}
$UsedLastOctets = New-Object System.Collections.Generic.HashSet[int]
foreach ($ip in $UsedIps) {
    $oct = [int]($ip.Split('.')[-1])
    $null = $UsedLastOctets.Add($oct)
}

$containersByIp = @{}
$containersToRemove = @{}
$containerDumpLocal = Join-Path $LocalComposeDir "stwnet_containers.json"
if (Test-Path $containerDumpLocal) {
    try {
        $rawContainers = Get-Content $containerDumpLocal -Raw
        if ($rawContainers) {
            $containerMap = $rawContainers | ConvertFrom-Json
            foreach ($entry in $containerMap.PSObject.Properties) {
                $containerId = $entry.Name
                $containerInfo = $entry.Value
                $ipAddress = ($containerInfo.IPv4Address -split '/')[0]
                if ($ipAddress) {
                    $containersByIp[$ipAddress] = @{
                        Id = $containerId
                        Name = $containerInfo.Name
                    }
                }
            }
        }
    } catch {
        Write-Warning "Unable to parse stwnet container list. Skipping IP cleanup."
    }
}

# Helper: get next free IP octet
function Get-NextFreeOctet {
    param(
        [int]$start,
        [System.Collections.Generic.HashSet[int]]$used
    )
    for ($o = $start; $o -le 250; $o++) {
        if (-not $used.Contains($o)) { return $o }
    }
    throw "No free IP octet found from $start..250 on stwnet."
}

function Is-ValidIPv4 {
    param([string]$ip)
    return [bool]([System.Net.IPAddress]::TryParse($ip, [ref]([System.Net.IPAddress]::Loopback)))
}

function Get-SubnetPrefix {
    param([string]$cidr)
    if (-not $cidr) { return $null }
    $parts = $cidr.Split('/')
    if ($parts.Count -ne 2) { return $null }
    $mask = [int]$parts[1]
    if ($mask -ne 24) { return $null }
    return $parts[0].Trim()
}

function Get-IpOctetIfInSubnet {
    param([string]$ip, [string]$subnetCidr)
    if (-not (Is-ValidIPv4 $ip)) { return $null }
    $prefix = Get-SubnetPrefix $subnetCidr
    if (-not $prefix) { return $null }
    $prefixParts = $prefix.Split('.')
    $ipParts = $ip.Split('.')
    if ($prefixParts.Count -ne 4 -or $ipParts.Count -ne 4) { return $null }
    if (($prefixParts[0..2] -join '.') -ne ($ipParts[0..2] -join '.')) { return $null }
    return [int]$ipParts[3]
}

function Get-UnitConfigJson {
    param([string]$rootPath)
    if (-not $rootPath -or -not (Test-Path $rootPath)) { return $null }
    $configPath = Get-ChildItem -Path $rootPath -Recurse -Filter "unit.config" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $configPath) { return $null }
    try {
        $raw = Get-Content -Path $configPath.FullName -Raw
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) {
            $raw = $raw.TrimStart([char]0xFEFF)
        }
        return $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

# ==========================================
# 1/5 DOWNLOAD TARGET FILES
# ==========================================
Write-Host "`n[1/5] Downloading Target Files Only..." -ForegroundColor Cyan
& (Join-Path $ScriptDir "Download-AdoUnit.ps1") -UnitNumber $UnitNumber

# ==========================================
# 2/5 UPDATE UNIT CONFIGS
# ==========================================
Write-Host "`n[2/5] Updating Unit Configs..." -ForegroundColor Cyan
& (Join-Path $ScriptDir "Update-MPC-UnitConfig.ps1") -UnitNumber $UnitNumber

# ==========================================
# 3/5 MODIFY DOCKER-COMPOSE
# - purge target unit(s)
# - insert into managed region
# - force networks.stwnet external
# ==========================================
Write-Host "`n[3/5] Updating Central Docker Compose File..." -ForegroundColor Cyan
$composeContent = [System.IO.File]::ReadAllText($LocalCompose)

$svcBegin = "# --- AUTOGEN UNITS BEGIN ---"
$svcEnd   = "# --- AUTOGEN UNITS END ---"
$volBegin = "# --- AUTOGEN UNIT VOLUMES BEGIN ---"
$volEnd   = "# --- AUTOGEN UNIT VOLUMES END ---"

function Get-ManagedRegionContent {
    param(
        [string]$yaml,
        [string]$beginMarker,
        [string]$endMarker,
        [int]$indentSpaces
    )
    $regionRegex  = "(?ms)^\s{$indentSpaces}$([Regex]::Escape($beginMarker))\s*$\n(.*?)^\s{$indentSpaces}$([Regex]::Escape($endMarker))\s*$"
    if ($yaml -match $regionRegex) {
        if ($Matches.Count -ge 3 -and $null -ne $Matches[2]) {
            return $Matches[2].TrimEnd()
        }
        return ""
    }
    return ""
}

function Ensure-RootKey {
    param([string]$yaml, [string]$key)
    if ($yaml -match "(?m)^$([Regex]::Escape($key)):\s*$") { return $yaml }
    return ($yaml.TrimEnd() + "`n`n${key}:`n")
}

function Replace-Or-Insert-ManagedRegion {
    param(
        [string]$yaml,
        [string]$rootKey,
        [string]$beginMarker,
        [string]$endMarker,
        [string]$contentBlock,
        [int]$indentSpaces
    )

    $yaml = Ensure-RootKey -yaml $yaml -key $rootKey
    $rootKeyRegex = "(?m)^$([Regex]::Escape($rootKey)):\s*$"
    $regionRegex  = "(?ms)^\s{$indentSpaces}$([Regex]::Escape($beginMarker))\s*$\n.*?^\s{$indentSpaces}$([Regex]::Escape($endMarker))\s*$\n?"

    $replacement =
        (" " * $indentSpaces) + $beginMarker + "`n" +
        ($contentBlock.TrimEnd() + "`n") +
        (" " * $indentSpaces) + $endMarker + "`n"

    if ($yaml -match $regionRegex) {
        return [Regex]::Replace($yaml, $regionRegex, $replacement, 1)
    }

    $insertion = "`n" + $replacement
    return [Regex]::Replace($yaml, $rootKeyRegex, { param($m) $m.Value + $insertion }, 1)
}

function Remove-ServiceFromServicesSection {
    param([string]$yaml, [string]$serviceName)

    $svc = [Regex]::Escape($serviceName)

    return [Regex]::Replace(
        $yaml,
        "(?ms)(^services:\s*\n)(.*?)(?=^\S|\Z)",
        {
            param($m)
            $head = $m.Groups[1].Value
            $body = $m.Groups[2].Value

            # Remove unquoted or quoted service key blocks
            $body = [Regex]::Replace($body, "(?ms)^\s{2}(""${svc}""|${svc}):\s*\n.*?(?=^\s{2}\S|\Z)", "")
            return $head + $body
        },
        1
    )
}

function Remove-RootVolumeFromVolumesSection {
    param([string]$yaml, [string]$volumeName)
    $vol = [Regex]::Escape($volumeName)

    return [Regex]::Replace(
        $yaml,
        "(?ms)(^volumes:\s*\n)(.*?)(?=^\S|\Z)",
        {
            param($m)
            $head = $m.Groups[1].Value
            $body = $m.Groups[2].Value
            $body = [Regex]::Replace($body, "(?m)^\s{2}${vol}:\s*$\n?", "")
            return $head + $body
        },
        1
    )
}

# Capture existing managed regions so we can preserve other units
$existingServicesBlock = Get-ManagedRegionContent -yaml $composeContent -beginMarker $svcBegin -endMarker $svcEnd -indentSpaces 2
$existingVolumesBlock = Get-ManagedRegionContent -yaml $composeContent -beginMarker $volBegin -endMarker $volEnd -indentSpaces 2

# Purge existing target unit service + volume
foreach ($u in $UnitNumber) {
    $unit = $u.Trim().Trim('"').Trim("'")
    $composeContent = Remove-ServiceFromServicesSection -yaml $composeContent -serviceName $unit
    $composeContent = Remove-RootVolumeFromVolumesSection -yaml $composeContent -volumeName "${unit}_etc"
    $composeContent = Remove-ServiceFromServicesSection -yaml $composeContent -serviceName "${unit}eng"
    $composeContent = Remove-ServiceFromServicesSection -yaml $composeContent -serviceName "${unit}adds"
    $composeContent = Remove-RootVolumeFromVolumesSection -yaml $composeContent -volumeName "${unit}eng_etc"
    $composeContent = Remove-RootVolumeFromVolumesSection -yaml $composeContent -volumeName "${unit}adds_etc"
}

# Build fresh blocks + pick free IPs
$serviceBlocks = New-Object System.Collections.Generic.List[string]
$volumeLines   = New-Object System.Collections.Generic.List[string]
$targetServices = New-Object System.Collections.Generic.HashSet[string]

$nextOctet = $StartIpOctet

foreach ($u in $UnitNumber) {
    $unit = $u.Trim().Trim('"').Trim("'")
    $localUnitPath = Join-Path $ScriptDir "staging\$unit"
    if (-not (Test-Path $localUnitPath)) { continue }

    $engPath = Join-Path $localUnitPath "Eng"
    $addsPath = Join-Path $localUnitPath "Adds"
    $hasEng = Test-Path $engPath
    $hasAdds = Test-Path $addsPath
    $isDualBlender = $hasEng -or $hasAdds

    $desiredServiceIps = @{}
    if ($isDualBlender) {
        $engConfig = Get-UnitConfigJson -rootPath $engPath
        $addsConfig = Get-UnitConfigJson -rootPath $addsPath
        if ($addsConfig -and $addsConfig.U09Ip) {
            $desiredServiceIps["${unit}eng"] = [string]$addsConfig.U09Ip
        }
        if ($engConfig -and $engConfig.U10Ip) {
            $desiredServiceIps["${unit}adds"] = [string]$engConfig.U10Ip
        }
    }

    $serviceDefs = @()
    if ($isDualBlender) {
        if ($hasEng) { $serviceDefs += @{ Name = "${unit}eng"; ConfigDir = "Eng" } }
        if ($hasAdds) { $serviceDefs += @{ Name = "${unit}adds"; ConfigDir = "Adds" } }
    } else {
        $serviceDefs += @{ Name = $unit; ConfigDir = "" }
    }

    foreach ($svc in $serviceDefs) {
        $serviceName = $svc.Name
        $null = $targetServices.Add($serviceName)
        $serviceRoot = if ($svc.ConfigDir) { Join-Path $localUnitPath $svc.ConfigDir } else { $localUnitPath }
        $hasEtc = Test-Path (Join-Path $serviceRoot "etc")
        $configDir = "./${serviceName}"
        $qtermLocal = if ($svc.ConfigDir) { Join-Path $localUnitPath "$($svc.ConfigDir)\QTerm" } else { Join-Path $localUnitPath "QTerm" }
        $qtermDir = if ($qtermLocal -and (Test-Path $qtermLocal)) {
            "./${serviceName}/QTerm"
        } else { $null }
        $qtermArg = ""
        if ($qtermDir) {
            $qtermArg = "`n        qterm_dir: ${qtermDir}/."
        }

        $targetIp = $null
        if ($desiredServiceIps.ContainsKey($serviceName)) {
            $candidateIp = $desiredServiceIps[$serviceName]
            $octet = Get-IpOctetIfInSubnet -ip $candidateIp -subnetCidr $Subnet
            if ($null -ne $octet) {
                if (-not $UsedLastOctets.Contains($octet)) {
                    $null = $UsedLastOctets.Add($octet)
                    $nextOctet = [Math]::Max($nextOctet, $octet + 1)
                    $targetIp = $candidateIp
                    Write-Host "Using ${serviceName} IP from unit.config: $candidateIp" -ForegroundColor DarkGray
                } else {
                    if ($containersByIp.ContainsKey($candidateIp)) {
                        $containerInfo = $containersByIp[$candidateIp]
                        $containersToRemove[$containerInfo.Id] = $containerInfo.Name
                        $UsedLastOctets.Remove($octet) | Out-Null
                        $null = $UsedLastOctets.Add($octet)
                        $nextOctet = [Math]::Max($nextOctet, $octet + 1)
                        $targetIp = $candidateIp
                        Write-Host "Requested IP $candidateIp for ${serviceName} is in use by $($containerInfo.Name). Removing container before deploy." -ForegroundColor DarkYellow
                    } else {
                        Write-Warning "Requested IP $candidateIp for ${serviceName} is already in use. Falling back to auto-assigned IP."
                    }
                }
            } else {
                Write-Warning "Requested IP $candidateIp for ${serviceName} is not in subnet $Subnet. Falling back to auto-assigned IP."
            }
        }

        if (-not $targetIp) {
            $octet = Get-NextFreeOctet -start $nextOctet -used $UsedLastOctets
            $null  = $UsedLastOctets.Add($octet)
            $nextOctet = $octet + 1
            $targetIp = "172.18.1.$octet"
        }

        $serviceBlocks.Add(@"
  "${serviceName}":
    build:
      context: ./stw/.
      args:
        simName: ${serviceName}${qtermArg}
        config_dir: ${configDir}
    stdin_open: true
    tty: true
    restart: unless-stopped
    #volumes:
      #- ${serviceName}_etc:/home/developer/Development/test/data/dataflash/etc
    networks:
      ${ComposeNetworkKey}:
        ipv4_address: ${targetIp}
"@.TrimEnd())

        $volumeLines.Add("  ${serviceName}_etc:")
    }
}

$preservedServices = ""
if ($existingServicesBlock) {
    $existingServicesYaml = "services:`n" + $existingServicesBlock
    foreach ($serviceName in $targetServices) {
        $existingServicesYaml = Remove-ServiceFromServicesSection -yaml $existingServicesYaml -serviceName $serviceName
    }
    $preservedServices = ($existingServicesYaml -replace "(?ms)^services:\s*\n", "").TrimEnd()
}

$preservedVolumes = ""
if ($existingVolumesBlock) {
    $existingVolumesYaml = "volumes:`n" + $existingVolumesBlock
    foreach ($serviceName in $targetServices) {
        $existingVolumesYaml = Remove-RootVolumeFromVolumesSection -yaml $existingVolumesYaml -volumeName "${serviceName}_etc"
    }
    $preservedVolumes = ($existingVolumesYaml -replace "(?ms)^volumes:\s*\n", "").TrimEnd()
}

$servicesRegionParts = @()
if ($preservedServices) { $servicesRegionParts += $preservedServices }
if ($serviceBlocks.Count -gt 0) { $servicesRegionParts += ($serviceBlocks -join "`n`n") }
$servicesRegionContent = ($servicesRegionParts -join "`n`n").TrimEnd()

$volumesRegionParts = @()
if ($preservedVolumes) { $volumesRegionParts += $preservedVolumes }
if ($volumeLines.Count -gt 0) { $volumesRegionParts += ($volumeLines -join "`n") }
$volumesRegionContent  = ($volumesRegionParts -join "`n").TrimEnd()

$composeContent = Replace-Or-Insert-ManagedRegion `
    -yaml $composeContent `
    -rootKey "services" `
    -beginMarker $svcBegin `
    -endMarker $svcEnd `
    -contentBlock $servicesRegionContent `
    -indentSpaces 2

$composeContent = Replace-Or-Insert-ManagedRegion `
    -yaml $composeContent `
    -rootKey "volumes" `
    -beginMarker $volBegin `
    -endMarker $volEnd `
    -contentBlock $volumesRegionContent `
    -indentSpaces 2

# Force networks.stwnet to external:true (do NOT try to define macvlan here; it's already created on host)
$composeContent = Ensure-RootKey -yaml $composeContent -key "networks"

# Replace the entire networks: section with ONLY stwnet external (safe for your fleet compose usage)
$composeContent = [Regex]::Replace(
    $composeContent,
    "(?ms)^networks:\s*\n.*?(?=^\S|\Z)",
@"
networks:
  stwnet:
    external: true
"@ + "`n",
    1
)

# Normalize blank lines
$composeContent = $composeContent -replace "(?m)^\s*$\n(?=\s*$\n)", ""

Out-LinuxFile -path $LocalCompose -content $composeContent

if ($containersToRemove.Count -gt 0) {
    Write-Host "`n[3.5/5] Cleaning conflicting containers..." -ForegroundColor DarkYellow
    $cleanupScript = Join-Path $env:TEMP "winscp_cleanup.txt"
    $cleanupCommands = @()
    $cleanupCommands += $WinScpOptions
    $cleanupCommands += @(
        "open sftp://${LinuxUser}:${LinuxPassword}@${LinuxHost}/ -hostkey=`"*`" -timeout=120"
    )
    foreach ($entry in $containersToRemove.GetEnumerator()) {
        $cleanupCommands += "call docker rm -f $($entry.Key)"
    }
    $cleanupCommands += "exit"
    Out-LinuxFile -path $cleanupScript -content $cleanupCommands
    $cleanupLog = Join-Path $WinScpLogDir "winscp-cleanup.log"
    & $WinSCPPath /script=$cleanupScript /log=$cleanupLog /loglevel=2 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Cleanup encountered errors. Continuing with deployment."
    }
}

# ==========================================
# 4/5 DEPLOYMENT EXECUTION
# ==========================================
foreach ($u in $UnitNumber) {
    $unit = $u.Trim().Trim('"').Trim("'")
    $localUnitPath = Join-Path $ScriptDir "staging\$unit"
    if (-not (Test-Path $localUnitPath)) { continue }

    $engPath = Join-Path $localUnitPath "Eng"
    $addsPath = Join-Path $localUnitPath "Adds"
    $hasEng = Test-Path $engPath
    $hasAdds = Test-Path $addsPath
    $serviceNames = if ($hasEng -or $hasAdds) {
        @(
            if ($hasEng) { "${unit}eng" }
            if ($hasAdds) { "${unit}adds" }
        )
    } else {
        @($unit)
    }
    $composeArgs = ($serviceNames | ForEach-Object { "`"$($_)`"" }) -join " "
    $verifyCmd = ($serviceNames | ForEach-Object {
        "docker ps -f name=$($_) -f status=running | grep $($_) > /dev/null && echo 'SUCCESS: $($_) is running.' || (echo 'ERROR: $($_) failed. Logs:' && docker logs $($_) | tail -n 25)"
    }) -join " && "

    Write-Host "`n>>> Deploying: ${unit}" -ForegroundColor Yellow
    $remoteUnitDir = "$RemoteSTWPath/$unit"
    $serviceUploadDefs = @()
    if ($hasEng) {
        $serviceUploadDefs += @{ Name = "${unit}eng"; LocalPath = $engPath }
    }
    if ($hasAdds) {
        $serviceUploadDefs += @{ Name = "${unit}adds"; LocalPath = $addsPath }
    }
    if (-not $hasEng -and -not $hasAdds) {
        $serviceUploadDefs += @{ Name = $unit; LocalPath = $localUnitPath }
    }
    $winscpScriptFile = Join-Path $env:TEMP "winscp_deploy_$unit.txt"

    $uploadCommands = @()
    if ($hasEng -or $hasAdds) {
        $uploadCommands += "call rm -rf ""$remoteUnitDir"""
    } else {
        $uploadCommands += "call rm -rf ""$remoteUnitDir"""
        $uploadCommands += "call mkdir -p ""$remoteUnitDir"""
    }
    foreach ($svc in $serviceUploadDefs) {
        $remoteServiceDir = "$RemoteSTWPath/$($svc.Name)"
        $localServicePath = $svc.LocalPath
        $localEtcPath = Join-Path $localServicePath "etc"
        $localQtermPath = Join-Path $localServicePath "QTerm"
        $uploadRootPath = if (Test-Path $localEtcPath) { $localEtcPath } else { $localServicePath }
        $uploadCommands += "call rm -rf ""$remoteServiceDir"""
        $uploadCommands += "call mkdir -p ""$remoteServiceDir"""
        $uploadCommands += "put -nopreservetime ""$uploadRootPath\*"" ""$remoteServiceDir/"""
        if (Test-Path $localQtermPath) {
            $uploadCommands += "call mkdir -p ""$remoteServiceDir/QTerm"""
            $uploadCommands += "put -nopreservetime ""$localQtermPath\*"" ""$remoteServiceDir/QTerm/"""
        }
        $uploadCommands += "call chmod -R 777 ""$remoteServiceDir"""
    }

    $commands = @()
    $commands += $WinScpOptions
    $commands += @(
        "open sftp://${LinuxUser}:${LinuxPassword}@${LinuxHost}/ -hostkey=`"*`" -timeout=120",

        # Ensure fleet root exists before upload
        "call mkdir -p ""$RemoteFleetRoot""",
        "put ""$LocalCompose"" ""$RemoteFleetRoot/"""
    )
    $commands += $uploadCommands
    $commands += @(
        # Print the inserted block so you can SEE it in the output
        "call cd ""$RemoteFleetRoot"" && echo '--- compose snippet ---' && grep -n 'AUTOGEN' -n docker-compose.yml || true",
        "call cd ""$RemoteFleetRoot"" && export BUILDKIT_PROGRESS=plain && docker compose up -d --build $composeArgs",

        "call sleep 2",
        "call $verifyCmd",
        "exit"
    )

    Out-LinuxFile -path $winscpScriptFile -content $commands
    $unitLog = Join-Path $WinScpLogDir "winscp-deploy-$unit.log"
    & $WinSCPPath /script=$winscpScriptFile /timeout=1800 /log=$unitLog /loglevel=2
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $unitLog) {
            Write-Host "WinSCP deploy log for $unit (tail):" -ForegroundColor DarkYellow
            Get-Content $unitLog -Tail 60 | ForEach-Object { Write-Host $_ }
        }
        throw "Deployment failed for $unit. WinSCP exit code: $LASTEXITCODE"
    }
}

Get-ChildItem -Path $env:TEMP -Filter "winscp_*" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "`nDeployment Complete." -ForegroundColor Green
