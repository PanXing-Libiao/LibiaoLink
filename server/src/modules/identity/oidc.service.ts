import { Injectable, Logger } from "@nestjs/common";
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";

/** JWKS 中的 RSA 公钥（只取验签需要的字段）。 */
interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface PkceRequest {
  state: string;
  verifier: string;
  challenge: string;
}

export interface TokenSet {
  idToken: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * OIDC 客户端（Casdoor，authorization_code + PKCE）。
 * discovery / JWKS / 换令牌 / 验签全部在服务端完成；client_secret 不进浏览器（ADR-010）。
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discoveryCache: { jwksUri: string; expiresAt: number } | null = null;
  private jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;

  constructor(private readonly config: AppConfig) {
    if (config.env.CASDOOR_CLIENT_SECRET === "") {
      this.logger.warn("缺少 CASDOOR_CLIENT_SECRET：复制 .env.example 为 .env 并填入应用 Secret（本地沙箱见 deploy/casdoor/）");
    }
  }

  get issuer(): string {
    return trimTrailingSlashes(this.config.env.CASDOOR_ISSUER);
  }

  createPkceRequest(): PkceRequest {
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { state, verifier, challenge };
  }

  buildAuthorizeUrl(state: string, challenge: string): string {
    const env = this.config.env;
    const url = new URL(this.issuer + "/login/oauth/authorize");
    url.searchParams.set("client_id", env.CASDOOR_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", env.CASDOOR_REDIRECT_URI);
    url.searchParams.set("scope", env.CASDOOR_SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /**
   * 单点登出地址（清 SSO 会话；id_token_hint 来自服务端会话记录）。
   * post_logout_redirect_uri 复用已登记的回调地址（CASDOOR_REDIRECT_URI）：Casdoor 按应用
   * 「许可跳转列表」校验该参数，站点根地址未登记时登出直接落 Casdoor 错误 JSON（2026-10-14
   * test-pm 实测；本地沙箱因 Casdoor 对 localhost 的豁免未暴露）。登出回跳由 /auth/callback
   * 的无参分支处理后落到站点首页。
   */
  buildLogoutUrl(idToken: string | null): string {
    const env = this.config.env;
    const url = new URL(this.issuer + "/api/logout");
    url.searchParams.set("client_id", env.CASDOOR_CLIENT_ID);
    url.searchParams.set("post_logout_redirect_uri", env.CASDOOR_REDIRECT_URI);
    if (idToken !== null) {
      url.searchParams.set("id_token_hint", idToken);
    }
    return url.toString();
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const env = this.config.env;
    const url = new URL(this.issuer + "/api/login/oauth/access_token");
    url.searchParams.set("grant_type", "authorization_code");
    url.searchParams.set("client_id", env.CASDOOR_CLIENT_ID);
    url.searchParams.set("client_secret", env.CASDOOR_CLIENT_SECRET);
    url.searchParams.set("code", code);
    url.searchParams.set("redirect_uri", env.CASDOOR_REDIRECT_URI);
    url.searchParams.set("code_verifier", verifier);
    const body = await this.requestJson<{ id_token?: unknown; error?: unknown; error_description?: unknown }>(url, { method: "POST" });
    if (typeof body.error === "string" && body.error !== "") {
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 换取令牌失败（" + body.error + "）");
    }
    if (typeof body.id_token !== "string" || body.id_token === "") {
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 未返回 ID Token");
    }
    return { idToken: body.id_token };
  }

  /** 验签 + 校验 iss / aud / exp；失败一律 AUTH_CALLBACK_FAILED（对浏览器不泄漏细节）。 */
  async verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    const segments = idToken.split(".");
    if (segments.length !== 3) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 格式非法");
    }
    const header = decodeJson(segments[0]);
    const claims = decodeJson(segments[1]);
    if (header === null || claims === null) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 解析失败");
    }
    if (header.alg !== "RS256") {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 签名算法不受支持");
    }
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const key = await this.fetchSigningKey(kid);
    const signed = segments[0] + "." + segments[1];
    const signature = Buffer.from(segments[2] ?? "", "base64url");
    if (!verifySignature("RSA-SHA256", Buffer.from(signed), key, signature)) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 验签失败");
    }
    this.assertClaims(claims);
    return claims;
  }

  /** 从服务端存储的 ID Token 解出声明（不做验签；值来自本系统数据库，登录时已验签）。 */
  decodeClaims(idToken: string): Record<string, unknown> {
    const segments = idToken.split(".");
    if (segments.length !== 3) {
      return {};
    }
    return decodeJson(segments[1]) ?? {};
  }

  private assertClaims(claims: Record<string, unknown>): void {
    if (claims.iss !== this.issuer) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 签发方不匹配");
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.config.env.CASDOOR_CLIENT_ID)) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 受众不匹配");
    }
    const exp = typeof claims.exp === "number" ? claims.exp : null;
    if (exp === null || exp * 1000 <= Date.now()) {
      throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 已过期");
    }
  }

  private async fetchSigningKey(kid: string | undefined): Promise<KeyObject> {
    const now = Date.now();
    let cache = this.jwksCache;
    if (cache === null || cache.expiresAt <= now) {
      const jwksUri = await this.fetchJwksUri();
      const document = await this.requestJson<{ keys?: unknown }>(new URL(jwksUri), { method: "GET" });
      const keys = Array.isArray(document.keys) ? (document.keys as Jwk[]) : [];
      cache = { keys, expiresAt: now + CACHE_TTL_MS };
      this.jwksCache = cache;
    }
    const candidates = cache.keys.filter((item) => item.kty === "RSA" && typeof item.n === "string" && typeof item.e === "string");
    const matched = (kid === undefined ? undefined : candidates.find((item) => item.kid === kid)) ?? candidates[0];
    if (matched === undefined) {
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 公钥不可用，请稍后重试");
    }
    return createPublicKey({ key: matched as unknown as JsonWebKey, format: "jwk" });
  }

  private async fetchJwksUri(): Promise<string> {
    const now = Date.now();
    const cached = this.discoveryCache;
    if (cached !== null && cached.expiresAt > now) {
      return cached.jwksUri;
    }
    const document = await this.requestJson<{ jwks_uri?: unknown }>(new URL(this.issuer + "/.well-known/openid-configuration"), { method: "GET" });
    if (typeof document.jwks_uri !== "string" || document.jwks_uri === "") {
      throw new AppError("AUTH_CALLBACK_FAILED", "OIDC discovery 文档缺少 jwks_uri");
    }
    this.discoveryCache = { jwksUri: document.jwks_uri, expiresAt: now + CACHE_TTL_MS };
    return document.jwks_uri;
  }

  private async requestJson<T>(url: URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      this.logger.warn("OIDC 请求失败 " + url.pathname + "：" + String(error));
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 服务不可用，请稍后重试");
    }
    if (!response.ok) {
      this.logger.warn("OIDC 响应异常 " + url.pathname + "：HTTP " + String(response.status));
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 服务响应异常（HTTP " + String(response.status) + "）");
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 响应无法解析");
    }
  }
}

function trimTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function decodeJson(segment: string | undefined): Record<string, unknown> | null {
  if (segment === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
