#!/bin/bash
# Statiku's server on Oracle Cloud's Always Free tier, set up on its first boot: paste this whole file, with the deploy
# key filled in, as the instance's cloud-init script (on Ubuntu 24.04). It adds swap, opens the web ports, installs
# Docker, fetches Statiku with a read-only deploy key, writes its settings once, and starts Statiku, its Postgres and
# Caddy, then keeps them up to date every five minutes and copies the database every night.
# Progress is in /var/log/statiku-setup.log; the first build takes ten minutes or so.
# No command tracing (set -x): it would write the deploy key into the log.
set -euo pipefail
exec > >(tee -a /var/log/statiku-setup.log) 2>&1
say() { echo "[$(date +%T)] $*"; }

DOMAIN=statiku.victorabuchi.com
# A read-only deploy key of github.com/victorabuchi/statiku (the repository's Settings, then Deploy keys).
DEPLOY_KEY='PASTE THE PRIVATE KEY HERE'
if [ "${DEPLOY_KEY#-----BEGIN}" = "$DEPLOY_KEY" ]; then echo "The deploy key isn't filled in." >&2; exit 1; fi

say "Adding swap"
# Memory to spare for building on the smallest server.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Opening ports 80 and 443"
# Oracle's Ubuntu lets in only SSH; HTTP and HTTPS too, first, ahead of its final REJECT rule (other hosts' Ubuntu
# lets everything in, and this changes nothing there). The network's security list or firewall has to allow them as
# well (see docs/OPERATIONS.md).
# A minimal image may have no iptables at all, and then nothing to open.
if command -v iptables >/dev/null; then
  for port in 443 80; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi
fi

say "Installing Docker"
# Named in full, as a minimal image may lack the smaller ones (Ubuntu 24.04 or 26.04, Minimal or not).
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 docker-buildx git openssh-client openssl ca-certificates
systemctl enable --now docker

say "Fetching Statiku"
# Statiku's code, through the deploy key.
install -d -m 700 /root/.ssh
printf '%s\n' "$DEPLOY_KEY" > /root/.ssh/statiku_deploy
chmod 600 /root/.ssh/statiku_deploy
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts
cat >> /root/.ssh/config <<'CONFIG'
Host github.com
  IdentityFile /root/.ssh/statiku_deploy
  IdentitiesOnly yes
CONFIG
[ -d /opt/statiku/.git ] || git clone git@github.com:victorabuchi/statiku.git /opt/statiku

# Settings, made once and kept: the database's password and the key that seals tokens.
SETTINGS=/opt/statiku/deploy/oracle/.env
if [ ! -f "$SETTINGS" ]; then
  umask 077
  cat > "$SETTINGS" <<ENV
DOMAIN=$DOMAIN
DB_PASSWORD=$(openssl rand -hex 24)
SECRET_KEY=$(openssl rand -base64 32)
ENV
fi

# Up to date every five minutes, and a copy of the database every night.
cat > /etc/systemd/system/statiku-update.service <<'UNIT'
[Unit]
Description=Bring Statiku up to date with GitHub
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/opt/statiku/deploy/oracle/update.sh
UNIT
cat > /etc/systemd/system/statiku-update.timer <<'UNIT'
[Unit]
Description=Bring Statiku up to date with GitHub every five minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/statiku-backup.service <<'UNIT'
[Unit]
Description=Copy Statiku's database
After=docker.service
[Service]
Type=oneshot
ExecStart=/opt/statiku/deploy/oracle/backup.sh
UNIT
cat > /etc/systemd/system/statiku-backup.timer <<'UNIT'
[Unit]
Description=Copy Statiku's database every night
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now statiku-update.timer statiku-backup.timer

say "Building and starting Statiku"
if /opt/statiku/deploy/oracle/update.sh --force; then say "Done: https://$DOMAIN"
else say "The first build failed; it's tried again every five minutes (journalctl -u statiku-update)"; fi
