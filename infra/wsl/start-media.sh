#!/usr/bin/env bash
# Inicia a pilha de mídia no WSL2 "LSG": Redis e Egress, e, conforme LIVEKIT_SERVER_HOST no .env, também o
# LiveKit Server:
#   LIVEKIT_SERVER_HOST=windows -> LiveKit roda NATIVO no Windows (infra/windows/start-livekit.ps1), usando este
#                                  Redis; o Egress conecta nele pelo gateway do WSL. Necessário para acessar pela
#                                  rede local (celular): o WSL2 do Windows 10 não repassa UDP.
#   LIVEKIT_SERVER_HOST=wsl     -> (padrão) LiveKit também no WSL; só o próprio PC conecta.
# Chave/segredo são lidos do .env do projeto (LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
# Uso (PowerShell):  wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/start-media.sh"
set -euo pipefail
PROJECT="/mnt/d/LS GLOBAL"
RUN=/var/log/lsg-media
mkdir -p "$RUN" /etc/lsg

envval() { grep -E "^$1=" "$PROJECT/.env" | tail -1 | cut -d= -f2- | tr -d '\r'; }
KEY=$(envval LIVEKIT_API_KEY)
SECRET=$(envval LIVEKIT_API_SECRET)
[ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "LIVEKIT_API_KEY/SECRET ausentes no .env"; exit 1; }
API_PORT=$(envval API_PORT); API_PORT=${API_PORT:-3333}
MODE=$(envval LIVEKIT_SERVER_HOST); MODE=${MODE:-wsl}
# Windows visto de dentro do WSL2 (modo NAT): gateway padrão.
WIN_HOST=$(ip route show default | awk '{print $3}')

# Encerra um processo e espera ele sair de fato (o LiveKit leva um tempo esperando participantes saírem).
stop_wait() {
  pgrep "$@" >/dev/null || return 0
  pkill "$@" || true
  for _ in $(seq 1 30); do pgrep "$@" >/dev/null || return 0; sleep 1; done
  pkill -9 "$@" || true; sleep 1
}

umask 077
if [ "$MODE" = windows ]; then
  LK_HOST=$WIN_HOST
  stop_wait -f "livekit-server --config"
else
  LK_HOST=127.0.0.1
  cat > /etc/lsg/livekit.yaml <<EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
redis:
  address: 127.0.0.1:6379
keys:
  $KEY: $SECRET
webhook:
  api_key: $KEY
  urls:
    - http://$WIN_HOST:$API_PORT/api/v1/webhooks/livekit
logging:
  level: info
EOF
fi

OLD_EGRESS_CFG=$(cat /etc/lsg/egress.yaml 2>/dev/null || true)
cat > /etc/lsg/egress.yaml <<EOF
api_key: $KEY
api_secret: $SECRET
ws_url: ws://$LK_HOST:7880
redis:
  address: 127.0.0.1:6379
health_port: 9090
log_level: info
# Perfil do Chrome em RAM: criado no disco (HD mecânico) a cada gravação, levava de 5 s a 35 s e estourava os
# prazos do Egress ("websocket url timeout reached"); em /dev/shm leva ~0,4 s. O MP4 continua no disco.
# Perfil único: neste ambiente de desenvolvimento, uma gravação por vez.
chrome_flags:
  user-data-dir: /dev/shm/egress-chrome
EOF
# Modo windows: o Chrome do Egress conecta em ws:// num IP privado (gateway do WSL) e o Chrome bloqueia isso
# (Local Network Access) a menos que "insecure" esteja ligado. Vale só para o Chrome interno do Egress, em
# desenvolvimento; em produção, LiveKit e Egress ficam no mesmo host Linux (ws://127.0.0.1) ou usam wss://.
[ "$MODE" = windows ] && echo "insecure: true" >> /etc/lsg/egress.yaml
chown egress /etc/lsg/egress.yaml
# Configuração do Egress mudou (ex.: troca de modo): reinicia para aplicar.
[ "$OLD_EGRESS_CFG" = "$(cat /etc/lsg/egress.yaml)" ] || stop_wait -x egress

pgrep -x redis-server >/dev/null || redis-server /etc/redis/redis.conf --daemonize yes
if [ "$MODE" != windows ]; then
  pgrep -f "livekit-server --config" >/dev/null || nohup livekit-server --config /etc/lsg/livekit.yaml > "$RUN/livekit.log" 2>&1 &
fi

# O WSLg monta /tmp/.X11-unix somente leitura; o Xvfb do Egress precisa criar o socket do display ali.
if mount | grep -q ' /tmp/.X11-unix .*ro,'; then umount /tmp/.X11-unix 2>/dev/null || umount -l /tmp/.X11-unix; fi
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Disco virtual do WSL em HD mecânico: o Chrome (~450 MB) relido do disco a cada gravação leva de 7 s a 30 s para
# abrir, conforme a carga do disco, e estoura os prazos fixos do Egress (15–20 s). Mantém Chrome, Egress e
# GStreamer travados na RAM (~600 MB).
if command -v vmtouch >/dev/null && ! pgrep -x vmtouch >/dev/null; then
  vmtouch -q -d -l /opt/google/chrome /usr/local/bin/egress /usr/lib/x86_64-linux-gnu/gstreamer-1.0 \
    $(ls /usr/lib/x86_64-linux-gnu/libgst*.so* 2>/dev/null) \
    $(ldd /opt/google/chrome/chrome | awk '/=>/{print $3}') 2>/dev/null || true
fi

if ! pgrep -x egress >/dev/null; then
  # PulseAudio de uma execução anterior (sem a pasta de sessão, que é recriada abaixo) impediria o novo.
  stop_wait -u egress -x pulseaudio
  su - egress -c '
    export XDG_RUNTIME_DIR=/home/egress/.cache/xdgr
    rm -rf /home/egress/tmp/* /home/egress/.config/pulse /home/egress/.cache/xdgr/pulse
    pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1
    pactl info >/dev/null 2>&1 || { echo "PulseAudio não iniciou (a gravação ficaria sem áudio)"; exit 1; }
    # Cache do registro do GStreamer: sem ele, cada gravação refaz a varredura de plugins e o Chrome
    # do Egress estoura o prazo de 20 s para abrir ("websocket url timeout reached").
    gst-inspect-1.0 >/dev/null 2>&1 || true
    # Aquece o Chrome (disco e cache de fontes). A frio, depois de horas parado, a primeira abertura leva ~25 s,
    # e o Egress mata o Chrome aos 20 s; como o aquecimento nunca termina, toda gravação falha do mesmo jeito.
    timeout 90 /opt/google/chrome/chrome --headless=new --no-sandbox --disable-gpu --user-data-dir=/home/egress/tmp/warmup --dump-dom about:blank >/dev/null 2>&1 || true
    rm -rf /home/egress/tmp/warmup
    ulimit -n 65536 || true
    EGRESS_CONFIG_FILE=/etc/lsg/egress.yaml nohup /usr/local/bin/egress > /tmp/egress.log 2>&1 &
  '
fi
sleep 3
echo "Modo:    LiveKit no $MODE ($LK_HOST:7880)"
echo "Redis:   $(redis-cli ping 2>/dev/null || echo FALHOU)"
echo "LiveKit: $(curl -s -m 3 "http://$LK_HOST:7880/" || echo "FALHOU$([ "$MODE" = windows ] && echo ' — inicie infra/windows/start-livekit.ps1 e confira a regra de firewall')")"
echo "Egress:  $(curl -s -m 3 http://127.0.0.1:9090/ >/dev/null && echo ok || echo 'ainda iniciando — veja /tmp/egress.log')"
