# Inicia o LiveKit Server NATIVO do Windows, usando o Redis do WSL2 "LSG" (compartilhado com o Egress).
# Motivo: no Windows 10 o WSL2 não repassa UDP da rede local; com o LiveKit no Windows, PC, celulares da rede
# e o Egress (no WSL) conectam a mídia por UDP direto.
#
# Uso (PowerShell comum, sem administrador):
#   powershell -ExecutionPolicy Bypass -File "D:\LS GLOBAL\infra\windows\start-livekit.ps1"
# Pré-requisitos: start-media.sh já executado no WSL (Redis + Egress) e a regra de firewall de
# infra\windows\firewall-livekit.ps1 aplicada uma vez como administrador.
param(
  [string]$Exe = 'D:\livekit\bin\livekit-server.exe',
  [string]$ConfigPath = 'D:\livekit\livekit.yaml',
  [string]$LogPath = 'D:\livekit\livekit.log',
  # Teste em rede externa (pinggy.bat): relay TURN anunciado aos navegadores. Sem estes, só rede local.
  [string]$TurnHost = '',
  [int]$TurnPort = 0,
  [string]$TurnUser = '',
  [string]$TurnPass = '',
  # Encerra o LiveKit em execução antes de iniciar (necessário para aplicar uma configuração nova).
  [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\..\.env'
function EnvVal([string]$k) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^$k=" } | Select-Object -Last 1
  if ($line) { return ($line -replace "^$k=", '').Trim() }
}
$key = EnvVal 'LIVEKIT_API_KEY'; $secret = EnvVal 'LIVEKIT_API_SECRET'
if (-not $key -or -not $secret) { throw 'LIVEKIT_API_KEY/LIVEKIT_API_SECRET ausentes no .env' }
$apiPort = EnvVal 'API_PORT'; if (-not $apiPort) { $apiPort = '3333' }

$turn = ''
if ($TurnHost) {
  $turn = @"

  turn_servers:
    - host: $TurnHost
      port: $TurnPort
      protocol: tcp
      username: $TurnUser
      credential: $TurnPass
"@
}

# O arquivo contém o segredo: fica fora do repositório (D:\livekit) e é regravado a cada início.
@"
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false$turn
redis:
  address: 127.0.0.1:6379
keys:
  ${key}: ${secret}
webhook:
  api_key: $key
  urls:
    - http://localhost:${apiPort}/api/v1/webhooks/livekit
logging:
  level: info
"@ | Set-Content -Path $ConfigPath -Encoding ascii

if ($Restart) {
  # O LiveKit leva alguns segundos para sair (espera os participantes); só então a porta 7880 fica livre.
  Get-Process livekit-server -ErrorAction SilentlyContinue | Stop-Process -Force
  for ($i = 0; $i -lt 30 -and (Get-Process livekit-server -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
}
$running = Get-Process livekit-server -ErrorAction SilentlyContinue
if ($running) { Write-Host "LiveKit já está rodando (PID $($running.Id)). Para reiniciar: Stop-Process -Name livekit-server"; }
else {
  Start-Process -FilePath $Exe -ArgumentList '--config', "`"$ConfigPath`"" -WindowStyle Hidden `
    -RedirectStandardError $LogPath -RedirectStandardOutput "$LogPath.out"
  Start-Sleep 3
}
try { Write-Host "LiveKit: $((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7880 -TimeoutSec 5).Content)" }
catch { Write-Host "LiveKit: FALHOU — veja $LogPath"; exit 1 }
