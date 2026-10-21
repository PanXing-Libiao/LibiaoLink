#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/storage.sh · 对象存储（MinIO）初始化 / 只读校验 / 真机回放
# ------------------------------------------------------------
# 口径来源：server/scripts/storage-init.mjs（幂等 + --check 门禁）、storage-it.mjs（24 项断言）。
# 依赖：minio 容器健康；secrets/s3_access_key、secrets/s3_secret_key 已生成；
#       server.env 的 S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_CORS_ORIGINS / S3_ABORT_INCOMPLETE_DAYS 已回填。
#       注：server 的 loadEnv 校验要求 DATABASE_URL 存在（storage 脚本不访问数据库）——本脚本按应用角色自动注入。
# 用法：
#   bash scripts/storage.sh init            # 建桶 + 版本控制 + 分片清理（幂等）
#   bash scripts/storage.sh init --check    # 只读门禁（部署验收）
#   bash scripts/storage.sh it              # 真机回放（24 项断言）
# ============================================================
set -euo pipefail

PROD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROD_DIR"

case "${1:-}" in
  init) INNER='cd /opt/libiaolink/server && exec node scripts/storage-init.mjs "$@"' ;;
  it)   INNER='cd /opt/libiaolink/server && exec node scripts/storage-it.mjs "$@"' ;;
  *) echo "用法：bash scripts/storage.sh init [--check] | bash scripts/storage.sh it" >&2; exit 2 ;;
esac

S3_ENDPOINT="$(grep -E '^S3_ENDPOINT=' server.env | head -n1 | cut -d= -f2-)"
S3_REGION="$(grep -E '^S3_REGION=' server.env | head -n1 | cut -d= -f2-)"
S3_BUCKET="$(grep -E '^S3_BUCKET=' server.env | head -n1 | cut -d= -f2-)"
S3_CORS_ORIGINS="$(grep -E '^S3_CORS_ORIGINS=' server.env | head -n1 | cut -d= -f2-)"
S3_ABORT_INCOMPLETE_DAYS="$(grep -E '^S3_ABORT_INCOMPLETE_DAYS=' server.env | head -n1 | cut -d= -f2-)"

# env 校验前置：DATABASE_URL 必须存在（值只需可解析；口径与 service-entrypoint.cjs 一致）
DATABASE_URL="postgres://libiaolink_api:$(cat secrets/pg_api_password)@postgres:5432/${PG_DB:-libiaolink}"

docker compose --profile tools run --rm \
  -e S3_ENDPOINT="$S3_ENDPOINT" \
  -e S3_REGION="$S3_REGION" \
  -e S3_BUCKET="$S3_BUCKET" \
  -e S3_CORS_ORIGINS="$S3_CORS_ORIGINS" \
  -e S3_ABORT_INCOMPLETE_DAYS="$S3_ABORT_INCOMPLETE_DAYS" \
  -e S3_ACCESS_KEY="$(cat secrets/s3_access_key)" \
  -e S3_SECRET_KEY="$(cat secrets/s3_secret_key)" \
  -e DATABASE_URL="$DATABASE_URL" \
  tools -c "$INNER" sh "${@:2}"
