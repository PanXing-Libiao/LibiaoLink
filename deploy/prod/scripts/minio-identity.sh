#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/minio-identity.sh · F-02 S3
# ------------------------------------------------------------
# 作用：校验并建立 MinIO 最小权限父用户、策略和 service account。
# 边界：只改 MinIO 身份与 secrets/s3_* 文件；不重启 api / worker，
#       不读取对象内容，不修改桶策略，不执行 root 轮换。
#
# 用法（服务器 root）：
#   bash scripts/minio-identity.sh lint   # 仅仓库静态校验，不连接 MinIO
#   MC_BIN=/usr/local/bin/mc bash scripts/minio-identity.sh apply
#   MC_BIN=/usr/local/bin/mc bash scripts/minio-identity.sh check
#
# 凭据输入：root 凭据只从 secrets/minio_root_* 读入临时环境；
#           parent 用户口令随机生成后丢弃；service account 凭据由 mc 生成并直接写文件。
#           任何 Secret 都不得进入命令行参数、日志或仓库。
# ============================================================
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
POLICY_DIR="${MINIO_POLICY_DIR:-$PROD_DIR/minio/policies}"
SECRETS_DIR="${MINIO_SECRETS_DIR:-$PROD_DIR/secrets}"
EVIDENCE_DIR="${F02_EVIDENCE_DIR:-/srv/data/backups/f02-s3-evidence}"
MC_BIN="${MC_BIN:-mc}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
MC_SOURCE="${MC_SOURCE:-}"
MC_INSECURE="${MC_INSECURE:-1}"
MINIO_ADMIN_ENDPOINT="${MINIO_ADMIN_ENDPOINT:-https://127.0.0.1:9443}"

APP_POLICY="libiaolink-app-rw"
BOOTSTRAP_POLICY="libiaolink-bootstrap"
APP_USER="libiaolink-app"
BOOTSTRAP_USER="libiaolink-bootstrap"
APP_SVC="libiaolink-api"
BOOTSTRAP_SVC="libiaolink-storage-init"

APP_POLICY_FILE="$POLICY_DIR/$APP_POLICY.json"
BOOTSTRAP_POLICY_FILE="$POLICY_DIR/$BOOTSTRAP_POLICY.json"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
用法：
  bash scripts/minio-identity.sh lint
  MC_BIN=/path/to/mc bash scripts/minio-identity.sh apply
  MC_BIN=/path/to/mc bash scripts/minio-identity.sh check

环境变量：
  MC_BIN                  受控 mc 二进制路径（默认 mc）
  PYTHON_BIN              Python 3 路径（默认 python3）
  MC_SOURCE               mc 的受控来源；apply / check 必填，并写入证据
  MC_INSECURE             1 = 对回环/自签证书使用 --insecure（默认 1）
  MINIO_ADMIN_ENDPOINT    MinIO 管理端点（默认 https://127.0.0.1:9443，必须无路径）
  MINIO_POLICY_DIR        策略目录（默认 deploy/prod/minio/policies）
  MINIO_SECRETS_DIR       Secret 目录（默认 deploy/prod/secrets）
  F02_EVIDENCE_DIR        工具链与执行证据目录（默认 /srv/data/backups/f02-s3-evidence）

说明：
  lint   只校验策略文件，不要求 root / mc / MinIO。
  apply  创建或校验策略、父用户、service account；不重启 api / worker。
  check  只读校验远端身份、策略与两套 service account 凭据。
  轮换不在 S3 执行；留待 S5 的维护窗口统一处理。
EOF
}

cleanup() {
  unset MC_HOST_f02root MC_HOST_f02app MC_HOST_f02bootstrap 2>/dev/null || true
  unset ROOT_USER ROOT_PASSWORD 2>/dev/null || true
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

lint_policy_files() {
  resolve_python
  [[ -s "$APP_POLICY_FILE" ]] || die "缺少策略文件：$APP_POLICY_FILE"
  [[ -s "$BOOTSTRAP_POLICY_FILE" ]] || die "缺少策略文件：$BOOTSTRAP_POLICY_FILE"

  "$PYTHON_BIN" - "$APP_POLICY_FILE" "$BOOTSTRAP_POLICY_FILE" <<'PY'
import json
import sys


def canonical(value):
    if isinstance(value, list):
        mapped = [canonical(item) for item in value]
        if all(isinstance(item, str) for item in mapped):
            return sorted(mapped)
        return sorted(
            mapped,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


expected_app = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
            "Resource": ["arn:aws:s3:::libiaolink"],
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:DeleteObjectVersion",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
            ],
            "Resource": ["arn:aws:s3:::libiaolink/*"],
        },
    ],
}
expected_bootstrap = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:CreateBucket",
                "s3:ListBucket",
                "s3:GetBucketVersioning",
                "s3:PutBucketVersioning",
                "s3:GetLifecycleConfiguration",
                "s3:PutLifecycleConfiguration",
            ],
            "Resource": ["arn:aws:s3:::libiaolink"],
        },
    ],
}


def read_policy(path):
    with open(path, "r", encoding="utf-8") as handle:
        raw = handle.read()
    for forbidden in ("s3:*", "arn:aws:s3:::*"):
        if forbidden in raw:
            raise ValueError(f"{path} 含禁止项 {forbidden}")
    return json.loads(raw)


try:
    app = read_policy(sys.argv[1])
    bootstrap = read_policy(sys.argv[2])
    if canonical(app) != canonical(expected_app):
        raise ValueError("应用策略与 S0 冻结内容不一致")
    if canonical(bootstrap) != canonical(expected_bootstrap):
        raise ValueError("bootstrap 策略与 S0 冻结内容不一致")
except Exception as error:
    print(f"policy lint failed: {error}", file=sys.stderr)
    raise SystemExit(1)

print("policy lint: app + bootstrap ok")
PY
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "apply / check 必须以 root 在部署机执行"
}

resolve_python() {
  PYTHON_PATH="$(command -v -- "$PYTHON_BIN" 2>/dev/null || true)"
  [[ -n "$PYTHON_PATH" && -x "$PYTHON_PATH" ]] || die "找不到 Python 3：$PYTHON_BIN"
}

assert_secure_dir() {
  local path="$1"
  [[ -d "$path" ]] || die "目录不存在：$path"
  local mode
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 077) == 0 )) || die "目录权限必须为 700：$path（当前 $mode）"
}

assert_secure_file() {
  local path="$1"
  [[ -s "$path" ]] || die "Secret 文件缺失或为空：$path"
  local mode
  mode="$(stat -c '%a' "$path")"
  (( (8#$mode & 077) == 0 )) || die "Secret 文件权限必须为 600：$path（当前 $mode）"
}

load_root_credentials() {
  assert_secure_dir "$SECRETS_DIR"
  assert_secure_file "$SECRETS_DIR/minio_root_user"
  assert_secure_file "$SECRETS_DIR/minio_root_password"
  ROOT_USER="$(<"$SECRETS_DIR/minio_root_user")"
  ROOT_PASSWORD="$(<"$SECRETS_DIR/minio_root_password")"
  [[ -n "$ROOT_USER" && -n "$ROOT_PASSWORD" ]] || die "MinIO root 凭据为空"
}

resolve_mc() {
  MC_PATH="$(command -v -- "$MC_BIN" 2>/dev/null || true)"
  [[ -n "$MC_PATH" && -x "$MC_PATH" ]] || die "找不到可执行 mc：$MC_BIN"
}

record_toolchain_evidence() {
  mkdir -p -- "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  local mode
  mode="$(stat -c '%a' "$EVIDENCE_DIR")"
  (( (8#$mode & 077) == 0 )) || die "证据目录权限必须为 700：$EVIDENCE_DIR（当前 $mode）"
  local file="$EVIDENCE_DIR/mc-toolchain.txt"
  {
    printf 'recorded_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'mc_path=%s\n' "$MC_PATH"
    printf 'mc_source=%s\n' "$MC_SOURCE"
    printf 'mc_version=%s\n' "$MC_VERSION"
    printf 'mc_sha256=%s\n' "$MC_SHA256"
    printf 'python_path=%s\n' "$PYTHON_PATH"
    printf 'python_version=%s\n' "$PYTHON_VERSION"
    printf 'help_checks=ok\n'
    printf 'insecure=%s\n' "$MC_INSECURE"
    printf 'admin_endpoint=%s\n' "$MINIO_ADMIN_ENDPOINT"
  } > "$file"
  chmod 600 "$file"
  info "toolchain evidence: $file"
}

toolchain_gate() {
  command -v sha256sum >/dev/null 2>&1 || die "缺少 sha256sum"
  resolve_mc
  resolve_python
  [[ "$MC_INSECURE" == "0" || "$MC_INSECURE" == "1" ]] || die "MC_INSECURE 只能是 0 或 1"
  [[ -n "$MC_SOURCE" ]] || die "apply / check 必须通过 MC_SOURCE 登记受控 mc 来源"
  [[ "$MC_SOURCE" != *$'\n'* && "$MC_SOURCE" != *$'\r'* ]] || die "MC_SOURCE 不得包含换行"
  MC_VERSION="$("$MC_PATH" --version 2>&1 | sed -n '1p')"
  [[ -n "$MC_VERSION" ]] || die "mc --version 无输出"
  MC_SHA256="$(sha256sum -- "$MC_PATH" | awk '{print $1}')"
  [[ "$MC_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "无法计算 mc SHA-256"
  PYTHON_VERSION="$("$PYTHON_PATH" --version 2>&1 | sed -n '1p')"
  [[ -n "$PYTHON_VERSION" ]] || die "Python --version 无输出"

  local help_specs=(
    "--help"
    "admin user add --help"
    "admin user info --help"
    "admin user svcacct add --help"
    "admin user svcacct info --help"
    "admin policy create --help"
    "admin policy info --help"
    "admin policy attach --help"
    "ls --help"
  )
  local spec
  local -a argv
  for spec in "${help_specs[@]}"; do
    read -r -a argv <<< "$spec"
    "$MC_PATH" "${argv[@]}" >/dev/null 2>&1 || die "mc 兼容性检查失败：mc $spec"
  done

  info "mc: $MC_PATH"
  info "mc source: $MC_SOURCE"
  info "mc version: $MC_VERSION"
  info "mc sha256: $MC_SHA256"
  info "mc compatibility: ok"
  record_toolchain_evidence
}

setup_mc_env() {
  resolve_python
  [[ "$MINIO_ADMIN_ENDPOINT" =~ ^https?://[^/?#]+$ ]] ||
    die "MINIO_ADMIN_ENDPOINT 必须是无路径、查询串和 fragment 的 http(s) 地址"
  local rest="${MINIO_ADMIN_ENDPOINT#*://}"
  [[ "$rest" != *@* ]] || die "MINIO_ADMIN_ENDPOINT 不得包含凭据"

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/f02-s3.XXXXXX")"
  chmod 700 "$TMP_DIR"
  export MC_CONFIG_DIR="$TMP_DIR/mc"
  mkdir -p -- "$MC_CONFIG_DIR"
  chmod 700 "$MC_CONFIG_DIR"
  set_mc_alias f02root "$ROOT_USER" "$ROOT_PASSWORD"
}

mc_run() {
  local -a flags=()
  if [[ "$MC_INSECURE" == "1" ]]; then
    flags+=(--insecure)
  fi
  "$MC_PATH" "${flags[@]}" "$@"
}

set_mc_alias() {
  local alias="$1" access_key="$2" secret_key="$3"
  printf '%s\n%s\n' "$access_key" "$secret_key" |
    mc_run alias set "$alias" "$MINIO_ADMIN_ENDPOINT" >/dev/null
}

canonical_json_equal() {
  local left="$1" right="$2"
  "$PYTHON_PATH" -c '
import json
import sys


def canonical(value):
    if isinstance(value, list):
        mapped = [canonical(item) for item in value]
        if all(isinstance(item, str) for item in mapped):
            return sorted(mapped)
        return sorted(
            mapped,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


try:
    with open(sys.argv[1], "r", encoding="utf-8") as left:
        expected = json.load(left)
    with open(sys.argv[2], "r", encoding="utf-8") as right:
        actual = json.load(right)
    raise SystemExit(0 if canonical(expected) == canonical(actual) else 1)
except Exception:
    raise SystemExit(1)
' "$left" "$right"
}

policy_matches() {
  local name="$1" file="$2" exported="$TMP_DIR/${1}.remote.json"
  rm -f -- "$exported"
  mc_run admin policy info f02root "$name" --policy-file "$exported" >/dev/null 2>&1 || return 10
  canonical_json_equal "$file" "$exported"
}

ensure_policy() {
  local name="$1" file="$2"
  if mc_run admin policy info f02root "$name" >/dev/null 2>&1; then
    if policy_matches "$name" "$file"; then
      info "policy unchanged: $name"
      return
    fi
    die "策略 $name 已存在但与 $file 不一致；S3 不自动覆盖，请按变更控制用 Console 复核后再执行"
  fi
  mc_run admin policy create f02root "$name" "$file" >/dev/null
  policy_matches "$name" "$file" || die "策略写入后校验失败：$name"
  info "policy created: $name"
}

user_policy_matches() {
  local user="$1" policy="$2"
  mc_run --json admin user info f02root "$user" 2>/dev/null | "$PYTHON_PATH" -c '
import json
import sys


def policies(info):
    value = info.get("policyName", "")
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).split(",") if item.strip()]


try:
    info = json.load(sys.stdin)
    status = str(info.get("userStatus", "")).lower()
    raise SystemExit(
        0
        if status in {"enabled", "on"} and policies(info) == [sys.argv[1]]
        else 1
    )
except Exception:
    raise SystemExit(1)
' "$policy"
}

user_policy_has_none() {
  local user="$1"
  mc_run --json admin user info f02root "$user" 2>/dev/null | "$PYTHON_PATH" -c '
import json
import sys


def policies(info):
    value = info.get("policyName", "")
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).split(",") if item.strip()]


try:
    info = json.load(sys.stdin)
    status = str(info.get("userStatus", "")).lower()
    raise SystemExit(0 if status in {"enabled", "on"} and not policies(info) else 1)
except Exception:
    raise SystemExit(1)
'
}

ensure_parent_user() {
  local user="$1" policy="$2"
  if mc_run admin user info f02root "$user" >/dev/null 2>&1; then
    if user_policy_matches "$user" "$policy"; then
      info "parent user unchanged: $user"
      return
    fi
    if ! user_policy_has_none "$user"; then
      die "父用户 $user 已存在但策略或状态与预期不一致；脚本不自动解除现有策略，请人工复核"
    fi
    info "parent user exists without policy: $user"
  else
    command -v openssl >/dev/null 2>&1 || die "缺少 openssl，无法生成一次性 parent 口令"
    openssl rand -base64 48 | tr -d '\r' | mc_run admin user add f02root "$user" >/dev/null
    info "parent user created: $user"
  fi
  mc_run admin policy attach f02root "$policy" --user "$user" >/dev/null
  user_policy_matches "$user" "$policy" ||
    die "父用户 $user 未精确绑定唯一预期策略 $policy"
}

write_service_credentials() {
  local json_file="$1" access_file="$2" secret_file="$3"
  "$PYTHON_PATH" -c '
import json
import os
import sys
import tempfile


try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    access_key = str(parsed["accessKey"])
    secret_key = str(parsed["secretKey"])
    if not access_key or not secret_key:
        raise ValueError("empty credential")
except Exception:
    print("service account JSON 解析失败或缺少 accessKey / secretKey", file=sys.stderr)
    raise SystemExit(1)

values = ((sys.argv[2], access_key), (sys.argv[3], secret_key))
temps = []
try:
    for target, value in values:
        directory = os.path.dirname(os.path.abspath(target))
        fd, temp_path = tempfile.mkstemp(
            prefix="." + os.path.basename(target) + ".f02-s3.", dir=directory
        )
        temps.append(temp_path)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    for temp_path, (target, _) in zip(temps, values):
        os.replace(temp_path, target)
except Exception:
    for temp_path in temps:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
    print("写入 service account Secret 失败", file=sys.stderr)
    raise SystemExit(1)
' "$json_file" "$access_file" "$secret_file"
}

files_match_root() {
  local access_file="$1" secret_file="$2"
  [[ -f "$access_file" && -f "$secret_file" ]] || return 1
  [[ "$(<"$access_file")" == "$ROOT_USER" && "$(<"$secret_file")" == "$ROOT_PASSWORD" ]]
}

service_account_exists() {
  local parent="$1" access_file="$2" secret_file="$3"
  assert_secure_file "$access_file"
  assert_secure_file "$secret_file"
  local access_key
  access_key="$(<"$access_file")"
  mc_run --json admin user svcacct info f02root "$access_key" 2>/dev/null | "$PYTHON_PATH" -c '
import json
import sys


try:
    info = json.load(sys.stdin)
    status = str(info.get("accountStatus", "")).lower()
    expiration = str(info.get("expiration") or "")
    permanent = not expiration or expiration == "1970-01-01T00:00:00Z"
    valid = (
        info.get("parentUser") == sys.argv[1]
        and status in {"enabled", "on"}
        and info.get("impliedPolicy") is True
        and permanent
    )
    raise SystemExit(0 if valid else 1)
except Exception:
    raise SystemExit(1)
' "$parent"
}

ensure_service_account() {
  local parent="$1" name="$2" access_file="$3" secret_file="$4" kind="$5"
  local access_exists=0 secret_exists=0
  [[ -e "$access_file" ]] && access_exists=1
  [[ -e "$secret_file" ]] && secret_exists=1
  if (( access_exists != secret_exists )); then
    die "Secret 文件必须成对存在：$access_file / $secret_file"
  fi
  if (( access_exists == 1 )); then
    if service_account_exists "$parent" "$access_file" "$secret_file"; then
      info "service account unchanged: $name"
      return
    fi
    if [[ "$kind" == "app" ]] && files_match_root "$access_file" "$secret_file"; then
      info "legacy root application credentials detected: $name（本次替换为最小权限 service account）"
    else
      die "现有 Secret 不是 $name 的有效 service account，且不是可识别的 legacy root；请人工复核"
    fi
  fi

  local json_file="$TMP_DIR/${name}.json"
  mc_run --json admin user svcacct add f02root "$parent" --name "$name" --description "F-02 S3 $name" > "$json_file"
  write_service_credentials "$json_file" "$access_file" "$secret_file"
  service_account_exists "$parent" "$access_file" "$secret_file" ||
    die "service account 创建后校验失败：$name"
  info "service account created: $name"
}

probe_service_credentials() {
  local alias="$1" access_file="$2" secret_file="$3"
  assert_secure_file "$access_file"
  assert_secure_file "$secret_file"
  local access_key secret_key
  access_key="$(<"$access_file")"
  secret_key="$(<"$secret_file")"
  [[ "$access_key" =~ ^[A-Za-z0-9]+$ ]] || die "$alias access key 格式异常"
  set_mc_alias "$alias" "$access_key" "$secret_key"
  mc_run ls "${alias}/libiaolink" >/dev/null
}

apply_identities() {
  ensure_policy "$APP_POLICY" "$APP_POLICY_FILE"
  ensure_policy "$BOOTSTRAP_POLICY" "$BOOTSTRAP_POLICY_FILE"
  ensure_parent_user "$APP_USER" "$APP_POLICY"
  ensure_parent_user "$BOOTSTRAP_USER" "$BOOTSTRAP_POLICY"
  ensure_service_account "$APP_USER" "$APP_SVC" \
    "$SECRETS_DIR/s3_access_key" "$SECRETS_DIR/s3_secret_key" app
  ensure_service_account "$BOOTSTRAP_USER" "$BOOTSTRAP_SVC" \
    "$SECRETS_DIR/s3_bootstrap_access_key" "$SECRETS_DIR/s3_bootstrap_secret_key" bootstrap
  info "S3 identity apply complete; api / worker 未重启，运行时仍使用旧环境值"
  info "测试机部署后验证清单见 F-02 方案 S3「测试机部署后验证登记」"
}

check_identities() {
  policy_matches "$APP_POLICY" "$APP_POLICY_FILE" || die "应用策略缺失或与文件不一致"
  policy_matches "$BOOTSTRAP_POLICY" "$BOOTSTRAP_POLICY_FILE" || die "bootstrap 策略缺失或与文件不一致"
  info "policy check: ok"

  mc_run admin user info f02root "$APP_USER" >/dev/null 2>&1 || die "父用户不存在：$APP_USER"
  mc_run admin user info f02root "$BOOTSTRAP_USER" >/dev/null 2>&1 || die "父用户不存在：$BOOTSTRAP_USER"
  user_policy_matches "$APP_USER" "$APP_POLICY" || die "父用户 $APP_USER 策略不符"
  user_policy_matches "$BOOTSTRAP_USER" "$BOOTSTRAP_POLICY" || die "父用户 $BOOTSTRAP_USER 策略不符"
  info "parent user check: ok"

  service_account_exists "$APP_USER" "$SECRETS_DIR/s3_access_key" "$SECRETS_DIR/s3_secret_key" ||
    die "应用 service account 缺失、禁用或 parent 不符"
  service_account_exists "$BOOTSTRAP_USER" "$SECRETS_DIR/s3_bootstrap_access_key" "$SECRETS_DIR/s3_bootstrap_secret_key" ||
    die "bootstrap service account 缺失、禁用或 parent 不符"
  info "service account check: ok"

  probe_service_credentials f02app "$SECRETS_DIR/s3_access_key" "$SECRETS_DIR/s3_secret_key"
  probe_service_credentials f02bootstrap "$SECRETS_DIR/s3_bootstrap_access_key" "$SECRETS_DIR/s3_bootstrap_secret_key"
  info "credential probes: ok（仅 ListBucket，无对象读写）"
  info "S3 identity check complete；负向权限、storage:init --check 与运行时未切换证据待测试机部署后验证"
}

main() {
  local mode="${1:-}"
  case "$mode" in
    lint)
      lint_policy_files
      info "S3 lint complete；未连接 MinIO"
      ;;
    apply)
      require_root
      lint_policy_files
      toolchain_gate
      load_root_credentials
      setup_mc_env
      apply_identities
      ;;
    check)
      require_root
      lint_policy_files
      toolchain_gate
      load_root_credentials
      setup_mc_env
      check_identities
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
