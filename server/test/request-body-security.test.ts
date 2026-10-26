import { Body, Controller, Get, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApiErrorFilter } from "../src/common/errors/api-error.filter.js";
import { API_BODY_PARSER_OPTIONS, applyApiRequestBodyPolicy } from "../src/common/http/request-body.js";

@Controller()
class RequestBodyProbeController {
  @Post("echo")
  echo(@Body() body: unknown): { body: unknown } {
    return { body };
  }

  @Get("health")
  health(): { ok: true } {
    return { ok: true };
  }
}

async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [RequestBodyProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ ...API_BODY_PARSER_OPTIONS });
  applyApiRequestBodyPolicy(app);
  app.useGlobalFilters(new ApiErrorFilter());
  app.useLogger(false);
  await app.init();
  return app;
}

function compressedJsonWithTrailingBytes(): Buffer {
  return Buffer.concat([gzipSync(Buffer.from(JSON.stringify({ ok: true }))), Buffer.from("trailing-bytes")]);
}

describe("请求体解析安全（GHSA-27r3-jxmh-p828）", () => {
  it("普通 JSON 请求体仍可解析", async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .post("/echo")
        .set("Content-Type", "application/json")
        .send({ ok: true });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ body: { ok: true } });
    } finally {
      await app.close();
    }
  });

  it("压缩 JSON（含尾随字节）在解压前返回 415，且进程仍可响应健康探针", async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .post("/echo")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "gzip")
        .send(compressedJsonWithTrailingBytes());
      expect(response.status).toBe(415);

      const health = await request(app.getHttpServer()).get("/health");
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("压缩 URL-encoded 请求体同样返回 415，不存在默认解析器绕过", async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .post("/echo")
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Content-Encoding", "gzip")
        .send(gzipSync(Buffer.from("ok=true")));
      expect(response.status).toBe(415);
    } finally {
      await app.close();
    }
  });

  it("Nginx 对全部 API 反代入口拒绝非 identity 请求编码，且不剥离编码头", () => {
    const config = readFileSync(new URL("../../deploy/prod/nginx/libiaolink.conf", import.meta.url), "utf8");
    const httpsStart = config.indexOf("listen 443 ssl;");
    const httpsEnd = config.indexOf("# ---- 9443");
    expect(httpsStart).toBeGreaterThan(-1);
    expect(httpsEnd).toBeGreaterThan(httpsStart);
    const httpsBlock = config.slice(httpsStart, httpsEnd);

    expect(httpsBlock.match(/proxy_pass http:\/\/api_backend;/g)).toHaveLength(4);
    expect(httpsBlock.match(/\$http_content_encoding !~\* "\^\(identity\)\?\$"/g)).toHaveLength(4);
    expect(httpsBlock.match(/return 415;/g)).toHaveLength(4);
    expect(httpsBlock).not.toContain("proxy_set_header Content-Encoding");
  });
});
