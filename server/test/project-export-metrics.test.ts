import { Logger } from "@nestjs/common";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ProjectExportTelemetry } from "../src/modules/project-export/project-export.metrics.js";
import { ProjectExportService } from "../src/modules/project-export/project-export.service.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const LOG_PREFIX = "project_export_metrics ";

function createService(projects: unknown): ProjectExportService {
  return new ProjectExportService(
    projects as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function createEmptyPageService(mode: "legacy" | "stream"): ProjectExportService {
  const emptyPage = { items: [], page: 1, limit: 200, total: 0 };
  const list = vi.fn().mockResolvedValue(emptyPage);
  return new ProjectExportService(
    { getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, code: "LBGW-1", name: "指标测试项目", managerIds: [], managerNames: [] }) } as never,
    { list } as never,
    { list } as never,
    { list } as never,
    { listProjectChanges: list } as never,
    { list } as never,
    { listProjectFiles: list, listExportFileRefs: vi.fn().mockResolvedValue(new Map()) } as never,
    { listUsers: list } as never,
    { can: vi.fn().mockResolvedValue(true) } as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    { db: {} } as never,
    {} as never,
    { env: { PROJECT_EXPORT_MODE: mode } } as never,
  );
}

function metricLogs(logSpy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map(([message]) => typeof message === "string" ? message : "")
    .filter((message) => message.startsWith(LOG_PREFIX))
    .map((message) => JSON.parse(message.slice(LOG_PREFIX.length)) as Record<string, unknown>);
}

describe("ProjectExportTelemetry", () => {
  it("聚合阶段耗时、对象存储调用、字节和导出结果，不记录错误消息", () => {
    const telemetry = new ProjectExportTelemetry(PROJECT_ID, "zip");
    telemetry.setMode("archive");
    telemetry.addDuration("dataLoad", 12.34);
    telemetry.addDuration("thumbnailDecode", 2.26);
    telemetry.recordAttachmentPlan(["file-a", "file-a", "file-b"]);
    telemetry.recordAttachmentStatuses(["included", "missing", "skipped"]);
    telemetry.recordObjectStreamCall();
    telemetry.recordObjectStreamBytes(1024);
    telemetry.recordObjectGetCall();
    telemetry.recordObjectGetBytes(512);
    telemetry.setRequestedImages(4);
    telemetry.recordResult({
      mode: "archive",
      rows: 9,
      images: 3,
      imageLinks: 1,
      missingImages: 1,
      outputBytes: 4096,
    });

    const error = Object.assign(new Error("objects/secret.png"), { code: "E_EXPORT" });
    const snapshot = telemetry.snapshot("failed", error);

    expect(snapshot).toMatchObject({
      event: "project_export_metrics",
      projectId: PROJECT_ID,
      format: "zip",
      mode: "archive",
      status: "failed",
      errorCode: "E_EXPORT",
      errorName: "Error",
      counts: {
        attachmentsPlanned: 3,
        attachmentsIncluded: 1,
        attachmentsMissing: 1,
        attachmentsSkipped: 1,
        duplicateFileIds: 1,
        objectStreamCalls: 1,
        objectGetCalls: 1,
        attachmentBytesRead: 1024,
        thumbnailBytesRead: 512,
        objectBytesRead: 1536,
        requestedImages: 4,
        embeddedImages: 3,
        imageLinks: 1,
        missingImages: 1,
        rows: 9,
        outputBytes: 4096,
      },
    });
    expect(snapshot.timingsMs).toMatchObject({ dataLoad: 12.3, thumbnailDecode: 2.3 });
    expect(JSON.stringify(snapshot)).not.toContain("objects/secret.png");
  });
});

describe("项目导出指标日志", () => {
  it("项目读取失败时输出 failed 指标，不记录错误消息", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    onTestFinished(() => logSpy.mockRestore());
    const service = createService({
      getProject: vi.fn().mockRejectedValue(new Error("db.password=secret")),
    });

    await expect(service.exportProject(PROJECT_ID, "actor-1", "https://pm.example")).rejects.toThrow("db.password=secret");
    const metrics = metricLogs(logSpy);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ format: "xlsx", mode: null, status: "failed", errorName: "Error" });
    expect(metrics[0]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(metrics[0])).not.toContain("db.password=secret");
  });

  it("取消导出时输出 cancelled 指标", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    onTestFinished(() => logSpy.mockRestore());
    const controller = new AbortController();
    controller.abort(new Error("用户取消导出"));

    await expect(createService({}).exportProject(PROJECT_ID, "actor-1", "https://pm.example", controller.signal))
      .rejects.toThrow("用户取消导出");
    const metrics = metricLogs(logSpy);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ format: "xlsx", mode: null, status: "cancelled" });
  });

  it("legacy 与 stream 成功导出都输出一行 success 指标", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    onTestFinished(() => logSpy.mockRestore());

    for (const mode of ["legacy", "stream"] as const) {
      const result = await createEmptyPageService(mode).exportProject(PROJECT_ID, "actor-1", "https://pm.example");
      try {
        expect(result.mode).toBe(mode);
      } finally {
        if (result.kind === "file") await result.cleanup();
      }
    }

    const metrics = metricLogs(logSpy);
    expect(metrics).toHaveLength(2);
    expect(metrics.map((metric) => metric.mode)).toEqual(["legacy", "stream"]);
    for (const metric of metrics) {
      expect(metric).toMatchObject({
        format: "xlsx",
        status: "success",
        counts: {
          objectStreamCalls: 0,
          objectGetCalls: 0,
          requestedImages: 0,
          rows: 0,
        },
      });
      expect((metric.counts as { outputBytes: number }).outputBytes).toBeGreaterThan(0);
    }
  });

  it("指标日志写入失败不影响导出错误返回", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    onTestFinished(() => logSpy.mockRestore());
    const controller = new AbortController();
    controller.abort(new Error("用户取消导出"));

    await expect(createService({}).exportProject(PROJECT_ID, "actor-1", "https://pm.example", controller.signal))
      .rejects.toThrow("用户取消导出");
  });
});
