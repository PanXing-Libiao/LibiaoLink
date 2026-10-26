import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule } from "../app.module.js";
import { API_BODY_PARSER_OPTIONS, applyApiRequestBodyPolicy } from "../common/http/request-body.js";
import { applyHttpSecurityHeaders } from "../common/http/security-headers.js";
import { loadEnv } from "../config/env.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
    ...API_BODY_PARSER_OPTIONS,
  });
  applyHttpSecurityHeaders(app);
  // 「我的计划」便签墙（Push 268）：PATCH /users/me/preferences 单请求可携带整面便签墙
  // （契约上限 300 条 × 内容 2000 字，最坏 UTF-8 约 1.8MB）——默认 100kb 会 413，抬到 4mb。
  applyApiRequestBodyPolicy(app);
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

await bootstrap();
