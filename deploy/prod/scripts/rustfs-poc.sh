#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/rustfs-poc.sh · RustFS 1.0.3 隔离 POC
# ------------------------------------------------------------
# 边界：
#   - 只管理 rustfs-poc / rustfs-poc-web 两个 POC 容器；
#   - 不启动或重建 minio / api / worker / web，不改 443 门面；
#   - 数据 / 日志 / Secret / service account 全部使用 rustfs_poc 前缀；
#   - 测试机 POC 代理只发布到 127.0.0.1:9445，入口走 SSH 隧道。
#
# 用法（root）：
#   bash scripts/rustfs-poc.sh prepare
#   bash scripts/rustfs-poc.sh up
#   bash scripts/rustfs-poc.sh apply
#   bash scripts/rustfs-poc.sh check
#   bash scripts/rustfs-poc.sh it
#   bash scripts/rustfs-poc.sh down
#   RUSTFS_POC_CONFIRM=PURGE_RUSTFS_POC bash scripts/rustfs-poc.sh purge
#
# 可选环境变量：
#   RUSTFS_POC_DATA_DIR / RUSTFS_POC_LOG_DIR / RUSTFS_POC_PORT
#   RUSTFS_POC_CORS_ALLOWED_ORIGINS
#   RUSTFS_POC_RC_IMAGE / RUSTFS_POC_STORAGE_ENDPOINT
# ============================================================
set -Eeuo pipefail
umask 077

PROD_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$PROD_DIR"

RUSTFS_POC_RC_IMAGE="${RUSTFS_POC_RC_IMAGE:-rustfs/rc@sha256:ab024bfebee49a750ce886b4c70963ccd9ddaa03f491704a90710641d7a26699}"
RUSTFS_POC_CONTAINER="${RUSTFS_POC_CONTAINER:-libiaolink-rustfs-poc}"
RUSTFS_POC_DATA_DIR="${RUSTFS_POC_DATA_DIR:-/srv/data/rustfs-poc}"
RUSTFS_POC_LOG_DIR="${RUSTFS_POC_LOG_DIR:-/srv/data/rustfs-poc-logs}"
RUSTFS_POC_PORT="${RUSTFS_POC_PORT:-9445}"
RUSTFS_POC_CORS_ALLOWED_ORIGINS="${RUSTFS_POC_CORS_ALLOWED_ORIGINS:-http://127.0.0.1:${RUSTFS_POC_PORT}}"
RUSTFS_POC_BUCKET="rustfs-poc"
RUSTFS_POC_STORAGE_ENDPOINT="${RUSTFS_POC_STORAGE_ENDPOINT:-http://rustfs-poc-web}"
S3_REGION="${RUSTFS_POC_REGION:-us-east-1}"
S3_ABORT_INCOMPLETE_DAYS="${RUSTFS_POC_ABORT_INCOMPLETE_DAYS:-30}"

export RUSTFS_POC_DATA_DIR RUSTFS_POC_LOG_DIR RUSTFS_POC_PORT
export RUSTFS_POC_CORS_ALLOWED_ORIGINS

SECRETS_DIR="$PROD_DIR/secrets"
POLICIES_DIR="$PROD_DIR/rustfs-poc/policies"
APP_NAME="libiaolink-poc-app"
BOOTSTRAP_NAME="libiaolink-poc-bootstrap"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '✓ %s\n' "$*"; }

compose() {
  docker compose -f docker-compose.yml -f docker-compose.rustfs-poc.yml "$@"
}

require_root() {
  [[ "$(id -u)" == "0" ]] || die "该动作需要 root（数据目录需归属 10001:10001，Secret 需 600）"
}

require_commands() {
  local name
  for name in docker install openssl stat mktemp; do
    command -v "$name" >/dev/null 2>&1 || die "缺少命令：$name"
  done
}

validate_secret_file() {
  local file="$1" label="$2" value mode
  [[ -f "$file" && ! -L "$file" ]] || die "缺少普通 Secret 文件：$file"
  mode="$(stat -c '%a' "$file" 2>/dev/null)" || die "无法读取 Secret 权限：$file"
  [[ "$mode" == "600" ]] || die "$file 权限必须为 600（当前 $mode）"
  value="$(<"$file")"
  [[ -n "$value" ]] || die "Secret 文件为空：$file"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label 不能包含换行"
  [[ "$value" =~ ^[A-Za-z0-9+/=._~-]+$ ]] || die "$label 含不支持的字符"
}

read_secret_file() {
  local file="$1" label="$2" value
  validate_secret_file "$file" "$label"
  value="$(<"$file")"
  printf '%s' "$value"
}

write_new_secret() {
  local file="$1" value="$2" tmp
  [[ ! -e "$file" ]] || die "拒绝覆盖已有 Secret：$file"
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  printf '%s' "$value" > "$tmp"
  chmod 600 "$tmp"
  mv -- "$tmp" "$file"
}

ensure_secret() {
  local file="$1" label="$2" kind="$3" value
  if [[ -e "$file" ]]; then
    validate_secret_file "$file" "$label"
    return
  fi
  case "$kind" in
    access)
      value="$(openssl rand -hex 8)"
      value="${label:0:4}${value:0:16}"
      ;;
    secret)
      value="$(openssl rand -hex 20)"
      ;;
    *)
      die "未知 Secret 类型：$kind"
      ;;
  esac
  write_new_secret "$file" "$value"
  note "已生成 $label → $file"
}

ensure_root_secrets() {
  install -d -m 0700 "$SECRETS_DIR"
  ensure_secret "$SECRETS_DIR/rustfs_poc_root_access_key" "LIBIAOLINKPOCROOT" access
  ensure_secret "$SECRETS_DIR/rustfs_poc_root_secret_key" "rustfs_poc_root_secret_key" secret
  chown 10001:10001 "$SECRETS_DIR/rustfs_poc_root_access_key" "$SECRETS_DIR/rustfs_poc_root_secret_key"
  chmod 600 "$SECRETS_DIR/rustfs_poc_root_access_key" "$SECRETS_DIR/rustfs_poc_root_secret_key"
}

ensure_service_secrets() {
  install -d -m 0700 "$SECRETS_DIR"
  ensure_secret "$SECRETS_DIR/rustfs_poc_app_access_key" "LIBPOCAPP" access
  ensure_secret "$SECRETS_DIR/rustfs_poc_app_secret_key" "rustfs_poc_app_secret_key" secret
  ensure_secret "$SECRETS_DIR/rustfs_poc_bootstrap_access_key" "LIBPOCBOOT" access
  ensure_secret "$SECRETS_DIR/rustfs_poc_bootstrap_secret_key" "rustfs_poc_bootstrap_secret_key" secret
  chown 10001:10001 "$SECRETS_DIR"/rustfs_poc_*
  chmod 600 "$SECRETS_DIR"/rustfs_poc_*
}

prepare() {
  require_root
  require_commands
  [[ "$RUSTFS_POC_DATA_DIR" == /* ]] || die "RUSTFS_POC_DATA_DIR 必须是绝对路径"
  [[ "$RUSTFS_POC_LOG_DIR" == /* ]] || die "RUSTFS_POC_LOG_DIR 必须是绝对路径"
  [[ "$RUSTFS_POC_DATA_DIR" != "/" && "$RUSTFS_POC_LOG_DIR" != "/" ]] || die "拒绝使用根目录作为 POC 数据目录"
  [[ ! -L "$RUSTFS_POC_DATA_DIR" && ! -L "$RUSTFS_POC_LOG_DIR" ]] || die "POC 数据 / 日志目录不得是符号链接"

  install -d -m 0700 "$RUSTFS_POC_DATA_DIR" "$RUSTFS_POC_LOG_DIR"
  chown 10001:10001 "$RUSTFS_POC_DATA_DIR" "$RUSTFS_POC_LOG_DIR"
  chmod 700 "$RUSTFS_POC_DATA_DIR" "$RUSTFS_POC_LOG_DIR"
  install -d -m 0700 "$SECRETS_DIR"
  note "POC 数据目录：$RUSTFS_POC_DATA_DIR（10001:10001 · 700）"
  note "POC 日志目录：$RUSTFS_POC_LOG_DIR（10001:10001 · 700）"
}

wait_healthy() {
  local container="$1" status="" attempt
  for ((attempt = 1; attempt <= 90; attempt++)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && { note "$container healthy"; return; }
    [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]] && break
    sleep 2
  done
  docker logs --tail 40 "$container" >&2 || true
  die "$container 未在 180 秒内 healthy（当前：${status:-不存在}）"
}

up() {
  prepare
  ensure_root_secrets
  compose --profile rustfs-poc up -d rustfs-poc rustfs-poc-web
  wait_healthy libiaolink-rustfs-poc
  wait_healthy libiaolink-rustfs-poc-web
  note "POC 已启动；本机回环入口 http://127.0.0.1:${RUSTFS_POC_PORT}"
}

rc_shell() {
  local script="$1"
  docker run --rm \
    --network "container:${RUSTFS_POC_CONTAINER}" \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 64 \
    --tmpfs /tmp:rw,noexec,nosuid,size=8m \
    --env HOME=/tmp/rc \
    --env "RUSTFS_POC_BUCKET=$RUSTFS_POC_BUCKET" \
    --volume "$SECRETS_DIR/rustfs_poc_root_access_key:/run/libiaolink-poc-secrets/rustfs_poc_root_access_key:ro" \
    --volume "$SECRETS_DIR/rustfs_poc_root_secret_key:/run/libiaolink-poc-secrets/rustfs_poc_root_secret_key:ro" \
    --volume "$SECRETS_DIR/rustfs_poc_app_access_key:/run/libiaolink-poc-secrets/rustfs_poc_app_access_key:ro" \
    --volume "$SECRETS_DIR/rustfs_poc_app_secret_key:/run/libiaolink-poc-secrets/rustfs_poc_app_secret_key:ro" \
    --volume "$SECRETS_DIR/rustfs_poc_bootstrap_access_key:/run/libiaolink-poc-secrets/rustfs_poc_bootstrap_access_key:ro" \
    --volume "$SECRETS_DIR/rustfs_poc_bootstrap_secret_key:/run/libiaolink-poc-secrets/rustfs_poc_bootstrap_secret_key:ro" \
    --volume "$POLICIES_DIR:/run/libiaolink-poc-policies:ro" \
    --entrypoint /bin/sh \
    "$RUSTFS_POC_RC_IMAGE" -c "$script"
}

apply_identity() {
  local script
  read -r -d '' script <<'EOS' || true
set -eu
export HOME=/tmp/rc
mkdir -p "$HOME"

ROOT_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_root_access_key)"
ROOT_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_root_secret_key)"
APP_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_app_access_key)"
APP_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_app_secret_key)"
BOOT_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_bootstrap_access_key)"
BOOT_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_bootstrap_secret_key)"

rc alias set poc http://127.0.0.1:9000 "$ROOT_ACCESS" "$ROOT_SECRET" >/dev/null

if rc admin service-account info poc "$APP_ACCESS" >/dev/null 2>&1; then
  rc admin service-account update poc "$APP_ACCESS" \
    --secret-key "$APP_SECRET" \
    --name libiaolink-poc-app \
    --description "LibiaoLink RustFS POC application" \
    --policy /run/libiaolink-poc-policies/app.json >/dev/null
else
  rc admin service-account create poc "$APP_ACCESS" "$APP_SECRET" \
    --name libiaolink-poc-app \
    --description "LibiaoLink RustFS POC application" \
    --policy /run/libiaolink-poc-policies/app.json >/dev/null
fi

if rc admin service-account info poc "$BOOT_ACCESS" >/dev/null 2>&1; then
  rc admin service-account update poc "$BOOT_ACCESS" \
    --secret-key "$BOOT_SECRET" \
    --name libiaolink-poc-bootstrap \
    --description "LibiaoLink RustFS POC bootstrap" \
    --policy /run/libiaolink-poc-policies/bootstrap.json >/dev/null
else
  rc admin service-account create poc "$BOOT_ACCESS" "$BOOT_SECRET" \
    --name libiaolink-poc-bootstrap \
    --description "LibiaoLink RustFS POC bootstrap" \
    --policy /run/libiaolink-poc-policies/bootstrap.json >/dev/null
fi
EOS
  rc_shell "$script"
  note "POC service account 已创建 / 更新：$APP_NAME、$BOOTSTRAP_NAME"
}

storage_run() {
  local action="$1"
  shift
  local prefix inner tmp_dir env_file access secret status
  case "$action" in
    init)
      prefix="rustfs_poc_bootstrap"
      inner='cd /opt/libiaolink/server && exec node scripts/storage-init.mjs "$@"'
      ;;
    it)
      prefix="rustfs_poc_app"
      inner='cd /opt/libiaolink/server && exec node scripts/storage-it.mjs "$@"'
      ;;
    *)
      die "未知 storage 动作：$action"
      ;;
  esac

  access="$(read_secret_file "$SECRETS_DIR/${prefix}_access_key" "${prefix}_access_key")"
  secret="$(read_secret_file "$SECRETS_DIR/${prefix}_secret_key" "${prefix}_secret_key")"

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/libiaolink-rustfs-poc.XXXXXX")"
  env_file="$tmp_dir/storage.env"
  chmod 700 "$tmp_dir"
  (
    umask 077
    printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\nDATABASE_URL=postgres://libiaolink_api@postgres:5432/libiaolink\n' \
      "$access" "$secret" > "$env_file"
  )
  chmod 600 "$env_file"
  unset access secret

  status=0
  compose --profile tools run --rm --no-deps \
    --env-from-file "$env_file" \
    -e S3_ENDPOINT="$RUSTFS_POC_STORAGE_ENDPOINT" \
    -e S3_REGION="$S3_REGION" \
    -e S3_BUCKET="$RUSTFS_POC_BUCKET" \
    -e S3_CORS_ORIGINS="$RUSTFS_POC_CORS_ALLOWED_ORIGINS" \
    -e S3_ABORT_INCOMPLETE_DAYS="$S3_ABORT_INCOMPLETE_DAYS" \
    tools -c "$inner" sh "$@" || status=$?
  rm -f -- "$env_file"
  rmdir -- "$tmp_dir" 2>/dev/null || true
  return "$status"
}

permission_check() {
  local script
  read -r -d '' script <<'EOS' || true
set -eu
export HOME=/tmp/rc
mkdir -p "$HOME"

ROOT_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_root_access_key)"
ROOT_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_root_secret_key)"
APP_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_app_access_key)"
APP_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_app_secret_key)"
BOOT_ACCESS="$(cat /run/libiaolink-poc-secrets/rustfs_poc_bootstrap_access_key)"
BOOT_SECRET="$(cat /run/libiaolink-poc-secrets/rustfs_poc_bootstrap_secret_key)"

rc alias set root http://127.0.0.1:9000 "$ROOT_ACCESS" "$ROOT_SECRET" >/dev/null
rc alias set app http://127.0.0.1:9000 "$APP_ACCESS" "$APP_SECRET" >/dev/null
rc alias set bootstrap http://127.0.0.1:9000 "$BOOT_ACCESS" "$BOOT_SECRET" >/dev/null

PROBE_BUCKET="rustfs-poc-deny-$(date +%s)"
PROBE_KEY="_rustfs-poc-permission-probe-$(date +%s)"
cleanup() {
  rc object remove "root/${RUSTFS_POC_BUCKET}/${PROBE_KEY}" --versions --force >/dev/null 2>&1 || true
}
trap cleanup EXIT

assert_denied() {
  local file="$1" label="$2"
  if ! grep -Eqi 'AccessDenied|Access Denied|Forbidden|status code:? 403|(^|[^0-9])403([^0-9]|$)' "$file"; then
    printf 'FAIL: %s 未显式返回 403 / AccessDenied\n' "$label" >&2
    cat "$file" >&2
    exit 1
  fi
  printf '  ✓ %s：403 / AccessDenied\n' "$label"
}

if rc bucket create "app/${PROBE_BUCKET}" >/tmp/app-create.log 2>&1; then
  rc bucket remove "root/${PROBE_BUCKET}" --force >/dev/null 2>&1 || true
  printf 'FAIL: 应用账号可以创建桶\n' >&2
  exit 1
fi
assert_denied /tmp/app-create.log "应用账号禁止创建桶"

if ! printf 'rustfs-poc-permission-probe\n' | rc pipe "app/${RUSTFS_POC_BUCKET}/${PROBE_KEY}" >/tmp/app-put.log 2>&1; then
  printf 'FAIL: 应用账号无法写入探针对象\n' >&2
  cat /tmp/app-put.log >&2
  exit 1
fi
printf '  ✓ 应用账号可写探针对象\n'

if rc object stat "bootstrap/${RUSTFS_POC_BUCKET}/${PROBE_KEY}" >/tmp/bootstrap-read.log 2>&1; then
  printf 'FAIL: bootstrap 账号可以读取对象\n' >&2
  exit 1
fi
assert_denied /tmp/bootstrap-read.log "bootstrap 账号禁止读取对象"
EOS
  rc_shell "$script"
}

check_ready() {
  local container status
  for container in "$RUSTFS_POC_CONTAINER" libiaolink-rustfs-poc-web; do
    status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "running" ]] || die "POC 容器未运行：$container；先执行 up"
  done
}

apply() {
  check_ready
  ensure_root_secrets
  ensure_service_secrets
  apply_identity
  storage_run init
  note "POC 初始化完成；下一步：bash scripts/rustfs-poc.sh check 与 it"
}

check() {
  check_ready
  validate_secret_file "$SECRETS_DIR/rustfs_poc_root_access_key" rustfs_poc_root_access_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_root_secret_key" rustfs_poc_root_secret_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_bootstrap_access_key" rustfs_poc_bootstrap_access_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_bootstrap_secret_key" rustfs_poc_bootstrap_secret_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_app_access_key" rustfs_poc_app_access_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_app_secret_key" rustfs_poc_app_secret_key
  storage_run init --check
  permission_check
  note "POC check 通过"
}

it() {
  check_ready
  validate_secret_file "$SECRETS_DIR/rustfs_poc_app_access_key" rustfs_poc_app_access_key
  validate_secret_file "$SECRETS_DIR/rustfs_poc_app_secret_key" rustfs_poc_app_secret_key
  storage_run it
  note "POC storage:it 通过"
}

down() {
  compose --profile rustfs-poc stop rustfs-poc-web rustfs-poc
  note "POC 已停止；数据目录保留：$RUSTFS_POC_DATA_DIR"
}

purge() {
  require_root
  [[ "${RUSTFS_POC_CONFIRM:-}" == "PURGE_RUSTFS_POC" ]] || die "需显式设置 RUSTFS_POC_CONFIRM=PURGE_RUSTFS_POC"
  [[ "$RUSTFS_POC_DATA_DIR" == /*/rustfs-poc ]] || die "拒绝清理非 */rustfs-poc 数据目录：$RUSTFS_POC_DATA_DIR"
  [[ "$RUSTFS_POC_LOG_DIR" == /*/rustfs-poc-logs ]] || die "拒绝清理非 */rustfs-poc-logs 日志目录：$RUSTFS_POC_LOG_DIR"
  compose --profile rustfs-poc rm -sf rustfs-poc-web rustfs-poc
  rm -rf -- "$RUSTFS_POC_DATA_DIR" "$RUSTFS_POC_LOG_DIR"
  rm -f -- "$SECRETS_DIR"/rustfs_poc_*
  note "POC 容器、数据、日志与 rustfs_poc_* Secret 已清理；MinIO 未改动"
}

case "${1:-}" in
  prepare) prepare ;;
  up) up ;;
  apply) apply ;;
  check) check ;;
  it) it ;;
  down) down ;;
  purge) purge ;;
  *)
    cat >&2 <<'EOS'
用法：bash scripts/rustfs-poc.sh <动作>
  prepare  创建独立数据 / 日志目录并设置 10001:10001 / 700
  up       生成缺失的 root Secret 并启动 POC 两个容器
  apply    创建 / 更新两个 service account，初始化桶
  check    storage:init --check + 应用 / bootstrap 权限负向探针
  it       用应用 service account 执行 storage:it
  down     停止 POC，保留数据
  purge    删除 POC 容器、数据、日志与 Secret（需 RUSTFS_POC_CONFIRM）
EOS
    exit 2
    ;;
esac
