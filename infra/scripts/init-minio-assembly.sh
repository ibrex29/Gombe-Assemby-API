#!/bin/sh
set -e

ENDPOINT="${S3_ENDPOINT:-http://electromon-pantamiyya-minio:9000}"
echo "Initializing MinIO bucket: ${S3_BUCKET} at ${ENDPOINT}"

mc alias set local "${ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb "local/${S3_BUCKET}" --ignore-existing
mc anonymous set download "local/${S3_BUCKET}/public" 2>/dev/null || true

echo "MinIO bucket '${S3_BUCKET}' ready."
