#!/usr/bin/env sh
set -eu

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/cloudshelf-${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"
tar -czf "${TARGET}" -C "${DATA_DIR}" .

echo "Backup written to ${TARGET}"
