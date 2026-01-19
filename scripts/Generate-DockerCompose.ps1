param (
    [string]$FleetRoot = "/home/developer/Deployment/docker/fleet/stw",
    [string]$OutputPath = "/home/developer/Deployment/docker/fleet/docker-compose.yml",
    [string]$Subnet = "172.18.1.0/24",
    [string]$Gateway = "172.18.1.1",
    [string]$BaseIp = "172.18.1.100"  # starting IP offset for automatic allocation
)

# --- Helper: Convert IP to integer for auto increment ---
function Convert-IpToInt($ip) {
    ($ip -split '\.') | ForEach-Object { [int]$_ } |
        ForEach-Object -Begin { $res = 0 } -Process { $res = ($res -shl 8) -bor $_ } -End { $res }
}

function Convert-IntToIp($num) {
    [string]::Join('.', [System.BitConverter]::GetBytes([uint32]([System.Net.IPAddress]$num).Address)[0..3][::-1])
}

# --- Scan fleet directories ---
$unitDirs = Get-ChildItem -Path $FleetRoot -Directory
if (-not $unitDirs) {
    Write-Error "No directories found under $FleetRoot"
    exit
}

$compose = [ordered]@{
    version  = '2.1'
    services = @{}
    networks = @{
        stwnet = @{
            driver = 'macvlan'
            driver_opts = @{ parent = 'br0' }
            ipam = @{
                driver = 'default'
                config = @(@{ subnet = $Subnet; gateway = $Gateway })
            }
        }
    }
}

# --- Start IP allocation ---
$baseInt = (Convert-IpToInt $BaseIp) + 1

foreach ($unit in $unitDirs) {
    $name = $unit.Name
    $contextPath = './stw/.'
    $ip = Convert-IntToIp $baseInt
    $baseInt++

    $args = [ordered]@{
        qterm_dir = "./$name/QTerm/."
        simName   = $name
        config_dir = "./$name"
    }

    # Example: handle special-case Kiwi or Blender patterns
    if ($name -match 'blender2_') {
        $args.kiwi_ver = "./blender_eng"
    }
    elseif ($name -match 'blender_bd11_') {
        $args.kiwi_ver = "./$name"
    }

    $compose.services.$name = [ordered]@{
        build = @{
            context = $contextPath
            args    = $args
        }
        stdin_open = $true
        tty = $true
        networks = @{
            stwnet = @{ ipv4_address = $ip }
        }
    }
}

# --- Serialize to YAML ---
$yaml = @(
    "version: '2.1'",
    "services:"
)

foreach ($svcName in $compose.services.Keys) {
    $svc = $compose.services.$svcName
    $yaml += "  ${svcName}:"
    $yaml += "    build:"
    $yaml += "      context: $($svc.build.context)"
    $yaml += "      args:"
    foreach ($arg in $svc.build.args.GetEnumerator()) {
        $yaml += "        $($arg.Key): $($arg.Value)"
    }
    $yaml += "    stdin_open: true"
    $yaml += "    tty: true"
    $yaml += "    networks:"
    $yaml += "      stwnet:"
    $yaml += "        ipv4_address: $($svc.networks.stwnet.ipv4_address)"
}

$yaml += @(
    "",
    "networks:",
    "  stwnet:",
    "    driver: macvlan",
    "    driver_opts:",
    "      parent: br0",
    "    ipam:",
    "      driver: default",
    "      config:",
    "        - subnet: $Subnet",
    "          gateway: $Gateway"
)

$yaml -join "`n" | Out-File -FilePath $OutputPath -Encoding utf8

Write-Host "`n Docker Compose generated successfully at $OutputPath" -ForegroundColor Green
