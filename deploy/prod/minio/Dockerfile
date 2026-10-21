# ============================================================
# deploy/prod/minio/Dockerfile · MinIO 本地构建件（quay 下架应急）
# ------------------------------------------------------------
# 背景（2026-10-13 实测）：quay.io/minio/minio 已不可拉（匿名 401 / token $disabled），
#   Docker Hub 无此镜像、dl.min.io 410 Gone、上游仓库 archived —— 镜像站路线全部失效。
# 来源：GitHub Release 官方资产 minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z
#   SHA-256 = 7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f（已校验）
# 构建（服务器；二进制与本文件同级 = /srv/data/images/minio）：
#   docker build -f /opt/libiaolink/deploy/prod/minio/Dockerfile -t libiaolink/minio:RELEASE.2025-09-07T16-13-09Z /srv/data/images/minio
# 运行：compose minio 服务（entrypoint 挂 scripts/minio-entrypoint.sh 注入根凭据；healthcheck 走 busybox wget）。
# ============================================================
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# 官方静态二进制（CGO_ENABLED=0，无需 glibc）
COPY minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z /usr/local/bin/minio
RUN chmod 0555 /usr/local/bin/minio

# 9000 = S3 API / 9001 = 控制台（对外发布范围由 compose 控制）
EXPOSE 9000 9001

# 直接 docker run 的兜底入口（compose 的 entrypoint 覆盖后此 CMD 参数被脚本忽略）
CMD ["minio", "server", "/data"]
