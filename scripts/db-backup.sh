#!/usr/bin/env bash
# PostgreSQL custom-format backup for Supabase, AWS RDS, or standard PostgreSQL.
# Usage: DIRECT_DATABASE_URL='postgresql://...' ./scripts/db-backup.sh [dir] [retention]
set -euo pipefail

: "${DIRECT_DATABASE_URL:?Set DIRECT_DATABASE_URL to the direct PostgreSQL connection string}"
BACKUP_DIR="${1:-./db-backups}"
RETENTION="${2:-14}"
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump not found on PATH" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/visa_compass_$STAMP.dump"
echo "Creating PostgreSQL backup -> $OUT"
pg_dump --format=custom --verbose --no-owner --no-acl --schema=visa_compass \
  --file="$OUT" "$DIRECT_DATABASE_URL"

if [ ! -s "$OUT" ]; then
  echo "Backup file is empty; aborting. No rotation performed." >&2
  exit 1
fi
echo "Backup complete: $(wc -c < "$OUT") bytes"

total=$(find "$BACKUP_DIR" -maxdepth 1 -name 'visa_compass_*.dump' -type f | wc -l)
if [ "$total" -gt "$RETENTION" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'visa_compass_*.dump' -type f -printf '%T@ %p\n' \
    | sort -rn | tail -n "+$((RETENTION + 1))" | cut -d' ' -f2- \
    | while read -r old; do echo "Removing old backup $old"; rm -f -- "$old"; done
fi
echo "Done. Keeping up to $RETENTION backups."
