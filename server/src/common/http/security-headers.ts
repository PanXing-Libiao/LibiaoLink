import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";

/** 全站 API 统一安全头；错误响应同样由入口中间件在进入路由前写入。 */
export const HTTP_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

/**
 * F-06（2026-10-23）：关闭 Express 指纹并给所有 API 响应补齐统一安全头。
 * 必须在 listen 前注册；响应头在异常过滤器 / 控制器之前写入，200 / 401 / 404 / 500 同口径。
 * HSTS 仍由 TLS 终止的 Nginx 统一下发，避免内网 HTTP 直连也误带 HSTS。
 */
export function applyHttpSecurityHeaders(app: NestExpressApplication): void {
  app.disable("x-powered-by");
  app.use((_request: Request, response: Response, next: NextFunction): void => {
    for (const [name, value] of Object.entries(HTTP_SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    next();
  });
}
