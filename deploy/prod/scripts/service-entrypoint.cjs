#!/usr/bin/env node
// ============================================================
// deploy/prod/scripts/service-entrypoint.cjs · api / worker 容器引导
// ------------------------------------------------------------
// 职责（按序）：
//   1) 以 root 读 /run/secrets（Compose Secret；宿主 chmod 600）→ 注入环境变量；
//   2) 组装 DATABASE_URL（应用角色 libiaolink_api，密码来自 /run/secrets/pg_api_password）；
//   3) 降权到 node(1000:1000) 后 spawn 目标入口（生产门禁：容器进程非 root）；
//   4) 转发 SIGTERM / SIGINT 给子进程，保证 docker stop 时 NestJS 优雅退场。
// 用法（compose command）：
//   node /opt/libiaolink/deploy/service-entrypoint.cjs dist/entry/api.js
//   node /opt/libiaolink/deploy/service-entrypoint.cjs dist/entry/worker.js --health-check
// ============================================================
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SECRETS_DIR = "/run/secrets";
const LEGACY_SECRETS_DIR = "/opt/libiaolink/secrets";
const NODE_UID = 1000;
const NODE_GID = 1000;

/** 生产启动必需项；文件缺失 / 为空 / 非普通文件 / 不可读 → 退出 70（fail closed）。 */
const REQUIRED_SECRET_MAP = [
  ["pg_api_password", null],
  ["casdoor_client_id", "CASDOOR_CLIENT_ID"],
  ["casdoor_client_secret", "CASDOOR_CLIENT_SECRET"],
  ["s3_access_key", "S3_ACCESS_KEY"],
  ["s3_secret_key", "S3_SECRET_KEY"],
  ["internal_sync_token", "INTERNAL_SYNC_TOKEN"],
  ["onlyoffice_jwt_secret", "ONLYOFFICE_JWT_SECRET"],
];

/** 业务可选项；文件缺失或为空 = 明确 unset，禁止从 server.env 回退。 */
const OPTIONAL_SECRET_MAP = [
  ["translate_api_key", "TRANSLATE_API_KEY"],
  ["wecom_app_secret", "WECOM_APP_SECRET"],
  ["wecom_bot_secret", "WECOM_BOT_SECRET"],
];

const ALLOWED_SECRET_FILES = new Set(
  [...REQUIRED_SECRET_MAP, ...OPTIONAL_SECRET_MAP].map(([file]) => file),
);
const MANAGED_ENV_NAMES = [...REQUIRED_SECRET_MAP, ...OPTIONAL_SECRET_MAP]
  .map(([, envName]) => envName)
  .filter((envName) => envName !== null);

function fail(message) {
  console.error("service-entrypoint: " + message);
  process.exit(70);
}

function assertSecretLayout() {
  if (fs.existsSync(LEGACY_SECRETS_DIR)) {
    fail("检测到旧整目录 Secret 挂载 " + LEGACY_SECRETS_DIR + "；拒绝启动");
  }

  let entries;
  try {
    entries = fs.readdirSync(SECRETS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    fail("无法读取 " + SECRETS_DIR + "：" + (error instanceof Error ? error.message : String(error)));
  }

  for (const entry of entries) {
    if (!ALLOWED_SECRET_FILES.has(entry.name)) {
      fail("发现未授权 Secret 文件 " + entry.name + "；拒绝启动");
    }
    if (!entry.isFile()) {
      fail("Secret 项不是普通文件：" + entry.name);
    }
  }
}

function readSecret(name, required) {
  const file = path.join(SECRETS_DIR, name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!required && error && error.code === "ENOENT") return null;
    fail("缺少 Secret " + name);
  }

  if (!stat.isFile()) fail("Secret 不是普通文件：" + name);
  if ((stat.mode & 0o022) !== 0) fail("Secret 权限不允许组或其他用户写入：" + name);

  let value;
  try {
    value = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    fail("Secret 不可读：" + name + "（" + (error instanceof Error ? error.message : String(error)) + "）");
  }
  if (value === "") {
    if (required) fail("必需 Secret 为空：" + name);
    return null;
  }
  if (value.includes("\n") || value.includes("\r")) fail("Secret 不能包含换行：" + name);
  if (value.includes("\0")) fail("Secret 含非法 NUL 字符：" + name);
  return value;
}

assertSecretLayout();

// 先清空所有受管变量，确保 server.env 中残留的旧 Secret 不会成为回退值。
for (const envName of MANAGED_ENV_NAMES) delete process.env[envName];
delete process.env.DATABASE_URL;

for (const [file, envName] of REQUIRED_SECRET_MAP) {
  const value = readSecret(file, true);
  if (envName !== null) process.env[envName] = value;
}
for (const [file, envName] of OPTIONAL_SECRET_MAP) {
  const value = readSecret(file, false);
  if (value !== null) process.env[envName] = value;
}

// DATABASE_URL：应用角色 + Compose Secret；不接受 server.env / 显式环境变量回退。
const password = readSecret("pg_api_password", true);
const host = process.env.DB_HOST || "postgres";
const port = process.env.DB_PORT || "5432";
const name = process.env.DB_NAME || "libiaolink";
process.env.DATABASE_URL =
  "postgres://libiaolink_api:" + encodeURIComponent(password) + "@" + host + ":" + port + "/" + name;

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
