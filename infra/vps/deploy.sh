#!/usr/bin/env bash
# Publica o commit atual (HEAD) na VPS. Rode da raiz do repositório (Git Bash no Windows).
#
#   bash infra/vps/deploy.sh            # deploy normal
#   bash infra/vps/deploy.sh --seed     # deploy + recria os dados de demonstração
#   bash infra/vps/deploy.sh --setup    # 1ª vez: instala serviço systemd e nginx, depois faz deploy com seed
#
# Variáveis opcionais: VPS_HOST (padrão 187.53.110.218), VPS_USER (deploy), VPS_KEY (~/.ssh/lsglobal_vps)
# Envia a árvore de trabalho atual: arquivos versionados + novos não ignorados pelo .gitignore
# (.env, node_modules, dist, storage e .certs nunca vão).
set -euo pipefail
HOST="${VPS_HOST:-187.53.110.218}"
USER_="${VPS_USER:-deploy}"
KEY="${VPS_KEY:-$HOME/.ssh/lsglobal_vps}"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes "$USER_@$HOST")
MODE="${1:-}"

cd "$(git rev-parse --show-toplevel)"
REV=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then REV="$REV-dirty"; echo "Aviso: publicando com alterações não commitadas ($REV)."; fi

if [ "$MODE" = "--setup" ]; then
  echo "== instalando serviço e nginx"
  "${SSH[@]}" "sudo tee /etc/systemd/system/lsglobal-api.service >/dev/null" < infra/vps/lsglobal-api.service
  "${SSH[@]}" "sudo tee /etc/nginx/conf.d/lsglobal.conf >/dev/null" < infra/vps/nginx-lsglobal.conf
  "${SSH[@]}" "sudo sed -i '/^    server {/,/^    }/s/^/#/' /etc/nginx/nginx.conf; sudo systemctl daemon-reload; sudo systemctl enable lsglobal-api nginx; sudo systemctl start nginx"
  MODE="--seed"
fi

echo "== enviando $REV"
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -T - -czf - \
  | "${SSH[@]}" "cat > /tmp/lsglobal-$REV.tar.gz"
"${SSH[@]}" "sudo tee /tmp/lsglobal-remote-build.sh >/dev/null" < infra/vps/remote-build.sh
"${SSH[@]}" "sudo bash /tmp/lsglobal-remote-build.sh /tmp/lsglobal-$REV.tar.gz $MODE"
echo "Publicado: http://$HOST  (commit $REV)"
