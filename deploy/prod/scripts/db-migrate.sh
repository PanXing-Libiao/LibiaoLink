#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/db-migrate.sh · 数据库迁移（以 libiaolink_migrator 身份）
# ------------------------------------------------------------
# 迁移必须由 libiaolink_migrator 执行（建表者决定默认权限归属；见 database/README.md）。
# 依赖：postgres 容器健康（compose 自动等待）；首次运行会在命名卷里装 pg 依赖。
# 用法：
#   bash scripts/db-migrate.sh              # 执行全部待执行迁移（当前 0001~0053）
#   bash scripts/db-migrate.sh --dry-run    # 只列出待执行，不改库
# 可选慢网换源：
#   NPM_REGISTRY=https://registry.npmmirror.com bash scripts/db-migrate.sh
# ============================================================
set -euo pipefail

PROD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROD_DIR"

docker compose --profile tools run --rm -e NPM_REGISTRY="${NPM_REGISTRY:-}" tools -c '
set -e
cd /opt/libiaolink/database
export PGUSER=libiaolink_migrator
export PGPASSWORD="$(cat /opt/libiaolink/secrets/pg_migrator_password)"

if [ ! -d node_modules/pg ]; then
  echo "== 首次：安装迁移器依赖（pg 包）"
  if [ -n "${NPM_REGISTRY:-}" ]; then
    npm ci --omit=dev --no-audit --no-fund --registry="${NPM_REGISTRY}"
  else
    npm ci --omit=dev --no-audit --no-fund
  fi
fi

exec node scripts/migrate.mjs "$@"
' sh "$@"