#!/usr/bin/env bash
# Connects the website's quote and contact forms to Resend so they send email.
# Run in the server console:
#   curl -fsSL https://raw.githubusercontent.com/pengledesign/pengledesign.github.io/cop-on-top-portal/set-email.sh -o /tmp/se.sh && bash /tmp/se.sh
set -e
echo "Paste the Resend API key (starts with re_). It won't show on screen:"
read -rs KEY </dev/tty
echo
case "$KEY" in re_*) ;; *) echo "That doesn't look like a Resend key (should start with re_). Nothing changed."; exit 1;; esac
read -rp "Email address that should get quote alerts [support@cop-on-top.com]: " TO </dev/tty
TO=${TO:-support@cop-on-top.com}
mkdir -p /etc/cop-on-top && chmod 700 /etc/cop-on-top
umask 077
cat > /etc/cop-on-top/mail.env <<CFG
RESEND_API_KEY=$KEY
MAIL_FROM=Cop On Top <quotes@cop-on-top.com>
MAIL_TO=$TO
CFG
systemctl restart cop-portal
sleep 2
systemctl is-active --quiet cop-portal && echo "EMAIL CONNECTED. Quotes go to customers, alerts go to $TO." || { echo "Portal didn't restart:"; systemctl --no-pager status cop-portal | tail -15; }
