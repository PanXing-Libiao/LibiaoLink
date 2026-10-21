#!/usr/bin/env node
// ============================================================
// deploy/prod/scripts/service-entrypoint.cjs · api / worker 容器引导
// ------------------------------------------------------------
// 职责（按序）：
//   1) 以 root 读 secrets/ 文件（宿主 chmod 600，仅 root 可读）→ 注入环境变量；
//   2) 组装 DATABASE_URL（应用角色 libiaolink_api，密码来自 secrets；server 只认 DATABASE_URL）；
//   3) 降权到 node(1000:1000) 后 spawn 目标入口（生产门禁：容器进程非 root）；
//   4) 转发 SIGTERM / SIGINT 给子进程，保证 docker stop 时 NestJS 优雅退场。
// 用法（compose command）：
//   node /opt/libiaolink/deploy/service-entrypoint.cjs dist/entry/api.js
//   node /opt/libiaolink/deploy/service-entrypoint.cjs dist/entry/worker.js --health-check
// ============================================================
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const SECRETS_DIR = "/opt/libiaolink/secrets";
const NODE_UID = 1000;
const NODE_GID = 1000;

/** [secrets 文件名, 目标环境变量]；文件缺失或为空 → 跳过（交由应用启动校验 fail fast）。 */
const SECRET_MAP = [
  ["casdoor_client_id", "CASDOOR_CLIENT_ID"],
  ["casdoor_client_secret", "CASDOOR_CLIENT_SECRET"],
  ["s3_access_key", "S3_ACCESS_KEY"],
  ["s3_secret_key", "S3_SECRET_KEY"],
  ["internal_sync_token", "INTERNAL_SYNC_TOKEN"],
  ["onlyoffice_jwt_secret", "ONLYOFFICE_JWT_SECRET"],
  ["translate_api_key", "TRANSLATE_API_KEY"],
  ["wecom_app_secret", "WECOM_APP_SECRET"],
  ["wecom_bot_secret", "WECOM_BOT_SECRET"],
];

function readSecret(name) {
  try {
    const value = fs.readFileSync(SECRETS_DIR + "/" + name, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

for (const [file, envName] of SECRET_MAP) {
  const value = readSecret(file);
  if (value !== null) process.env[envName] = value;
}

// DATABASE_URL：应用角色 + secrets 密码（密码 hex；encode 兜底防特殊字符）
if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "") {
  const password = readSecret("pg_api_password");
  if (password === null) {
    console.error("service-entrypoint: 缺 secrets/pg_api_password，且未显式提供 DATABASE_URL");
    process.exit(70);
  }
  const host = process.env.DB_HOST || "postgres";
  const port = process.env.DB_PORT || "5432";
  const name = process.env.DB_NAME || "libiaolink";
  process.env.DATABASE_URL =
    "postgres://libiaolink_api:" + encodeURIComponent(password) + "@" + host + ":" + port + "/" + name;
}

const target = process.argv.slice(2);
if (target.length === 0) {
  console.error("service-entrypoint: 用法 node service-entrypoint.cjs <入口（如 dist/entry/api.js）> [args...]");
  process.exit(64);
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  process.setgid(NODE_GID);
  process.setuid(NODE_UID);
}

const child = spawn(process.execPath, target, { stdio: "inherit", env: process.env });

child.on("error", (error) => {
  console.error("service-entrypoint: 子进程启动失败：" + error.message);
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* 子进程已退出 */
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code === null ? 1 : code);
  }
});