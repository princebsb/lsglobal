#!/usr/bin/env bash
# Executado NA VPS (como root) por infra/vps/deploy.sh.
# Uso: remote-build.sh <arquivo.tar.gz> [--seed]
#
# Layout:
#   /opt/lsglobal/app         versão no ar (código + build)
#   /opt/lsglobal/shared/.env segredos (gerados na primeira execução; fora do Git)
#   /opt/lsglobal/storage     arquivos, outbox de e-mail e gravações (persistem entre deploys)
set -euo pipefail
TARBALL="$1"; SEED="${2:-}"
BASE=/opt/lsglobal
NEW="$BASE/app.new"
PUBLIC_HOST="${PUBLIC_HOST:-$(curl -s4 --max-time 5 https://ifconfig.me || hostname -I | awk '{print $1}')}"

install -d -o lsg -g lsg "$BASE/shared" "$BASE/storage" "$BASE/storage/outbox" "$BASE/storage/recordings"

# ---------- segredos (somente na primeira vez) ----------
if [ ! -f "$BASE/shared/.env" ]; then
  echo "== gerando $BASE/shared/.env"
  rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }
  PG_ADMIN_PWD=$(rnd 24 hex); APP_PWD=$(rnd 24 hex)
  sudo -u postgres psql -qc "alter user postgres password '$PG_ADMIN_PWD'"
  cat > "$BASE/shared/.env" <<EOF
# Gerado em $(date -Iseconds) por remote-build.sh. NÃO versionar.
# Ambiente TEMPORÁRIO de demonstração via IP (HTTP). Para produção: domínio + HTTPS,
# NODE_ENV=production, MFA_ENFORCE_ADMIN=true e sem seed de demonstração.
NODE_ENV=development
API_PORT=3333
WEB_ORIGIN=http://$PUBLIC_HOST
PUBLIC_WEB_URL=http://$PUBLIC_HOST

DATABASE_ADMIN_URL=postgres://postgres:$PG_ADMIN_PWD@127.0.0.1:5432/postgres
DB_NAME=lsglobal_assembleias
DB_TEST_NAME=lsglobal_assembleias_test
DB_APP_USER=lsg_app
DB_APP_PASSWORD=$APP_PWD
DB_POOL_MAX=20

JWT_SECRET=$(rnd 48 base64url)
JWT_ACCESS_TTL_SECONDS=900
REFRESH_TTL_DAYS=7
DATA_ENCRYPTION_KEY=$(rnd 32 base64)
DATA_HMAC_KEY=$(rnd 32 base64)
MFA_ENFORCE_ADMIN=false

STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=$BASE/storage
MAIL_DRIVER=file
MAIL_OUTBOX_DIR=$BASE/storage/outbox
MAIL_FROM=LS Global Assembleias <nao-responda@lsglobal.local>
OUTBOX_WORKER=true
OUTBOX_INTERVAL_MS=5000

LIVEKIT_EGRESS_ENABLED=false
RECORDINGS_DIR=$BASE/storage/recordings
LOG_LEVEL=info
EOF
  chown lsg:lsg "$BASE/shared/.env"; chmod 600 "$BASE/shared/.env"
fi

# ---------- build em diretório novo (a versão atual continua no ar) ----------
echo "== extraindo"
rm -rf "$NEW"; install -d -o lsg -g lsg "$NEW"
tar -xzf "$TARBALL" -C "$NEW"; rm -f "$TARBALL"
ln -sf "$BASE/shared/.env" "$NEW/.env"
chown -R lsg:lsg "$NEW"

as_lsg() { sudo -u lsg env HOME="$BASE" npm_config_cache="$BASE/.npm" bash -c "cd '$1' && $2"; }

echo "== npm ci"
as_lsg "$NEW" "npm ci --no-audit --no-fund --loglevel=error"
echo "== build"
as_lsg "$NEW" "npm run build --silent"

# ---------- troca de versão ----------
echo "== publicando"
systemctl stop lsglobal-api 2>/dev/null || true
rm -rf "$BASE/app.old"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.old"
mv "$NEW" "$BASE/app"

echo "== banco"
as_lsg "$BASE/app" "npm run db:setup --silent && npm run db:migrate --silent"
if [ "$SEED" = "--seed" ]; then
  echo "== seed de demonstração"
  as_lsg "$BASE/app" "npm run db:seed --silent"
fi

systemctl start lsglobal-api
nginx -t -q && systemctl reload nginx

for i in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:3333/api/v1/health; then echo "DEPLOY_OK"; exit 0; fi
  sleep 1
done
echo "A API não respondeu em 30s:"; journalctl -u lsglobal-api -n 40 --no-pager; exit 1
