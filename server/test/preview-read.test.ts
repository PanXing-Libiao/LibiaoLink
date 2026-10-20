import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { AppError } from "../src/common/errors/app-error.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { FileRepository, FileRow, FileVersionRow } from "../src/modules/file/file.repository.js";
import { PreviewReadService } from "../src/modules/file/preview-read.service.js";
import type { PreviewArtifactKey, PreviewArtifactRow, PreviewRepository } from "../src/modules/file/preview.repository.js";
import type { UserService } from "../src/modules/identity/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { DownloadUrlInput, ObjectStorage, SignedUrl } from "../src/storage/index.js";

/**
 * M4-05 读 API 门禁（不连库、不连对象存储）：`GET /files/{id}/preview` 的通道语义。
 * ① 图片直签（S6-前置 · D6）—— 原对象短时签名（TTL 与内联语义）+ **不写审计**（Push 283 起操作日志不记录预览动作）；
 *    不查 / 不落产物行、不投任务；存量产物行（ready / not_ready / failed）一律不参与；指定历史版本签该版本原对象；
 * ② 终态降级 —— 判不出通道 / 无版本两类（不落表不投递）；
 * ③ 404 —— 文件不存在 / 项目不可见 / 版本不属于该文件（同形，防 IDOR）。
 * 产物通道三态（not_ready 补投 / failed 缓存态回原因）为保留段（S6-前置 后无投递、对新请求不可达），
 * 不再从读 API 侧单测（structured 二期启用投递时随投递恢复补测）。
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const VERSION = "66666666-6666-4666-8666-666666666666";
const HISTORY = "88888888-8888-4888-8888-888888888888";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const HASH = "a".repeat(64);
const HASH_HISTORY = "b".repeat(64);
const NOW = new Date("2026-09-23T08:00:00Z");
const SOURCE_KEY = "projects/" + PROJECT + "/files/" + FILE + "/v1/" + HASH + ".png";
const SOURCE_KEY_HISTORY = "projects/" + PROJECT + "/files/" + FILE + "/v2/" + HASH_HISTORY + ".png";

/** 版本对象键（扩展名随文件名 —— Push 256 起预览通道按**版本对象键**扩展名判定：变更更名后历史版本仍按各旧扩展名）。 */
function sourceKeyOf(ext: string): string {
  return "projects/" + PROJECT + "/files/" + FILE + "/v1/" + HASH + "." + ext;
}
const ARTIFACT_KEY = "previews/" + HASH + "/1.0.0/image";
const ARTIFACT_KEY_HISTORY = "previews/" + HASH_HISTORY + "/1.0.0/image";

const ENV = {
  PREVIEW_PIPELINE_VERSION: "1.0.0",
  PREVIEW_URL_TTL_SECONDS: 300,
  ONLYOFFICE_DOCSERVER_URL: "http://docs.local:8001",
  ONLYOFFICE_DOCSERVER_API_BASE_URL: "http://api.internal:3000",
  ONLYOFFICE_JWT_SECRET: "unit-test-secret",
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
    name: "机械设计图纸.png",
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
    objectKey: SOURCE_KEY,
    sizeBytes: 12 * 1024 * 1024,
    contentHash: HASH,
    mime: "image/png",
    uploadedBy: ACTOR,
    uploadedAt: NOW,
    changeRequestId: null,
    ...overrides,
  };
}

function makeArtifactRow(overrides: Partial<PreviewArtifactRow> = {}): PreviewArtifactRow {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    fileId: FILE,
    versionId: VERSION,
    contentHash: HASH,
    target: "image",
    pipelineVersion: "1.0.0",
    status: "not_ready",
    objectKey: null,
    error: null,
    generatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeFileRepository {
  file: FileRow | null = makeFileRow();
  readonly versions = new Map<string, FileVersionRow>([[VERSION, makeVersionRow()]]);

  async findFileById(fileId: string): Promise<FileRow | null> {
    return this.file !== null && this.file.id === fileId ? this.file : null;
  }

  async findVersionById(fileId: string, versionId: string): Promise<FileVersionRow | null> {
    const version = this.versions.get(versionId);
    return version !== undefined && version.fileId === fileId ? version : null;
  }
}

class FakePreviewRepository {
  rows: PreviewArtifactRow[] = [];
  readonly queries: PreviewArtifactKey[] = [];
  readonly ensured: (PreviewArtifactKey & { fileId: string; versionId: string })[] = [];

  async findByKey(key: PreviewArtifactKey): Promise<PreviewArtifactRow | null> {
    this.queries.push(key);
    return (
      this.rows.find(
        (row) =>
          row.contentHash === key.contentHash &&
          row.pipelineVersion === key.pipelineVersion &&
          row.target === key.target,
      ) ?? null
    );
  }

  async ensureRequested(input: PreviewArtifactKey & { fileId: string; versionId: string }): Promise<PreviewArtifactRow> {
    this.ensured.push(input);
    const existing = await this.findByKey(input);
    if (existing !== null) {
      return existing;
    }
    const row = makeArtifactRow({
      fileId: input.fileId,
      versionId: input.versionId,
      contentHash: input.contentHash,
      pipelineVersion: input.pipelineVersion,
      target: input.target,
    });
    this.rows.push(row);
    return row;
  }
}

class FakeStorage {
  readonly signed: DownloadUrlInput[] = [];
  expiresAt = new Date("2026-09-23T08:05:00Z");

  async signDownloadUrl(input: DownloadUrlInput): Promise<SignedUrl> {
    this.signed.push(input);
    return { url: "https://minio.local/" + input.objectKey + "?sig=1", expiresAt: this.expiresAt };
  }
}

class FakePermissionService {
  visible = true;
  readonly calls: string[] = [];

  async assertProjectVisible(_actorId: string, projectId: string): Promise<{ projectId: string; member: boolean; projectManager: boolean }> {
    this.calls.push(projectId);
    if (!this.visible) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    return { projectId, member: true, projectManager: false };
  }
}

class FakeAuditService {
  readonly entries: Record<string, unknown>[] = [];

  async record(_client: unknown, input: Record<string, unknown>): Promise<void> {
    this.entries.push(input);
  }
}

class FakeDatabase {
  readonly outbox: unknown[] = [];
  transactions = 0;
  db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      this.transactions += 1;
      return fn(this.makeTx());
    },
  };

  makeTx() {
    return {
      insert: () => ({
        values: (value: unknown) => {
          this.outbox.push(value);
          return { onConflictDoUpdate: async () => {} };
        },
      }),
    };
  }
}

interface Harness {
  service: PreviewReadService;
  repo: FakeFileRepository;
  previews: FakePreviewRepository;
  storage: FakeStorage;
  permission: FakePermissionService;
  users: FakeUserService;
  audit: FakeAuditService;
  database: FakeDatabase;
}

class FakeUserService {
  readonly names = new Map<string, string>([[ACTOR, "蓝工"]]);

  async getUser(userId: string): Promise<{ displayName: string }> {
    const displayName = this.names.get(userId);
    if (displayName === undefined) {
      throw new AppError("NOT_FOUND", "用户不存在");
    }
    return { displayName };
  }
}

function makeService(env: Partial<Env> = {}): Harness {
  const repo = new FakeFileRepository();
  const previews = new FakePreviewRepository();
  const storage = new FakeStorage();
  const permission = new FakePermissionService();
  const users = new FakeUserService();
  const audit = new FakeAuditService();
  const database = new FakeDatabase();
  const config = new AppConfig({ ...ENV, ...env } as Env);
  const service = new PreviewReadService(
    database as unknown as DatabaseService,
    repo as unknown as FileRepository,
    previews as unknown as PreviewRepository,
    storage as unknown as ObjectStorage,
    permission as unknown as PermissionService,
    users as unknown as UserService,
    config,
  );
  return { service, repo, previews, storage, permission, users, audit, database };
}

describe("PreviewReadService.getPreview（M4-05 读 API）", () => {
  it.each(["step", "stp", "iges", "igs", "stl", "3mf", "obj", "gltf", "glb", "easm", "dxf", "dwg"])(
    "CAD 接入准备（.%s）：即使 MIME 误报为图片或有旧 ready 产物，也不签原对象或投任务",
    async (extension) => {
      const h = makeService();
      h.repo.file = makeFileRow({ name: "模型." + extension });
      h.repo.versions.set(VERSION, makeVersionRow({ mime: "image/png", objectKey: sourceKeyOf(extension) }));
      h.previews.rows = [makeArtifactRow({ status: "ready", objectKey: ARTIFACT_KEY })];

      const result = await h.service.getPreview(FILE, null, ACTOR);

      expect(result).toEqual({
        fileId: FILE,
        versionId: VERSION,
        status: "failed",
        target: null,
        viewer: null,
        url: null,
        expiresAt: null,
        pipelineVersion: null,
        reason: "CAD 在线预览正在升级，暂不可用，请下载原文件查看",
        generatedAt: null,
      });
      expect(h.storage.signed).toHaveLength(0);
      expect(h.previews.queries).toHaveLength(0);
      expect(h.previews.ensured).toHaveLength(0);
      expect(h.database.outbox).toHaveLength(0);
      expect(h.database.transactions).toBe(0);
    },
  );

  it.each(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"])(
    "CAD 不因误报的 Office/PDF MIME（%s）进入查看器",
    async (mime) => {
      const h = makeService();
      h.repo.versions.set(VERSION, makeVersionRow({ mime, objectKey: sourceKeyOf("STEP") }));

      const result = await h.service.getPreview(FILE, null, ACTOR);

      expect(result.status).toBe("failed");
      expect(result.viewer).toBeNull();
      expect(h.storage.signed).toHaveLength(0);
    },
  );

  it("历史 CAD 版本按版本后缀降级；同一文件的历史图片仍可预览", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ name: "更名后的模型.png" });
    h.repo.versions.set(HISTORY, makeVersionRow({ id: HISTORY, mime: null, objectKey: sourceKeyOf("step") }));

    const cad = await h.service.getPreview(FILE, HISTORY, ACTOR);

    expect(cad).toMatchObject({ versionId: HISTORY, status: "failed", url: null, viewer: null });
    expect(cad.reason).toContain("CAD 在线预览正在升级");
    expect(h.storage.signed).toHaveLength(0);

    h.repo.file = makeFileRow({ name: "更名后的模型.step" });
    const image = await h.service.getPreview(FILE, VERSION, ACTOR);

    expect(image).toMatchObject({ versionId: VERSION, status: "ready", target: "image" });
    expect(h.storage.signed).toEqual([{ objectKey: SOURCE_KEY, expiresInSeconds: 300 }]);
  });

  it("CAD 项目不可见时仍返回同形 404，不能通过暂不可预览提示探测文件", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ name: "模型.step" });
    h.repo.versions.set(VERSION, makeVersionRow({ objectKey: sourceKeyOf("step"), mime: null }));
    h.permission.visible = false;

    await expect(h.service.getPreview(FILE, null, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.storage.signed).toHaveLength(0);
    expect(h.previews.queries).toHaveLength(0);
  });

  it("图片直签（缺省当前版本 · S6-前置 D6）：原对象短时签名 + 不写审计 + 产物字段全空", async () => {
    const h = makeService();

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result).toEqual({
      fileId: FILE,
      versionId: VERSION,
      status: "ready",
      target: "image",
      viewer: null,
      url: "https://minio.local/" + SOURCE_KEY + "?sig=1",
      expiresAt: "2026-09-23T08:05:00.000Z",
      pipelineVersion: null,
      reason: null,
      generatedAt: null,
    });
    expect(h.storage.signed).toEqual([{ objectKey: SOURCE_KEY, expiresInSeconds: 300 }]);
    expect(h.audit.entries).toHaveLength(0);
    // 不查产物（findByKey 0 次）/ 不登记 / 不投递 / 不开事务（S6-前置 起无 not_ready 轮询路径）。
    expect(h.previews.queries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
    expect(h.database.transactions).toBe(0);
  });

  it("图片直签签名参数：TTL 取 PREVIEW_URL_TTL_SECONDS，不传 fileName（内联渲染，不改写 Content-Disposition）", async () => {
    const h = makeService({ PREVIEW_URL_TTL_SECONDS: 120 });

    await h.service.getPreview(FILE, null, ACTOR);

    expect(h.storage.signed).toEqual([{ objectKey: SOURCE_KEY, expiresInSeconds: 120 }]);
    expect(Object.keys(h.storage.signed[0]!)).toEqual(["objectKey", "expiresInSeconds"]);
  });

  it("图片直签指定历史版本（A4-06）：签该版本原对象，不写审计", async () => {
    const h = makeService();
    h.repo.versions.set(
      HISTORY,
      makeVersionRow({ id: HISTORY, seq: 2, contentHash: HASH_HISTORY, objectKey: SOURCE_KEY_HISTORY }),
    );

    const result = await h.service.getPreview(FILE, HISTORY, ACTOR);

    expect(result).toMatchObject({
      versionId: HISTORY,
      status: "ready",
      target: "image",
      url: "https://minio.local/" + SOURCE_KEY_HISTORY + "?sig=1",
      pipelineVersion: null,
      generatedAt: null,
    });
    expect(h.storage.signed).toEqual([{ objectKey: SOURCE_KEY_HISTORY, expiresInSeconds: 300 }]);
    expect(h.audit.entries).toHaveLength(0);
    expect(h.previews.queries).toHaveLength(0);
  });

  it("存量产物行（ready）：图片仍直签原对象 —— 产物通道对图片不可达（S6-前置）", async () => {
    const h = makeService();
    h.previews.rows = [
      makeArtifactRow({ status: "ready", objectKey: ARTIFACT_KEY, generatedAt: new Date("2026-09-23T07:00:00Z") }),
    ];

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result.url).toBe("https://minio.local/" + SOURCE_KEY + "?sig=1");
    expect(result.url).not.toContain("previews/");
    expect(h.previews.queries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
  });

  it("存量 not_ready / failed 产物行：图片仍直签（不补投、不被缓存态失败阻塞）", async () => {
    const pending = makeService();
    pending.previews.rows = [makeArtifactRow({ status: "not_ready" })];
    const pendingResult = await pending.service.getPreview(FILE, null, ACTOR);
    expect(pendingResult.status).toBe("ready");
    expect(pendingResult.url).toBe("https://minio.local/" + SOURCE_KEY + "?sig=1");
    expect(pending.previews.ensured).toHaveLength(0);
    expect(pending.database.outbox).toHaveLength(0);

    const failed = makeService();
    failed.previews.rows = [
      makeArtifactRow({ status: "failed", error: "转换失败：UNSUPPORTED_MEDIA（该扩展名暂不支持）" }),
    ];
    const failedResult = await failed.service.getPreview(FILE, null, ACTOR);
    expect(failedResult.status).toBe("ready");
    expect(failedResult.reason).toBeNull();
    expect(failed.storage.signed).toEqual([{ objectKey: SOURCE_KEY, expiresInSeconds: 300 }]);
    expect(failed.database.outbox).toHaveLength(0);
  });

  it("判不出渲染通道（.zip）：终态降级 failed，不查产物 / 不登记 / 不投递 / 不写审计", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ name: "资料包.zip" });
    h.repo.versions.set(VERSION, makeVersionRow({ mime: "application/zip", objectKey: sourceKeyOf("zip") }));

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result.status).toBe("failed");
    expect(result.versionId).toBe(VERSION);
    expect(result.reason).toContain("暂不支持在线预览");
    expect(result.pipelineVersion).toBeNull();
    expect(h.previews.queries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it("文件尚无版本（draft 未完成上传）：终态降级 failed，versionId 为空", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: null });
    h.repo.versions.delete(VERSION);

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result).toEqual({
      fileId: FILE,
      versionId: null,
      status: "failed",
      target: null,
      viewer: null,
      url: null,
      expiresAt: null,
      pipelineVersion: null,
      reason: "文件尚无任何版本（未完成过上传），请下载查看",
      generatedAt: null,
    });
    expect(h.previews.queries).toHaveLength(0);
  });

  it("versionId 不属于该文件 / 不存在 → 404（不查产物）", async () => {
    const h = makeService();
    h.repo.versions.set(HISTORY, makeVersionRow({ id: HISTORY, fileId: "33333333-3333-4333-8333-333333333333" }));

    await expect(h.service.getPreview(FILE, HISTORY, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.previews.queries).toHaveLength(0);
    expect(h.storage.signed).toHaveLength(0);
  });

  it("文件不存在 → 404（且不判可见性）", async () => {
    const h = makeService();
    h.repo.file = null;

    await expect(h.service.getPreview(FILE, null, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.permission.calls).toHaveLength(0);
  });

  it("项目不可见 → 404（越权与不存在同形；不签发、不审计、不补投）", async () => {
    const h = makeService();
    h.permission.visible = false;

    await expect(h.service.getPreview(FILE, null, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.previews.queries).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
    expect(h.storage.signed).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });
});

describe("PreviewReadService.getPreview（S3 · ONLYOFFICE 查看器通道）", () => {
  it("PDF 并入查看器通道（2026-10-08 业务口径「统一用onlyoffice」）：ready + viewer（documentType / fileType = pdf）、不查产物 / 不投递", async () => {
    const h = makeService();
    // 默认 fixture 为 png（产物通道用例）；这里显式改回 PDF，锁定「PDF 不再走源直通产物」的新口径。
    h.repo.file = makeFileRow({ name: "机械设计图纸.pdf" });
    h.repo.versions.set(VERSION, makeVersionRow({ mime: "application/pdf", objectKey: sourceKeyOf("pdf") }));

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result).toMatchObject({
      status: "ready",
      target: null,
      url: null,
      viewer: { kind: "onlyoffice", documentType: "pdf", document: { title: "机械设计图纸.pdf", fileType: "pdf" } },
    });
    expect(h.previews.queries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
    expect(h.storage.signed).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it("Office（docx）→ ready + viewer 非空：不查产物 / 不投递 / 不签名 / 不写审计（Push 283 起操作日志不记录预览动作）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ name: "方案.docx" });
    h.repo.versions.set(
      VERSION,
      makeVersionRow({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", objectKey: sourceKeyOf("docx") }),
    );

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result).toMatchObject({
      fileId: FILE,
      versionId: VERSION,
      status: "ready",
      target: null,
      url: null,
      expiresAt: null,
      pipelineVersion: null,
      reason: null,
      generatedAt: null,
    });
    expect(result.viewer).toMatchObject({
      kind: "onlyoffice",
      docServerUrl: "http://docs.local:8001",
      documentType: "word",
      document: {
        title: "方案.docx",
        url: "http://api.internal:3000/api/v1/files/" + FILE + "/versions/" + VERSION + "/preview-content",
        fileType: "docx",
        key: HASH,
        // Push 258 错层修正：权限段嵌 document（ONLYOFFICE 只认该位置）。
        permissions: { edit: false, download: true, print: false, comment: false, chat: false, fillForms: false, protect: true },
      },
      editorConfig: { mode: "view", lang: "zh-CN", user: { id: ACTOR, name: "蓝工" } },
    });
    expect(h.previews.queries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
    expect(h.storage.signed).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it("viewer token：HS256 逐字签发（permissions 嵌 document · Push 258 错层修正）+ iat/exp（TTL = ONLYOFFICE_JWT_TTL_SECONDS），document.url 不含存储凭证", async () => {
    const h = makeService({ ONLYOFFICE_JWT_TTL_SECONDS: 900 });
    h.repo.file = makeFileRow({ name: "说明.txt" });
    h.repo.versions.set(VERSION, makeVersionRow({ mime: "text/plain", objectKey: sourceKeyOf("txt") }));

    const result = await h.service.getPreview(FILE, null, ACTOR);

    const token = result.viewer!.token;
    const [header, payload, signature] = token.split(".");
    expect(signature).toBeDefined();
    expect(createHmac("sha256", "unit-test-secret").update(header + "." + payload).digest("base64url")).toBe(signature);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
      documentType: string;
      document: { url: string; key: string; permissions: { edit: boolean; download: boolean } };
      editorConfig: { mode: string };
      iat: number;
      exp: number;
    };
    expect(claims.documentType).toBe("word");
    expect(claims.document.url).toBe(
      "http://api.internal:3000/api/v1/files/" + FILE + "/versions/" + VERSION + "/preview-content",
    );
    expect(claims.document.url).not.toContain("X-Amz-");
    expect(claims.document.key).toBe(HASH);
    // Push 258 业务口径「原本的下载不要隐藏」：download 保持可见（点击由前端命中层接原文件链）。
    expect(claims.document.permissions.download).toBe(true);
    expect(claims.document.permissions.edit).toBe(false);
    expect((claims as Record<string, unknown>).permissions).toBeUndefined();
    expect(claims.editorConfig.mode).toBe("view");
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("文本族 / Office 映射：csv → cell、无扩展名按 MIME 反推（ms-excel → cell/xls）", async () => {
    const csv = makeService();
    csv.repo.file = makeFileRow({ name: "清单.csv" });
    csv.repo.versions.set(VERSION, makeVersionRow({ mime: "text/csv", objectKey: sourceKeyOf("csv") }));
    const csvResult = await csv.service.getPreview(FILE, null, ACTOR);
    expect(csvResult.viewer).toMatchObject({ documentType: "cell", document: { fileType: "csv" } });

    const byMime = makeService();
    byMime.repo.file = makeFileRow({ name: "无扩展名" });
    byMime.repo.versions.set(VERSION, makeVersionRow({ mime: "application/vnd.ms-excel", objectKey: "projects/" + PROJECT + "/files/" + FILE + "/v1/" + HASH + ".bin" }));
    const byMimeResult = await byMime.service.getPreview(FILE, null, ACTOR);
    expect(byMimeResult.viewer).toMatchObject({ documentType: "cell", document: { fileType: "xls" } });
  });

  it("（Push 256）变更更名后按版本对象键扩展名判通道：新版本 .pptx → slide/pptx；历史版本 .xls → cell/xls（旧内容不被当成新扩展名 —— 修 ONLYOFFICE -85「扩展名不一致」）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ name: "回放-变更后.pptx" });
    h.repo.versions.set(
      VERSION,
      makeVersionRow({
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        objectKey: "projects/" + PROJECT + "/files/" + FILE + "/v2/" + HASH + ".pptx",
      }),
    );
    h.repo.versions.set(
      HISTORY,
      makeVersionRow({ id: HISTORY, seq: 1, contentHash: HASH_HISTORY, mime: "application/vnd.ms-excel", objectKey: "projects/" + PROJECT + "/files/" + FILE + "/v1/" + HASH_HISTORY + ".xls" }),
    );

    const current = await h.service.getPreview(FILE, null, ACTOR);
    expect(current.viewer).toMatchObject({
      documentType: "slide",
      document: { title: "回放-变更后.pptx", fileType: "pptx" },
    });

    const history = await h.service.getPreview(FILE, HISTORY, ACTOR);
    expect(history.viewer).toMatchObject({
      documentType: "cell",
      document: { title: "回放-变更后.pptx", fileType: "xls" },
    });
  });

  it("ONLYOFFICE_JWT_SECRET 未配置 → INTERNAL fail closed（不签发、不审计、不落表）", async () => {
    const h = makeService({ ONLYOFFICE_JWT_SECRET: "" });
    h.repo.file = makeFileRow({ name: "方案.docx" });
    h.repo.versions.set(
      VERSION,
      makeVersionRow({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", objectKey: sourceKeyOf("docx") }),
    );

    await expect(h.service.getPreview(FILE, null, ACTOR)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.audit.entries).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
  });

  it("展示名取不到（账号已删）→ 退化 actorId（展示用，不阻塞签发）", async () => {
    const h = makeService();
    h.users.names.delete(ACTOR);
    h.repo.file = makeFileRow({ name: "方案.docx" });
    h.repo.versions.set(
      VERSION,
      makeVersionRow({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", objectKey: sourceKeyOf("docx") }),
    );

    const result = await h.service.getPreview(FILE, null, ACTOR);

    expect(result.viewer).toMatchObject({ editorConfig: { user: { id: ACTOR, name: ACTOR } } });
  });
});
