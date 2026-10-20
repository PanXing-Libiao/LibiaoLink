/** Local integration fixture: real guards/services/engine, substitute business records and storage.
 * Never registered by the application module or deployed as an authentication route. */
import "reflect-metadata";
import { Controller, Get, Param, Post, Res, UseGuards, Inject } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Response, RequestHandler } from "express";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import { AppError } from "../src/common/errors/app-error.js";
import { ApiErrorFilter } from "../src/common/errors/api-error.filter.js";
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

export async function createCadFixture(paths: string[], cache: string, python: string, mesher = "", browser = false, middleware?: RequestHandler) {
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
    async getObject(key: string) { await this.beforeRead?.(); const row = records.find((record) => record.objectKey === key); if (!row) return null; const bytes = await readFile(row.path); if (this.corrupt) bytes[0] ^= 1; return { objectKey: key, bytes, sizeBytes: bytes.byteLength, contentType: "application/step" }; } };
  const config = new AppConfig({ CAD_ENGINE_PYTHON: python, CAD_MESHER_PYTHON: mesher, CAD_CACHE_DIR: cache, CAD_MAX_INPUT_MIB: 64 } as Env);
  const engine = new CadEngineClient(config);
  const cad = new CadPreviewService(repository as unknown as FileRepository, permission as unknown as PermissionService, storage as unknown as ObjectStorage, engine);
  const previews = new PreviewReadService({} as never, repository as never, {} as never, storage as never, permission as never, {} as never, config);
  const sessions = { async resolve(token: string) { if (!["cad-local-a", "cad-local-b"].includes(token)) throw new AppError("AUTH_REQUIRED", "未登录"); return { user: { id: token === "cad-local-a" ? ACTOR_A : ACTOR_B, casdoorId: "local-fixture", username: "local-fixture", displayName: "本地测试", email: null, owner: "local" } }; } };

  @Controller("__cad-smoke")
  class BrowserController {
    @Post("login") login(@Res({ passthrough: true }) response: Response) {
      response.setHeader("Set-Cookie", ["ll_sid=cad-local-a; HttpOnly; SameSite=Lax; Path=/", "ll_csrf=cad-local-csrf; SameSite=Lax; Path=/"]);
      return { localFixture: true };
    }
    @Get("files") files() { return records.map(({ id, versionId, name, size }) => ({ id, versionId, name, size })); }
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
  return { app, engine, cad, records, permission, storage, async close() { await app.close(); await engine.onModuleDestroy(); } };
}
