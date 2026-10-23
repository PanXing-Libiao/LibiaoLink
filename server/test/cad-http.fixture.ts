/** Local integration fixture: real guards/services/engine, substitute business records and storage.
 * Never registered by the application module or deployed as an authentication route. */
import "reflect-metadata";
import { Controller, Get, Headers, Param, Post, Req, Res, UseGuards, Inject } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Response, RequestHandler } from "express";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import { AppError } from "../src/common/errors/app-error.js";
import { ApiErrorFilter } from "../src/common/errors/api-error.filter.js";
import { readRequestBody } from "../src/common/http/multipart.js";
import { SessionGuard, CurrentActorId } from "../src/modules/identity/auth.guard.js";
import { CsrfGuard as RealCsrfGuard } from "../src/modules/identity/csrf.guard.js";
import { SessionService } from "../src/modules/identity/session.service.js";
import { CadEngineClient } from "../src/modules/file/cad-engine.client.js";
import { CadPreviewService } from "../src/modules/file/cad-preview.service.js";
import { CadPreviewController } from "../src/modules/file/cad-preview.controller.js";
import { PreviewReadService } from "../src/modules/file/preview-read.service.js";
import type { FileRepository } from "../src/modules/file/file.repository.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { ObjectStorage } from "../src/storage/index.js";

export const ACTOR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ACTOR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const LOCAL_COOKIE = "ll_sid=cad-local-a; ll_csrf=cad-local-csrf";
export const LOCAL_COOKIE_B = "ll_sid=cad-local-b; ll_csrf=cad-local-csrf";
export const LOCAL_CSRF = "cad-local-csrf";

@Controller("api/v1/files")
@UseGuards(SessionGuard, RealCsrfGuard)
class PreviewFixtureController {
  constructor(@Inject(PreviewReadService) private readonly previews: PreviewReadService) {}
  @Get(":fileId/preview") preview(@Param("fileId") fileId: string, @CurrentActorId() actorId: string) {
    return this.previews.getPreview(fileId, null, actorId);
  }
}

export async function createCadFixture(paths: string[], cache: string, endpoint: string, browser = false, middleware?: RequestHandler) {
  const importedPaths = new Set<string>();
  const records = await Promise.all(paths.map(async (path, index) => {
    const bytes = await readFile(path), sha = createHash("sha256").update(bytes).digest("hex"), number = String(index + 1).padStart(12, "0");
    return { path, id: "22222222-2222-4222-8222-" + number, versionId: "66666666-6666-4666-8666-" + number,
      name: basename(path), sha, size: bytes.byteLength, objectKey: "fixture/" + sha + extname(path).toLowerCase() };
  }));
  const permission = { revoked: false, async assertProjectVisible() { if (this.revoked) throw new AppError("NOT_FOUND", "项目不存在或不可见"); } };
  const repository = {
    async findFileById(id: string) { const row = records.find((record) => record.id === id); return row ? { id, projectId: "11111111-1111-4111-8111-111111111111", name: row.name, currentVersionId: row.versionId } : null; },
    async findVersionById(id: string, versionId: string) { const row = records.find((record) => record.id === id && record.versionId === versionId); return row ? { id: versionId, fileId: id, objectKey: row.objectKey, contentHash: row.sha, sizeBytes: row.size, mime: "application/step" } : null; },
  };
  const storage = { corrupt: false, beforeRead: undefined as (() => Promise<void>) | undefined,
    async getObject(key: string) { await this.beforeRead?.(); const row = records.find((record) => record.objectKey === key); if (!row) return null; const bytes = await readFile(row.path); if (this.corrupt && bytes.length > 0) bytes[0] = bytes[0]! ^ 1; return { objectKey: key, bytes, sizeBytes: bytes.byteLength, contentType: "application/step" }; } };
  const config = new AppConfig({ NODE_ENV: "test", CAD_ENGINE_URL: endpoint.startsWith("http:") ? endpoint : "",
    CAD_ENGINE_SOCKET: endpoint.startsWith("/") ? endpoint : "", CAD_MAX_INPUT_MIB: 64 } as Env);
  const engine = new CadEngineClient(config);
  const cad = new CadPreviewService(repository as unknown as FileRepository, permission as unknown as PermissionService, storage as unknown as ObjectStorage, engine);
  const previews = new PreviewReadService({} as never, repository as never, {} as never, storage as never, permission as never, {} as never, { record: async () => {} } as never, config);
  const sessions = { async resolve(token: string) { if (!["cad-local-a", "cad-local-b"].includes(token)) throw new AppError("AUTH_REQUIRED", "未登录"); return { user: { id: token === "cad-local-a" ? ACTOR_A : ACTOR_B, casdoorId: "local-fixture", username: "local-fixture", displayName: "本地测试", email: null, owner: "local" } }; } };

  @Controller("__cad-smoke")
  class BrowserController {
    private importing = false;
    @Post("login") login(@Res({ passthrough: true }) response: Response) {
      response.setHeader("Set-Cookie", ["ll_sid=cad-local-a; HttpOnly; SameSite=Lax; Path=/", "ll_csrf=cad-local-csrf; SameSite=Lax; Path=/"]);
      return { localFixture: true };
    }
    @Get("files") files() { return records.map(({ id, versionId, name, size }) => ({ id, versionId, name, size })); }
    @Post("import")
    @UseGuards(SessionGuard, RealCsrfGuard)
    async importFile(@Req() request: IncomingMessage, @Headers("x-cad-filename") encodedName: string | undefined, @Headers("content-type") contentType: string | undefined) {
      if (this.importing) throw new AppError("RATE_LIMITED", "正在导入文件，请稍后再试");
      this.importing = true;
      try {
        let name: string;
        try { name = decodeURIComponent(encodedName ?? ""); } catch { throw new AppError("VALIDATION_FAILED", "文件名无效"); }
        if (contentType !== "application/octet-stream" || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || !/\.(step|stp)$/i.test(name)) throw new AppError("VALIDATION_FAILED", "请选择 .step 或 .stp 文件");
        const bytes = await readRequestBody(request, 64 * 1024 * 1024);
        if (!bytes.length) throw new AppError("VALIDATION_FAILED", "文件为空");
        const sha = createHash("sha256").update(bytes).digest("hex"), existing = records.find(record => record.sha === sha);
        const id = randomUUID(), versionId = randomUUID();
        let path = existing?.path;
        if (!path) {
          const directory = join(cache, "local-imports"); await mkdir(directory, { recursive: true });
          path = join(directory, id + ".step");
          await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); importedPaths.add(path);
        }
        const row = { path, id, versionId, name, sha, size: bytes.byteLength, objectKey: "fixture/" + sha + extname(name).toLowerCase() };
        records.push(row);
        return { id, versionId, name, size: row.size };
      } finally { this.importing = false; }
    }
  }
  const module = await Test.createTestingModule({
    controllers: [CadPreviewController, PreviewFixtureController, ...(browser ? [BrowserController] : [])],
    providers: [{ provide: CadPreviewService, useValue: cad }, { provide: PreviewReadService, useValue: previews },
      { provide: SessionService, useValue: sessions }, SessionGuard, RealCsrfGuard],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new ApiErrorFilter());
  if (middleware !== undefined) app.use(middleware);
  await app.init();
  if (!browser) await app.listen(0, "127.0.0.1");
  return { app, engine, cad, records, permission, storage, async close() { await app.close(); await engine.onModuleDestroy(); await Promise.all([...importedPaths].map(path => rm(path, { force: true }))); } };
}
