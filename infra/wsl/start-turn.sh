#!/usr/bin/env bash
# Relay TURN (coturn) para participantes FORA da rede local, em teste com túnel público (pinggy.bat).
#
# Caminho da mídia: navegador -> túnel TCP do Pinggy -> este coturn (TCP 3478, no WSL) -> UDP -> LiveKit no
# Windows (gateway do WSL). O LiveKit não muda: a rede local continua por UDP direto.
#
# Uso:  start-turn.sh <usuario> <senha>    inicia (ou reinicia) com estas credenciais
#       start-turn.sh stop                 encerra
# Segurança: o relay só aceita encaminhar para o LiveKit (Windows); qualquer outro destino é recusado, para que o
# endereço público não vire um proxy aberto. As credenciais são novas a cada execução do pinggy.bat.
set -euo pipefail
RUN=/var/log/lsg-media
mkdir -p "$RUN" /etc/lsg

stop() {
  pkill -x turnserver 2>/dev/null || true
  for _ in $(seq 1 10); do pgrep -x turnserver >/dev/null || return 0; sleep 1; done
  pkill -9 -x turnserver || true
}

if [ "${1:-}" = stop ]; then stop; echo "TURN: encerrado"; exit 0; fi
[ $# -eq 2 ] || { echo "uso: $0 <usuario> <senha> | stop"; exit 1; }
command -v turnserver >/dev/null || { echo "coturn ausente: rode infra/wsl/setup-media.sh"; exit 1; }

WIN_HOST=$(ip route show default | awk '{print $3}')
WSL_IP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)

umask 077
cat > /etc/lsg/turnserver.conf <<EOF
listening-ip=$WSL_IP
relay-ip=$WSL_IP
listening-port=3478
min-port=49160
max-port=49200
realm=lsg
fingerprint
lt-cred-mech
user=$1:$2
no-tls
no-dtls
no-cli
no-multicast-peers
# Só o LiveKit (Windows, visto do WSL) pode receber dados pelo relay.
denied-peer-ip=0.0.0.0-255.255.255.255
allowed-peer-ip=$WIN_HOST
log-file=$RUN/turn.log
simple-log
EOF

stop
turnserver -c /etc/lsg/turnserver.conf --daemon >/dev/null 2>&1
sleep 1
pgrep -x turnserver >/dev/null || { echo "TURN: FALHOU — veja $RUN/turn.log"; exit 1; }
echo "TURN: ok ($WSL_IP:3478 -> LiveKit em $WIN_HOST)"
echo "WSL_IP=$WSL_IP"
