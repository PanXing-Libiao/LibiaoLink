import { z } from "../zod.ts";

/**
 * 认证与会话（identity 模块）契约（ADR-010）。
 * - 浏览器直接导航 /auth/*（根路径，不进 /api/v1）：login / callback / me / logout 由后端承载（g6）。
 * - /auth/me 返回用户与 CSRF 同步 token；Cookie 仍保留可读 ll_csrf 兼容，WAF 将其改写为 HttpOnly 时前端仍可从响应取得。
 */

/** 登录用户：Casdoor JWT-Custom claims 归一化后的稳定口径（name=工号、displayName=姓名）。 */
export const UserSchema = z
  .object({
    id: z.string().nullable().openapi({ example: "a195b721bb30a7d4", description: "Casdoor 用户 ID（claims.id → users.casdoor_id）" }),
    name: z.string().nullable().openapi({ example: "A0001", description: "工号（claims.name → users.username）" }),
    displayName: z.string().nullable().openapi({ example: "张三", description: "姓名（claims.displayName → users.display_name）" }),
    email: z.string().nullable().openapi({ example: "zhangsan@libiaorobot.com" }),
    owner: z.string().nullable().openapi({ example: "libiaorobot.com", description: "所属组织（claims.owner）" }),
  })
  .openapi("User", { description: "登录用户（SSO 归一化口径，ADR-010）" });

/** GET /auth/me 响应：前端以 user 渲染账号区；claims 为 ID Token 原始声明（排障用，前端不依赖具体字段）。 */
export const MeResponseSchema = z
  .object({
    user: UserSchema,
    claims: z.record(z.string(), z.unknown()).openapi({ description: "ID Token 声明（已验签；排障用）" }),
    expiresAt: z.number().int().nullable().openapi({ example: 1758182400, description: "ID Token 到期时间（Unix 秒，UTC）；null = 未知" }),
    csrfToken: z.string().min(1).openapi({
      example: "Q2xvdWQtQ1NSRi10b2tlbi0xNg",
      description: "写请求 X-CSRF-Token 同步值（与 ll_csrf Cookie 一致；响应禁止缓存）",
    }),
  })
  .openapi("MeResponse", { description: "/auth/me 响应（会话由 HttpOnly Cookie 承载；CSRF token 随响应下发）" });

/** GET /auth/login 查询参数：returnTo = 登录后回跳的应用内路径（同源白名单校验，非法值回退 /）。 */
export const LoginQuerySchema = z.object({
  returnTo: z.string().optional().openapi({ example: "/projects/12", description: "登录成功后的回跳路径（仅同源相对路径）" }),
});

/** GET /auth/callback 查询参数：授权码回调（state + PKCE 校验；error 场景由 Casdoor 回传）。 */
export const CallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
