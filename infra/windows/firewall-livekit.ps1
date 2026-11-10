# Libera o LiveKit Server nativo do Windows para a rede local e para a rede interna do WSL2 (Egress).
# Executar UMA VEZ no PowerShell COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File "D:\LS GLOBAL\infra\windows\firewall-livekit.ps1"
# Desfazer: o mesmo comando com -Remove.
# Também remove o repasse de portas antigo (infra\wsl\lan-access.ps1), que ocuparia as portas 7880/7881.
param(
  [string]$Exe = 'D:\livekit\bin\livekit-server.exe',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$rule = 'LSG LiveKit Server (Windows)'

# Repasse antigo (v4tov4/v4tov6 em 7880/7881), qualquer endereço de escuta.
foreach ($kind in 'v4tov4', 'v4tov6') {
  $lines = netsh interface portproxy show $kind | Select-String -Pattern '^\s*(\S+)\s+(7880|7881)\s'
  foreach ($m in $lines) {
    $addr = $m.Matches[0].Groups[1].Value; $port = $m.Matches[0].Groups[2].Value
    netsh interface portproxy delete $kind listenaddress=$addr listenport=$port | Out-Null
  }
}
Get-NetFirewallRule -DisplayName 'LSG LiveKit (rede local)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName "$rule*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if (-not $Remove) {
  # Somente sub-redes locais (LAN e a rede virtual do WSL); nunca a internet.
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Program $Exe -Protocol TCP -LocalPort 7880, 7881 `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName "$rule UDP" -Direction Inbound -Program $Exe -Protocol UDP -LocalPort 50000-50200 `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
}
Write-Host 'Repasses restantes:'; netsh interface portproxy show all
Get-NetFirewallRule -DisplayName "$rule*" -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Action
