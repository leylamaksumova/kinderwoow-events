#!/usr/bin/env bash
# One-time setup of the KinderWoow website on a fresh Ubuntu 24.04 server (e.g. a DigitalOcean droplet).
# Installs Node.js, PostgreSQL and nginx, downloads the code, starts the site and gets an HTTPS certificate.
#
# Usage (as root):  bash setup.sh <domain> <email for the SSL certificate>
# Example:          bash setup.sh kinderwoow.de info@example.com
#
# Safe to run again: existing passwords, database and nginx settings are kept.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
    echo "Usage: bash setup.sh <domain> <email>   (example: bash setup.sh kinderwoow.de info@example.com)"
    exit 1
fi
if [[ $EUID -ne 0 ]]; then
    echo "Please run as root."
    exit 1
fi

APP_DIR=/opt/kinderwoow
APP_USER=kinderwoow
DB_NAME=kinderwoow
ENV_FILE=/etc/kinderwoow.env
REPO_URL=https://github.com/leylamaksumova/kinderwoow-events.git
APP_PORT=3000
NGINX_SITE=/etc/nginx/sites-available/kinderwoow

step() { echo; echo "==> $*"; }

step "Installing system updates and packages (this takes a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git nginx postgresql ufw openssl certbot python3-certbot-nginx

# Small droplets have 1 GB RAM: a swap file keeps npm and PostgreSQL from running out of memory
if ! swapon --show | grep -q .; then
    step "Adding 1 GB swap file"
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Installing Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
node -v

step "Creating system user '$APP_USER' for the website"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

step "Downloading the website code"
# The code stays owned by root, the website user can only read it
if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only
else
    git clone --branch main "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

step "Setting up the PostgreSQL database"
ADMIN_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
    DB_PASSWORD=$(openssl rand -hex 24)
    SESSION_SECRET=$(openssl rand -hex 32)
    ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)

    if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$APP_USER'" | grep -q 1; then
        sudo -u postgres psql -q -c "ALTER ROLE $APP_USER WITH LOGIN PASSWORD '$DB_PASSWORD'"
    else
        sudo -u postgres psql -q -c "CREATE ROLE $APP_USER WITH LOGIN PASSWORD '$DB_PASSWORD'"
    fi
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
        sudo -u postgres createdb -O "$APP_USER" "$DB_NAME"
    fi

    cat > "$ENV_FILE" <<EOF
# KinderWoow settings. After changing this file run: systemctl restart kinderwoow
NODE_ENV=production
PORT=$APP_PORT
DATABASE_URL=postgres://$APP_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
DATABASE_SSL=false
SESSION_SECRET=$SESSION_SECRET
SITE_URL=https://$DOMAIN
BUSINESS_TIMEZONE=Europe/Berlin

# First admin account (only used on the very first start)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD

# Booking notification e-mails (optional): remove the "#" and fill in.
# DigitalOcean blocks SMTP (Gmail), so use Resend: API key from https://resend.com/api-keys
#RESEND_API_KEY=re_xxxxxxxx
#NOTIFY_EMAIL=your-resend-account-address@gmail.com
# Or Gmail, on hosts that allow SMTP:
#GMAIL_USER=your-address@gmail.com
#GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
#NOTIFY_EMAIL=your-address@gmail.com
EOF
    chown root:root "$ENV_FILE"
    chmod 600 "$ENV_FILE"
else
    echo "$ENV_FILE already exists, keeping the existing passwords."
fi

step "Starting the website as a service (restarts automatically, also after a reboot)"
cat > /etc/systemd/system/kinderwoow.service <<EOF
[Unit]
Description=KinderWoow website
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kinderwoow
systemctl restart kinderwoow

for _ in $(seq 1 20); do
    curl -fsS "http://127.0.0.1:$APP_PORT/robots.txt" >/dev/null 2>&1 && break
    sleep 1
done
if ! curl -fsS "http://127.0.0.1:$APP_PORT/robots.txt" >/dev/null 2>&1; then
    echo "❌ The website did not start. Last log lines:"
    journalctl -u kinderwoow -n 30 --no-pager
    exit 1
fi
echo "✅ Website is running on port $APP_PORT"

step "Configuring nginx for $DOMAIN"
# Written only once: certbot adds the HTTPS settings to this file later
if [[ ! -f "$NGINX_SITE" ]]; then
    cat > "$NGINX_SITE" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__ www.__DOMAIN__;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
    sed -i "s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$APP_PORT/g" "$NGINX_SITE"
fi
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/kinderwoow
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

step "Configuring the firewall (only SSH, HTTP and HTTPS are open)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

step "Getting a free HTTPS certificate (Let's Encrypt)"
SERVER_IP=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null || hostname -I | awk '{print $1}')
domain_ip() { getent ahostsv4 "$1" | awk 'NR==1 {print $1}'; }
CERT_DOMAINS=()
[[ "$(domain_ip "$DOMAIN")" == "$SERVER_IP" ]] && CERT_DOMAINS+=(-d "$DOMAIN")
[[ "$(domain_ip "www.$DOMAIN")" == "$SERVER_IP" ]] && CERT_DOMAINS+=(-d "www.$DOMAIN")

CERT_COMMAND="certbot --nginx -d $DOMAIN -d www.$DOMAIN -m $EMAIL --agree-tos --redirect -n"
if [[ ${#CERT_DOMAINS[@]} -eq 2 ]]; then
    certbot --nginx "${CERT_DOMAINS[@]}" -m "$EMAIL" --agree-tos --redirect -n
    HTTPS_OK=yes
else
    HTTPS_OK=no
    echo "⚠️  $DOMAIN / www.$DOMAIN do not point to this server ($SERVER_IP) yet, skipping HTTPS for now."
fi

echo
echo "================================================================"
if [[ "$HTTPS_OK" == yes ]]; then
    echo "🎉 Done! Website: https://$DOMAIN   Admin panel: https://$DOMAIN/admin.html"
else
    echo "🎉 The website is installed: http://$SERVER_IP"
    echo
    echo "Next: point the domain to $SERVER_IP (DNS A records for $DOMAIN and www.$DOMAIN)."
    echo "When that works, get HTTPS with this command:"
    echo "    $CERT_COMMAND"
    echo "The admin panel only works over HTTPS (secure login cookie)."
fi
if [[ -n "$ADMIN_PASSWORD" ]]; then
    echo
    echo "Admin login:   username: admin   password: $ADMIN_PASSWORD"
    echo "⚠️  Write this password down now, it is shown only once."
    echo "    (It is also in $ENV_FILE. Change it in the admin panel → My Account.)"
fi
echo "================================================================"
