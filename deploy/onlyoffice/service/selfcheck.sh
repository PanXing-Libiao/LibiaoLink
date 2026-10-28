#!/usr/bin/env bash
# ============================================================
# LibiaoLink ONLYOFFICE 启动后自检（S2 · 定稿 §1.2 / §1.3）
# 只读、幂等；退出码 0 = 通过（同时用作容器 healthcheck）
# 检查项：① 配置三键（blockPrivateIP / allowPrivateIPAddress / request.outbox）
#         ② 中文字体（fc-list + AllFonts.js）
#         ③ 示例 app 关闭（R6：直连容器侧非 200 为合规）
# ============================================================
set -uo pipefail
TAG="[libiaolink-selfcheck]"
rc=0
say() { printf "%s %s\n" "$TAG" "$*"; }

# ① 配置三键（F1/R3 + outbox 期望态）
if python3 - <<'PY'
import json
import sys

with open("/etc/onlyoffice/documentserver/local.json") as fh:
    data = json.load(fh)
co = data.get("services", {}).get("CoAuthoring", {})
block = co.get("externalRequest", {}).get("action", {}).get("blockPrivateIP")
allow = co.get("request-filtering-agent", {}).get("allowPrivateIPAddress")
outbox = co.get("token", {}).get("enable", {}).get("request", {}).get("outbox")
print("[libiaolink-selfcheck] local.json: blockPrivateIP=%s allowPrivateIPAddress=%s request.outbox=%s" % (block, allow, outbox))
sys.exit(0 if (block is False and allow is True and outbox is True) else 1)
PY
then say "配置三键 OK"; else say "配置三键 FAIL"; rc=1; fi

# ② 中文字体（C 组）
zh=$(fc-list :lang=zh 2>/dev/null | wc -l)
if [ "$zh" -ge 1 ] && grep -q "Noto Sans CJK SC" /var/www/onlyoffice/documentserver/sdkjs/common/AllFonts.js 2>/dev/null; then
  say "中文字体 OK（fc-list=$zh 条，AllFonts.js 含 Noto Sans CJK SC）"
else
  say "中文字体 FAIL（fc-list=$zh 条）"
  rc=1
fi

# ③ 示例 app 关闭（R6）
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/example/ 2>/dev/null || true)
if [ "$code" != "200" ]; then
  say "示例 app 关闭 OK（/example/ -> $code）"
else
  say "示例 app 关闭 FAIL（/example/ -> 200）"
  rc=1
fi

# ④ 查看器冷启动硬超时（2026-10-28 移动端修订：宿主 90 秒先裁决，内嵌模板不得在 30 秒弹窗重载）
timeout_ok=1
for relative in documenteditor/main/index.html spreadsheeteditor/main/index.html presentationeditor/main/index.html pdfeditor/main/index.html; do
  file="/var/www/onlyoffice/documentserver/web-apps/apps/$relative"
  if ! grep -q "waitSeconds: 120" "$file" 2>/dev/null || ! grep -q "}, 120000);" "$file" 2>/dev/null; then
    timeout_ok=0
  fi
done
if [ "$timeout_ok" = "1" ]; then
  say "查看器冷启动超时 OK（120s）"
else
  say "查看器冷启动超时 FAIL（DocServer 模板仍为 30s）"
  rc=1
fi

if [ "$rc" -eq 0 ]; then say "PASS"; else say "FAIL（rc=$rc）"; fi
exit "$rc"
