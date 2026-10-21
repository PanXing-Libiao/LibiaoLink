import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import { CallbackQuerySchema, LoginQuerySchema, MeResponseSchema, z } from "@libiaolink/contracts";
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { parseCookieHeader, serializeCookie } from "../../common/http/cookies.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { AppConfig } from "../../config/config.module.js";
import { CSRF_COOKIE, SESSION_COOKIE, TRANSIENT_COOKIE, TRANSIENT_MAX_AGE_SECONDS } from "./auth.constants.js";
import { OidcService } from "./oidc.service.js";
import { safeReturnTo } from "./return-to.js";
import { SessionService } from "./session.service.js";
import { toMeUser } from "./me-user.js";
import { UserService } from "./user.service.js";

type MeResponse = z.infer<typeof MeResponseSchema>;
type LoginQuery = z.infer<typeof LoginQuerySchema>;
type CallbackQuery = z.infer<typeof CallbackQuerySchema>;

interface TransientState {
  state: string;
  verifier: string;
  returnTo: string;
}

const DEFAULT_EXPIRES_IN_SECONDS = 7200;

/**
 * 会话链路（根路径 /auth/*，浏览器直接导航；ADR-010）。
 * 本地开发由 Vite 中间件承载，生产由本控制器承载；前端切换见 k6 卡片。
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
    private readonly users: UserService,
  ) {}

  @Get("login")
  login(@Query(new ZodValidationPipe(LoginQuerySchema)) query: LoginQuery, @Res() response: Response): void {
    const pkce = this.oidc.createPkceRequest();
    const transient: TransientState = { state: pkce.state, verifier: pkce.verifier, returnTo: safeReturnTo(query.returnTo) };
    response.append(
      "Set-Cookie",
      serializeCookie(TRANSIENT_COOKIE, JSON.stringify(transient), {
        httpOnly: true,
        sameSite: "Lax",
        secure: this.cookieSecure,
        maxAgeSeconds: TRANSIENT_MAX_AGE_SECONDS,
      }),
    );
    response.redirect(302, this.oidc.buildAuthorizeUrl(pkce.state, pkce.challenge));
  }

  @Get("callback")
  async callback(
    @Query(new ZodValidationPipe(CallbackQuerySchema)) query: CallbackQuery,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // 单点登出回跳：buildLogoutUrl 复用本回调地址作 post_logout_redirect_uri，
    // 无 code / state / error 的请求即登出落地 —— 302 回站点首页（未登录态由前端统一转登录页）。
    if (query.code === undefined && query.state === undefined && (query.error ?? "") === "") {
      response.redirect(302, "/");
      return;
    }
    if (typeof query.error === "string" && query.error !== "") {
      throw new AppError("AUTH_CALLBACK_FAILED", "SSO 授权失败（" + query.error + "）");
    }
    if (query.code === undefined || query.state === undefined) {
      throw new AppError("AUTH_CALLBACK_FAILED", "缺少 code / state，请从应用入口重新进入");
    }
    const transient = this.readTransient(request);
    if (transient === null) {
      throw new AppError("AUTH_CALLBACK_FAILED", "登录会话已过期，请从应用入口重新进入");
    }
    if (query.state !== transient.state) {
      throw new AppError("AUTH_CALLBACK_FAILED", "state 校验失败（可能同时打开了多个登录标签页），请重新进入");
    }
    const tokens = await this.oidc.exchangeCode(query.code, transient.verifier);
    const claims = await this.oidc.verifyIdToken(tokens.idToken);
    const user = await this.users.upsertFromClaims(claims);
    if (user.status !== "active") {
      throw new AppError("FORBIDDEN", "账号已被禁用，请联系管理员");
    }
    const exp = typeof claims.exp === "number" ? claims.exp : Math.floor(Date.now() / 1000) + DEFAULT_EXPIRES_IN_SECONDS;
    const session = await this.sessions.create({ userId: user.id, idToken: tokens.idToken, expiresAtSeconds: exp });
    const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
    response.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "Lax", secure: this.cookieSecure, maxAgeSeconds: maxAge }),
    );
    response.append(
      "Set-Cookie",
      serializeCookie(CSRF_COOKIE, randomBytes(16).toString("base64url"), { httpOnly: false, sameSite: "Lax", secure: this.cookieSecure, maxAgeSeconds: maxAge }),
    );
    response.append(
      "Set-Cookie",
      serializeCookie(TRANSIENT_COOKIE, "", { httpOnly: true, sameSite: "Lax", secure: this.cookieSecure, maxAgeSeconds: 0 }),
    );
    response.redirect(302, safeReturnTo(transient.returnTo));
  }

  @Get("me")
  async me(@Req() request: Request): Promise<MeResponse> {
    const token = parseCookieHeader(request.headers.cookie)[SESSION_COOKIE];
    if (token === undefined || token === "") {
      throw new AppError("AUTH_REQUIRED", "未登录");
    }
    const resolved = await this.sessions.resolve(token);
    const claims = this.oidc.decodeClaims(resolved.session.idToken);
    const exp = typeof claims.exp === "number" ? claims.exp : Math.floor(resolved.session.expiresAt.getTime() / 1000);
    return { user: toMeUser(resolved.user), claims, expiresAt: exp };
  }

  @Get("logout")
  async logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    const token = parseCookieHeader(request.headers.cookie)[SESSION_COOKIE];
    const idToken = token === undefined || token === "" ? null : await this.sessions.revoke(token);
    for (const name of [SESSION_COOKIE, CSRF_COOKIE, TRANSIENT_COOKIE]) {
      response.append(
        "Set-Cookie",
        serializeCookie(name, "", { httpOnly: name !== CSRF_COOKIE, sameSite: "Lax", secure: this.cookieSecure, maxAgeSeconds: 0 }),
      );
    }
    response.redirect(302, idToken === null ? "/" : this.oidc.buildLogoutUrl(idToken));
  }

  private get cookieSecure(): boolean {
    const flag = this.config.env.SESSION_COOKIE_SECURE;
    if (flag === "true") {
      return true;
    }
    if (flag === "false") {
      return false;
    }
    return this.config.env.NODE_ENV === "production";
  }

  private readTransient(request: Request): TransientState | null {
    const raw = parseCookieHeader(request.headers.cookie)[TRANSIENT_COOKIE];
    if (raw === undefined || raw === "") {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { state?: unknown; verifier?: unknown; returnTo?: unknown };
      if (typeof parsed.state !== "string" || typeof parsed.verifier !== "string") {
        return null;
      }
      return {
        state: parsed.state,
        verifier: parsed.verifier,
        returnTo: safeReturnTo(typeof parsed.returnTo === "string" ? parsed.returnTo : undefined),
      };
    } catch {
      return null;
    }
  }
}
