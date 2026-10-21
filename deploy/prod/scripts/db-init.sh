#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/db-init.sh · 应用数据库角色基线 + 注入角色密码
# ------------------------------------------------------------
# 幂等：可重复执行（角色脚本幂等；alter role 每次按 secrets/ 现值重设）。
# 密码纪律（CONTRIBUTING §12）：密码只从 secrets/ 文件读，不写仓库、不写 .env。
# 依赖：postgres 容器已在运行（docker compose up -d）。
# ============================================================
set -euo pipefail

PROD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$PROD_DIR/../.." && pwd)"
ROLES_SQL="${ROLES_SQL:-$ROOT_DIR/database/roles/0001_roles.sql}"
DB="${PG_DB:-libiaolink}"

cd "$PROD_DIR"

if [ ! -f "$ROLES_SQL" ]; then
  echo "缺角色基线文件：$ROLES_SQL" >&2
  exit 1
fi

psql_exec() {
  docker compose exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"
}

echo "== 1/2 应用角色基线（幂等）：$ROLES_SQL"
psql_exec -f - < "$ROLES_SQL"

echo "== 2/2 注入角色密码（从 secrets/ 读取）"
for role in migrator api readonly; do
  pw_file="$PROD_DIR/secrets/pg_${role}_password"
  if [ ! -f "$pw_file" ]; then
    echo "缺密钥文件：$pw_file" >&2
    exit 1
  fi
  pw="$(< "$pw_file")"
  if [ -z "$pw" ]; then
    echo "密钥文件为空：$pw_file" >&2
    exit 1
  fi
  psql_exec -c "alter role libiaolink_${role} password '${pw}';"
  echo "  - libiaolink_${role}：密码已注入"
done

echo "完成（可重复执行）。"
