#!/usr/bin/env bash
# =====================================================================
# Instala, dentro da distribuição WSL2 "LSG" (disco virtual em D:\wsl\lsg),
# a pilha de mídia do LS Global Assembleias — SEM Docker:
#   - Redis (compartilhado entre LiveKit Server e Egress)
#   - LiveKit Server (binário oficial Linux)
#   - LiveKit Egress compilado do código-fonte (Go + GStreamer 1.24 + Chrome)
#
# Uso (PowerShell):  wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/setup-media.sh"
# Downloads são verificados por SHA-256 quando o fornecedor publica o hash.
# =====================================================================
set -euo pipefail

LIVEKIT_VERSION=1.13.11
EGRESS_VERSION=v1.15.0
GO_VERSION=1.26.8
NODE_MAJOR=22
PROJECT="/mnt/d/LS GLOBAL"
WORK=/opt/lsg-media
mkdir -p "$WORK/dl" /etc/lsg

log() { printf '\n==> %s\n' "$*"; }

log "Pacotes do sistema (Redis, GStreamer 1.24, PulseAudio, Xvfb, fontes, toolchain)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget git unzip xz-utils jq build-essential pkg-config \
  redis-server pulseaudio xvfb fonts-noto fonts-noto-color-emoji vmtouch coturn \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
  gstreamer1.0-pulseaudio gstreamer1.0-x gstreamer1.0-nice
gst-launch-1.0 --version | head -2

log "Plugin GStreamer 'faac' (AAC do MP4; o pacote do Ubuntu não o inclui)"
if ! gst-inspect-1.0 faac >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends meson ninja-build libfaac-dev
  GST_VER=$(gst-launch-1.0 --version | awk 'NR==1{print $NF}')
  src="gst-plugins-bad-$GST_VER"
  wget -qO "$WORK/dl/$src.tar.xz" "https://gstreamer.freedesktop.org/src/gst-plugins-bad/$src.tar.xz"
  (cd "$WORK/dl" && echo "$(curl -fsSL "https://gstreamer.freedesktop.org/src/gst-plugins-bad/$src.tar.xz.sha256sum" | awk '{print $1}')  $src.tar.xz" | sha256sum -c -)
  rm -rf "$WORK/$src" && tar -C "$WORK" -xJf "$WORK/dl/$src.tar.xz"
  (cd "$WORK/$src" && meson setup build -Dauto_features=disabled -Dfaac=enabled && ninja -C build ext/faac/libgstfaac.so)
  install -m644 "$WORK/$src/build/ext/faac/libgstfaac.so" "$(pkg-config --variable=pluginsdir gstreamer-1.0)/"
  rm -rf /home/egress/.cache/gstreamer-1.0
fi
gst-inspect-1.0 faac >/dev/null && echo "faac: ok"

log "Redis: somente localhost"
sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
sed -i 's/^supervised .*/supervised no/' /etc/redis/redis.conf

log "Go $GO_VERSION"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go$GO_VERSION"; then
  GO_SHA=$(curl -fsSL "https://go.dev/dl/?mode=json&include=all" \
    | jq -r --arg f "go$GO_VERSION.linux-amd64.tar.gz" '.[].files[] | select(.filename==$f) | .sha256')
  [ -n "$GO_SHA" ] || { echo "hash do Go não encontrado"; exit 1; }
  wget -qO "$WORK/dl/go.tgz" "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"
  echo "$GO_SHA  $WORK/dl/go.tgz" | sha256sum -c -
  rm -rf /usr/local/go && tar -C /usr/local -xzf "$WORK/dl/go.tgz"
fi
export PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local

log "Node.js $NODE_MAJOR (para compilar o template de gravação)"
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR"; then
  NODE_FILE=$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-x64.tar.xz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$NODE_FILE" -o "$WORK/dl/$NODE_FILE"
  (cd "$WORK/dl" && curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" | grep " $NODE_FILE\$" | sha256sum -c -)
  tar -C /usr/local --strip-components=1 -xJf "$WORK/dl/$NODE_FILE"
fi
node -v
corepack enable

log "Google Chrome (renderização do layout da gravação)"
if ! command -v google-chrome >/dev/null; then
  wget -qO "$WORK/dl/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y "$WORK/dl/chrome.deb"
fi
google-chrome --version

log "LiveKit Server $LIVEKIT_VERSION (Linux)"
if ! /usr/local/bin/livekit-server --version 2>/dev/null | grep -q "$LIVEKIT_VERSION"; then
  base="https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION"
  f="livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz"
  wget -qO "$WORK/dl/$f" "$base/$f"
  (cd "$WORK/dl" && curl -fsSL "$base/checksums.txt" | grep " $f\$" | sha256sum -c -)
  tar -C /usr/local/bin -xzf "$WORK/dl/$f" livekit-server
fi
livekit-server --version

log "LiveKit Egress $EGRESS_VERSION (compilação a partir do código-fonte)"
if [ ! -x /usr/local/bin/egress ] || [ "$(cat "$WORK/egress.version" 2>/dev/null)" != "$EGRESS_VERSION" ]; then
  rm -rf "$WORK/egress"
  git clone --depth 1 --branch "$EGRESS_VERSION" https://github.com/livekit/egress.git "$WORK/egress"
  cd "$WORK/egress/template-default"
  CI=true corepack pnpm install --frozen-lockfile
  corepack pnpm build
  if [ -d build ]; then outdir=build; elif [ -d dist ]; then outdir=dist; else echo "template sem build/ nem dist/"; exit 1; fi
  mkdir -p ../cmd/server/templates && cp -r "$outdir"/. ../cmd/server/templates/
  find ../cmd/server/templates -name '*.map' -delete
  cd "$WORK/egress"
  CGO_ENABLED=1 GODEBUG=disablethp=1 go build -o /usr/local/bin/egress ./cmd/server
  echo "$EGRESS_VERSION" > "$WORK/egress.version"
fi

# coturn: relay TURN só para testes em rede externa (infra/wsl/start-turn.sh, chamado pelo pinggy.bat). O serviço
# padrão do pacote fica desligado: sem autenticação configurada, não deve escutar nada por conta própria.
systemctl disable --now coturn >/dev/null 2>&1 || true

log "Usuário de serviço 'egress' e diretório de gravações"
id egress >/dev/null 2>&1 || useradd -ms /bin/bash -G pulse,pulse-access egress || useradd -ms /bin/bash egress
mkdir -p /home/egress/tmp /home/egress/.cache/xdgr && chown -R egress /home/egress
grep -q 'rlimit-nofile' /etc/pulse/daemon.conf || echo "rlimit-nofile = -1" >> /etc/pulse/daemon.conf
mkdir -p "$PROJECT/apps/api/storage/recordings"

log "Concluído. Inicie com: wsl -d LSG -u root -- bash \"$PROJECT/infra/wsl/start-media.sh\""
