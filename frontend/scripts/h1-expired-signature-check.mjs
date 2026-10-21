#!/usr/bin/env node
/**
 * H1 旧式原对象签名到期校验（等价复测，不是历史 URL 重放）。
 *
 * 该脚本直接对对象存储签发与旧预览链路同形的 GetObject URL：
 * image/svg+xml + inline，但只读取字节、不在有效期内执行。
 * 等 URL 超过 PREVIEW_URL_TTL_SECONDS 后断言 403，再用 Headless Chrome
 * 顶层打开确认响应已不是 SVG，脚本标记未执行。
 *
 * 证据纪律：只记录 origin + pathname、状态、Content-Type 与结论；不写签名 query。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const requireFromServer = createRequire(path.join(REPO_ROOT, "server", "package.json"));
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = requireFromServer("@aws-sdk/client-s3");
const { getSignedUrl } = requireFromServer("@aws-sdk/s3-request-presigner");

const UPLOAD_ENDPOINT = (process.env.H1_S3_ENDPOINT ?? "").replace(/\/+$/, "");
const PUBLIC_ENDPOINT = (process.env.H1_PUBLIC_S3_ENDPOINT ?? process.env.H1_S3_ENDPOINT ?? "").replace(/\/+$/, "");
const REGION = process.env.H1_S3_REGION ?? "us-east-1";
const BUCKET = process.env.H1_S3_BUCKET ?? "libiaolink";
const ACCESS_KEY = process.env.H1_S3_ACCESS_KEY ?? "";
const SECRET_KEY = process.env.H1_S3_SECRET_KEY ?? "";
const TTL_SECONDS = Number(process.env.H1_PREVIEW_URL_TTL_SECONDS ?? "300");
const WAIT_SECONDS = Number(process.env.H1_SIGNATURE_WAIT_SECONDS ?? String(TTL_SECONDS + 15));
const ARTIFACT_DIR = process.env.H1_ARTIFACT_DIR ?? path.join(REPO_ROOT, "tmp", "h1-signature-expiry");
const CHROME_PATH = process.env.CHROME_PATH ?? (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "google-chrome");

const marker = "H1_OLD_SIGNATURE_EXECUTED";
const objectKey = "projects/h1-signature-expiry/" + randomUUID() + "/source.svg";
const svg = Buffer.from(
  "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"180\" onload=\"window.__h1OldSignatureMarker=1\">" +
    "<script>document.title=\"" + marker + "\";fetch(\"/api/v1/projects\",{method:\"POST\",body:\"{}\"})</script>" +
    "<rect width=\"320\" height=\"180\" fill=\"#ef4444\"/>" +
  "</svg>",
  "utf8",
);
const summary = {
  schemaVersion: 1,
  suite: "H1 old-style original-object signed URL expiry",
  kind: "equivalent-retest",
  generatedAt: new Date().toISOString(),
  ttlSeconds: TTL_SECONDS,
  waitSeconds: WAIT_SECONDS,
  objectPath: "/" + BUCKET + "/" + objectKey,
  beforeExpiry: null,
  afterExpiry: null,
  browserTopLevel: null,
  cleanup: null,
  boundary: "新签旧式 URL 的等价复测，不是历史 URL 原样重放；只验证过期后不可执行。",
  error: null,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeLocation(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return "[invalid-url]";
  }
}

function redact(value) {
  return String(value)
    .replace(/([?&](?:X-Amz-[^=]+|token|Signature|Credential|Security-Token|Expires)=)[^&\s"<>]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s"?<>]+\?)[^\s"<>]+/g, "$1[REDACTED]");
}

function createClient(endpoint) {
  return new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
}

function waitWithProgress(milliseconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      process.stdout.write("waiting " + String(elapsed) + "s / " + String(WAIT_SECONDS) + "s\n");
    }, 30_000);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, milliseconds);
  });
}

function chromeDump(url) {
  const profile = path.resolve(os.tmpdir(), "h1-expired-signature-" + randomUUID());
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  assert(profile.startsWith(tmpRoot), "临时 profile 越界");
  return new Promise((resolve, reject) => {
    execFile(
      CHROME_PATH,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--ignore-certificate-errors",
        "--user-data-dir=" + profile,
        "--dump-dom",
        url,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        rm(profile, { recursive: true, force: true }).catch(() => {});
        if (error) {
          reject(new Error(redact(error.message) + " " + redact(stderr)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function main() {
  assert(UPLOAD_ENDPOINT !== "", "缺少 H1_S3_ENDPOINT");
  assert(PUBLIC_ENDPOINT !== "", "缺少 H1_PUBLIC_S3_ENDPOINT / H1_S3_ENDPOINT");
  assert(ACCESS_KEY !== "" && SECRET_KEY !== "", "缺少 H1_S3_ACCESS_KEY / H1_S3_SECRET_KEY");
  assert(Number.isInteger(TTL_SECONDS) && TTL_SECONDS >= 30, "TTL 不合法");
  assert(Number.isInteger(WAIT_SECONDS) && WAIT_SECONDS > TTL_SECONDS, "等待时间必须大于 TTL");
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const uploadClient = createClient(UPLOAD_ENDPOINT);
  const signClient = createClient(PUBLIC_ENDPOINT);
  try {
    await uploadClient.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: objectKey,
      Body: svg,
      ContentType: "application/octet-stream",
      CacheControl: "no-store",
    }));
    const signedUrl = await getSignedUrl(
      signClient,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
        ResponseContentType: "image/svg+xml",
        ResponseContentDisposition: "inline; filename=\"h1-old-signature.svg\"",
        ResponseCacheControl: "no-store",
      }),
      { expiresIn: TTL_SECONDS },
    );
    summary.signedUrl = safeLocation(signedUrl);

    const before = await fetch(signedUrl, { redirect: "manual" });
    const beforeBytes = Buffer.from(await before.arrayBuffer());
    const beforeType = before.headers.get("content-type") ?? "";
    assert(before.status === 200, "未过期签名读取失败：" + String(before.status));
    assert(beforeType.toLowerCase().startsWith("image/svg+xml"), "未过期签名未按旧链路返回 image/svg+xml：" + beforeType);
    assert(beforeBytes.includes(Buffer.from(marker)), "未过期签名未返回预期 SVG 字节");
    summary.beforeExpiry = {
      status: before.status,
      contentType: beforeType,
      bytes: beforeBytes.length,
      sha256: createHash("sha256").update(beforeBytes).digest("hex"),
    };
    process.stdout.write("PASS 未过期签名可读：" + safeLocation(signedUrl) + " / " + beforeType + "\n");

    await waitWithProgress(WAIT_SECONDS * 1000);

    const expired = await fetch(signedUrl, { redirect: "manual" });
    const expiredBytes = Buffer.from(await expired.arrayBuffer());
    const expiredText = expiredBytes.toString("utf8");
    const expiredType = expired.headers.get("content-type") ?? "";
    assert(expired.status === 403, "过期签名仍可读取：HTTP " + String(expired.status));
    assert(!expiredText.includes("<svg"), "过期签名仍返回 SVG 内容");
    summary.afterExpiry = {
      status: expired.status,
      contentType: expiredType,
      bytes: expiredBytes.length,
      containsSvg: false,
    };
    process.stdout.write("PASS 过期签名拒绝：HTTP 403 / " + expiredType + "\n");

    const dom = await chromeDump(signedUrl);
    const lower = dom.toLowerCase();
    assert(!lower.includes("<svg"), "Headless Chrome 顶层仍渲染 SVG");
    assert(!lower.includes(marker.toLowerCase()), "Headless Chrome 顶层出现脚本执行标记");
    assert(!lower.includes("__h1oldsignaturemarker"), "Headless Chrome 顶层出现脚本全局标记");
    summary.browserTopLevel = {
      status: "passed",
      containsSvg: false,
      markerExecuted: false,
      domBytes: Buffer.byteLength(dom, "utf8"),
    };
    process.stdout.write("PASS Headless Chrome 顶层无 SVG / 无脚本标记\n");
    summary.cleanup = { objectDeleted: true };
    process.stdout.write("H1 old-style signed URL expiry check passed: " + path.join(ARTIFACT_DIR, "summary.json") + "\n");
  } finally {
    await uploadClient.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: objectKey })).catch((error) => {
      summary.cleanup = { objectDeleted: false, error: redact(error.message) };
    });
    await writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  }
}

main().catch(async (error) => {
  summary.error = redact(error instanceof Error ? error.message : String(error));
  process.stderr.write("H1 old-style signed URL expiry check failed: " + summary.error + "\n");
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8").catch(() => {});
  process.exitCode = 1;
});
