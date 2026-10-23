#!/usr/bin/env node
// 对象存储初始化（ADR-006 阶段 0）：建桶 + 桶版本控制 + CORS + 未完成分片清理。
// 幂等：可反复执行；`--check` 只读校验（退出码 0/1，可当部署门禁）。
// 用法：npm run storage:init [-- --check]
// 依据：ADR-006 工程要点（桶版本控制 / 草稿 30 天生命周期）、技术设计v0.2 §5.1（分片直传）。
//
// 两条实测口径（2026-09-20，MinIO RELEASE.2025-09-07T16-13-09Z）：
// 1. CORS 在 MinIO 社区版是**服务端配置**（MINIO_API_CORS_ALLOW_ORIGIN），不是桶级 S3 API
//    —— root / 旧版本实测 PutBucketCors 返回 501 NotImplemented；锁定版本的最小权限 IAM 也不提供
//    Get/PutBucketCORS 动作，bootstrap 会得到 AccessDenied。CORS 路径按能力缺失告警，其它 API 的
//    AccessDenied 仍失败；沙箱已在 deploy/minio/docker-compose.yml 里注入该变量。
// 2. 未完成分片 MinIO 自带清理（`mc admin config get local api` 实测 stale_uploads_cleanup_interval=6h /
//    stale_uploads_expiry=24h），lifecycle 规则属于「其它 S3 实现」的兜底；本脚本尝试写入，被拒时告警。
//
// 有意不做的事：**不配置整桶对象过期**。ADR-006 的「草稿 / 临时文件 30 天清理」若用桶前缀过期实现，
// 一旦前缀写宽就会误删定档文件（定档不可变是产品行为）。到期清理按 `files.purge_after` 由 worker 驱动
// （M4-02 回收站卡片），存储侧不承担对象过期。
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

let envModule;
let storageModule;
let s3Module;
try {
  envModule = await import(pathToFileURL(join(distDir, "config", "env.js")).href);
  storageModule = await import(pathToFileURL(join(distDir, "storage", "index.js")).href);
  s3Module = await import("@aws-sdk/client-s3");
} catch (error) {
  console.error("storage:init: 无法加载 dist（先执行 npm run build）：" + String(error));
  process.exit(1);
}

const checkOnly = process.argv.includes("--check");
const env = envModule.loadEnv(process.env);
const client = storageModule.createS3Client(env);
const bucket = env.S3_BUCKET;
const corsOrigins = (process.env.S3_CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin !== "");
const abortIncompleteDays = Number(process.env.S3_ABORT_INCOMPLETE_DAYS ?? "30");

/** 该存储是否压根不实现这个 API（不支持 -> 告警；支持但配置不对 -> 失败）。 */
const NOT_IMPLEMENTED = new Set(["NotImplemented", "NotSupported", "MethodNotAllowed"]);
// MinIO 的 IAM 动作列表不包含 Get/PutBucketCORS；最小权限账号只能得到 AccessDenied。
// 该例外仅适用于 CORS，其它 API 的 AccessDenied 仍必须失败。
const CORS_UNSUPPORTED = new Set([...NOT_IMPLEMENTED, "AccessDenied"]);

const lines = [];
let failed = false;
let warned = 0;
const record = (label, state, detail) => {
  lines.push(`${state === true ? "✓" : state === "warn" ? "⚠" : "✗"} ${label}${detail ? "：" + detail : ""}`);
};
const fail = (label, detail) => {
  failed = true;
  record(label, false, detail);
};
const warn = (label, detail) => {
  warned += 1;
  record(label, "warn", detail);
};

const status = (error) => error?.$metadata?.httpStatusCode;

async function bucketExists() {
  try {
    await client.send(new s3Module.HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (status(error) === 404 || error?.name === "NotFound" || error?.name === "NoSuchBucket") return false;
    throw error;
  }
}

let exists = await bucketExists();
if (!exists && checkOnly) {
  fail("桶存在", `${bucket} 不存在（--check 不修改）`);
} else if (!exists) {
  await client.send(new s3Module.CreateBucketCommand({ Bucket: bucket }));
  exists = true;
  record("建桶", true, bucket);
} else {
  record("桶存在", true, bucket);
}

if (exists) {
  const versioning = await client.send(new s3Module.GetBucketVersioningCommand({ Bucket: bucket }));
  if (versioning.Status === "Enabled") {
    record("桶版本控制", true, "Enabled");
  } else if (checkOnly) {
    fail("桶版本控制", `当前 ${versioning.Status ?? "未开启"}，应为 Enabled`);
  } else {
    await client.send(new s3Module.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    record("桶版本控制", true, "已开启");
  }

  let corsRules = [];
  let corsUnsupported = "";
  try {
    const cors = await client.send(new s3Module.GetBucketCorsCommand({ Bucket: bucket }));
    corsRules = cors.CORSRules ?? [];
  } catch (error) {
    // NoSuchCORSConfiguration（未配置）与 NotImplemented（该存储不实现）要分开：前者可补配置，后者无解。
    corsUnsupported = CORS_UNSUPPORTED.has(error?.name) ? error.name : "";
  }
  const allowed = corsRules.flatMap((rule) => rule.AllowedOrigins ?? []);
  if (corsUnsupported !== "") {
    warn("CORS", `该存储不实现桶级 CORS（${corsUnsupported}）；MinIO 走服务端 MINIO_API_CORS_ALLOW_ORIGIN（沙箱已注入）`);
  } else if (corsOrigins.every((origin) => allowed.includes(origin))) {
    record("CORS", true, corsOrigins.join(", "));
  } else if (checkOnly) {
    warn("CORS", `未配置 ${corsOrigins.join(", ")}（--check 不修改）`);
  } else {
    try {
      await client.send(
        new s3Module.PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: corsOrigins,
                AllowedMethods: ["PUT", "GET", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
      record("CORS", true, corsOrigins.join(", "));
    } catch (error) {
      if (CORS_UNSUPPORTED.has(error?.name)) {
        warn("CORS", `该存储不实现桶级 CORS（${error.name}）；MinIO 走服务端 MINIO_API_CORS_ALLOW_ORIGIN（沙箱已注入）`);
      } else {
        fail("CORS", `${error?.name ?? "未知错误"}：${error?.message ?? error}`);
      }
    }
  }

  const abortRule = {
    ID: "abort-incomplete-multipart",
    Status: "Enabled",
    Filter: { Prefix: "" },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: abortIncompleteDays },
  };
  let lifecycleRules = [];
  let lifecycleUnsupported = "";
  try {
    const lifecycle = await client.send(new s3Module.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    lifecycleRules = lifecycle.Rules ?? [];
  } catch (error) {
    lifecycleUnsupported = NOT_IMPLEMENTED.has(error?.name) ? error.name : "";
  }
  const current = lifecycleRules.find((rule) => rule.ID === abortRule.ID);
  if (current?.AbortIncompleteMultipartUpload?.DaysAfterInitiation === abortIncompleteDays) {
    record("未完成分片清理", true, `${abortIncompleteDays} 天`);
  } else if (lifecycleUnsupported !== "") {
    warn(
      "未完成分片清理",
      `该存储不实现 lifecycle（${lifecycleUnsupported}）；MinIO 自带 stale_uploads_expiry 兜底，其它实现请按厂商方式配置`,
    );
  } else if (checkOnly) {
    warn("未完成分片清理", `未配置 ${abortIncompleteDays} 天规则（--check 不修改）`);
  } else {
    try {
      await client.send(
        // 整份配置是「替换」语义：保留桶上其它规则，只增 / 改本脚本这一条（幂等）。
        new s3Module.PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: [...lifecycleRules.filter((rule) => rule.ID !== abortRule.ID), abortRule] },
        }),
      );
      record("未完成分片清理", true, `${abortIncompleteDays} 天`);
    } catch (error) {
      if (NOT_IMPLEMENTED.has(error?.name) || error?.name === "InvalidArgument") {
        warn(
          "未完成分片清理",
          `该存储拒绝 lifecycle 规则（${error.name}）；MinIO 自带 stale_uploads_expiry 兜底，其它实现请按厂商方式配置`,
        );
      } else {
        fail("未完成分片清理", `${error?.name ?? "未知错误"}：${error?.message ?? error}`);
      }
    }
  }

  let anonymousStatus = null;
  try {
    const response = await fetch(`${env.S3_ENDPOINT.replace(/\/$/, "")}/${bucket}/__anonymous_probe__`);
    anonymousStatus = response.status;
    // 必须读完响应体：Windows 上残留的 fetch 句柄会让进程退出时踩到 libuv 断言。
    await response.arrayBuffer();
  } catch {
    anonymousStatus = null;
  }
  if (anonymousStatus === 200 || anonymousStatus === 206) {
    fail("禁止匿名读取", "桶对匿名 GET 返回 200，请检查桶策略");
  } else {
    record("禁止匿名读取", true, `匿名 GET 被拒（HTTP ${anonymousStatus ?? "无响应"}）`);
  }
}

console.log(`对象存储初始化（${checkOnly ? "只读校验" : "应用配置"}）：${env.S3_ENDPOINT} / 桶 ${bucket}`);
for (const line of lines) console.log("  " + line);
if (warned > 0) console.log(`  （${warned} 项按该存储能力降级为告警，不影响上线，但需运维按厂商方式确认）`);
process.exitCode = failed ? 1 : 0;
