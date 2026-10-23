import { Controller, Get, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { applyHttpSecurityHeaders, HTTP_SECURITY_HEADERS } from "../src/common/http/security-headers.js";

@Controller()
class SecurityProbeController {
  @Get("ok")
  ok(): { ok: boolean } {
    return { ok: true };
  }

  @Get("unauthorized")
  unauthorized(): never {
    throw new UnauthorizedException("probe");
  }

  @Get("boom")
  boom(): never {
    throw new Error("probe failure");
  }
}

describe("HTTP 安全头（F-06）", () => {
  it("200 / 401 / 404 / 500 均带统一安全头，且不暴露 Express 指纹", async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [SecurityProbeController] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    applyHttpSecurityHeaders(app);
    app.useLogger(false);
    await app.init();

    try {
      const cases = [
        ["/ok", 200],
        ["/unauthorized", 401],
        ["/no-such-route", 404],
        ["/boom", 500],
      ] as const;
      for (const [path, status] of cases) {
        const response = await request(app.getHttpServer()).get(path);
        expect(response.status, path).toBe(status);
        for (const [name, value] of Object.entries(HTTP_SECURITY_HEADERS)) {
          expect(response.headers[name.toLowerCase()], path + " " + name).toBe(value);
        }
        expect(response.headers["x-powered-by"], path).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it("Nginx 公网入口把 preview-content 终止为 404，且不回源", () => {
    const config = readFileSync(
      new URL("../../deploy/prod/nginx/libiaolink.conf", import.meta.url),
      "utf8",
    );
    const httpsStart = config.indexOf("listen 443 ssl;");
    const httpsEnd = config.indexOf("# ---- 9443");
    expect(httpsStart).toBeGreaterThan(-1);
    expect(httpsEnd).toBeGreaterThan(httpsStart);
    const httpsBlock = config.slice(httpsStart, httpsEnd);

    const gateStart = httpsBlock.indexOf(
      "location ~* ^/api/v1/files/[^/]+/versions/[^/]+/preview-content/?$ {",
    );
    expect(gateStart).toBeGreaterThan(-1);
    const gateEnd = httpsBlock.indexOf("}", gateStart);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gateBlock = httpsBlock.slice(gateStart, gateEnd + 1);
    expect(gateBlock).toContain("return 404;");
    expect(gateBlock).not.toContain("proxy_pass");

    expect(httpsBlock).toContain("proxy_hide_header X-Powered-By;");
    expect(httpsBlock).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(httpsBlock).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(httpsBlock).toContain(
      'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;',
    );
  });
});
