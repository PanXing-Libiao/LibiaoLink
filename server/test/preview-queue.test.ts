import { afterEach, describe, expect, it, vi } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import type { FileRepository, FileRow, FileVersionRow } from "../src/modules/file/file.repository.js";
import { ConverterError, PreviewConverter, type ConvertInput, type ConvertResult } from "../src/modules/file/preview.converter.js";
import { buildPreviewJobPayload, parsePreviewJob, previewJobDedupeKey } from "../src/modules/file/preview.job.js";
import type { PreviewArtifactKey, PreviewArtifactRow, PreviewRepository } from "../src/modules/file/preview.repository.js";
import { PreviewService } from "../src/modules/file/preview.service.js";
import { isRasterImageFile, isSvgFile, previewTargetsFor, viewerChannelFor } from "../src/modules/file/preview.targets.js";
import { StorageError, type GetObjectResult, type PutObjectInput } from "../src/storage/index.js";
import type { ObjectStorage } from "../src/storage/index.js";

/**
 * M4-05c 预览转换队列门禁（不连库、不连转换器）：
 * ① 转换器客户端 —— 响应头 / 错误面 → 可重试 vs 确定性、管线版本比对、超时与不可达；
 * ② 队列消费（S7-1 收敛为「消费与分类」）—— 三元组幂等（ready 复用 / failed 不原地重试）、产物键与元数据、
 *    失败分类（retry / dead）与终态降级留痕；领取 / 退避排程 / dead 落库在 OutboxDispatcher（见 outbox-dispatcher.test.ts）。
 * 转换器真机行为（沙箱四性 / 中文字体 / 通道矩阵）由 px 线 M4-05b 证据文档与真机回放覆盖，这里只管接线口径。
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const VERSION = "66666666-6666-4666-8666-666666666666";
const HASH = "a".repeat(64);
const NOW = new Date("2026-09-23T08:00:00Z");
const OUTBOX_ID = 4242;
const SOURCE_KEY = `projects/${PROJECT}/files/${FILE}/v1/${HASH}.pdf`;
const ARTIFACT_KEY = `previews/${HASH}/1.0.0/pdf`;

const ENV = {
  PREVIEW_CONVERTER_URL: "http://127.0.0.1:9900",
  PREVIEW_PIPELINE_VERSION: "1.0.0",
  PREVIEW_CONVERT_TIMEOUT_MS: 90000,
  PREVIEW_CONVERT_MAX_ATTEMPTS: 3,
  PREVIEW_CONVERT_BACKOFF_MS: 15000,
  PREVIEW_CONVERT_MAX_SOURCE_MB: 100,
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
    createdBy: "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69",
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
    mime: "application/pdf",
    uploadedBy: "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69",
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
    target: "pdf",
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

/** 可重试 / 确定性失败用例共用的任务行。 */
function makeJobRow(overrides: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow {
  return {
    id: OUTBOX_ID,
    topic: "preview.job",
    dedupeKey: previewJobDedupeKey({ contentHash: HASH, pipelineVersion: "1.0.0", target: "pdf" }),
    payload: buildPreviewJobPayload({
      projectId: PROJECT,
      fileId: FILE,
      versionId: VERSION,
      contentHash: HASH,
      target: "pdf",
      trigger: "finalize",
    }),
    attempts: 0,
    availableAt: NOW,
    lockedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const CONVERT_INPUT: ConvertInput = {
  bytes: new Uint8Array([1, 2, 3]),
  target: "pdf",
  fileName: "机械设计图纸.pdf",
  sourceMime: "application/pdf",
  requestId: "req-1",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeConverter(env: Partial<Env> = {}): PreviewConverter {
  return new PreviewConverter(new AppConfig({ ...ENV, ...env } as Env));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PreviewConverter（转换器客户端 · deploy/preview/README「五」）", () => {
  it("200：读回产物字节与响应头（mode / 耗时 / 产物名解 URL 编码 / 管线版本）", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "x-pipeline-version": "1.0.0",
          "x-convert-mode": "convert",
          "x-convert-duration-ms": "716",
          "x-artifact-name": encodeURIComponent("机械设计图纸.pdf"),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeConverter().convert(CONVERT_INPUT);

    expect(result).toMatchObject({
      contentType: "application/pdf",
      mode: "convert",
      durationMs: 716,
      artifactName: "机械设计图纸.pdf",
      pipelineVersion: "1.0.0",
    });
    expect([...result.bytes]).toEqual([9, 8, 7]);

    const call = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: unknown }];
    expect(call[0]).toBe("http://127.0.0.1:9900/convert");
    expect(call[1].headers).toMatchObject({
      "x-preview-target": "pdf",
      "x-file-name": encodeURIComponent("机械设计图纸.pdf"),
      "x-source-mime": "application/pdf",
      "x-request-id": "req-1",
    });
  });

  it("源 MIME 为空时不发 x-source-mime（可选项不送空头）", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "x-pipeline-version": "1.0.0" } }));
    vi.stubGlobal("fetch", fetchMock);

    await makeConverter().convert({ ...CONVERT_INPUT, sourceMime: null });

    const call = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers["x-source-mime"]).toBeUndefined();
    expect(call[1].headers["x-preview-target"]).toBe("pdf");
  });

  it("错误面分类：503 / 504 可重试；413 / 415 / 422 / 501 确定性失败（message 直接可落降级副行）", async () => {
    const cases: { status: number; code: string; kind: string }[] = [
      { status: 503, code: "SERVICE_BUSY", kind: "retryable" },
      { status: 503, code: "SERVICE_UNAVAILABLE", kind: "retryable" },
      { status: 504, code: "CONVERT_TIMEOUT", kind: "retryable" },
      { status: 413, code: "PAYLOAD_TOO_LARGE", kind: "deterministic" },
      { status: 415, code: "UNSUPPORTED_MEDIA", kind: "deterministic" },
      { status: 422, code: "CONVERT_FAILED", kind: "deterministic" },
      { status: 501, code: "UNSUPPORTED_TARGET", kind: "deterministic" },
    ];
    for (const item of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(item.status, {
            error: item.code,
            message: "转换失败：" + item.code,
            pipelineVersion: "1.0.0",
          }),
        ),
      );
      await expect(makeConverter().convert(CONVERT_INPUT)).rejects.toMatchObject({
        kind: item.kind,
        code: item.code,
        status: item.status,
      });
    }
  });

  it("管线版本不一致（200 但 x-pipeline-version 不同）：确定性失败，绝不写错缓存键", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { "x-pipeline-version": "1.0.1" } })),
    );
    await expect(makeConverter().convert(CONVERT_INPUT)).rejects.toMatchObject({
      kind: "deterministic",
      code: "PIPELINE_VERSION_MISMATCH",
    });
  });

  it("不可达 / 客户端超时：都归可重试（502 语义由退避与到顶兜底）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    await expect(makeConverter().convert(CONVERT_INPUT)).rejects.toMatchObject({
      kind: "retryable",
      code: "CONVERT_UNREACHABLE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }),
    );
    await expect(makeConverter().convert(CONVERT_INPUT)).rejects.toMatchObject({
      kind: "retryable",
      code: "CONVERT_TIMEOUT_LOCAL",
    });
  });

  it("超长 message 截到 500（preview_artifacts.error 的 CHECK 上限）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(422, { error: "CONVERT_FAILED", message: "崩".repeat(900) })),
    );
    const error = await makeConverter()
      .convert(CONVERT_INPUT)
      .then(() => null)
      .catch((thrown: unknown) => thrown as Error);
    expect(error).not.toBeNull();
    expect(error!.message).toHaveLength(500);
  });

  it("healthz：200 + 版本一致 / 版本不一致 / 503 soffice 不可用 / 不可达（都不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true, pipelineVersion: "1.0.0" })));
    expect(await makeConverter().healthz()).toMatchObject({ ok: true, pipelineVersion: "1.0.0", versionMatches: true });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true, pipelineVersion: "1.0.1" })));
    expect(await makeConverter().healthz()).toMatchObject({ ok: true, versionMatches: false });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { ok: false, pipelineVersion: "1.0.0" })));
    const busy = await makeConverter().healthz();
    expect(busy).toMatchObject({ ok: false, versionMatches: true });
    expect(busy.detail).toContain("soffice");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const down = await makeConverter().healthz();
    expect(down).toMatchObject({ ok: false, pipelineVersion: null, versionMatches: false });
    expect(down.detail).toContain("不可达");
  });
});

describe("previewTargetsFor / 类型判定 / preview.job（投递侧映射）", () => {
  it("投递通道映射（H1 · S2）：只有 SVG 进入 image 栅格化产物通道，其余不投", () => {
    expect(previewTargetsFor({ fileName: "现场照片.png", mime: "image/png" })).toEqual([]);
    expect(previewTargetsFor({ fileName: "矢量图.svg", mime: null })).toEqual(["image"]);
    expect(previewTargetsFor({ fileName: "矢量图.SVG", mime: "IMAGE/SVG+XML; charset=utf-8" })).toEqual(["image"]);
    expect(previewTargetsFor({ fileName: "机械设计图纸.pdf", mime: null })).toEqual([]);
    expect(previewTargetsFor({ fileName: "方案.docx", mime: null })).toEqual([]);
    expect(previewTargetsFor({ fileName: "报价.xlsx", mime: null })).toEqual([]);
    expect(previewTargetsFor({ fileName: "说明.txt", mime: null })).toEqual([]);
    expect(previewTargetsFor({ fileName: "无扩展名", mime: "application/vnd.ms-excel" })).toEqual([]);
    expect(previewTargetsFor({ fileName: "交付包.zip", mime: null })).toEqual([]);
    expect(previewTargetsFor({ fileName: "工具包", mime: null })).toEqual([]);
  });

  it("安全位图判定（H1 · S2）：扩展名与规范 MIME 必须精确一致；无扩展名 / SVG / 冲突一律 false", () => {
    expect(isRasterImageFile({ fileName: "现场照片.png", mime: "image/png" })).toBe(true);
    expect(isRasterImageFile({ fileName: "扫描件.TIFF", mime: "IMAGE/TIFF; charset=binary" })).toBe(true);
    expect(isRasterImageFile({ fileName: "照片.jpg", mime: "image/jpg" })).toBe(true);
    expect(isRasterImageFile({ fileName: "矢量图.svg", mime: null })).toBe(false);
    expect(isRasterImageFile({ fileName: "无扩展名", mime: "image/webp" })).toBe(false);
    expect(isRasterImageFile({ fileName: "冲突.png", mime: "image/svg+xml" })).toBe(false);
    expect(isRasterImageFile({ fileName: "冲突.svg", mime: "image/png" })).toBe(false);
    expect(isRasterImageFile({ fileName: "机械设计图纸.pdf", mime: null })).toBe(false);
    expect(isRasterImageFile({ fileName: "方案.docx", mime: null })).toBe(false);
  });

  it("SVG 判定（H1 · S2）：只接受扩展名 + 缺省 / SVG MIME；声明冲突不进入产物直签", () => {
    expect(isSvgFile({ fileName: "矢量图.svg", mime: null })).toBe(true);
    expect(isSvgFile({ fileName: "矢量图.SVG", mime: "image/svg+xml; charset=utf-8" })).toBe(true);
    expect(isSvgFile({ fileName: "无扩展名.bin", mime: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ fileName: "冲突.svg", mime: "image/png" })).toBe(false);
    expect(isSvgFile({ fileName: "冲突.png", mime: "image/svg+xml" })).toBe(false);
    expect(isSvgFile({ fileName: "无扩展名", mime: "image/svg+xml" })).toBe(true);
  });

  it("查看器通道映射（S3；PDF 2026-10-08 并入）：Office / 文本族 / PDF → documentType + fileType（扩展名优先、MIME 兜底）", () => {
    expect(viewerChannelFor({ fileName: "方案.docx", mime: null })).toEqual({ documentType: "word", fileType: "docx" });
    expect(viewerChannelFor({ fileName: "报表.xlsm", mime: null })).toEqual({ documentType: "cell", fileType: "xlsm" });
    expect(viewerChannelFor({ fileName: "说明.txt", mime: null })).toEqual({ documentType: "word", fileType: "txt" });
    expect(viewerChannelFor({ fileName: "清单.csv", mime: null })).toEqual({ documentType: "cell", fileType: "csv" });
    expect(viewerChannelFor({ fileName: "汇报.pptx", mime: null })).toEqual({ documentType: "slide", fileType: "pptx" });
    expect(viewerChannelFor({ fileName: "无扩展名", mime: "application/vnd.ms-excel" })).toEqual({
      documentType: "cell",
      fileType: "xls",
    });
    expect(viewerChannelFor({ fileName: "现场照片.png", mime: "image/png" })).toBeNull();
    expect(viewerChannelFor({ fileName: "恶意.html", mime: "text/html" })).toBeNull();
    expect(viewerChannelFor({ fileName: "冲突.docx", mime: "text/html" })).toBeNull();
    expect(viewerChannelFor({ fileName: "冲突.txt", mime: "image/png" })).toBeNull();
    // PDF（2026-10-08 业务口径「统一用onlyoffice」）：并入查看器通道（documentType = pdf）
    expect(viewerChannelFor({ fileName: "机械设计图纸.pdf", mime: null })).toEqual({ documentType: "pdf", fileType: "pdf" });
    expect(viewerChannelFor({ fileName: "无扩展名", mime: "application/pdf" })).toEqual({ documentType: "pdf", fileType: "pdf" });
    expect(viewerChannelFor({ fileName: "交付包.zip", mime: null })).toBeNull();
  });

  it("去重键 = 三元组：内容 / 管线版本 / 通道 任一不同即不同任务", () => {
    const base = previewJobDedupeKey({ contentHash: HASH, pipelineVersion: "1.0.0", target: "pdf" });
    expect(base).toBe("preview.job:" + HASH + ":1.0.0:pdf");
    expect(previewJobDedupeKey({ contentHash: HASH, pipelineVersion: "1.0.1", target: "pdf" })).not.toBe(base);
    expect(previewJobDedupeKey({ contentHash: HASH, pipelineVersion: "1.0.0", target: "image" })).not.toBe(base);
    expect(previewJobDedupeKey({ contentHash: "b".repeat(64), pipelineVersion: "1.0.0", target: "pdf" })).not.toBe(base);
  });

  it("载荷解析：非法（缺字段 / 通道不在值集 / 非字符串）一律 null，不兜底默认值", () => {
    const payload = buildPreviewJobPayload({
      projectId: PROJECT,
      fileId: FILE,
      versionId: VERSION,
      contentHash: HASH,
      target: "pdf",
      trigger: "finalize",
    });
    expect(parsePreviewJob(payload)).toEqual({ projectId: PROJECT, fileId: FILE, versionId: VERSION, target: "pdf" });
    expect(parsePreviewJob({ ...payload, target: "svg" })).toBeNull();
    expect(parsePreviewJob({ ...payload, versionId: "" })).toBeNull();
    expect(parsePreviewJob({ fileId: FILE })).toBeNull();
  });
});

/** preview_artifacts 替身：内存三元组表（唯一键语义与真库一致）。 */
class FakePreviewRepository {
  rows: PreviewArtifactRow[] = [];
  readonly ensured: (PreviewArtifactKey & { fileId: string; versionId: string })[] = [];
  readonly ready: { key: PreviewArtifactKey; input: { objectKey: string; generatedAt: Date } }[] = [];
  readonly failed: { key: PreviewArtifactKey; input: { error: string; updatedAt: Date } }[] = [];

  async findByKey(key: PreviewArtifactKey): Promise<PreviewArtifactRow | null> {
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
      status: "not_ready",
    });
    this.rows.push(row);
    return row;
  }

  async markReady(key: PreviewArtifactKey, input: { objectKey: string; generatedAt: Date }): Promise<void> {
    this.ready.push({ key, input });
  }

  async markFailed(key: PreviewArtifactKey, input: { error: string; updatedAt: Date }): Promise<void> {
    this.failed.push({ key, input });
  }
}

class FakeFileRepository {
  file: FileRow | null = makeFileRow();
  version: FileVersionRow | null = makeVersionRow();

  async findFileById(): Promise<FileRow | null> {
    return this.file;
  }

  async findVersionById(): Promise<FileVersionRow | null> {
    return this.version;
  }
}

class FakeStorage {
  source: GetObjectResult | null = {
    objectKey: SOURCE_KEY,
    bytes: new Uint8Array([4, 5, 6]),
    contentType: "application/pdf",
    sizeBytes: 3,
  };
  putError: Error | null = null;
  readonly puts: PutObjectInput[] = [];

  async getObject(objectKey: string): Promise<GetObjectResult | null> {
    return this.source === null ? null : { ...this.source, objectKey };
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string | null }> {
    if (this.putError !== null) {
      throw this.putError;
    }
    this.puts.push(input);
    return { etag: "\"put-etag\"" };
  }
}

class FakeConverter {
  readonly calls: ConvertInput[] = [];
  result: ConvertResult | Error = {
    bytes: new Uint8Array([7, 8, 9, 10]),
    contentType: "application/pdf",
    mode: "convert",
    durationMs: 716,
    artifactName: "机械设计图纸.pdf",
    pipelineVersion: "1.0.0",
  };

  async convert(input: ConvertInput): Promise<ConvertResult> {
    this.calls.push(input);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}
interface Harness {
  service: PreviewService;
  previews: FakePreviewRepository;
  repo: FakeFileRepository;
  storage: FakeStorage;
  converter: FakeConverter;
  clock: ClockService;
}

function makeService(env: Partial<Env> = {}): Harness {
  const previews = new FakePreviewRepository();
  const repo = new FakeFileRepository();
  const storage = new FakeStorage();
  const converter = new FakeConverter();
  const clock = new ClockService();
  clock.setSource(() => NOW);
  const config = new AppConfig({ ...ENV, ...env } as Env);
  const service = new PreviewService(
    repo as unknown as FileRepository,
    previews as unknown as PreviewRepository,
    storage as unknown as ObjectStorage,
    converter as unknown as PreviewConverter,
    config,
    clock,
  );
  return { service, previews, repo, storage, converter, clock };
}

/**
 * S7-1 切片后本服务只负责「消费与分类」：`consume` 返回 done / retry / dead（不触库、不外抛），
 * `onDead` 在 dispatcher 落 dead 前把产物置 failed。领取、退避排程与 outbox 三态回写见 outbox-dispatcher.test.ts。
 */
describe("PreviewService.consume（M4-05c 预览队列消费 · S7-1 收敛为分类）", () => {
  it("成功链路：直读源字节 → 转换 → 产物回对象存储（键 = 三元组）→ ready → done", async () => {
    const h = makeService();

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "done" });
    expect(h.converter.calls).toHaveLength(1);
    expect(h.converter.calls[0]).toMatchObject({
      target: "pdf",
      fileName: "机械设计图纸.pdf",
      sourceMime: "application/pdf",
    });
    expect([...h.converter.calls[0]!.bytes]).toEqual([4, 5, 6]);

    expect(h.storage.puts).toHaveLength(1);
    expect(h.storage.puts[0]).toMatchObject({ objectKey: ARTIFACT_KEY, contentType: "application/pdf" });
    expect(h.storage.puts[0]!.metadata).toMatchObject({
      "preview-pipeline-version": "1.0.0",
      "preview-target": "pdf",
      "preview-content-hash": HASH,
      "preview-source-version": VERSION,
      "preview-mode": "convert",
    });

    expect(h.previews.ready[0]!.key).toEqual({ contentHash: HASH, pipelineVersion: "1.0.0", target: "pdf" });
    expect(h.previews.ready[0]!.input.objectKey).toBe(ARTIFACT_KEY);
    expect(h.previews.ready[0]!.input.generatedAt).toBe(NOW);
  });

  it("三元组幂等：已有 ready 行 → 不调转换器、不重写产物，直接 done", async () => {
    const h = makeService();
    h.previews.rows = [makeArtifactRow({ status: "ready", objectKey: ARTIFACT_KEY, generatedAt: NOW })];

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "done" });
    expect(h.converter.calls).toHaveLength(0);
    expect(h.storage.puts).toHaveLength(0);
    expect(h.previews.ready).toHaveLength(0);
  });

  it("failed 是缓存态：不原地重试（由 pipeline_version 递增失效），任务直接 done", async () => {
    const h = makeService();
    h.previews.rows = [makeArtifactRow({ status: "failed", error: "上一轮确定性失败" })];

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "done" });
    expect(h.converter.calls).toHaveLength(0);
  });

  it("确定性失败（422）：分类 dead（不写 failed —— 终态留痕由 dispatcher 调 onDead 收口）", async () => {
    const h = makeService();
    h.converter.result = new ConverterError("deterministic", "CONVERT_FAILED", 422, "LibreOffice 转换失败：文件已损坏");

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "dead", error: "LibreOffice 转换失败：文件已损坏" });
    expect(h.previews.failed).toHaveLength(0);
  });

  it("可重试失败（503）：分类 retry（退避与到顶转 dead 由 dispatcher 按策略收敛）", async () => {
    const h = makeService();
    h.converter.result = new ConverterError("retryable", "SERVICE_BUSY", 503, "转换器忙，请稍后重试");

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "retry", error: "转换器忙，请稍后重试" });
    expect(h.previews.failed).toHaveLength(0);
  });

  it("structured 通道一期未启用：不调转换器，直接确定性降级", async () => {
    const h = makeService();
    const row = makeJobRow({
      payload: buildPreviewJobPayload({
        projectId: PROJECT,
        fileId: FILE,
        versionId: VERSION,
        contentHash: HASH,
        target: "structured",
        trigger: "read",
      }),
    });

    const outcome = await h.service.consume(row);

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect((outcome as { error: string }).error).toContain("structured");
    expect(h.converter.calls).toHaveLength(0);
  });

  it("超大源文件（> PREVIEW_CONVERT_MAX_SOURCE_MB）：不调转换器，直接降级「请下载」", async () => {
    const h = makeService();
    h.repo.version = makeVersionRow({ sizeBytes: 101 * 1024 * 1024 });

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect((outcome as { error: string }).error).toContain("超过预览转换上限 100 MB");
    expect(h.converter.calls).toHaveLength(0);
    expect(h.storage.puts).toHaveLength(0);
  });

  it("源对象缺失（存储侧读不到）：按可重试处理，不一次判死", async () => {
    const h = makeService();
    h.storage.source = null;

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toMatchObject({ outcome: "retry" });
    expect((outcome as { error: string }).error).toContain("源对象不存在");
    expect(h.converter.calls).toHaveLength(0);
  });

  it("产物写库 / 写对象失败（存储抖动）：按可重试处理", async () => {
    const h = makeService();
    h.storage.putError = new StorageError("unavailable", "对象存储暂不可用，请稍后重试");

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toMatchObject({ outcome: "retry", error: "对象存储暂不可用，请稍后重试" });
    expect(h.previews.ready).toHaveLength(0);
  });

  it("源版本已不存在（彻底删除 / 到期清理）：任务跳过并消费掉，不留噪音", async () => {
    const h = makeService();
    h.repo.version = null;

    const outcome = await h.service.consume(makeJobRow());

    expect(outcome).toEqual({ outcome: "done" });
    expect(h.converter.calls).toHaveLength(0);
    expect(h.previews.ensured).toHaveLength(0);
  });

  it("载荷非法：分类 dead（不猜默认值，也不占转换配额）", async () => {
    const h = makeService();

    const outcome = await h.service.consume(makeJobRow({ payload: { fileId: FILE } }));

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect((outcome as { error: string }).error).toContain("载荷非法");
    expect(h.converter.calls).toHaveLength(0);
  });

  it("首投登记：库内还没有产物行时补一条 not_ready（同三元组后续命中同一行）", async () => {
    const h = makeService();

    await h.service.consume(makeJobRow());

    expect(h.previews.ensured[0]).toMatchObject({
      fileId: FILE,
      versionId: VERSION,
      contentHash: HASH,
      pipelineVersion: "1.0.0",
      target: "pdf",
    });
  });

  it("onDead 终态留痕：产物置 failed（error + clock 时刻）；载荷非法 / 源版本不存在时静默 no-op", async () => {
    const h = makeService();

    await h.service.onDead(makeJobRow(), "LibreOffice 转换失败：文件已损坏");
    expect(h.previews.failed[0]).toMatchObject({
      key: { contentHash: HASH, pipelineVersion: "1.0.0", target: "pdf" },
      input: { error: "LibreOffice 转换失败：文件已损坏", updatedAt: NOW },
    });

    h.previews.failed.length = 0;
    await h.service.onDead(makeJobRow({ payload: { fileId: FILE } }), "x");
    expect(h.previews.failed).toHaveLength(0);

    h.repo.version = null;
    await h.service.onDead(makeJobRow(), "x");
    expect(h.previews.failed).toHaveLength(0);
  });
});
