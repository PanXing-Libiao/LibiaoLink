import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentDispositionFor, requestOriginCandidate } from "../src/modules/project-export/project-export.controller.js";
import { ProjectExportService, resolveProjectExportMode, splitChangeReason } from "../src/modules/project-export/project-export.service.js";
import {
  ProjectExportWorkbookWriter,
  buildProjectExportWorkbook,
  normalizeHttpOrigin,
  projectExportFileName,
  versionNameOf,
  type ProjectExportPayload,
} from "../src/modules/project-export/project-export.workbook.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP3sAAAAASUVORK5CYII=",
  "base64",
);

function payload(): ProjectExportPayload {
  return {
    project: { id: PROJECT_ID, code: "LBGW-20260331-1459", name: "英国项目" },
    origin: normalizeHttpOrigin("https://test-pm.libiaorobot.com"),
    tasks: [
      {
        description: "布局定档Layout scheduling",
        managers: "贾海洋(haiyang)",
        owners: "朱成荣(Eli)",
        status: "已完成",
        progress: 1,
        onTime: "按时交付",
        deliverables: "cad图纸",
        note: "现场确认完成",
        plannedStart: "5月20日",
        plannedEnd: "5月20日",
        headcount: 2,
        estimatedDays: 1,
        actualEnd: "5月20日",
        stage: "售前规划",
        priority: "高",
        endedAt: "2026/8/11",
        files: [
          { id: "file-1", name: "电气图.pdf" },
          { id: "file-2", name: "说明.pdf" },
        ],
        changeDates: ["2026/8/11"],
      },
    ],
    reports: [
      {
        date: "2026年9月1日（草稿）",
        author: "贾海洋(haiyang)",
        doneWork: "1 现场勘查",
        plan: "1 卸货",
        onsitePhotos: [
          { fileId: "image-1", name: "现场.png" },
          { fileId: "missing-1", name: "缺失现场.jpg" },
        ],
        issueDescription: "1 现场渗水",
        issueCategory: "客户原因",
        issueSolution: "1 增加排水装置",
        issueState: "处理中",
        issuePhotos: [],
        headcount: 2,
      },
    ],
    changes: [
      {
        changedAt: "2026/8/11",
        stage: "实施阶段",
        files: [{ id: "file-1", name: "电气图.pdf" }],
        description: "调整电源配置",
        beforeText: "旧电源",
        afterText: "新电源",
        reason: "客户原因",
        applicant: "贾海洋(haiyang)",
        writer: "贾海洋(haiyang)",
        afterVersion: versionNameOf("电气图.pdf"),
        afterFiles: [{ id: "file-1", name: "电气图.pdf" }],
        progress: "已生效",
        related: "布局定档Layout scheduling",
        beforePhotos: [{ fileId: "image-1", name: "变更前.png" }],
        afterPhotos: [{ fileId: "missing-2", name: "变更后.jpg" }],
      },
    ],
    stakeholders: [
      {
        name: "Christian Winkler",
        contact: "+49 123 / wx-1",
        email: "christian@example.com",
        position: "项目经理 / 客户接口",
        company: "客户customer / Vanilla",
        writer: "倪里特(Ni Lite)",
        submittedAt: "2026年9月15日 17:40",
      },
    ],
    images: new Map([["image-1", { bytes: PNG, extension: "png" }]]),
  };
}

function headersOf(sheet: ExcelJS.Worksheet): unknown[] {
  return Array.from({ length: sheet.columnCount }, (_value, index) => sheet.getCell(1, index + 1).value);
}

async function* rowsOf<T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
}

describe("项目数据导出工作簿", () => {
  it("四张表的名称、列顺序与关键字段对齐企微智能表格样例", async () => {
    const result = await buildProjectExportWorkbook(payload());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人"]);

    const task = workbook.getWorksheet("英国项目")!;
    expect(headersOf(task)).toEqual([
      "任务描述", "项目经理", "任务负责人", "任务状态", "项目进度", "是否按时交付", "输出成果文件", "项目进展描述",
      "开始日期", "预计完成日期", "预计所需施工人数", "预计所需天数", "实际完成日期", "阶段性里程", "紧急重要度",
      "结束时间", "文件", "变更关联",
    ]);
    expect(task.getCell(2, 1).value).toBe("布局定档Layout scheduling");
    expect(task.getCell(2, 5).value).toBe(1);
    expect(task.getCell(2, 16).value).toBe("2026/8/11");

    const report = workbook.getWorksheet("日报及问题汇总")!;
    expect(headersOf(report)).toEqual([
      "日期", "填写者", "当日完成工作", "明日计划", "现场工作附图", "问题描述", "问题归类",
      "解决方案或建议", "问题附图", "问题是否处理", "施工人数",
    ]);
    expect(report.getCell(2, 1).value).toBe("2026年9月1日（草稿）");
    expect(report.getCell(2, 5).value).toContain("（附图缺失）缺失现场.jpg");
    expect(report.getImages()).toHaveLength(1);

    const change = workbook.getWorksheet("变更管理")!;
    expect(headersOf(change)).toEqual([
      "变更时间", "变更阶段", "变更文件", "变更内容描述", "变更前", "变更后", "变更原因",
      "变更申请人", "填写者", "变更后文件版本", "变更后文件", "进度", "关联",
    ]);
    expect(change.getCell(2, 10).value).toBe("电气图");
    expect(change.getCell(2, 6).value).toContain("（附图缺失）变更后.jpg");
    expect(change.getImages()).toHaveLength(1);

    const stakeholder = workbook.getWorksheet("干系人")!;
    expect(headersOf(stakeholder)).toEqual([
      "干系人姓名/name", "电话或whats app或微信号", "邮箱Email", "职务Position/责任板块",
      "所属公司company", "填写者", "提交时间",
    ]);
    expect(stakeholder.getCell(2, 5).value).toBe("客户customer / Vanilla");
  });

  it("文件列只写文件名 / 项目文件链接；多文件逐行展示，链接指向项目文件视图", async () => {
    const result = await buildProjectExportWorkbook(payload());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const taskFile = workbook.getWorksheet("英国项目")!.getCell(2, 17).value as { text?: string; hyperlink?: string };
    expect(taskFile.text).toBe("电气图.pdf\n说明.pdf");
    expect(taskFile.hyperlink).toBe(
      "https://test-pm.libiaorobot.com/#/project/" + PROJECT_ID + "?view=files",
    );
    const changeFile = workbook.getWorksheet("变更管理")!.getCell(2, 11).value as { text?: string; hyperlink?: string };
    expect(changeFile.text).toBe("电气图.pdf");
    expect(changeFile.hyperlink).toContain("/#/project/" + PROJECT_ID + "?view=files");
  });

  it("同一单元格的多个附图按网格排布，图片不重叠", async () => {
    const sample = payload();
    const photos = Array.from({ length: 6 }, (_value, index) => ({ fileId: "multi-" + (index + 1), name: "多图" + (index + 1) + ".png" }));
    for (const photo of photos) sample.images.set(photo.fileId, { bytes: PNG, extension: "png" });
    sample.reports[0]!.onsitePhotos = photos.slice(0, 3);
    sample.reports[0]!.issuePhotos = photos.slice(3);
    sample.changes[0]!.beforePhotos = photos.slice(0, 3);
    sample.changes[0]!.afterPhotos = photos.slice(3);

    const result = await buildProjectExportWorkbook(sample);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const emuPerPx = 9525;
    const assertNoOverlap = (sheet: ExcelJS.Worksheet): void => {
      const images = sheet.getImages();
      expect(images).toHaveLength(6);
      const boxes = images.map((image) => {
        const ext = (image.range as unknown as { ext?: { width: number; height: number } }).ext;
        const left = image.range.tl.nativeColOff / emuPerPx;
        const top = image.range.tl.nativeRowOff / emuPerPx;
        return {
          column: image.range.tl.nativeCol,
          row: image.range.tl.nativeRow,
          left,
          top,
          right: left + (ext?.width ?? 0),
          bottom: top + (ext?.height ?? 0),
        };
      });
      for (let index = 0; index < boxes.length; index += 1) {
        for (let other = index + 1; other < boxes.length; other += 1) {
          const a = boxes[index]!;
          const b = boxes[other]!;
          if (a.column !== b.column || a.row !== b.row) continue;
          const separated = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          expect(separated, "图片 " + (index + 1) + " 与 " + (other + 1) + " 重叠").toBe(true);
        }
      }
    };
    assertNoOverlap(workbook.getWorksheet("日报及问题汇总")!);
    assertNoOverlap(workbook.getWorksheet("变更管理")!);
  });

  it("流式工作簿逐 Sheet 落盘；大项目附图改为项目文件视图链接且不嵌二进制", async () => {
    const directory = await mkdtemp(join(tmpdir(), "libiaolink-project-export-test-"));
    const filePath = join(directory, "stream.xlsx");
    try {
      const sample = payload();
      const writer = new ProjectExportWorkbookWriter(filePath, sample.project, sample.origin);
      await writer.writeTasks(rowsOf(sample.tasks));
      await writer.writeReports(rowsOf(sample.reports));
      await writer.writeChanges(rowsOf(sample.changes));
      await writer.writeStakeholders(rowsOf(sample.stakeholders));
      const result = await writer.commit();
      expect(result.sheetNames).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人"]);
      expect((await stat(result.filePath)).size).toBeGreaterThan(0);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.filePath);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(result.sheetNames);
      expect(headersOf(workbook.getWorksheet("英国项目")!)).toHaveLength(18);
      expect(workbook.getWorksheet("英国项目")!.getCell(2, 5).value).toBe(1);

      const report = workbook.getWorksheet("日报及问题汇总")!;
      const onsite = report.getCell(2, 5).value as { text?: string; hyperlink?: string };
      expect(onsite.text).toBe("现场.png\n缺失现场.jpg");
      expect(onsite.hyperlink).toBe("https://test-pm.libiaorobot.com/#/project/" + PROJECT_ID + "?view=files");
      expect(report.getImages()).toHaveLength(0);

      const change = workbook.getWorksheet("变更管理")!;
      const before = change.getCell(2, 5).value as { text?: string; hyperlink?: string };
      expect(before.text).toBe("旧电源\n变更前.png");
      expect(before.hyperlink).toContain("/#/project/" + PROJECT_ID + "?view=files");
      expect(change.getImages()).toHaveLength(0);

      const legacyWorkbook = new ExcelJS.Workbook();
      await legacyWorkbook.xlsx.load((await buildProjectExportWorkbook(sample)).buffer as unknown as ArrayBuffer);
      const skippedColumns: Record<string, ReadonlySet<number>> = {
        "日报及问题汇总": new Set([5, 9]),
        "变更管理": new Set([5, 6]),
      };
      for (const sheetName of result.sheetNames) {
        const streamedSheet = workbook.getWorksheet(sheetName)!;
        const legacySheet = legacyWorkbook.getWorksheet(sheetName)!;
        expect(streamedSheet.rowCount).toBe(legacySheet.rowCount);
        const skip = skippedColumns[sheetName] ?? new Set<number>();
        for (let row = 1; row <= legacySheet.rowCount; row += 1) {
          for (let column = 1; column <= legacySheet.columnCount; column += 1) {
            if (skip.has(column)) continue;
            expect(streamedSheet.getCell(row, column).value, sheetName + " R" + row + "C" + column).toEqual(
              legacySheet.getCell(row, column).value,
            );
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("项目导出的命名与请求边界", () => {
  it("文件名按「[项目编号] 项目名称.xlsx」；版本名沿用文件名并去掉扩展名", () => {
    expect(projectExportFileName({ code: "LBGW-20260331-1459", name: "英国-VANILLA-飞箱" })).toBe("[LBGW-20260331-1459] 英国-VANILLA-飞箱.xlsx");
    expect(projectExportFileName({ code: "A/B", name: "CON. " })).toBe("[A_B] CON.xlsx");
    expect(projectExportFileName({ code: "A", name: "a\"b<c>d|e" })).toBe("[A] a_b_c_d_e.xlsx");
    expect(versionNameOf("发货总清单（完整）.xlsx")).toBe("发货总清单（完整）");
    expect(versionNameOf("README")).toBe("README");
  });

  it("站点 origin 优先取前端显式参数，并规范成 http(s) origin", () => {
    expect(requestOriginCandidate("https://front.example/some/path", "https://origin.example", undefined, undefined, "api.internal")).toBe("https://front.example");
    expect(requestOriginCandidate(undefined, undefined, "https://referer.example/page", undefined, undefined)).toBe("https://referer.example");
    expect(requestOriginCandidate(undefined, undefined, undefined, "https, http", "test-pm.libiaorobot.com")).toBe("https://test-pm.libiaorobot.com");
    expect(requestOriginCandidate("javascript:alert(1)", undefined, undefined, undefined, undefined)).toBe("");
  });

  it("变更内容描述 / 变更原因从单列 reason 恢复为样例两列", () => {
    expect(splitChangeReason("调整电源配置；变更原因：客户要求")).toEqual({ content: "调整电源配置", reason: "客户要求" });
    expect(splitChangeReason("新增物料；原因：客户要求")).toEqual({ content: "新增物料", reason: "客户要求" });
    expect(splitChangeReason("Adjust cable; Change reason: customer request")).toEqual({ content: "Adjust cable", reason: "customer request" });
    expect(splitChangeReason("仅有一段内容")).toEqual({ content: "仅有一段内容", reason: "" });
  });

  it("Content-Disposition 同时提供 ASCII 回退名与 UTF-8 文件名", () => {
    const value = contentDispositionFor("[LBGW-1] 英国项目.xlsx");
    expect(value).toContain('filename="[LBGW-1] ____.xlsx"');
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("[LBGW-1] 英国项目.xlsx"));
  });

  it("auto 模式在 3,000 行达到流式阈值，显式模式始终优先", () => {
    expect(resolveProjectExportMode("auto", 2_999)).toBe("legacy");
    expect(resolveProjectExportMode("auto", 3_000)).toBe("stream");
    expect(resolveProjectExportMode("legacy", 20_000)).toBe("legacy");
    expect(resolveProjectExportMode("stream", 1)).toBe("stream");
  });

  it("stream 模式经服务返回临时文件，并在交付清理钩子后删除目录", async () => {
    const emptyPage = { items: [], page: 1, limit: 200, total: 0 };
    const list = vi.fn().mockResolvedValue(emptyPage);
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectExportService(
      { getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, code: "LBGW-1", name: "英国项目", managerIds: [], managerNames: [] }) } as never,
      { list } as never,
      { list } as never,
      { list } as never,
      { listProjectChanges: list } as never,
      { list } as never,
      { listProjectFiles: list } as never,
      { listUsers: list } as never,
      { can: vi.fn().mockResolvedValue(true) } as never,
      audit as never,
      { db: {} } as never,
      {} as never,
      { env: { PROJECT_EXPORT_MODE: "stream" } } as never,
    );
    const result = await service.exportProject(PROJECT_ID, "actor-1", "https://pm.libiaorobot.com");
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("预期文件结果");
    await expect(access(result.filePath)).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(result.filePath))).mode & 0o777).toBe(0o700);
    }
    expect(result.mode).toBe("stream");
    expect(result.sheetNames).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人"]);
    expect(audit.record).toHaveBeenCalledOnce();
    await result.cleanup();
    await expect(access(result.filePath)).rejects.toBeTruthy();
  });
});
