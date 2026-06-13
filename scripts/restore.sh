#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "Usage: scripts/restore.sh <backup.tar.gz>" >&2
  exit 1
fi

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_FILE="$1"

mkdir -p "${DATA_DIR}"
tar -xzf "${BACKUP_FILE}" -C "${DATA_DIR}"

echo "Restored ${BACKUP_FILE} into ${DATA_DIR}"
