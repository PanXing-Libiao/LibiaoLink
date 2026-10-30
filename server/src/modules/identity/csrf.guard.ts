import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { AppError } from "../../common/errors/app-error.js";
import { parseCookieHeader } from "../../common/http/cookies.js";
import { CSRF_COOKIE } from "./auth.constants.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF 同步 Token（double-submit）：写请求需 X-CSRF-Token 与 ll_csrf Cookie 一致。
 * /auth/* 自身靠 state + PKCE；本守卫供 /api/v1 写接口挂载（h2 起随业务接口启用）。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }
    const cookieToken = parseCookieHeader(request.headers.cookie)[CSRF_COOKIE];
    const headerToken = request.headers["x-csrf-token"];
    if (cookieToken === undefined || cookieToken === "" || typeof headerToken !== "string" || headerToken !== cookieToken) {
      throw new AppError("CSRF_FAILED", "CSRF 校验失败，请刷新页面后重试");
    }
    return true;
  }
}
