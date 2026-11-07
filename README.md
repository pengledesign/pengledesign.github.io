# Cop On Top — website + client portal

Install or update on the server (Ubuntu 24.04, as root):

    curl -fsSL https://raw.githubusercontent.com/pengledesign/pengledesign.github.io/cop-on-top-portal/install.sh | bash

- `site/` public website (served by Caddy)
- `portal/` Node server: logins, admin, PTZ, and the live-video gate in front of go2rtc
- `deploy/` Caddy, go2rtc and systemd config

Data (logins, cameras) lives in /var/lib/cop-on-top on the server and is never in this repo.
