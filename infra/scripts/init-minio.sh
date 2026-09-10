#!/bin/sh
set -e

echo "Initializing MinIO bucket: ${S3_BUCKET}"

mc alias set local http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb "local/${S3_BUCKET}" --ignore-existing
mc anonymous set download "local/${S3_BUCKET}/public" 2>/dev/null || true

echo "MinIO bucket '${S3_BUCKET}' ready."
