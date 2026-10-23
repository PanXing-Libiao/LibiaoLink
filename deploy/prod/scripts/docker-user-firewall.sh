#!/usr/bin/env bash
# ============================================================
# deploy/prod/scripts/docker-user-firewall.sh · F-02 S2
# ------------------------------------------------------------
# 在 DOCKER-USER 链中阻断外部接口到 9000 / 9001 / 9443 的 TCP 转发，
# 作为 Compose 端口收口之外的第二层边界。规则只匹配外部接口，不阻断
# Docker 容器之间的直连（容器间走 bridge 接口，不经过这些入接口规则）。
#
# 用法（root）：
#   bash scripts/docker-user-firewall.sh --check
#   bash scripts/docker-user-firewall.sh --apply
#   bash scripts/docker-user-firewall.sh --remove
#   bash scripts/docker-user-firewall.sh --help
#
# 规则幂等：--apply 只删除带本脚本标记的旧规则，再重新插入到链首；
# --remove 也只删除本脚本标记的规则，绝不 flush DOCKER-USER。
# 持久化：由 systemd/libiaolink-docker-user-firewall.service 在 Docker
# 启动后执行 --apply；Docker / 主机重启后的复核见部署 README §9.1。
# ============================================================
set -euo pipefail

readonly CHAIN="DOCKER-USER"
readonly MARKER="libiaolink-f02-s2"
readonly PORTS=(9000 9001 9443)

usage() {
  printf '%s\n' \
    "用法：bash scripts/docker-user-firewall.sh --check|--apply|--remove" \
    "" \
    "  --check   校验 DOCKER-USER 中本脚本规则完整、位于链首且无残留" \
    "  --apply   幂等应用 IPv4 / IPv6 规则（只管理系统自有规则）" \
    "  --remove  只删除本脚本规则；不回滚 Compose 端口绑定" \
    "  --help    显示本帮助"
}

die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "需要 root（请用 sudo 执行）"
  fi
}

external_interfaces() {
  ip -o link show up | awk -F': ' '
    {
      iface = $2
      sub(/@.*/, "", iface)
      if (iface == "lo") next
      if (iface ~ /^(docker|br-|veth|virbr|tun|tap)/) next
      print iface
    }'
}

reject_with() {
  case "$1" in
    ipv4) printf '%s\n' "icmp-port-unreachable" ;;
    ipv6) printf '%s\n' "icmp6-port-unreachable" ;;
    *) die "未知协议族：$1" ;;
  esac
}

family_cmd() {
  case "$1" in
    ipv4) printf '%s\n' "iptables" ;;
    ipv6) printf '%s\n' "ip6tables" ;;
    *) die "未知协议族：$1" ;;
  esac
}

check_chain() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "缺少 $cmd"
  "$cmd" -S "$CHAIN" >/dev/null 2>&1 ||
    die "$cmd 中不存在 $CHAIN；请确认 Docker 已启动（规则不能脱离 Docker 链）"
}

managed_rule_count() {
  local cmd="$1"
  "$cmd" -S "$CHAIN" | awk -v needle="--comment $MARKER" 'index($0, needle) { count += 1 } END { print count + 0 }'
}

remove_managed() {
  local cmd="$1"
  local line
  local -a args
  local removed=0

  check_chain "$cmd"
  while IFS= read -r line; do
    case "$line" in
      "-A $CHAIN "*) ;;
      *) continue ;;
    esac
    [[ "$line" == *"--comment $MARKER"* ]] || continue

    read -r -a args <<< "${line#-A $CHAIN }"
    "$cmd" -D "$CHAIN" "${args[@]}" >/dev/null ||
      die "无法删除 $cmd 旧规则：$line"
    removed=$((removed + 1))
  done < <("$cmd" -S "$CHAIN")

  printf '  %s：移除 %s 条旧规则\n' "$cmd" "$removed"
}

apply_family() {
  local family="$1"
  local cmd reject iface port
  local -a spec

  cmd="$(family_cmd "$family")"
  reject="$(reject_with "$family")"
  check_chain "$cmd"
  remove_managed "$cmd"

  for iface in "${EXTERNAL_IFACES[@]}"; do
    for port in "${PORTS[@]}"; do
      spec=(-i "$iface" -p tcp --dport "$port" -m comment --comment "$MARKER" -j REJECT --reject-with "$reject")
      "$cmd" -I "$CHAIN" 1 "${spec[@]}"
    done
  done

  printf '✓ %s：已应用 %s 个接口 × %s 个端口\n' \
    "$cmd" "${#EXTERNAL_IFACES[@]}" "${#PORTS[@]}"
}

check_family() {
  local family="$1"
  local cmd reject iface port expected=0 count=0 missing=0 ordering_bad=0 managed
  local line
  local -a spec

  cmd="$(family_cmd "$family")"
  reject="$(reject_with "$family")"
  check_chain "$cmd"

  for iface in "${EXTERNAL_IFACES[@]}"; do
    for port in "${PORTS[@]}"; do
      spec=(-i "$iface" -p tcp --dport "$port" -m comment --comment "$MARKER" -j REJECT --reject-with "$reject")
      if ! "$cmd" -C "$CHAIN" "${spec[@]}" >/dev/null 2>&1; then
        printf '✗ %s：缺规则 %s:%s\n' "$cmd" "$iface" "$port" >&2
        missing=1
      fi
      expected=$((expected + 1))
    done
  done

  while IFS= read -r line; do
    case "$line" in
      "-A $CHAIN "*) ;;
      *) continue ;;
    esac
    count=$((count + 1))
    if [ "$count" -le "$expected" ] && [[ "$line" != *"--comment $MARKER"* ]]; then
      ordering_bad=1
    fi
  done < <("$cmd" -S "$CHAIN")

  managed="$(managed_rule_count "$cmd")"
  if [ "$managed" -ne "$expected" ]; then
    printf '✗ %s：标记规则数量 %s，期望 %s\n' "$cmd" "$managed" "$expected" >&2
    missing=1
  fi

  if [ "$ordering_bad" -ne 0 ]; then
    printf '✗ %s：本脚本规则前仍有其它 DOCKER-USER 规则，拦截顺序不可信\n' "$cmd" >&2
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    return 1
  fi
  printf '✓ %s：%s 条规则完整且位于链首\n' "$cmd" "$expected"
}

main() {
  local mode="${1:-}"
  case "$mode" in
    --help|-h)
      usage
      return 0
      ;;
    --check|--apply|--remove) ;;
    *)
      usage >&2
      return 64
      ;;
  esac

  command -v ip >/dev/null 2>&1 || die "缺少 ip 命令"
  require_root

  mapfile -t EXTERNAL_IFACES < <(external_interfaces)
  if [ "${#EXTERNAL_IFACES[@]}" -eq 0 ]; then
    die "未发现外部接口；拒绝在无法识别边界时静默放行"
  fi
  printf '外部接口：%s\n' "${EXTERNAL_IFACES[*]}"

  case "$mode" in
    --apply)
      apply_family ipv4
      apply_family ipv6
      check_family ipv4
      check_family ipv6
      ;;
    --check)
      check_family ipv4
      check_family ipv6
      ;;
    --remove)
      remove_managed iptables
      remove_managed ip6tables
      ;;
  esac
}

main "$@"
