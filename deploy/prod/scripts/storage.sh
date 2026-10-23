#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/storage.sh · 对象存储（MinIO）初始化 / 只读校验 / 真机回放
# ------------------------------------------------------------
# F-02 S4 凭据边界：
#   - init / init --check 只读 secrets/s3_bootstrap_*；it 只读 secrets/s3_*；
#   - Secret 经一次性 600 env-file 传入 tools，不进入 docker compose / node 命令行参数；
#   - 文件必须存在、非空、权限 600，且凭据成对；缺失或格式异常直接退出；
#   - DATABASE_URL 仅为满足 server loadEnv 的非敏感占位值，storage 脚本不访问数据库。
# ============================================================
set -Eeuo pipefail
umask 077

PROD_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$PROD_DIR"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  init)
    CREDENTIAL_PREFIX="s3_bootstrap"
    INNER='cd /opt/libiaolink/server && exec node scripts/storage-init.mjs "$@"'
    ;;
  it)
    CREDENTIAL_PREFIX="s3"
    INNER='cd /opt/libiaolink/server && exec node scripts/storage-it.mjs "$@"'
    ;;
  *)
    echo "用法：bash scripts/storage.sh init [--check] | bash scripts/storage.sh it" >&2
    exit 2
    ;;
esac
shift

read_server_env() {
  local key="$1" value
  value="$(grep -m1 -E "^${key}=" server.env | cut -d= -f2-)" || true
  [[ -n "$value" ]] || die "server.env 缺少 ${key}"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "server.env 的 ${key} 不能包含换行"
  printf '%s' "$value"
}

read_credential() {
  local file="$1" label="$2" value mode
  [[ -f "$file" && ! -L "$file" ]] || die "缺少普通 Secret 文件：${file}"
  mode="$(stat -c '%a' "$file" 2>/dev/null)" || die "无法读取 Secret 权限：${file}"
  [[ "$mode" == "600" ]] || die "${file} 权限必须为 600（当前 ${mode}）"
  value="$(<"$file")"
  [[ -n "$value" ]] || die "Secret 文件为空：${file}"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "${label} 不能包含换行"
  [[ "$value" =~ ^[A-Za-z0-9+/=._~-]+$ ]] || die "${label} 含不支持的字符"
  printf '%s' "$value"
}

S3_ENDPOINT="$(read_server_env S3_ENDPOINT)"
S3_REGION="$(read_server_env S3_REGION)"
S3_BUCKET="$(read_server_env S3_BUCKET)"
S3_CORS_ORIGINS="$(read_server_env S3_CORS_ORIGINS)"
S3_ABORT_INCOMPLETE_DAYS="$(read_server_env S3_ABORT_INCOMPLETE_DAYS)"

ACCESS_KEY="$(read_credential "secrets/${CREDENTIAL_PREFIX}_access_key" "${CREDENTIAL_PREFIX}_access_key")"
SECRET_KEY="$(read_credential "secrets/${CREDENTIAL_PREFIX}_secret_key" "${CREDENTIAL_PREFIX}_secret_key")"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/libiaolink-storage.XXXXXX")"
ENV_FILE="$TMP_DIR/storage.env"
cleanup() {
  rm -f -- "$ENV_FILE"
  rmdir -- "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

chmod 700 "$TMP_DIR"
(
  umask 077
  printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\nDATABASE_URL=postgres://libiaolink_api@postgres:5432/libiaolink\n' \
    "$ACCESS_KEY" "$SECRET_KEY" > "$ENV_FILE"
)
chmod 600 "$ENV_FILE"
unset ACCESS_KEY SECRET_KEY

docker compose --profile tools run --rm \
  --env-from-file "$ENV_FILE" \
  -e S3_ENDPOINT="$S3_ENDPOINT" \
  -e S3_REGION="$S3_REGION" \
  -e S3_BUCKET="$S3_BUCKET" \
  -e S3_CORS_ORIGINS="$S3_CORS_ORIGINS" \
  -e S3_ABORT_INCOMPLETE_DAYS="$S3_ABORT_INCOMPLETE_DAYS" \
  tools -c "$INNER" sh "$@"
