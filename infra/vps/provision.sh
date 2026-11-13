#!/usr/bin/env bash
# Provisionamento inicial da VPS (CentOS Stream 10). Rode UMA vez, como root, com a chave pública autorizada:
#   ssh root@IP "bash -s -- '$(cat ~/.ssh/lsglobal_vps.pub)'" < infra/vps/provision.sh
# Depois: bash infra/vps/deploy.sh --setup
set -euo pipefail
PUB="$1"

echo "== sistema"
dnf -y -q upgrade --refresh
dnf -y -q install epel-release
dnf -y -q install git tar gzip curl nginx firewalld fail2ban gcc-c++ make python3 nodejs nodejs-npm policycoreutils-python-utils
timedatectl set-timezone America/Sao_Paulo

echo "== swap 2G"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== PostgreSQL 18 (AppStream)"
dnf -y -q install postgresql18-server postgresql18 postgresql18-contrib   # contrib: pgcrypto, citext
if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
  postgresql-setup --initdb
fi
# só aceita conexões locais (scram)
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" /var/lib/pgsql/data/postgresql.conf
cat > /var/lib/pgsql/data/pg_hba.conf <<'EOF'
local   all   postgres                peer
local   all   all                     scram-sha-256
host    all   all   127.0.0.1/32      scram-sha-256
host    all   all   ::1/128           scram-sha-256
EOF
systemctl enable --now postgresql
systemctl restart postgresql

echo "== usuários"
# lsg: roda a API (sem login, sem sudo)
id lsg >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/lsglobal --shell /sbin/nologin lsg
chmod 755 /opt/lsglobal
# deploy: acesso SSH dos desenvolvedores, com sudo
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash -G wheel deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "$PUB" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy && chmod 440 /etc/sudoers.d/90-deploy

echo "== firewall"
systemctl enable --now firewalld
firewall-cmd -q --permanent --add-service=ssh
firewall-cmd -q --permanent --add-service=http
firewall-cmd -q --permanent --add-service=https
firewall-cmd -q --permanent --remove-service=cockpit 2>/dev/null || true
firewall-cmd -q --permanent --remove-service=dhcpv6-client 2>/dev/null || true
firewall-cmd -q --reload
systemctl disable --now cockpit.socket 2>/dev/null || true

echo "== fail2ban"
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = systemd
banaction = firewallcmd-rich-rules

[sshd]
enabled = true
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== SSH: só chave"
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
MaxAuthTries 4
EOF
# alguns templates de nuvem forçam PasswordAuthentication yes em 50-cloud-init.conf
sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true
sshd -t && systemctl reload sshd

echo "== versões"
node -v; npm -v; postgres --version; nginx -v 2>&1
echo PROVISION_OK
