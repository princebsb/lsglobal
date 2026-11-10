# Teste em rede externa (4G, outra casa) por túneis do Pinggy. Chamado pelo pinggy.bat da raiz do projeto (uso: pinggy.bat [porta], padrão 5173).
#
#   Página + API + sinalização:  https://www.hellou.com.br  ->  Vite (https://localhost:5173), que repassa
#                                /api, /socket.io e /rtc (LiveKit). HTTPS válido: microfone e câmera liberados.
#   Mídia (áudio e vídeo):       tcp://<host>:<porta>  ->  coturn no WSL (TCP 3478)  ->  UDP  ->  LiveKit (Windows)
#
# O LiveKit é reiniciado anunciando esse relay TURN aos navegadores; ao encerrar (tecla S, ou Ctrl+C) os túneis são
# fechados, o relay é parado e o LiveKit volta à configuração só de rede local. Reiniciar o LiveKit derruba quem
# estiver na sala: os participantes reconectam sozinhos em alguns segundos.
param(
  # Chave paga do Pinggy (página com "+uromaster", como no pinggy.bat antigo; mídia com "+tcp").
  # Lida de PINGGY_TOKEN no .env da raiz quando não informada.
  [string]$Token = '',
  # Domínio próprio associado a este token no painel do Pinggy (o mesmo que o pinggy.bat antigo publicava).
  [string]$PublicUrl = 'https://www.hellou.com.br',
  [int]$WebPort = 5173
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $Token) {
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^PINGGY_TOKEN=' } | Select-Object -Last 1
    if ($line) { $Token = ($line -replace '^PINGGY_TOKEN=', '').Trim() }
  }
}
if (-not $Token) { throw 'PINGGY_TOKEN ausente no .env (ex.: PINGGY_TOKEN=suachave+uromaster)' }
$logDir = Join-Path $env:TEMP 'lsg-pinggy'
New-Item -ItemType Directory -Force $logDir | Out-Null
$turnScript = '/mnt/d/LS GLOBAL/infra/wsl/start-turn.sh'
$livekitScript = Join-Path $PSScriptRoot 'start-livekit.ps1'

function Listening([int]$port) {
  [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}
function WaitMatch([string[]]$files, [string]$pattern, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    foreach ($f in $files) {
      if (Test-Path $f) {
        $m = Select-String -Path $f -Pattern $pattern -AllMatches | Select-Object -First 1
        if ($m) { return $m.Matches[0] }
      }
    }
    Start-Sleep 1
  }
  return $null
}
# Túnel em segundo plano pelo ssh do Pinggy. Sem terminal (-T), o Pinggy escreve os endereços em texto (ex.:
# tcp://xxx.a.pinggy.link:41234), que são lidos do log. O pinggy.exe não serve aqui: com a saída redirecionada,
# não escreve nada.
function StartTunnel([string]$name, [string]$forward, [string]$userAtHost, [string[]]$remoteCmd = @()) {
  $out = Join-Path $logDir "$name.out"; $err = Join-Path $logDir "$name.err"
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  $sshArgs = @('-p', '443', "-R0:$forward", '-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes', $userAtHost) + $remoteCmd
  $p = Start-Process -FilePath 'ssh' -ArgumentList $sshArgs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  return @{ Proc = $p; Files = @($out, $err) }
}
function StopTunnel($tun) { if ($tun -and -not $tun.Proc.HasExited) { Stop-Process -Id $tun.Proc.Id -Force -ErrorAction SilentlyContinue } }
# --- Pré-requisitos -------------------------------------------------------------------------------------------
if (-not (Listening $WebPort)) { throw "Nada escutando na porta $WebPort. Rode 'npm run dev' antes." }
if (-not (Listening 7880)) { throw 'LiveKit parado. Rode start-media.sh (WSL) e infra\windows\start-livekit.ps1 antes.' }

# Túneis de mídia de uma execução anterior (janela fechada no X, sem passar pela limpeza): um deles pode estar
# segurando o domínio próprio e derrubando a página.
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
  Where-Object { $_.CommandLine -match 'pinggy' -and $_.CommandLine -match ':3478|127\.0\.0\.1:' } |
  ForEach-Object { Write-Host "  Encerrando túnel antigo (PID $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$web = $null; $tcp = $null
$turnOn = $false
try {
  # --- Relay TURN no WSL, com credenciais novas a cada execução ---------------------------------------------
  $user = 'lsg'
  $pass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $turnOut = wsl -d LSG -u root -- bash $turnScript $user $pass
  $turnOut | Where-Object { $_ -notmatch '^WSL_IP=' } | ForEach-Object { Write-Host "  $_" }
  $wslIp = ($turnOut | Where-Object { $_ -match '^WSL_IP=' }) -replace '^WSL_IP=', ''
  if (-not $wslIp) { throw 'O relay TURN não iniciou (veja a mensagem acima).' }
  $turnOn = $true

  # --- Túneis --------------------------------------------------------------------------------------------------
  # O domínio próprio está ligado à chave e fica com o PRIMEIRO túnel que a usa: por isso a página sobe antes da
  # mídia. Se a ordem se inverter, www.hellou.com.br passa a cair no relay e a página não abre.
  # x:localServerTls: o Vite atende em HTTPS, então o Pinggy fala HTTPS com ele.
  $key = ($Token -split '\+')[0]
  function Up {
    $script:web = StartTunnel 'web' "127.0.0.1:$WebPort" "$Token@pro.pinggy.io" @('x:localServerTls:localhost')
    $w = WaitMatch $script:web.Files 'https://[A-Za-z0-9.-]+' 45
    if (-not $w) { Get-Content $script:web.Files -ErrorAction SilentlyContinue | Select-Object -Last 15; throw 'O túnel da página não subiu (saída do Pinggy acima).' }
    # Primeiro com a chave paga (sem limite de tempo). Como segundo túnel da mesma chave, o Pinggy conecta mas não
    # devolve endereço (visto em 06/11/2026); nesse caso usa o túnel gratuito (até 60 min; o vigia abaixo reabre).
    $pat = 'tcp://([A-Za-z0-9.-]+):(\d+)'
    $script:tcp = StartTunnel 'tcp' "${wslIp}:3478" "$key+tcp@pro.pinggy.io"
    $m = WaitMatch $script:tcp.Files $pat 15
    $script:tcpFree = $false
    if (-not $m) {
      StopTunnel $script:tcp
      Write-Host '  Chave paga não liberou um segundo túnel; usando o túnel TCP gratuito (renovado a cada 60 min).'
      $script:tcp = StartTunnel 'tcp' "${wslIp}:3478" 'tcp@free.pinggy.io'
      $m = WaitMatch $script:tcp.Files $pat 45
      $script:tcpFree = $true
    }
    if (-not $m) { Get-Content $script:tcp.Files -ErrorAction SilentlyContinue | Select-Object -Last 15; throw 'O Pinggy não informou o endereço do túnel TCP (saída acima).' }
    # Com a chave, o Pinggy lista o domínio próprio e um nome *.pinggy.link; o relay usa o do Pinggy.
    $pl = WaitMatch $script:tcp.Files 'tcp://([A-Za-z0-9.-]+\.pinggy[A-Za-z.-]*\.link):(\d+)' 1
    if ($pl) { $m = $pl }
    $script:turnHost = $m.Groups[1].Value; $script:turnPort = [int]$m.Groups[2].Value
    # LiveKit anunciando o relay (a porta do túnel muda a cada conexão).
    & $livekitScript -Restart -TurnHost $script:turnHost -TurnPort $script:turnPort -TurnUser $user -TurnPass $pass
    if ($LASTEXITCODE) { throw 'O LiveKit não reiniciou.' }
  }
  Up

  Write-Host ''
  Write-Host '  ============================================================'
  Write-Host "    ENDEREÇO PÚBLICO:  $PublicUrl"
  Write-Host '  ============================================================'
  Write-Host "    Mídia por TURN/TCP: ${turnHost}:$turnPort  ->  coturn ${wslIp}:3478"
  Write-Host '    Quem está fora da rede abre o endereço acima (celular no 4G, outra casa).'
  Write-Host '    Quem está na rede local pode continuar em https://192.168.1.106:5173.'
  Write-Host '    O endereço fica público enquanto esta janela estiver aberta.'
  if ($tcpFree) { Write-Host '    Túnel da mídia gratuito: a cada ~60 min ele é renovado sozinho (a sala cai alguns segundos).' }
  Write-Host '    Para encerrar: pressione S (não feche a janela no X).'
  Write-Host '  ============================================================'

  # --- Vigia: se um túnel cair, reabre os dois na ordem certa ----------------------------------------------------
  # O ssh não sai quando o túnel gratuito vence (60 min): o processo continua vivo e o endereço deixa de existir.
  # Por isso o vigia também testa o endereço do túnel a cada minuto e renova o gratuito aos 55 min.
  function TcpAlive([string]$h, [int]$port) {
    $c = New-Object Net.Sockets.TcpClient
    try { return $c.ConnectAsync($h, $port).Wait(5000) -and $c.Connected } catch { return $false } finally { $c.Close() }
  }
  $since = Get-Date; $lastProbe = Get-Date; $fails = 0
  while ($true) {
    if ([Console]::KeyAvailable -and [Console]::ReadKey($true).Key -eq 'S') { break }
    $why = $null
    if ($web.Proc.HasExited -or $tcp.Proc.HasExited) { $why = 'Um túnel caiu' }
    elseif ($tcpFree -and ((Get-Date) - $since).TotalMinutes -ge 55) { $why = 'Túnel gratuito da mídia perto de vencer (60 min)' }
    elseif (((Get-Date) - $lastProbe).TotalSeconds -ge 60) {
      $lastProbe = Get-Date
      if (TcpAlive $turnHost $turnPort) { $fails = 0 } else { $fails++ }
      if ($fails -ge 2) { $why = 'O túnel da mídia parou de responder' }
    }
    if ($why) {
      Write-Host ''
      Write-Host "    $(Get-Date -Format HH:mm:ss) $why; reabrindo em 10 s (a sala reconecta sozinha)..."
      $since = Get-Date; $lastProbe = Get-Date; $fails = 0
      StopTunnel $web; StopTunnel $tcp
      Start-Sleep 10
      try { Up; Write-Host "    Túneis de volta. Mídia: ${turnHost}:$turnPort" }
      catch { Write-Host "    [ERRO] $($_.Exception.Message) Nova tentativa em seguida." }
    }
    Start-Sleep -Milliseconds 300
  }
}finally {
  Write-Host '  Encerrando...'
  StopTunnel $web; StopTunnel $tcp
  if ($turnOn) {
    wsl -d LSG -u root -- bash $turnScript stop | ForEach-Object { Write-Host "  $_" }
    & $livekitScript -Restart | ForEach-Object { Write-Host "  $_" }
  }
  Write-Host "  Logs dos túneis: $logDir"
}
