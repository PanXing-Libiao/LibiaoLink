import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BadGatewayException, MethodNotAllowedException, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppError } from "../src/common/errors/app-error.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { FileRepository, FileRow, FileVersionRow } from "../src/modules/file/file.repository.js";
import { buildPreviewContentUrl, signHs256Jwt } from "../src/modules/file/onlyoffice.jwt.js";
import { PreviewContentController } from "../src/modules/file/preview-content.controller.js";
import { PreviewContentService } from "../src/modules/file/preview-content.service.js";
import { StorageError } from "../src/storage/index.js";
import type { GetObjectResult, ObjectStorage } from "../src/storage/index.js";

/**
 * 受控预览内容端点门禁（S3 · 安全定稿 §3.2 / §6 · ADR-030）：
 * ① 200：仅有效 Bearer 可达 —— 版本 mime / Content-Length / inline / no-store / nosniff 响应头 + 字节原样直写
 *    （无重定向、无 Location、无预签名回退）；
 * ② 401 五反例（缺失 / 畸形 / 签名篡改 / 过期超容差 / URL 错配 / alg=none）：统一 AUTH_REQUIRED，
 *    且鉴权先于任何库 / 存储访问（无效凭证不触达业务面）；
 * ③ 404 同形：文件缺失 / 已回收（status / recycledAt 两种）/ 版本缺失 / 对象缺失 —— 状态码与文案完全一致；
 * ④ 存储故障 fail-closed：unavailable → 503、其它 StorageError → 502、未知异常原样抛 —— 响应未被触碰；
 * ⑤ 控制器：非 GET 显式 405（不进业务逻辑）、GET 透传 originalUrl / Authorization 原值。
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const VERSION = "66666666-6666-4666-8666-666666666666";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const HASH = "a".repeat(64);
const NOW = new Date("2026-09-30T08:00:00Z");
const SECRET = "unit-test-secret";
const API_BASE = "http://api.internal:3000";
const REQUEST_PATH = "/api/v1/files/" + FILE + "/versions/" + VERSION + "/preview-content";
const VIEW_URL = buildPreviewContentUrl(API_BASE, FILE, VERSION);
const OBJECT_KEY = "projects/" + PROJECT + "/files/" + FILE + "/v1/" + HASH + ".pdf";
const NOT_FOUND_MESSAGE = "文件或版本不存在或不可用";
const OBJECT_BYTES = Uint8Array.from(Buffer.from("%PDF-1.7\npreview-content unit-test bytes\n", "ascii"));

const ENV = {
  ONLYOFFICE_DOCSERVER_URL: "http://docs.local:8001",
  ONLYOFFICE_DOCSERVER_API_BASE_URL: API_BASE,
  ONLYOFFICE_JWT_SECRET: SECRET,
  ONLYOFFICE_JWT_TTL_SECONDS: 900,
  ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS: 60,
} as unknown as Env;

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: FILE,
    projectId: PROJECT,
    nodeId: null,
    taskId: null,
    docType: null,
    name: "机械设计图纸.pdf",
    status: "final",
    currentVersionId: VERSION,
    version: 6,
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: NOW,
    finalizedBy: null,
    recycledAt: null,
    recycledBy: null,
    recycledFromStatus: null,
    purgeAfter: null,
    ...overrides,
  };
}

function makeVersionRow(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: VERSION,
    fileId: FILE,
    seq: 1,
    objectKey: OBJECT_KEY,
    sizeBytes: OBJECT_BYTES.byteLength,
    contentHash: HASH,
    mime: "application/pdf",
    uploadedBy: ACTOR,
    uploadedAt: NOW,
    changeRequestId: null,
    ...overrides,
  };
}

function makeObjectResult(overrides: Partial<GetObjectResult> = {}): GetObjectResult {
  return {
    objectKey: OBJECT_KEY,
    bytes: OBJECT_BYTES,
    contentType: "application/pdf",
    sizeBytes: OBJECT_BYTES.byteLength,
    ...overrides,
  };
}

class FakeFileRepository {
  file: FileRow | null = makeFileRow();
  readonly versions = new Map<string, FileVersionRow>([[VERSION, makeVersionRow()]]);
  fileLookups = 0;
  versionLookups = 0;

  async findFileById(fileId: string): Promise<FileRow | null> {
    this.fileLookups += 1;
    return this.file !== null && this.file.id === fileId ? this.file : null;
  }

  async findVersionById(fileId: string, versionId: string): Promise<FileVersionRow | null> {
    this.versionLookups += 1;
    const version = this.versions.get(versionId);
    return version !== undefined && version.fileId === fileId ? version : null;
  }
}

class FakeStorage {
  object: GetObjectResult | null = makeObjectResult();
  error: Error | null = null;
  streamError: Error | null = null;
  getObjectCalls = 0;
  streamCalls = 0;
  readonly requested: string[] = [];

  async getObject(objectKey: string): Promise<GetObjectResult | null> {
    this.getObjectCalls += 1;
    this.requested.push(objectKey);
    throw new Error("preview-content 必须走 getObjectStream，不得整读 getObject");
  }

  async getObjectStream(objectKey: string): Promise<{
    stream: Readable;
    sizeBytes: number;
    contentType: string | null;
  } | null> {
    this.streamCalls += 1;
    this.requested.push(objectKey);
    if (this.error !== null) {
      throw this.error;
    }
    if (this.object === null) {
      return null;
    }
    const bytes = this.object.bytes;
    const stream = this.streamError === null
      ? Readable.from([bytes.subarray(0, 3), bytes.subarray(3)])
      : new Readable({
          read() {
            this.destroy(new Error("stream interrupted"));
          },
        });
    return { stream, sizeBytes: this.object.sizeBytes, contentType: this.object.contentType };
  }
}

class FakeResponse extends Writable {
  readonly headers = new Map<string, string | number>();
  statusCode: number | null = null;
  readonly chunks: Buffer[] = [];
  redirectCalls = 0;

  get body(): Uint8Array | null {
    return this.chunks.length === 0 ? null : Buffer.concat(this.chunks);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name: string, value: string | number): void {
    this.headers.set(name, value);
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  redirect(): void {
    this.redirectCalls += 1;
  }
}

interface Harness {
  service: PreviewContentService;
  repo: FakeFileRepository;
  storage: FakeStorage;
  response: FakeResponse;
}

function makeService(env: Partial<Env> = {}): Harness {
  const repo = new FakeFileRepository();
  const storage = new FakeStorage();
  const response = new FakeResponse();
  const config = new AppConfig({ ...ENV, ...env } as Env);
  const service = new PreviewContentService(
    repo as unknown as FileRepository,
    storage as unknown as ObjectStorage,
    config,
  );
  return { service, repo, storage, response };
}

function tokenFor(options: { url?: string; exp?: number; secret?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256Jwt(
    { payload: { url: options.url ?? VIEW_URL }, iat: now, exp: options.exp ?? now + 300 },
    options.secret ?? SECRET,
  );
}

function serve(h: Harness, authorization: string | null = "Bearer " + tokenFor()): Promise<void> {
  return h.service.serve({
    fileId: FILE,
    versionId: VERSION,
    originalUrl: REQUEST_PATH,
    authorization,
    response: h.response as unknown as Response,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("预期抛错但成功返回");
}

describe("PreviewContentService.serve（S3 · 受控端点 · 安全定稿 §3.2）", () => {
  it("200：有效 Bearer → 精确 MIME / Content-Length / inline / no-store / nosniff + 字节原样直写（无重定向）", async () => {
    const h = makeService();

    await serve(h);

    expect(h.storage.requested).toEqual([OBJECT_KEY]);
    expect(h.storage.streamCalls).toBe(1);
    expect(h.storage.getObjectCalls).toBe(0);
    expect(h.response.statusCode).toBe(200);
    expect(h.response.chunks).toHaveLength(2);
    expect(h.response.body).not.toBeNull();
    expect(Buffer.from(h.response.body!)).toEqual(Buffer.from(OBJECT_BYTES));
    expect(h.response.headers.get("Content-Type")).toBe("application/pdf");
    expect(h.response.headers.get("Content-Length")).toBe(OBJECT_BYTES.byteLength);
    expect(h.response.headers.get("Content-Disposition")).toBe("inline");
    expect(h.response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.response.headers.has("Location")).toBe(false);
    expect(h.response.redirectCalls).toBe(0);
  });

  it("对象流中途断开：不把截断内容当成功，销毁响应连接", async () => {
    const h = makeService();
    h.storage.streamError = new Error("stream interrupted");

    await expect(serve(h)).resolves.toBeUndefined();

    expect(h.response.statusCode).toBe(200);
    expect(h.response.destroyed).toBe(true);
  });

  it("只有精确白名单类型可 inline；SVG / HTML / 非法或缺失 MIME → octet-stream + attachment", async () => {
    const custom = makeService();
    custom.repo.versions.set(
      VERSION,
      makeVersionRow({ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
    await serve(custom);
    expect(custom.response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(custom.response.headers.get("Content-Disposition")).toBe("inline");

    const svg = makeService();
    svg.repo.versions.set(VERSION, makeVersionRow({ mime: "image/svg+xml; charset=utf-8" }));
    await serve(svg);
    expect(svg.response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(svg.response.headers.get("Content-Disposition")).toBe("attachment");

    const html = makeService();
    html.repo.versions.set(VERSION, makeVersionRow({ mime: "text/html" }));
    await serve(html);
    expect(html.response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(html.response.headers.get("Content-Disposition")).toBe("attachment");

    const injected = makeService();
    injected.repo.versions.set(VERSION, makeVersionRow({ mime: "application/pdf\r\nX-Evil: 1" }));
    await serve(injected);
    expect(injected.response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(injected.response.headers.get("Content-Disposition")).toBe("attachment");

    const missing = makeService();
    missing.repo.versions.set(VERSION, makeVersionRow({ mime: null }));
    await serve(missing);
    expect(missing.response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(missing.response.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("Authorization 形状：Bearer 大小写不敏感；缺头 / 其它 scheme → 401", async () => {
    const lower = makeService();
    await serve(lower, "bearer " + tokenFor());
    expect(lower.response.statusCode).toBe(200);

    await expect(serve(makeService(), null)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(serve(makeService(), "Basic " + tokenFor())).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("401 五反例（缺失 / 畸形 / 签名篡改 / 过期超容差 / URL 错配 / alg=none）：统一 AUTH_REQUIRED，且不触达库 / 存储", async () => {
    const now = Math.floor(Date.now() / 1000);
    const parts = tokenFor().split(".");
    const tampered = parts[0] + "." + parts[1] + "." + "A".repeat(parts[2]!.length);
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
    const noneBody = Buffer.from(
      JSON.stringify({ payload: { url: VIEW_URL }, iat: now, exp: now + 300 }),
      "utf8",
    ).toString("base64url");
    const otherUrl = buildPreviewContentUrl(API_BASE, FILE, "88888888-8888-4888-8888-888888888888");
    const cases: { name: string; authorization: string | null }[] = [
      { name: "缺失", authorization: null },
      { name: "畸形", authorization: "Bearer abc.def" },
      { name: "签名篡改", authorization: "Bearer " + tampered },
      { name: "过期超容差", authorization: "Bearer " + tokenFor({ exp: now - 61 }) },
      { name: "URL 错配", authorization: "Bearer " + tokenFor({ url: otherUrl }) },
      { name: "alg=none", authorization: "Bearer " + noneHeader + "." + noneBody + ".AAAA" },
    ];
    for (const testCase of cases) {
      const h = makeService();
      const error = await rejectionOf(serve(h, testCase.authorization));
      if (!(error instanceof AppError) || error.code !== "AUTH_REQUIRED" || error.httpStatus !== 401) {
        throw new Error("案例「" + testCase.name + "」预期 AUTH_REQUIRED / 401，实际：" + String(error));
      }
      expect(h.repo.fileLookups).toBe(0);
      expect(h.repo.versionLookups).toBe(0);
      expect(h.storage.requested).toHaveLength(0);
      expect(h.response.statusCode).toBeNull();
      expect(h.response.headers.size).toBe(0);
    }
  });

  it("404 同形：文件缺失 / 已回收（status）/ 已回收（recycledAt）/ 版本缺失 / 对象缺失 —— 404 + 同一条文案", async () => {
    const scenarios: { name: string; prepare: (h: Harness) => void }[] = [
      {
        name: "文件缺失",
        prepare: (h) => {
          h.repo.file = null;
        },
      },
      {
        name: "已回收（status）",
        prepare: (h) => {
          h.repo.file = makeFileRow({ status: "recycled" });
        },
      },
      {
        name: "已回收（recycledAt）",
        prepare: (h) => {
          h.repo.file = makeFileRow({ recycledAt: NOW });
        },
      },
      {
        name: "版本缺失",
        prepare: (h) => {
          h.repo.versions.clear();
        },
      },
      {
        name: "对象缺失",
        prepare: (h) => {
          h.storage.object = null;
        },
      },
    ];
    const outcomes: string[] = [];
    for (const scenario of scenarios) {
      const h = makeService();
      scenario.prepare(h);
      const error = await rejectionOf(serve(h));
      if (!(error instanceof AppError)) {
        throw new Error("案例「" + scenario.name + "」预期 AppError，实际：" + String(error));
      }
      if (error.code !== "NOT_FOUND" || error.httpStatus !== 404 || error.message !== NOT_FOUND_MESSAGE) {
        throw new Error("案例「" + scenario.name + "」语义不符：" + error.code + " / " + error.message);
      }
      outcomes.push(error.code + "|" + error.httpStatus + "|" + error.message);
    }
    expect(new Set(outcomes).size).toBe(1);
  });

  it("存储故障 fail-closed：unavailable → 503、其它 StorageError → 502、未知异常原样抛；响应未被触碰", async () => {
    const unavailable = makeService();
    unavailable.storage.error = new StorageError("unavailable", "桶不可达");
    const error503 = await rejectionOf(serve(unavailable));
    expect(error503).toBeInstanceOf(ServiceUnavailableException);
    expect((error503 as ServiceUnavailableException).getStatus()).toBe(503);
    expect(unavailable.response.statusCode).toBeNull();
    expect(unavailable.response.headers.size).toBe(0);

    const gone = makeService();
    gone.storage.error = new StorageError("object_not_found", "对象不存在");
    const error502 = await rejectionOf(serve(gone));
    expect(error502).toBeInstanceOf(BadGatewayException);
    expect((error502 as BadGatewayException).getStatus()).toBe(502);
    expect(gone.response.statusCode).toBeNull();

    const unexpected = makeService();
    unexpected.storage.error = new TypeError("boom");
    const raw = await rejectionOf(serve(unexpected));
    expect(raw).toBeInstanceOf(TypeError);
  });
});

describe("PreviewContentController（S3 · 仅 GET / 显式 405）", () => {
  it("非 GET（POST / PUT / PATCH / DELETE / HEAD / OPTIONS）→ 405，不进业务逻辑", async () => {
    let calls = 0;
    const controller = new PreviewContentController({
      serve: async () => {
        calls += 1;
      },
    } as unknown as PreviewContentService);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const request = { method, originalUrl: REQUEST_PATH, headers: {} } as unknown as Request;
      const error = await rejectionOf(
        controller.previewContent(FILE, VERSION, request, new FakeResponse() as unknown as Response),
      );
      if (!(error instanceof MethodNotAllowedException) || error.getStatus() !== 405) {
        throw new Error("方法 " + method + " 预期 405，实际：" + String(error));
      }
    }
    expect(calls).toBe(0);
  });

  it("GET：向服务透传 fileId / versionId / originalUrl / authorization 原值（不解析 / 不复写）", async () => {
    const captured: { fileId: string; versionId: string; originalUrl: string; authorization: string | null }[] = [];
    const controller = new PreviewContentController({
      serve: async (input: {
        fileId: string;
        versionId: string;
        originalUrl: string;
        authorization: string | null;
      }) => {
        captured.push({
          fileId: input.fileId,
          versionId: input.versionId,
          originalUrl: input.originalUrl,
          authorization: input.authorization,
        });
      },
    } as unknown as PreviewContentService);
    const request = {
      method: "GET",
      originalUrl: REQUEST_PATH + "?trace=1",
      headers: { authorization: "Bearer token-1" },
    } as unknown as Request;

    await controller.previewContent(FILE, VERSION, request, new FakeResponse() as unknown as Response);

    expect(captured).toEqual([
      { fileId: FILE, versionId: VERSION, originalUrl: REQUEST_PATH + "?trace=1", authorization: "Bearer token-1" },
    ]);
  });

  it("GET 全链（控制器 → 服务 → 响应）：200 字节直写、无重定向", async () => {
    const h = makeService();
    const controller = new PreviewContentController(h.service);
    const request = {
      method: "GET",
      originalUrl: REQUEST_PATH,
      headers: { authorization: "Bearer " + tokenFor() },
    } as unknown as Request;

    await controller.previewContent(FILE, VERSION, request, h.response as unknown as Response);

    expect(h.response.statusCode).toBe(200);
    expect(Buffer.from(h.response.body!)).toEqual(Buffer.from(OBJECT_BYTES));
    expect(h.response.redirectCalls).toBe(0);
  });
});
