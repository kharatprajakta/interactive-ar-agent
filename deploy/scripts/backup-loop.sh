#!/bin/sh
# Runs in the db-backup container: dump the database every BACKUP_INTERVAL_HOURS
# into /backups (a host folder), and delete dumps older than BACKUP_KEEP_DAYS.
# Restore: see docs/DEPLOYMENT.md ("Backups and restore").
# Copyright (c) 2026 PacificAI. All rights reserved.
set -eu
interval_hours="${BACKUP_INTERVAL_HOURS:-24}"
keep_days="${BACKUP_KEEP_DAYS:-14}"

while true; do
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  file="/backups/hellocrew-${stamp}.dump"
  if pg_dump --format=custom --no-owner --file="${file}.part" && mv "${file}.part" "$file"; then
    echo "[backup] wrote $file ($(du -h "$file" | cut -f1))"
  else
    echo "[backup] FAILED at ${stamp}" >&2
    rm -f "${file}.part"
  fi
  find /backups -name 'hellocrew-*.dump' -type f -mtime +"$keep_days" -print -delete | sed 's/^/[backup] pruned /'
  sleep "$((interval_hours * 3600))"
done
