# ============================================================
# LibiaoLink ONLYOFFICE 文档服务器镜像（S2 · 部署清单）
# ------------------------------------------------------------
# 构建（在 deploy/onlyoffice/ 下）：
#   docker compose build
#
# 口径（docs/PoC-10-部署前置定稿(F1-R3·R6).md）：
#   - 基座 pin：onlyoffice/documentserver:9.4.0.1（决策 D2 · digest 固化；
#     升级 = 改本 FROM + 台账登记 + 跑「升级回归五项」）；
#   - 中文字体：构建期装 Noto Sans CJK SC 并跑 documentserver-generate-allfonts.sh
#     （C 组硬验收项；构建期断言不通过 = 构建失败，不靠人工记得）；
#   - F1/R3 固化：入口包装（service/entrypoint.sh）在容器启动后写 local.json
#     并只重启 ds:docservice（不得依赖每次手工改容器）；启动后自检
#     （service/selfcheck.sh）失败 = 容器不健康；
#   - R6：示例 app（ds:example）保持默认关闭（compose 传 EXAMPLE_ENABLED=false）。
# ============================================================
# syntax=docker/dockerfile:1

FROM onlyoffice/documentserver:9.4.0.1@sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212

# 中文字体（C 组）+ 构建期门禁（字体注册失败直接构建失败）
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && documentserver-generate-allfonts.sh \
 && test "$(fc-list :lang=zh | wc -l)" -ge 1 \
 && grep -q "Noto Sans CJK SC" /var/www/onlyoffice/documentserver/sdkjs/common/AllFonts.js

# F1/R3 入口包装 + 启动后自检
COPY service/entrypoint.sh /usr/local/bin/libiaolink-entrypoint.sh
COPY service/selfcheck.sh   /usr/local/bin/libiaolink-selfcheck.sh
COPY service/patch-client-timeout.py /usr/local/bin/libiaolink-patch-client-timeout.py
RUN chmod 0755 /usr/local/bin/libiaolink-entrypoint.sh /usr/local/bin/libiaolink-selfcheck.sh /usr/local/bin/libiaolink-patch-client-timeout.py \
 && python3 /usr/local/bin/libiaolink-patch-client-timeout.py

ENTRYPOINT ["/usr/local/bin/libiaolink-entrypoint.sh"]
