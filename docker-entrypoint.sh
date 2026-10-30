#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-100}
DATA_DIR=${DATA_DIR:-/app/data}

# If running as root, fix permissions on data directory and drop privileges to PUID:PGID
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  chmod -R 775 "$DATA_DIR" 2>/dev/null || true
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"

