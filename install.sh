#!/usr/bin/env bash
# Cop On Top: installs or updates the website + client portal on this server.
# Safe to run again later to pick up updates. Portal logins and cameras are kept.
set -euo pipefail
REPO="https://github.com/pengledesign/pengledesign.github.io.git"
BRANCH="cop-on-top-portal"
GO2RTC_VER="v1.9.9"

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y nodejs git curl caddy ufw >/dev/null

echo "==> Getting the latest site and portal code"
if [ -d /opt/cop-on-top/.git ]; then
  git -C /opt/cop-on-top fetch --depth 1 origin "$BRANCH"
  git -C /opt/cop-on-top reset --hard FETCH_HEAD
else
  rm -rf /opt/cop-on-top
  git clone --depth 1 --single-branch -b "$BRANCH" "$REPO" /opt/cop-on-top
fi

echo "==> Installing the video relay (go2rtc $GO2RTC_VER)"
if ! /usr/local/bin/go2rtc -version 2>/dev/null | grep -q "${GO2RTC_VER#v}"; then
  curl -fsSL -o /usr/local/bin/go2rtc.new "https://github.com/AlexxIT/go2rtc/releases/download/${GO2RTC_VER}/go2rtc_linux_amd64"
  chmod +x /usr/local/bin/go2rtc.new && mv /usr/local/bin/go2rtc.new /usr/local/bin/go2rtc
fi

echo "==> Setting up accounts and folders"
id cotportal >/dev/null 2>&1 || useradd --system --home-dir /var/lib/cop-on-top --shell /usr/sbin/nologin cotportal
mkdir -p /var/lib/cop-on-top /etc/go2rtc /var/www/cop-on-top
[ -f /etc/go2rtc/go2rtc.yaml ] || cp /opt/cop-on-top/deploy/go2rtc.yaml /etc/go2rtc/go2rtc.yaml
chown -R cotportal:cotportal /var/lib/cop-on-top /etc/go2rtc
chmod 700 /var/lib/cop-on-top /etc/go2rtc

echo "==> Publishing the website"
rm -rf /var/www/cop-on-top/*
cp -r /opt/cop-on-top/site/. /var/www/cop-on-top/
cp /opt/cop-on-top/deploy/Caddyfile /etc/caddy/Caddyfile

echo "==> Starting services"
cp /opt/cop-on-top/deploy/go2rtc.service /opt/cop-on-top/deploy/cop-portal.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable go2rtc cop-portal >/dev/null 2>&1
systemctl restart go2rtc
sleep 2
systemctl restart cop-portal
systemctl reload caddy || systemctl restart caddy
ufw allow OpenSSH >/dev/null; ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; ufw --force enable >/dev/null

sleep 3
echo
if systemctl is-active --quiet cop-portal && systemctl is-active --quiet go2rtc; then
  echo "ALL DONE. The portal is running."
else
  echo "Something didn't start. Send a screenshot of this:"
  systemctl --no-pager status cop-portal go2rtc | tail -30
  exit 1
fi
if [ -f /var/lib/cop-on-top/setup-code.txt ]; then
  echo
  echo "  Go to https://cop-on-top.com/portal/ to create the admin account."
  echo "  SETUP CODE: $(cat /var/lib/cop-on-top/setup-code.txt)"
fi
