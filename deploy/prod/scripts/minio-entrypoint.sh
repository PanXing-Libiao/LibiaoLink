#!/bin/sh
# ============================================================
# minio-entrypoint.sh · MinIO 根凭据从 secrets 文件注入
# ------------------------------------------------------------
# 用途：compose entrypoint —— 以 root 读 /run/secrets/ → 出口令环境变量 → exec minio。
# 口径：镜像本身对 MINIO_ROOT_USER_FILE 的支持未验证，统一按本仓库「密钥走文件挂载」约定处理。
# ============================================================
set -eu

MINIO_ROOT_USER="$(cat /run/secrets/minio_root_user)"
MINIO_ROOT_PASSWORD="$(cat /run/secrets/minio_root_password)"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD

exec minio server /data --console-address ":9001"
