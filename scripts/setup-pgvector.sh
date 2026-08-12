#!/usr/bin/env bash
#
# Sets up a dedicated "tesseract" role + database with the pgvector
# extension on an existing local PostgreSQL install, and points the app at
# it via PGVECTOR_URL.
#
#   sudo ./scripts/setup-pgvector.sh
#
# Requires PostgreSQL already installed and running locally — see
# "Optional: PostgreSQL + pgvector" in UBUNTU-SETUP.md for installing it and
# the PGDG apt repo first. Safe to re-run: skips whatever already exists and
# never touches an existing PGVECTOR_URL.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tesseract/app}"
ENV_FILE="$APP_DIR/.env.local"
DB_NAME="${PGVECTOR_DB:-tesseract}"
DB_USER="${PGVECTOR_USER:-tesseract}"
DB_HOST="${PGVECTOR_HOST:-localhost}"
DB_PORT="${PGVECTOR_PORT:-5432}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
command -v psql >/dev/null 2>&1 || \
  die "PostgreSQL is not installed. See 'Optional: PostgreSQL + pgvector' in UBUNTU-SETUP.md."

bold "1/4  PostgreSQL version"
PG_MAJOR="$(pg_lsclusters 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {print $1; exit}')"
[ -n "$PG_MAJOR" ] || die "Could not detect a running PostgreSQL cluster (pg_lsclusters found nothing)."
info "PostgreSQL $PG_MAJOR"

bold "2/4  pgvector extension package"
export DEBIAN_FRONTEND=noninteractive
if ! apt-cache show "postgresql-${PG_MAJOR}-pgvector" >/dev/null 2>&1; then
  apt-get update -qq || true
fi
if ! apt-cache show "postgresql-${PG_MAJOR}-pgvector" >/dev/null 2>&1; then
  # PGDG's live repo (apt.postgresql.org) has stopped serving some older
  # Ubuntu releases entirely (focal returns a plain 404 as of 2026) while
  # still keeping everything at the archive mirror. Point there and retry
  # once before giving up.
  PGDG_LIST="$(ls /etc/apt/sources.list.d/*pgdg* 2>/dev/null | head -1 || true)"
  if [ -n "$PGDG_LIST" ] && grep -q '://apt\.postgresql\.org/' "$PGDG_LIST" 2>/dev/null; then
    warn "postgresql-${PG_MAJOR}-pgvector not found on apt.postgresql.org — trying the archive mirror"
    sed -i \
      -e 's|http://apt\.postgresql\.org/pub/repos/apt/|https://apt-archive.postgresql.org/pub/repos/apt/|' \
      -e 's|https://apt\.postgresql\.org/pub/repos/apt/|https://apt-archive.postgresql.org/pub/repos/apt/|' \
      "$PGDG_LIST"
    apt-get update -qq
  fi
fi
apt-cache show "postgresql-${PG_MAJOR}-pgvector" >/dev/null 2>&1 || \
  die "postgresql-${PG_MAJOR}-pgvector is not available. Install the PGDG apt repo first — see UBUNTU-SETUP.md."
apt-get install -y -qq "postgresql-${PG_MAJOR}-pgvector"
info "installed"

bold "3/4  Role, database, extension"
DB_PASS=""
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  info "role \"$DB_USER\" already exists — leaving its password alone"
else
  DB_PASS="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';" >/dev/null
  info "created role \"$DB_USER\""
fi
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  info "database \"$DB_NAME\" already exists"
else
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" >/dev/null
  info "created database \"$DB_NAME\""
fi
sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
info "vector extension enabled"

bold "4/4  Point the app at it"
if [ -z "$DB_PASS" ]; then
  warn "Role \"$DB_USER\" already existed, so no new password was generated."
  warn "Set PGVECTOR_URL in $ENV_FILE yourself with its existing password, then restart."
else
  URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  if [ ! -f "$ENV_FILE" ]; then
    info "No $ENV_FILE yet — add this line to it once it exists:"
    info "  PGVECTOR_URL=${URL}"
  elif grep -q '^PGVECTOR_URL=.\+' "$ENV_FILE"; then
    warn "$ENV_FILE already has a PGVECTOR_URL set — leaving it alone."
    info "New connection string, if you want it instead: $URL"
  else
    if grep -q '^# PGVECTOR_URL=' "$ENV_FILE"; then
      sed -i "s|^# PGVECTOR_URL=.*|PGVECTOR_URL=${URL}|" "$ENV_FILE"
    else
      printf '\nPGVECTOR_URL=%s\n' "$URL" >> "$ENV_FILE"
    fi
    info "set PGVECTOR_URL in $ENV_FILE"
    warn "Restart for it to take effect: sudo systemctl restart tesseract"
    warn "Anything already indexed under sqlite-vec stays there until you re-sync each facet."
  fi
fi
