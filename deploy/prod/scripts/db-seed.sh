#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/db-seed.sh · 种子数据（以 libiaolink_migrator 身份；幂等，可重跑）
# ------------------------------------------------------------
# 前置：迁移已执行（表结构存在）。种子与迁移分界见 database/seeds/README.md。
# 用法：
#   bash scripts/db-seed.sh                  # 全部常驻种子（roles / role-permissions / dicts / blueprint / task-nodes / task-templates）
#   bash scripts/db-seed.sh --dry-run        # 只打印变更摘要（全部回滚）
#   bash scripts/db-seed.sh --only=roles     # 只跑指定种子
# 可选慢网换源：
#   NPM_REGISTRY=https://registry.npmmirror.com bash scripts/db-seed.sh
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

exec node scripts/seed.mjs "$@"
' sh "$@"