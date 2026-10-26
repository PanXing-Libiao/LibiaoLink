import { UnsupportedMediaTypeException } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";

/**
 * P1（GHSA-27r3-jxmh-p828，2026-10-26）：API 不接收压缩请求体。
 * 关闭 Nest 默认 JSON / URL-encoded parser，避免默认 inflate 路径；仅注册 JSON parser，并显式设置
 * inflate:false。前置中间件同时拒绝所有非 identity 的 Content-Encoding，不能让无解析器的
 * Content-Type 绕过请求编码策略。
 */
export const API_BODY_PARSER_OPTIONS = { bodyParser: false } as const;

export function applyApiRequestBodyPolicy(app: NestExpressApplication): void {
  app.use((request: Request, _response: Response, next: NextFunction): void => {
    const header = request.headers["content-encoding"];
    const contentEncoding = typeof header === "string" ? header.trim().toLowerCase() : undefined;
    if (header !== undefined && contentEncoding !== "identity") {
      next(new UnsupportedMediaTypeException("不支持压缩请求体"));
      return;
    }
    next();
  });
  app.useBodyParser("json", { limit: "4mb", inflate: false });
}
