#!/usr/bin/env bash
# CockroachDB SQL dump backup for Visa Compass (small-footprint fallback to
# streaming BACKUP). Prefer `BACKUP INTO` for production scale.
#
# Usage:  DB_URL='postgresql://user:pass@host:port/dbname?sslmode=disable' \
#           ./scripts/db-backup.sh [backup-dir] [retention]
set -euo pipefail

: "${DB_URL:?Set DB_URL to the CockroachDB connection string}"
BACKUP_DIR="${1:-./db-backups}"
RETENTION="${2:-14}"

command -v cockroach >/dev/null 2>&1 || { echo "cockroach not found on PATH" >&2; exit 1; }

# postgresql://user[:pass]@host[:port]/dbname[?opts]
without_scheme="${DB_URL#*://}"
credentials="${without_scheme%%@*}"
hostport="${without_scheme#*@}"
hostport="${hostport%%/*}"
host="${hostport%%:*}"
PORT="${hostport##*:}"
[ "$PORT" = "$host" ] && PORT=26257        # no explicit port
user="${credentials%%:*}"
DB="${without_scheme#*@}"
DB="${DB#*/}"
DB="${DB%%\?*}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/visa_compass_$STAMP.sql"

echo "Dumping database '$DB' from $host:$PORT as '$user' -> $OUT"
cockroach dump "$DB" --host "$host" --port "$PORT" --user "$user" --insecure --file "$OUT"

if [ ! -s "$OUT" ]; then
  echo "Backup file is empty; aborting. No rotation performed." >&2
  exit 1
fi

echo "Backup complete: $(wc -c < "$OUT") bytes"

total=$(ls -1 "$BACKUP_DIR"/visa_compass_*.sql 2>/dev/null | wc -l)
if [ "$total" -gt "$RETENTION" ]; then
  ls -1 "$BACKUP_DIR"/visa_compass_*.sql | sort | head -n "$((total - RETENTION))" | while read -r old; do
    echo "Removing old backup $old"
    rm -f "$old"
  done
fi

echo "Done. Keeping up to $RETENTION backups."