#!/usr/bin/env bash
# Puts the latest code from GitHub (branch main) live on the server.
# Usage (as root):  bash /opt/kinderwoow/deploy/update.sh
set -euo pipefail

cd /opt/kinderwoow
git pull --ff-only
npm ci --omit=dev
systemctl restart kinderwoow

for _ in $(seq 1 20); do
    curl -fsS http://127.0.0.1:3000/robots.txt >/dev/null 2>&1 && break
    sleep 1
done
if curl -fsS http://127.0.0.1:3000/robots.txt >/dev/null 2>&1; then
    echo "✅ Updated to: $(git log -1 --format='%h %s')"
else
    echo "❌ The website did not start. Last log lines:"
    journalctl -u kinderwoow -n 30 --no-pager
    exit 1
fi
