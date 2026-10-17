#Requires -RunAsAdministrator
<#
.SYNOPSIS
    给 Kali 虚拟机做 VMware DHCP 地址保留（固定租约）。

.DESCRIPTION
    把 kali 的 MAC 地址钉死到 192.0.2.150，这样 VMware 的 DHCP 每次都会把同一个地址
    发给它，不会因为 DHCP 池重新分配而漂移。

    脚本可重复运行：已经存在同名 host 块时会更新而不是重复追加。

.PARAMETER Mac
    Kali eth0 的 MAC 地址。默认 00:0c:29:00:00:01（示例值，请按实际填写）。

.PARAMETER Address
    要保留的地址。默认 192.0.2.150。

.PARAMETER HostName
    配置文件里的条目名，仅作标识，不影响行为。

.NOTES
    VMware 在增删虚拟网卡时会重写 vmnetdhcp.conf，那时需要重新运行本脚本。
#>
[CmdletBinding()]
param(
    [string]$Mac = '00:0c:29:00:00:01',
    [string]$Address = '192.0.2.150',
    [string]$HostName = 'kali'
)

$ErrorActionPreference = 'Stop'

$conf = Join-Path $env:ProgramData 'VMware\vmnetdhcp.conf'
if (-not (Test-Path $conf)) {
    throw "找不到 VMware DHCP 配置：$conf"
}

# 1. 先备份。保留最近几份即可，避免堆满目录。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$conf.bak-$stamp"
Copy-Item -LiteralPath $conf -Destination $backup -Force
Write-Host "已备份配置到 $backup" -ForegroundColor Green

$text = Get-Content -LiteralPath $conf -Raw
$blockPattern = "(?ms)^[ \t]*host[ \t]+$([regex]::Escape($HostName))[ \t]*\{.*?^[ \t]*\}[ \t]*\r?\n?"

# 2. 已经有了就替换，保证幂等。
$newBlock = @"
host $HostName {
    hardware ethernet $Mac;
    fixed-address $Address;
}
"@

if ($text -match $blockPattern) {
    $text = [regex]::Replace($text, $blockPattern, ($newBlock + "`r`n"), 1)
    Write-Host "已更新既有的 host $HostName 条目" -ForegroundColor Yellow
} else {
    if (-not $text.EndsWith("`n")) { $text += "`r`n" }
    $text += "`r`n# DHCP 保留：$HostName（$Mac -> $Address），由 dhcp-reserve-kali.ps1 添加`r`n"
    $text += $newBlock
    Write-Host "已追加 host $HostName 条目" -ForegroundColor Yellow
}

Set-Content -LiteralPath $conf -Value $text -NoNewline -Encoding utf8

# 3. 重启 DHCP 服务让新配置生效。
$service = Get-Service -Name 'VMnetDHCP' -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Warning '没找到 VMnetDHCP 服务，配置已写入但需要手动重启 VMware DHCP。'
} else {
    Restart-Service -Name 'VMnetDHCP' -Force
    Write-Host '已重启 VMnetDHCP 服务' -ForegroundColor Green
}

Write-Host ''
Write-Host '完成。接下来在 Kali 里释放并重新获取租约：' -ForegroundColor Cyan
Write-Host '    sudo dhclient -r eth0 && sudo dhclient eth0'
Write-Host '    ip -4 addr show eth0'
Write-Host ''
Write-Host "预期拿到 $Address。" -ForegroundColor Cyan
