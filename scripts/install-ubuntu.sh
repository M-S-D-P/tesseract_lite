#!/usr/bin/env bash
#
# Tesseract Lite — Ubuntu installer.
#
# Installs Node, creates a service account, builds the app, generates a
# self-signed certificate, seeds the accounts and registers a systemd unit
# that serves HTTPS directly on the chosen port. No reverse proxy involved.
#
#   sudo ./scripts/install-ubuntu.sh
#
# Re-running is safe: every step checks for what it is about to create. It
# will not overwrite .env.local, an existing certificate, or existing accounts.
#
# Override any of these on the command line:
#   sudo BIND_HOST=10.2.0.28 PORT=3006 ./scripts/install-ubuntu.sh

set -euo pipefail

BIND_HOST="${BIND_HOST:-10.2.0.28}"     # address the app is reached on
PORT="${PORT:-3006}"
APP_USER="${APP_USER:-tesseract}"
APP_DIR="${APP_DIR:-/opt/tesseract/app}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE="${SERVICE:-tesseract}"

CERT_DIR="$APP_DIR/certs"
CERT_FILE="$CERT_DIR/server.crt"
KEY_FILE="$CERT_DIR/server.key"
ENV_FILE="$APP_DIR/.env.local"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

# The script lives in scripts/ inside the repo; the repo root is the app.
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold "Tesseract Lite installer"
info "host        : $BIND_HOST"
info "port        : $PORT"
info "install dir : $APP_DIR"
info "service user: $APP_USER"

# ---------------------------------------------------------------- packages
bold "1/9  System packages"
export DEBIAN_FRONTEND=noninteractive
# `|| true`: this host carries unrelated third-party apt repos (pgdg, yarn)
# that can fail here; apt-get update exits nonzero on any repo failure even
# when the archives we actually need succeeded.
apt-get update -qq || true
# build-essential and python3 are required — better-sqlite3 compiles a native
# module and fails without a C++ toolchain.
apt-get install -y -qq curl ca-certificates gnupg git build-essential python3 openssl
info "installed"

# -------------------------------------------------------------------- node
bold "2/9  Node.js $NODE_MAJOR"
if command -v node >/dev/null 2>&1 && \
   [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
  info "already present: $(node --version)"
else
  # Installed from the official nodejs.org tarball rather than apt/nodesource:
  # hosts with broken third-party apt repos make nodesource's setup script
  # silently no-op (it exits 0 even when its internal `apt update` fails),
  # leaving whatever Node major was already installed in place.
  NODE_DIST_DIR="/usr/local/lib/nodejs"
  NODE_VERSION="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
    | grep -o "node-v${NODE_MAJOR}\.[0-9]*\.[0-9]*-linux-x64" | head -1 | sed 's/-linux-x64//')"
  [ -n "$NODE_VERSION" ] || die "could not determine latest Node $NODE_MAJOR release"
  TARBALL="${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${TARBALL}" -o "/tmp/${TARBALL}"
  mkdir -p "$NODE_DIST_DIR"
  tar -xJf "/tmp/${TARBALL}" -C "$NODE_DIST_DIR"
  rm -f "/tmp/${TARBALL}"
  for bin in node npm npx corepack; do
    ln -sf "$NODE_DIST_DIR/${NODE_VERSION}-linux-x64/bin/$bin" "/usr/local/bin/$bin"
  done
  hash -r
  info "installed $(node --version)"
fi
NODE_BIN="$(command -v node)"

# ------------------------------------------------------------ service user
bold "3/9  Service account"
if id "$APP_USER" >/dev/null 2>&1; then
  info "$APP_USER already exists"
else
  useradd --system --create-home --home-dir "$(dirname "$APP_DIR")" \
          --shell /usr/sbin/nologin "$APP_USER"
  info "created $APP_USER"
fi

# ------------------------------------------------------------- application
bold "4/9  Application files"
mkdir -p "$APP_DIR"
if [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  # Copy the checkout into place, leaving build output and secrets behind.
  tar -C "$SOURCE_DIR" \
      --exclude=node_modules --exclude=.next --exclude=data \
      --exclude=.git --exclude='.env.local' --exclude=certs \
      -cf - . | tar -C "$APP_DIR" -xf -
  info "copied from $SOURCE_DIR"
else
  info "already in place"
fi
mkdir -p "$APP_DIR/data" "$CERT_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --------------------------------------------------------------- tls certs
bold "5/9  TLS certificate"
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  info "already present — leaving it alone"
else
  # A public CA cannot issue for a private address, so this is self-signed.
  # The SAN must carry the IP or browsers reject it outright.
  SAN="IP:$BIND_HOST"
  if [[ ! "$BIND_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN="DNS:$BIND_HOST"
  fi
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -subj "/CN=$BIND_HOST/O=CubeSmart/OU=Tesseract" \
    -addext "subjectAltName=$SAN" \
    -addext "basicConstraints=CA:FALSE" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  info "generated a self-signed certificate for $SAN (valid 825 days)"
  warn "Browsers will warn on first visit. Distribute $CERT_FILE to clients,"
  warn "or replace both files with a certificate from your internal CA."
fi
chown "$APP_USER:$APP_USER" "$CERT_FILE" "$KEY_FILE"
chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"

# ---------------------------------------------------------------- env file
bold "6/9  Configuration"
if [ -f "$ENV_FILE" ]; then
  info ".env.local already exists — not touching it"
else
  cat > "$ENV_FILE" <<EOF
# Written by install-ubuntu.sh on $(date -Iseconds)

# REQUIRED — the app cannot answer anything until this is set.
ANTHROPIC_API_KEY=

AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
APP_URL=https://$BIND_HOST:$PORT
PORT=$PORT
HOSTNAME=0.0.0.0

TLS_CERT_PATH=$CERT_FILE
TLS_KEY_PATH=$KEY_FILE

# Optional — see .env.example for the rest.
# OPENAI_API_KEY=
# GITHUB_TOKEN=
# PGVECTOR_URL=postgresql://tesseract:PASSWORD@localhost:5432/tesseract
EOF
  info "wrote $ENV_FILE with a generated AUTH_SECRET"
  warn "ANTHROPIC_API_KEY is empty — add it before anyone signs in."
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------- build
bold "7/9  Install dependencies and build"
info "this takes a few minutes"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --no-audit --no-fund" >/dev/null

# better-sqlite3 ships prebuilt binaries for every platform bundled directly
# inside its npm package (there's no install-time fetch to intercept), and
# its loader (lib/binding.js) always prefers the bundled one over anything
# built locally. On hosts with glibc older than 2.33 (e.g. Ubuntu 20.04's
# 2.31) that bundled binary fails to load, so compile one locally and
# delete the bundled prebuild to force the loader to fall back to it.
CXX_BIN=g++
if ! g++ -std=c++20 -x c++ -c /dev/null -o /dev/null 2>/dev/null; then
  # better-sqlite3's source needs C++20; older g++ (e.g. Ubuntu 20.04's 9.x)
  # doesn't recognize the flag, so bring in a newer compiler just for this.
  apt-get install -y -qq g++-10
  CXX_BIN=g++-10
fi
BETTER_SQLITE3_DIR="$APP_DIR/node_modules/better-sqlite3"
sudo -u "$APP_USER" bash -lc \
  "rm -rf '$BETTER_SQLITE3_DIR/build' && cd '$BETTER_SQLITE3_DIR' && CXX=$CXX_BIN npm run build-release" >/dev/null
sudo -u "$APP_USER" bash -lc "rm -f '$BETTER_SQLITE3_DIR/prebuilds/linux-x64.node'"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && node -e \"require('better-sqlite3')(':memory:')\"" \
  || die "better-sqlite3 failed to load even after a local rebuild"

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run build" >/dev/null
info "built"

# -------------------------------------------------------------------- seed
bold "8/9  Accounts"
if [ -f "$APP_DIR/data/tesseract.db" ] && \
   sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && node -e \"
     const D=require('better-sqlite3');
     try { console.log(D('data/tesseract.db').prepare('SELECT COUNT(*) c FROM users').get().c) }
     catch { console.log(0) }\"" | grep -qv '^0$'; then
  info "accounts already exist — skipping the seed"
  info "run 'sudo -u $APP_USER npm run seed' in $APP_DIR to add missing ones"
else
  sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run seed"
fi

# ----------------------------------------------------------------- systemd
bold "9/9  systemd service"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Tesseract Lite
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server.mjs
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
info "service registered and started"

# Ports above 1024 need no privileges, so the app binds directly.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  info "opened $PORT/tcp in ufw"
fi

sleep 4
bold "Result"
if systemctl is-active --quiet "$SERVICE"; then
  printf '  \033[32m✓ running at https://%s:%s\033[0m\n' "$BIND_HOST" "$PORT"
else
  printf '  \033[31m✗ service did not start\033[0m\n'
  info "journalctl -u $SERVICE -n 40 --no-pager"
  exit 1
fi

if ! grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE"; then
  warn "Still to do: add ANTHROPIC_API_KEY to $ENV_FILE, then"
  warn "  sudo systemctl restart $SERVICE"
fi
info "Logs: journalctl -u $SERVICE -f"
