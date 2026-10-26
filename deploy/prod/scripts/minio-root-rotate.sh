#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/minio-root-rotate.sh · F-02 S5
# ------------------------------------------------------------
# 作用：在维护窗口轮换 MinIO root，并验证新 root 可用、旧 root 失效。
#       轮换前要求 S3 身份与 S4 存储链路已通过；轮换后复核身份、bootstrap 与
#       应用 service account。api / worker 不使用 root，不随本脚本重启。
# 边界：不删除对象、桶、版本或数据目录；不重开 9000 / 9001 / 9443；不打印 Secret。
#
# 用法（部署机 root）：
#   MC_BIN=/usr/local/bin/mc MC_SOURCE='<受控来源>' \
#     bash scripts/minio-root-rotate.sh plan
#   MC_BIN=/usr/local/bin/mc MC_SOURCE='<受控来源>' \
#     bash scripts/minio-root-rotate.sh check
#   F02_S5_CONFIRM=ROTATE_MINIO_ROOT F02_S5_BACKUP_CONFIRMED=YES \
#     MC_BIN=/usr/local/bin/mc MC_SOURCE='<受控来源>' \
#     bash scripts/minio-root-rotate.sh rotate
#   F02_S5_CONFIRM=RESTORE_PREVIOUS_ROOT \
#     bash scripts/minio-root-rotate.sh recover
#   F02_S5_CONFIRM=FINALIZE_ROOT_ROTATION \
#     bash scripts/minio-root-rotate.sh finalize
#
# 旧 root 只在 /run/libiaolink-f02-s5（700 / 600，tmpfs）短暂保留用于失败恢复；
# 成功经 finalize 或显式回滚后删除。状态目录存在或 secrets/ 有残留临时件时
# rotate 会拒绝再次执行。
# ============================================================
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="${MINIO_SECRETS_DIR:-$PROD_DIR/secrets}"
STATE_DIR="/run/libiaolink-f02-s5"
EVIDENCE_DIR="${F02_S5_EVIDENCE_DIR:-/srv/data/backups/f02-s5-evidence}"
PUBLIC_BASE_URL="${F02_PUBLIC_BASE_URL:-https://test-pm.libiaorobot.com}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-/srv/data/minio}"
MINIO_CONTAINER_NAME="${MINIO_CONTAINER_NAME:-libiaolink-minio}"
MINIO_COMPOSE_SERVICE="${MINIO_COMPOSE_SERVICE:-minio}"
MINIO_HEALTH_TIMEOUT_SECONDS="${F02_S5_HEALTH_TIMEOUT_SECONDS:-180}"
MINIO_ADMIN_ENDPOINT="${MINIO_ADMIN_ENDPOINT:-https://127.0.0.1:9443}"
MC_BIN="${MC_BIN:-mc}"
MC_SOURCE="${MC_SOURCE:-}"
MC_INSECURE="${MC_INSECURE:-1}"

ROOT_USER_FILE="$SECRETS_DIR/minio_root_user"
ROOT_PASSWORD_FILE="$SECRETS_DIR/minio_root_password"
OLD_USER_FILE="$STATE_DIR/old_root_user"
OLD_PASSWORD_FILE="$STATE_DIR/old_root_password"
STARTED_AT_FILE="$STATE_DIR/started_at_utc"

TEMP_FILES=()
ROTATION_STARTED_AT=""
NEW_ROOT_AUTH_STATUS="not-checked"
RETIRED_ROOT_AUTH_STATUS="not-checked"
RECOVERY_ROOT_AUTH_STATUS="not-checked"
ROLLBACK_STATUS="not-attempted"
ROOT_USERNAME_CHANGED="unknown"
IDENTITY_CHECK_STATUS="not-checked"
STORAGE_INIT_CHECK_STATUS="not-checked"
STORAGE_IT_CHECK_STATUS="not-checked"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
用法：
  MC_BIN=/usr/local/bin/mc MC_SOURCE='<受控来源>' \
    bash scripts/minio-root-rotate.sh plan
  MC_BIN=/usr/local/bin/mc MC_SOURCE='<受控来源>' \
    bash scripts/minio-root-rotate.sh check
  F02_S5_CONFIRM=ROTATE_MINIO_ROOT F02_S5_BACKUP_CONFIRMED=YES \
    bash scripts/minio-root-rotate.sh rotate
  F02_S5_CONFIRM=RESTORE_PREVIOUS_ROOT \
    bash scripts/minio-root-rotate.sh recover
  F02_S5_CONFIRM=FINALIZE_ROOT_ROTATION \
    bash scripts/minio-root-rotate.sh finalize

环境变量：
  MC_BIN                   受控 mc 路径（默认 mc）
  MC_SOURCE                mc 的受控来源；plan / check / rotate / recover / finalize 必填
  MC_INSECURE              1 = 回环自签证书使用 --insecure（默认 1）
  MINIO_ADMIN_ENDPOINT     MinIO S3 管理入口（默认 https://127.0.0.1:9443）
  MINIO_SECRETS_DIR        Secret 目录（默认 deploy/prod/secrets）
  MINIO_DATA_DIR           MinIO 数据目录（默认 /srv/data/minio）
  MINIO_CONTAINER_NAME     容器名（默认 libiaolink-minio）
  MINIO_COMPOSE_SERVICE    Compose 服务名（默认 minio）
  F02_PUBLIC_BASE_URL      443 验收基址（默认 https://test-pm.libiaorobot.com）
  F02_S5_EVIDENCE_DIR      证据目录（默认 /srv/data/backups/f02-s5-evidence）
  F02_S5_HEALTH_TIMEOUT_SECONDS  等待 minio healthy 的秒数（默认 180）

说明：
  plan      只读检查前置条件，不生成凭据、不写 Secret、不重启容器。
  check     只读复核当前 root、S3 身份、storage:init --check、storage:it 与 443 探针。
  rotate    受控轮换；失败时仅在“新 root 尚不可用”阶段自动恢复旧 root。
  recover   在 rotate 中断后，用 /run 状态目录恢复旧 root 并重建 minio。
  finalize  轮换已生效但旧副本扫描有命中时，清理后在无命中前提下删除状态目录。
EOF
}

cleanup() {
  unset ROOT_PASSWORD OLD_ROOT_PASSWORD NEW_ROOT_PASSWORD 2>/dev/null || true
  unset MC_HOST_f02root MC_HOST_f02newroot MC_HOST_f02retiredroot 2>/dev/null || true
  local file
  for file in "${TEMP_FILES[@]:-}"; do
    [[ -n "$file" ]] && rm -f -- "$file"
  done
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    find "$TMP_DIR" -mindepth 1 -delete 2>/dev/null || true
    rmdir -- "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "必须以 root 在部署机执行"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

assert_secure_dir() {
  local path="$1" mode
  [[ -d "$path" ]] || die "目录不存在：$path"
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 077) == 0 )) || die "目录权限必须为 700：$path（当前 $mode）"
}

assert_secure_file() {
  local path="$1" mode
  [[ -f "$path" && ! -L "$path" ]] || die "Secret 必须是普通文件：$path"
  [[ -s "$path" ]] || die "Secret 文件缺失或为空：$path"
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 077) == 0 )) || die "Secret 文件权限必须为 600：$path（当前 $mode）"
}

validate_secret_value() {
  local label="$1" value="$2" min_length="$3"
  [[ -n "$value" ]] || die "$label 为空"
  (( ${#value} >= min_length )) || die "$label 长度不足 $min_length"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label 不能包含换行"
}

load_root_from_files() {
  assert_secure_dir "$SECRETS_DIR"
  assert_secure_file "$ROOT_USER_FILE"
  assert_secure_file "$ROOT_PASSWORD_FILE"
  ROOT_USER="$(<"$ROOT_USER_FILE")"
  ROOT_PASSWORD="$(<"$ROOT_PASSWORD_FILE")"
  validate_secret_value "minio_root_user" "$ROOT_USER" 3
  validate_secret_value "minio_root_password" "$ROOT_PASSWORD" 8
  assert_app_credentials_not_root "应用" "$SECRETS_DIR/s3_access_key" "$SECRETS_DIR/s3_secret_key"
  assert_app_credentials_not_root "bootstrap" \
    "$SECRETS_DIR/s3_bootstrap_access_key" "$SECRETS_DIR/s3_bootstrap_secret_key"
}

assert_app_credentials_not_root() {
  local label="$1" access_file="$2" secret_file="$3" access_key secret_key
  assert_secure_file "$access_file"
  assert_secure_file "$secret_file"
  access_key="$(<"$access_file")"
  secret_key="$(<"$secret_file")"
  if [[ "$access_key" == "$ROOT_USER" || "$secret_key" == "$ROOT_PASSWORD" ]]; then
    die "$label S3 凭据仍与 root 相同；先完成 S4 运行时切换，再执行 S5"
  fi
}

load_state_root() {
  assert_secure_dir "$STATE_DIR"
  assert_secure_file "$OLD_USER_FILE"
  assert_secure_file "$OLD_PASSWORD_FILE"
  OLD_ROOT_USER="$(<"$OLD_USER_FILE")"
  OLD_ROOT_PASSWORD="$(<"$OLD_PASSWORD_FILE")"
  validate_secret_value "待恢复 root 用户名" "$OLD_ROOT_USER" 3
  validate_secret_value "待恢复 root 口令" "$OLD_ROOT_PASSWORD" 8
  if [[ -f "$STARTED_AT_FILE" && ! -L "$STARTED_AT_FILE" ]]; then
    ROTATION_STARTED_AT="$(<"$STARTED_AT_FILE")"
  fi
}

assert_state_absent() {
  [[ ! -e "$STATE_DIR" ]] || die "检测到未完成状态：$STATE_DIR；先用 recover，或完成核查后用 finalize"
}

atomic_write_pair() {
  local user_target="$1" password_target="$2" user_value="$3" password_value="$4"
  local user_tmp password_tmp user_backup="" password_backup=""
  local user_existed=0 password_existed=0
  [[ -e "$user_target" ]] && user_existed=1
  [[ -e "$password_target" ]] && password_existed=1
  (( user_existed == password_existed )) ||
    die "Secret 必须成对存在或成对缺失：$user_target / $password_target"
  user_tmp="$(mktemp "$(dirname -- "$user_target")/.$(basename -- "$user_target").f02-s5.XXXXXX")"
  TEMP_FILES+=("$user_tmp")
  password_tmp="$(mktemp "$(dirname -- "$password_target")/.$(basename -- "$password_target").f02-s5.XXXXXX")"
  TEMP_FILES+=("$password_tmp")
  chmod 600 "$user_tmp" "$password_tmp"
  printf '%s\n' "$user_value" > "$user_tmp"
  printf '%s\n' "$password_value" > "$password_tmp"

  if (( user_existed )); then
    user_backup="$(mktemp "$(dirname -- "$user_target")/.$(basename -- "$user_target").f02-s5.old.XXXXXX")"
    TEMP_FILES+=("$user_backup")
    cp -p -- "$user_target" "$user_backup"
    chmod 600 "$user_backup"
    password_backup="$(mktemp "$(dirname -- "$password_target")/.$(basename -- "$password_target").f02-s5.old.XXXXXX")"
    TEMP_FILES+=("$password_backup")
    cp -p -- "$password_target" "$password_backup"
    chmod 600 "$password_backup"
  fi

  if ! mv -f -- "$user_tmp" "$user_target"; then
    rm -f -- "$user_backup" "$password_backup"
    return 1
  fi
  if ! mv -f -- "$password_tmp" "$password_target"; then
    if (( user_existed )); then
      mv -f -- "$user_backup" "$user_target" || true
    else
      rm -f -- "$user_target"
    fi
    rm -f -- "$password_backup"
    return 1
  fi
  sync -f "$(dirname -- "$user_target")" 2>/dev/null || true
  sync -f "$(dirname -- "$password_target")" 2>/dev/null || true
  rm -f -- "$user_backup" "$password_backup"
}

atomic_pair_artifact() {
  find "$SECRETS_DIR" -maxdepth 1 -type f \
    \( -name '.minio_root_user.f02-s5.*' -o -name '.minio_root_password.f02-s5.*' \) \
    -print -quit
}

assert_no_atomic_pair_artifacts() {
  local artifact
  artifact="$(atomic_pair_artifact)"
  [[ -z "$artifact" ]] || die "检测到未清理的 S5 临时 Secret 文件：$artifact；先按事件核查，不得直接重跑 rotate"
}

remove_atomic_pair_artifacts() {
  assert_secure_dir "$SECRETS_DIR"
  find "$SECRETS_DIR" -maxdepth 1 -type f \
    \( -name '.minio_root_user.f02-s5.*' -o -name '.minio_root_password.f02-s5.*' \) \
    -delete
}

create_state() {
  OLD_ROOT_USER="$ROOT_USER"
  OLD_ROOT_PASSWORD="$ROOT_PASSWORD"
  mkdir -m 700 -- "$STATE_DIR"
  atomic_write_pair "$OLD_USER_FILE" "$OLD_PASSWORD_FILE" "$ROOT_USER" "$ROOT_PASSWORD"
  ROTATION_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$ROTATION_STARTED_AT" > "$STARTED_AT_FILE"
  chmod 600 "$STARTED_AT_FILE"
  assert_secure_dir "$STATE_DIR"
  assert_secure_file "$OLD_USER_FILE"
  assert_secure_file "$OLD_PASSWORD_FILE"
}

remove_state() {
  [[ -d "$STATE_DIR" ]] || return 0
  assert_secure_dir "$STATE_DIR"
  find "$STATE_DIR" -mindepth 1 -delete
  rmdir -- "$STATE_DIR"
}

ensure_evidence_dir() {
  mkdir -p -- "$EVIDENCE_DIR" "$EVIDENCE_DIR/logs"
  chmod 700 "$EVIDENCE_DIR" "$EVIDENCE_DIR/logs"
  assert_secure_dir "$EVIDENCE_DIR"
  assert_secure_dir "$EVIDENCE_DIR/logs"
}

write_evidence() {
  local status="$1" stage="$2" file timestamp
  ensure_evidence_dir
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$EVIDENCE_DIR/root-rotation-$timestamp-$status-$RANDOM.txt"
  {
    printf 'recorded_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'status=%s\n' "$status"
    printf 'stage=%s\n' "$stage"
    printf 'rotation_started_at_utc=%s\n' "${ROTATION_STARTED_AT:-unknown}"
    printf 'root_username_changed=%s\n' "$ROOT_USERNAME_CHANGED"
    printf 'new_root_auth=%s\n' "$NEW_ROOT_AUTH_STATUS"
    printf 'retired_root_auth=%s\n' "$RETIRED_ROOT_AUTH_STATUS"
    printf 'recovery_root_auth=%s\n' "$RECOVERY_ROOT_AUTH_STATUS"
    printf 'rollback=%s\n' "$ROLLBACK_STATUS"
    printf 'identity_check=%s\n' "$IDENTITY_CHECK_STATUS"
    printf 'storage_init_check=%s\n' "$STORAGE_INIT_CHECK_STATUS"
    printf 'storage_it=%s\n' "$STORAGE_IT_CHECK_STATUS"
    printf 'healthz=%s\n' "${HEALTHZ_STATUS:-unknown}"
    printf 'readyz=%s\n' "${READYZ_STATUS:-unknown}"
    printf 'object_facade_status=%s\n' "${OBJECT_FACADE_STATUS:-unknown}"
    printf 'retired_secret_scan=%s\n' "${RETIRED_SECRET_SCAN:-unknown}"
    printf 'state_cleanup=%s\n' "${STATE_CLEANUP:-unknown}"
    printf 'secret_values_recorded=no\n'
    printf 'f02_status=open\n'
  } > "$file"
  chmod 600 "$file"
  info "evidence: $file"
}

validate_endpoint() {
  [[ "$MINIO_ADMIN_ENDPOINT" =~ ^https?://[^/?#]+$ ]] ||
    die "MINIO_ADMIN_ENDPOINT 必须是无路径、查询串和 fragment 的 http(s) 地址"
  [[ "${MINIO_ADMIN_ENDPOINT#*://}" != *@* ]] || die "MINIO_ADMIN_ENDPOINT 不得包含凭据"
  [[ "$PUBLIC_BASE_URL" =~ ^https://[^/?#]+$ ]] ||
    die "F02_PUBLIC_BASE_URL 必须是无路径、查询串和 fragment 的 https 地址"
}

resolve_mc() {
  MC_PATH="$(command -v -- "$MC_BIN" 2>/dev/null || true)"
  [[ -n "$MC_PATH" && -x "$MC_PATH" ]] || die "找不到可执行 mc：$MC_BIN"
  [[ "$MC_INSECURE" == "0" || "$MC_INSECURE" == "1" ]] || die "MC_INSECURE 只能是 0 或 1"
  [[ -n "$MC_SOURCE" ]] || die "check / rotate / recover / finalize 必须通过 MC_SOURCE 登记受控 mc 来源"
  [[ "$MC_SOURCE" != *$'\n'* && "$MC_SOURCE" != *$'\r'* ]] || die "MC_SOURCE 不得包含换行"
  MC_VERSION="$("$MC_PATH" --version 2>&1 | sed -n '1p')"
  [[ -n "$MC_VERSION" ]] || die "mc --version 无输出"
  MC_SHA256="$(sha256sum -- "$MC_PATH" | awk '{print $1}')"
  [[ "$MC_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "无法计算 mc SHA-256"
  local spec
  for spec in "alias set --help" "admin info --help" "admin user svcacct info --help" "ls --help"; do
    local -a argv
    read -r -a argv <<< "$spec"
    "$MC_PATH" "${argv[@]}" >/dev/null 2>&1 || die "mc 兼容性检查失败：mc $spec"
  done
}

prepare_workdir() {
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/libiaolink-s5.XXXXXX")"
  chmod 700 "$TMP_DIR"
  MC_CONFIG_DIR="$TMP_DIR/mc"
  mkdir -m 700 -- "$MC_CONFIG_DIR"
  export MC_CONFIG_DIR
}

clear_mc_config() {
  [[ -n "${MC_CONFIG_DIR:-}" && -d "$MC_CONFIG_DIR" ]] || return 0
  find "$MC_CONFIG_DIR" -mindepth 1 -delete
}

mc_flags() {
  if [[ "$MC_INSECURE" == "1" ]]; then
    printf '%s\n' "--insecure"
  fi
}

mc_run() {
  local -a flags=()
  local flag
  while IFS= read -r flag; do
    [[ -n "$flag" ]] && flags+=("$flag")
  done < <(mc_flags)
  "$MC_PATH" "${flags[@]}" "$@"
}

probe_root_available() {
  local alias="$1" access_key="$2" secret_key="$3" alias_output
  if ! alias_output="$(printf '%s\n%s\n' "$access_key" "$secret_key" | mc_run alias set "$alias" "$MINIO_ADMIN_ENDPOINT" 2>&1)"; then
    return 1
  fi
  mc_run admin info "$alias" >/dev/null 2>&1
}

probe_retired_root_rejected() {
  local alias="$1" access_key="$2" secret_key="$3" alias_output alias_status output status
  if alias_output="$(printf '%s\n%s\n' "$access_key" "$secret_key" | mc_run alias set "$alias" "$MINIO_ADMIN_ENDPOINT" 2>&1)"; then
    alias_status=0
  else
    alias_status=$?
  fi
  if (( alias_status != 0 )); then
    case "$alias_output" in
      *"Access Denied"*|*"AccessDenied"*|*"InvalidAccessKeyId"*|*"SignatureDoesNotMatch"*|\
      *"Access Key Id you provided does not exist"*|*"Access key ID you provided does not exist"*|\
      *"request signature we calculated does not match"*)
        return 0
        ;;
      *) return 2 ;;
    esac
  fi
  if output="$(mc_run admin info "$alias" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  (( status != 0 )) || return 1
  case "$output" in
    *"Access Denied"*|*"AccessDenied"*|*"InvalidAccessKeyId"*|*"SignatureDoesNotMatch"*|\
    *"Access Key Id you provided does not exist"*|*"Access key ID you provided does not exist"*|\
    *"request signature we calculated does not match"*)
      return 0
      ;;
    *) return 2 ;;
  esac
}

assert_minio_data_dir() {
  [[ -d "$MINIO_DATA_DIR" ]] || die "MinIO 数据目录不存在：$MINIO_DATA_DIR"
  [[ -n "$(find "$MINIO_DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
    die "MinIO 数据目录为空，拒绝在未确认数据挂载时轮换：$MINIO_DATA_DIR"
}

assert_minio_healthy() {
  local status
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$MINIO_CONTAINER_NAME" 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] || die "minio 当前不健康：${status:-not-found}"
}

assert_compose_config() {
  (cd "$PROD_DIR" && docker compose --profile app config --quiet) ||
    die "Compose 配置解析失败，拒绝进入 S5"
}

restart_minio() {
  (
    cd "$PROD_DIR"
    docker compose --profile app up -d --no-deps --force-recreate "$MINIO_COMPOSE_SERVICE" >/dev/null
  )
}

wait_minio_healthy() {
  local deadline status
  deadline=$((SECONDS + MINIO_HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$MINIO_CONTAINER_NAME" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 2
  done
  return 1
}

run_logged() {
  local log="$1"
  shift
  if ! "$@" >>"$log" 2>&1; then
    printf '检查失败，日志：%s\n' "$log" >&2
    tail -n 30 "$log" >&2 || true
    return 1
  fi
}

check_identities() {
  ensure_evidence_dir
  local log="$EVIDENCE_DIR/logs/identity-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM.log"
  run_logged "$log" env \
    MC_BIN="$MC_PATH" \
    MC_SOURCE="$MC_SOURCE" \
    MC_INSECURE="$MC_INSECURE" \
    MINIO_ADMIN_ENDPOINT="$MINIO_ADMIN_ENDPOINT" \
    MINIO_SECRETS_DIR="$SECRETS_DIR" \
    F02_EVIDENCE_DIR="$EVIDENCE_DIR" \
    bash "$SCRIPT_DIR/minio-identity.sh" check
  IDENTITY_CHECK_STATUS="ok"
}

check_storage_init() {
  ensure_evidence_dir
  local log="$EVIDENCE_DIR/logs/storage-init-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM.log"
  run_logged "$log" bash "$SCRIPT_DIR/storage.sh" init --check
  STORAGE_INIT_CHECK_STATUS="ok"
}

check_storage_it() {
  ensure_evidence_dir
  local log="$EVIDENCE_DIR/logs/storage-it-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM.log"
  run_logged "$log" bash "$SCRIPT_DIR/storage.sh" it
  STORAGE_IT_CHECK_STATUS="ok"
}

probe_http() {
  HEALTHZ_STATUS="$(curl --proto '=https' -fsS --max-time 30 -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL/healthz")" ||
    return 1
  READYZ_STATUS="$(curl --proto '=https' -fsS --max-time 30 -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL/readyz")" ||
    return 1
  OBJECT_FACADE_STATUS="$(curl --proto '=https' -sS --max-time 30 -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL/libiaolink/")" ||
    return 1
  [[ "$HEALTHZ_STATUS" == "200" && "$READYZ_STATUS" == "200" ]] || return 1
  case "$OBJECT_FACADE_STATUS" in
    400|403|404) return 0 ;;
    *) return 1 ;;
  esac
}

run_runtime_checks() {
  check_identities
  check_storage_init
  check_storage_it
  probe_http
}

generate_new_root() {
  local attempt
  command -v openssl >/dev/null 2>&1 || die "缺少 openssl"
  for attempt in 1 2 3 4 5; do
    NEW_ROOT_USER="libiaolink-root-$(openssl rand -hex 2)"
    NEW_ROOT_PASSWORD="$(openssl rand -hex 32)"
    if [[ "$NEW_ROOT_USER" != "$ROOT_USER" && "$NEW_ROOT_PASSWORD" != "$ROOT_PASSWORD" ]]; then
      break
    fi
  done
  [[ "$NEW_ROOT_USER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,19}$ ]] || die "生成的新 root 用户名格式异常"
  [[ "$NEW_ROOT_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || die "生成的新 root 口令格式异常"
  [[ "$NEW_ROOT_USER" != "$NEW_ROOT_PASSWORD" ]] || die "新 root 用户名与口令相同"
  local file value
  for file in s3_access_key s3_secret_key s3_bootstrap_access_key s3_bootstrap_secret_key; do
    [[ -f "$SECRETS_DIR/$file" ]] || continue
    value="$(<"$SECRETS_DIR/$file")"
    [[ "$NEW_ROOT_PASSWORD" != "$value" && "$NEW_ROOT_USER" != "$value" ]] ||
      die "新 root 凭据与现有 S3 凭据冲突"
  done
}

rollback_to_old_root() {
  local reason="$1"
  STATE_CLEANUP="pending"
  if ! atomic_write_pair "$ROOT_USER_FILE" "$ROOT_PASSWORD_FILE" "$OLD_ROOT_USER" "$OLD_ROOT_PASSWORD"; then
    printf 'ERROR: %s；恢复旧 Secret 文件失败，状态目录保留：%s\n' "$reason" "$STATE_DIR" >&2
    return 1
  fi
  remove_atomic_pair_artifacts
  ROOT_USERNAME_CHANGED="no"
  if ! restart_minio || ! wait_minio_healthy; then
    printf 'ERROR: %s；恢复旧 root 后 minio 未 healthy，状态目录保留：%s\n' "$reason" "$STATE_DIR" >&2
    return 1
  fi
  if ! probe_root_available f02root "$OLD_ROOT_USER" "$OLD_ROOT_PASSWORD"; then
    printf 'ERROR: %s；旧 root 恢复后认证失败，状态目录保留：%s\n' "$reason" "$STATE_DIR" >&2
    return 1
  fi
  ROLLBACK_STATUS="ok"
  RECOVERY_ROOT_AUTH_STATUS="accepted"
  remove_state
  STATE_CLEANUP="removed"
  write_evidence "rolled-back" "$reason"
  info "已恢复旧 root 启动；F-02 仍开放，必须立即按事件处置并重新轮换"
  return 0
}

fail_with_new_root() {
  local stage="$1"
  STATE_CLEANUP="retained"
  info "S5 rotation stage: $stage"
  write_evidence "failed" "$stage"
  info "新 root 已生效，未回滚；状态目录保留供核查：$STATE_DIR"
  exit 1
}

scan_retired_secret_copies() {
  local hits_file="$TMP_DIR/retired-secret-hits.txt" errors_file="$TMP_DIR/retired-secret-scan-errors.txt"
  : > "$hits_file"
  : > "$errors_file"
  local path file rc
  for path in "$PROD_DIR" /srv/data/backups "$EVIDENCE_DIR" /root/.bash_history /home /tmp /var/tmp; do
    [[ -e "$path" ]] || continue
    if [[ -f "$path" ]]; then
      if grep -IlF -f "$OLD_PASSWORD_FILE" -- "$path" >>"$hits_file" 2>/dev/null; then
        rc=0
      else
        rc=$?
      fi
      if (( rc > 1 )); then
        printf '%s\n' "$path" >>"$errors_file"
      fi
      continue
    fi
    while IFS= read -r -d '' file; do
      if grep -IlF -f "$OLD_PASSWORD_FILE" -- "$file" >>"$hits_file" 2>/dev/null; then
        rc=0
      else
        rc=$?
      fi
      if (( rc > 1 )); then
        printf '%s\n' "$file" >>"$errors_file"
      fi
    done < <(find "$path" \( -type d \( -name .git -o -name node_modules -o -name .cache \) -prune \) -o -type f -print0)
  done

  local container
  for container in "$MINIO_CONTAINER_NAME" libiaolink-api libiaolink-worker; do
    if docker inspect "$container" >/dev/null 2>&1; then
      if docker logs "$container" 2>&1 | grep -F -f "$OLD_PASSWORD_FILE" >/dev/null; then
        printf 'docker-logs:%s\n' "$container" >>"$hits_file"
      fi
    fi
  done

  sort -u -o "$hits_file" "$hits_file"
  sort -u -o "$errors_file" "$errors_file"
  if [[ -s "$errors_file" ]]; then
    printf '旧 root 口令扫描存在不可读文件，扫描不完整（路径不写入证据）：\n' >&2
    sed 's#^#  - #' "$errors_file" >&2
    return 1
  fi
  if [[ -s "$hits_file" ]]; then
    printf '旧 root 口令仍出现在以下位置（不输出内容）：\n' >&2
    sed 's#^#  - #' "$hits_file" >&2
    return 2
  fi
  return 0
}

finalize_state() {
  local scan_status
  clear_mc_config
  remove_atomic_pair_artifacts
  if scan_retired_secret_copies; then
    scan_status=0
  else
    scan_status=$?
  fi
  case "$scan_status" in
    0) ;;
    2)
      RETIRED_SECRET_SCAN="hits"
      fail_with_new_root "retired-secret-scan"
      ;;
    *)
      RETIRED_SECRET_SCAN="error"
      fail_with_new_root "retired-secret-scan-error"
      ;;
  esac
  RETIRED_SECRET_SCAN="zero-hits"
  remove_state
  STATE_CLEANUP="removed"
}

cmd_plan() {
  require_root
  load_root_from_files
  validate_endpoint
  assert_state_absent
  assert_no_atomic_pair_artifacts
  assert_secure_file "$SECRETS_DIR/s3_access_key"
  assert_secure_file "$SECRETS_DIR/s3_secret_key"
  assert_secure_file "$SECRETS_DIR/s3_bootstrap_access_key"
  assert_secure_file "$SECRETS_DIR/s3_bootstrap_secret_key"
  [[ -f "$PROD_DIR/server.env" ]] || die "缺少 $PROD_DIR/server.env"
  assert_minio_data_dir
  assert_minio_healthy
  assert_compose_config
  resolve_mc
  expect_rotate_plan
}

expect_rotate_plan() {
  info "F-02 S5 plan：前置检查通过，未生成凭据、未写 Secret、未重启容器"
  info "1) 基线：minio-identity.sh check + storage:init --check + storage:it + 443 探针"
  info "2) 状态备份：${STATE_DIR}（700 / 600，tmpfs）"
  info "3) 新 root 原子写入 ${SECRETS_DIR}，随后仅重建 minio"
  info "4) 验证新 root 可用、旧 root 认证拒绝、S3 / storage / HTTP 全链路"
  info "5) 扫描旧口令残留；无命中后删除状态目录并写脱敏证据"
  info "执行需设置 F02_S5_CONFIRM=ROTATE_MINIO_ROOT 与 F02_S5_BACKUP_CONFIRMED=YES"
}

cmd_check() {
  require_root
  load_root_from_files
  validate_endpoint
  assert_state_absent
  assert_no_atomic_pair_artifacts
  assert_minio_data_dir
  assert_minio_healthy
  assert_compose_config
  prepare_workdir
  resolve_mc
  run_runtime_checks || die "当前 root / S3 / storage / HTTP 检查失败"
  ROOT_USERNAME_CHANGED="no"
  write_evidence "checked" "check"
  info "S5 check complete；未生成凭据、未写 Secret、未重启容器"
}

cmd_rotate() {
  require_root
  [[ "${F02_S5_CONFIRM:-}" == "ROTATE_MINIO_ROOT" ]] || die "缺少 F02_S5_CONFIRM=ROTATE_MINIO_ROOT"
  [[ "${F02_S5_BACKUP_CONFIRMED:-}" == "YES" ]] || die "缺少 F02_S5_BACKUP_CONFIRMED=YES"
  load_root_from_files
  validate_endpoint
  assert_state_absent
  assert_no_atomic_pair_artifacts
  assert_minio_data_dir
  assert_minio_healthy
  assert_compose_config
  prepare_workdir
  resolve_mc
  ensure_evidence_dir

  info "== 基线检查（轮换前）"
  run_runtime_checks || die "轮换前基线检查失败，未修改任何 Secret"

  create_state
  generate_new_root
  info "== 写入新 root Secret（不输出值）"
  atomic_write_pair "$ROOT_USER_FILE" "$ROOT_PASSWORD_FILE" "$NEW_ROOT_USER" "$NEW_ROOT_PASSWORD"
  ROOT_USERNAME_CHANGED="yes"

  info "== 重建 minio（仅 minio，不重启 api / worker）"
  if ! restart_minio || ! wait_minio_healthy; then
    NEW_ROOT_AUTH_STATUS="not-reached"
    if rollback_to_old_root "new-root-startup-failed"; then
      exit 1
    fi
    STATE_CLEANUP="retained"
    write_evidence "failed" "new-root-startup-and-rollback"
    exit 1
  fi

  if ! probe_root_available f02newroot "$NEW_ROOT_USER" "$NEW_ROOT_PASSWORD"; then
    NEW_ROOT_AUTH_STATUS="rejected"
    if rollback_to_old_root "new-root-auth-failed"; then
      exit 1
    fi
    STATE_CLEANUP="retained"
    write_evidence "failed" "new-root-auth-and-rollback"
    exit 1
  fi
  NEW_ROOT_AUTH_STATUS="accepted"
  info "new root auth: accepted"

  local retired_status
  if probe_retired_root_rejected f02retiredroot "$OLD_ROOT_USER" "$OLD_ROOT_PASSWORD"; then
    retired_status=0
  else
    retired_status=$?
  fi
  case "$retired_status" in
    0)
      RETIRED_ROOT_AUTH_STATUS="rejected"
      info "retired root auth: rejected"
      ;;
    1)
      RETIRED_ROOT_AUTH_STATUS="accepted"
      if rollback_to_old_root "retired-root-still-accepted"; then
        exit 1
      fi
      STATE_CLEANUP="retained"
      write_evidence "failed" "retired-root-and-rollback"
      exit 1
      ;;
    *)
      RETIRED_ROOT_AUTH_STATUS="inconclusive"
      fail_with_new_root "retired-root-probe-inconclusive"
      ;;
  esac

  info "== 轮换后 S3 / storage / HTTP 复核"
  if ! run_runtime_checks; then
    fail_with_new_root "post-rotation-checks"
  fi

  info "== 旧口令残留扫描"
  finalize_state
  write_evidence "success" "rotate"
  unset NEW_ROOT_PASSWORD OLD_ROOT_PASSWORD ROOT_PASSWORD 2>/dev/null || true
  info "S5 rotate complete；F-02 仍需 S1～S4 运行证据、S6 / S7 后才可关闭"
}

cmd_recover() {
  require_root
  [[ "${F02_S5_CONFIRM:-}" == "RESTORE_PREVIOUS_ROOT" ]] || die "缺少 F02_S5_CONFIRM=RESTORE_PREVIOUS_ROOT"
  [[ -d "$STATE_DIR" ]] || die "没有可恢复状态：$STATE_DIR"
  load_state_root
  validate_endpoint
  prepare_workdir
  resolve_mc
  ensure_evidence_dir
  if ! rollback_to_old_root "explicit-recover"; then
    STATE_CLEANUP="retained"
    write_evidence "failed" "explicit-recover"
    exit 1
  fi
  info "S5 recover complete；F-02 仍开放，必须重新轮换 root"
}

cmd_finalize() {
  require_root
  [[ "${F02_S5_CONFIRM:-}" == "FINALIZE_ROOT_ROTATION" ]] || die "缺少 F02_S5_CONFIRM=FINALIZE_ROOT_ROTATION"
  [[ -d "$STATE_DIR" ]] || die "没有待完成状态：$STATE_DIR"
  load_root_from_files
  load_state_root
  validate_endpoint
  assert_minio_data_dir
  assert_minio_healthy
  prepare_workdir
  resolve_mc
  ensure_evidence_dir
  if [[ "$ROOT_USER" == "$OLD_ROOT_USER" && "$ROOT_PASSWORD" == "$OLD_ROOT_PASSWORD" ]]; then
    die "当前 Secret 与待退休 root 相同；轮换未生效，拒绝删除状态目录"
  fi
  ROOT_USERNAME_CHANGED="yes"
  if ! probe_root_available f02root "$ROOT_USER" "$ROOT_PASSWORD"; then
    fail_with_new_root "finalize-current-root-unavailable"
  fi
  NEW_ROOT_AUTH_STATUS="accepted"
  if ! run_runtime_checks; then
    fail_with_new_root "finalize-runtime-checks"
  fi
  local retired_status
  if probe_retired_root_rejected f02retiredroot "$OLD_ROOT_USER" "$OLD_ROOT_PASSWORD"; then
    retired_status=0
  else
    retired_status=$?
  fi
  case "$retired_status" in
    0)
      RETIRED_ROOT_AUTH_STATUS="rejected"
      ;;
    1)
      RETIRED_ROOT_AUTH_STATUS="accepted"
      fail_with_new_root "finalize-retired-root-still-accepted"
      ;;
    *)
      RETIRED_ROOT_AUTH_STATUS="inconclusive"
      fail_with_new_root "finalize-retired-root-probe-inconclusive"
      ;;
  esac
  finalize_state
  write_evidence "success" "finalize"
  info "S5 finalize complete；状态目录已删除"
}

command="${1:-}"
case "$command" in
  plan)
    cmd_plan
    ;;
  check)
    cmd_check
    ;;
  rotate)
    cmd_rotate
    ;;
  recover)
    cmd_recover
    ;;
  finalize)
    cmd_finalize
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
