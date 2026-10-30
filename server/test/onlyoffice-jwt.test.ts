import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import {
  absoluteDocServerApiUrl,
  buildPreviewContentUrl,
  signHs256Jwt,
  verifyPullToken,
  type PullTokenCheck,
} from "../src/modules/file/onlyoffice.jwt.js";

/**
 * ONLYOFFICE JWT 原语门禁（S3 · 安全定稿 §3.2 / C4 / C5）：正例 + 五类反例 + URL 构造 + 环境变量契约。
 * 全部确定性时间（NOW 固定），不依赖真实钟。
 */

const SECRET = "unit-test-secret";
const BASE = "http://api.internal:3000";
const FILE = "22222222-2222-4222-8222-222222222222";
const VERSION = "66666666-6666-4666-8666-666666666666";
const NOW = 1_800_000_000;
const URL_ = buildPreviewContentUrl(BASE, FILE, VERSION);

function tokenFor(options: { url?: string; exp?: number; secret?: string } = {}): string {
  return signHs256Jwt(
    { payload: { url: options.url ?? URL_ }, iat: NOW, exp: options.exp ?? NOW + 300 },
    options.secret ?? SECRET,
  );
}

function verify(token: string | null, expectedUrl: string = URL_): PullTokenCheck {
  return verifyPullToken({ token, secret: SECRET, expectedUrl, nowSeconds: NOW, clockToleranceSeconds: 60 });
}

describe("ONLYOFFICE JWT（HS256 原语 · 安全定稿 §3.2）", () => {
  it("正例：签名 / payload.url 逐字绑定 / exp 未过期 → 通过", () => {
    expect(verify(tokenFor())).toEqual({ ok: true });
  });

  it("反例·缺失：无 token / 空串 → 拒绝", () => {
    expect(verify(null)).toEqual({ ok: false, reason: "malformed" });
    expect(verify("")).toEqual({ ok: false, reason: "malformed" });
  });

  it("反例·篡改：签名被改 → signature 拒绝（payload 篡改 = URL 错配，见下）", () => {
    const token = tokenFor();
    const parts = token.split(".");
    const tampered = parts[0] + "." + parts[1] + "." + "A".repeat(parts[2]!.length);
    expect(verify(tampered)).toEqual({ ok: false, reason: "signature" });
  });

  it("反例·过期：超出容差拒绝、容差内通过（C5：exp > now - tolerance；边界取严）", () => {
    expect(verify(tokenFor({ exp: NOW - 61 }))).toEqual({ ok: false, reason: "expired" });
    expect(verify(tokenFor({ exp: NOW - 60 }))).toEqual({ ok: false, reason: "expired" });
    expect(verify(tokenFor({ exp: NOW - 59 }))).toEqual({ ok: true });
    expect(verify(tokenFor({ exp: NOW + 300 }))).toEqual({ ok: true });
  });

  it("反例·URL 错配：换目标文件 / 换版本 → url_mismatch（不能换目标重放）", () => {
    const otherUrl = buildPreviewContentUrl(BASE, FILE, "88888888-8888-4888-8888-888888888888");
    expect(verify(tokenFor({ url: otherUrl }))).toEqual({ ok: false, reason: "url_mismatch" });
  });

  it("反例·alg=none 伪造（带非空假签名）→ alg 拒绝", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ payload: { url: URL_ }, iat: NOW, exp: NOW + 300 })).toString("base64url");
    expect(verify(header + "." + body + ".AAAA")).toEqual({ ok: false, reason: "alg" });
  });

  it("反例·claims 形状：无 payload.url（浏览器 editor-config 形状）/ 缺 exp → claims 拒绝", () => {
    const editorShape = signHs256Jwt({ documentType: "word", document: { url: URL_ }, exp: NOW + 300 }, SECRET);
    expect(verify(editorShape)).toEqual({ ok: false, reason: "claims" });
    const missingExp = signHs256Jwt({ payload: { url: URL_ }, iat: NOW }, SECRET);
    expect(verify(missingExp)).toEqual({ ok: false, reason: "claims" });
  });

  it("反例·畸形：段数不足 / 非法 base64url → malformed 拒绝", () => {
    expect(verify("abc.def")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("!!!.???.###")).toEqual({ ok: false, reason: "malformed" });
  });

  it("密钥缺失（空串）→ secret_missing（fail closed，不按空密钥验签）", () => {
    const check = verifyPullToken({
      token: tokenFor({ secret: "" }),
      secret: "",
      expectedUrl: URL_,
      nowSeconds: NOW,
      clockToleranceSeconds: 60,
    });
    expect(check).toEqual({ ok: false, reason: "secret_missing" });
  });

  it("URL 构造（C1 同源生成）：基址去尾斜杠 + 固定 path；校验侧拼接同源", () => {
    expect(buildPreviewContentUrl("http://api.internal:3000/", FILE, VERSION)).toBe(URL_);
    expect(buildPreviewContentUrl("http://api.internal:3000", FILE, VERSION)).toBe(URL_);
    expect(absoluteDocServerApiUrl("http://api.internal:3000///", "/api/v1/files/x")).toBe(
      "http://api.internal:3000/api/v1/files/x",
    );
  });
});

describe("env（ONLYOFFICE 查看器 · S3 配置契约）", () => {
  function productionBase(): Record<string, string> {
    return {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x/y",
      CASDOOR_CLIENT_ID: "client",
      CASDOOR_CLIENT_SECRET: "secret",
      CASDOOR_ORG_NAME: "org",
      INTERNAL_SYNC_TOKEN: "token",
      S3_ACCESS_KEY: "key",
      S3_SECRET_KEY: "secret",
      GROUP_ACCESS_ENFORCED: "true",
      GROUP_ACCESS_ADMIN_USER_IDS: "11111111-1111-4111-8111-111111111111",
    };
  }

  it("缺省：TTL 900s（S8-2 定案）/ 容差 60s / DocServer 基址缺省；非生产不要求密钥", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x/y" });
    expect(env.ONLYOFFICE_JWT_TTL_SECONDS).toBe(900);
    expect(env.ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS).toBe(60);
    expect(env.ONLYOFFICE_JWT_SECRET).toBe("");
    expect(env.ONLYOFFICE_DOCSERVER_URL).toBe("http://127.0.0.1:8001");
    expect(env.ONLYOFFICE_DOCSERVER_API_BASE_URL).toBe("http://127.0.0.1:3000");
  });

  it("生产：缺 ONLYOFFICE_JWT_SECRET → 启动失败（fail fast）；配齐后通过", () => {
    expect(() => loadEnv({ ...productionBase() })).toThrow(/ONLYOFFICE_JWT_SECRET/);
    expect(loadEnv({ ...productionBase(), ONLYOFFICE_JWT_SECRET: "shared-secret" }).ONLYOFFICE_JWT_SECRET).toBe(
      "shared-secret",
    );
  });

  it("边界：容差上限 60s（C5）/ TTL 下界 30s", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://x/y", ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS: "61" })).toThrow(
      /ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS/,
    );
    expect(() => loadEnv({ DATABASE_URL: "postgres://x/y", ONLYOFFICE_JWT_TTL_SECONDS: "10" })).toThrow(
      /ONLYOFFICE_JWT_TTL_SECONDS/,
    );
  });
});
