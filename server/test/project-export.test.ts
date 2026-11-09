import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { contentDispositionFor, projectExportFormat, requestOriginCandidate } from "../src/modules/project-export/project-export.controller.js";
import {
  planProjectArchiveAttachments,
  projectArchiveHref,
  projectArchiveLinks,
  ProjectZipWriter,
  type ProjectArchiveAttachmentSource,
} from "../src/modules/project-export/project-export.archive.js";
import { ProjectExportService, resolveProjectExportMode, splitChangeReason } from "../src/modules/project-export/project-export.service.js";
import {
  ProjectExportWorkbookWriter,
  buildProjectExportWorkbook,
  normalizeHttpOrigin,
  projectExportArchiveFileName,
  projectExportArchiveStem,
  projectExportArchiveWorkbookName,
  projectExportFileName,
  versionNameOf,
  type ExportImage,
  type ExportPhotoRef,
  type ProjectExportPayload,
} from "../src/modules/project-export/project-export.workbook.js";
import { injectWorkbookImages } from "../src/modules/project-export/project-export.xlsx-images.js";

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

function loaderFor(images: ReadonlyMap<string, ExportImage>) {
  return async (refs: readonly ExportPhotoRef[]) => new Map(
    refs.flatMap((ref) => {
      const image = images.get(ref.fileId);
      return image === undefined ? [] : [[ref.fileId, image] as const];
    }),
  );
}


function readZipEntries(bytes: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("EOCD 缺失");
  const count = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const result = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    result.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
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

  it("流式工作簿逐 Sheet 落盘；大项目附图仍内嵌缩略图且不生成图片链接", async () => {
    const directory = await mkdtemp(join(tmpdir(), "libiaolink-project-export-test-"));
    const filePath = join(directory, "stream.xlsx");
    try {
      const sample = payload();
      const writer = new ProjectExportWorkbookWriter(filePath, sample.project, sample.origin, loaderFor(sample.images));
      await writer.writeTasks(rowsOf(sample.tasks));
      await writer.writeReports(rowsOf(sample.reports));
      await writer.writeChanges(rowsOf(sample.changes));
      await writer.writeStakeholders(rowsOf(sample.stakeholders));
      const result = await writer.commit();
      await injectWorkbookImages(result.filePath, result.imagePlacements, result.images);
      expect(result.sheetNames).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人"]);
      expect((await stat(result.filePath)).size).toBeGreaterThan(0);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.filePath);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(result.sheetNames);
      expect(headersOf(workbook.getWorksheet("英国项目")!)).toHaveLength(18);
      expect(workbook.getWorksheet("英国项目")!.getCell(2, 5).value).toBe(1);

      const report = workbook.getWorksheet("日报及问题汇总")!;
      expect(String(report.getCell(2, 5).value)).toBe("（附图缺失）缺失现场.jpg");
      expect(report.getCell(2, 5).value).not.toEqual(expect.objectContaining({ hyperlink: expect.anything() }));
      expect(report.getImages()).toHaveLength(1);

      const change = workbook.getWorksheet("变更管理")!;
      expect(change.getCell(2, 5).value).toBe("旧电源");
      expect(String(change.getCell(2, 6).value)).toBe("新电源\n（附图缺失）变更后.jpg");
      expect(change.getCell(2, 5).value).not.toEqual(expect.objectContaining({ hyperlink: expect.anything() }));
      expect(change.getImages()).toHaveLength(1);

      const legacyWorkbook = new ExcelJS.Workbook();
      await legacyWorkbook.xlsx.load((await buildProjectExportWorkbook(sample)).buffer as unknown as ArrayBuffer);
      for (const sheetName of result.sheetNames) {
        const streamedSheet = workbook.getWorksheet(sheetName)!;
        const legacySheet = legacyWorkbook.getWorksheet(sheetName)!;
        expect(streamedSheet.rowCount).toBe(legacySheet.rowCount);
        for (let row = 1; row <= legacySheet.rowCount; row += 1) {
          for (let column = 1; column <= legacySheet.columnCount; column += 1) {
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

  it("流式图片注入支持多图网格、跨 Sheet 复用媒体，并保留原文件超链接", async () => {
    const directory = await mkdtemp(join(tmpdir(), "libiaolink-project-export-test-"));
    const filePath = join(directory, "stream-images.xlsx");
    try {
      const sample = payload();
      const photos = Array.from({ length: 6 }, (_value, index) => ({
        fileId: "stream-photo-" + String(index + 1),
        name: "流式图" + String(index + 1) + ".png",
      }));
      for (const photo of photos) sample.images.set(photo.fileId, { bytes: PNG, extension: "png" });
      sample.reports[0]!.onsitePhotos = photos.slice(0, 3);
      sample.reports[0]!.issuePhotos = photos.slice(3);
      sample.changes[0]!.beforePhotos = photos.slice(0, 3);
      sample.changes[0]!.afterPhotos = photos.slice(3);

      const writer = new ProjectExportWorkbookWriter(filePath, sample.project, sample.origin, loaderFor(sample.images));
      await writer.writeTasks(rowsOf(sample.tasks));
      await writer.writeReports(rowsOf(sample.reports));
      await writer.writeChanges(rowsOf(sample.changes));
      await writer.writeStakeholders(rowsOf(sample.stakeholders));
      const result = await writer.commit();
      await injectWorkbookImages(result.filePath, result.imagePlacements, result.images);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.filePath);
      const report = workbook.getWorksheet("日报及问题汇总")!;
      const change = workbook.getWorksheet("变更管理")!;
      expect(report.getImages()).toHaveLength(6);
      expect(change.getImages()).toHaveLength(6);

      const taskFile = workbook.getWorksheet("英国项目")!.getCell(2, 17).value as { hyperlink?: string };
      expect(taskFile.hyperlink).toContain("/#/project/" + PROJECT_ID + "?view=files");
      const changeFile = change.getCell(2, 11).value as { hyperlink?: string };
      expect(changeFile.hyperlink).toContain("/#/project/" + PROJECT_ID + "?view=files");

      const emuPerPx = 9525;
      const assertNoOverlap = (sheet: ExcelJS.Worksheet): void => {
        const images = sheet.getImages();
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
            expect(separated, "流式图片 " + String(index + 1) + " 与 " + String(other + 1) + " 重叠").toBe(true);
          }
        }
      };
      assertNoOverlap(report);
      assertNoOverlap(change);

      const entries = readZipEntries(await readFile(result.filePath));
      expect([...entries.keys()].filter((name) => /^xl\/media\/image\d+\.png$/.test(name))).toHaveLength(6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("项目 Excel + 附件 ZIP", () => {
  it("内置 ZIP 写入器支持中文路径、压缩与未压缩条目", async () => {
    const directory = await mkdtemp(join(tmpdir(), "libiaolink-zip-test-"));
    const filePath = join(directory, "sample.zip");
    try {
      const writer = new ProjectZipWriter(filePath);
      await writer.open();
      await writer.addBuffer("项目/说明.txt", Buffer.from("你好", "utf8"));
      await writer.addBuffer("项目/附件/原图.jpg", Buffer.from("not-really-jpeg"), false);
      await writer.close();
      const entries = readZipEntries(await readFile(filePath));
      expect([...entries.keys()]).toEqual(["项目/说明.txt", "项目/附件/原图.jpg"]);
      expect(entries.get("项目/说明.txt")?.toString("utf8")).toBe("你好");
      expect(entries.get("项目/附件/原图.jpg")?.toString("utf8")).toBe("not-really-jpeg");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("附件规划按目录去重、重名追加序号，并为 Excel 生成编码后的相对链接", () => {
    const sources: ProjectArchiveAttachmentSource[] = [
      { key: "a", sourcePage: "日报及问题汇总", sourceRow: 2, sourceRecord: "9月1日", attachmentType: "现场工作附图", directory: "日报及问题汇总/现场工作附图", fileId: "file-1", fileName: "现场 1.png" },
      { key: "b", sourcePage: "日报及问题汇总", sourceRow: 3, sourceRecord: "9月2日", attachmentType: "现场工作附图", directory: "日报及问题汇总/现场工作附图", fileId: "file-1", fileName: "现场 1.png" },
      { key: "c", sourcePage: "日报及问题汇总", sourceRow: 4, sourceRecord: "9月3日", attachmentType: "现场工作附图", directory: "日报及问题汇总/现场工作附图", fileId: "file-2", fileName: "现场 1.png" },
      { key: "d", sourcePage: "变更管理", sourceRow: 2, sourceRecord: "变更", attachmentType: "变更后文件", directory: "变更管理/变更后文件", fileId: "missing", fileName: "缺失.pdf" },
    ];
    const plan = planProjectArchiveAttachments(sources, new Map([
      ["file-1", { id: "file-1", name: "现场 1.png", mime: "image/png", sizeBytes: 10, objectKey: "objects/1" }],
      ["file-2", { id: "file-2", name: "现场 1.png", mime: "image/png", sizeBytes: 20, objectKey: "objects/2" }],
    ]));
    expect(plan.files).toHaveLength(3);
    expect(plan.references[0]?.file.relativePath).toBe("附件/日报及问题汇总/现场工作附图/现场 1.png");
    expect(plan.references[1]?.file.relativePath).toBe("附件/日报及问题汇总/现场工作附图/现场 1.png");
    expect(plan.references[2]?.file.relativePath).toBe("附件/日报及问题汇总/现场工作附图/现场 1_2.png");
    expect(plan.references[3]?.file.status).toBe("missing");
    expect(projectArchiveHref("附件/日报及问题汇总/现场工作附图/现场 1.png")).toContain("%E7%8E%B0%E5%9C%BA%201.png");
    expect(projectArchiveLinks(plan).get("a")).toBe(projectArchiveHref("附件/日报及问题汇总/现场工作附图/现场 1.png"));
    expect(projectArchiveLinks(plan).has("d")).toBe(false);
  });

  it("ZIP 模式工作簿增加附件清单 Sheet，附图最多嵌 4 张并链接相对路径", async () => {
    const sample = payload();
    const photos = Array.from({ length: 6 }, (_value, index) => ({
      fileId: "archive-photo-" + String(index + 1),
      name: "附件图" + String(index + 1) + ".png",
      href: "./附件/日报及问题汇总/现场工作附图/附件图" + String(index + 1) + ".png",
    }));
    for (const photo of photos) sample.images.set(photo.fileId, { bytes: PNG, extension: "png" });
    sample.reports[0]!.onsitePhotos = photos;
    sample.attachmentSheet = [{
      sourcePage: "日报及问题汇总",
      sourceRow: 2,
      sourceRecord: "2026年9月1日",
      attachmentType: "现场工作附图",
      fileName: "附件图1.png",
      relativePath: "附件/日报及问题汇总/现场工作附图/附件图1.png",
      sizeBytes: PNG.byteLength,
      status: "已包含",
    }];
    sample.imageLimitPerCell = 4;
    const result = await buildProjectExportWorkbook(sample);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as ArrayBuffer);
    expect(result.sheetNames).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人", "附件清单"]);
    expect(headersOf(workbook.getWorksheet("附件清单")!)).toEqual([
      "来源页面", "来源行", "来源记录", "附件类型", "文件名", "相对路径", "文件大小", "状态",
    ]);
    const report = workbook.getWorksheet("日报及问题汇总")!;
    const onsite = report.getCell(2, 5).value as { text?: string; hyperlink?: string };
    expect(onsite.text).toBe("6 张现场附图");
    expect(onsite.hyperlink).toBe("./附件/日报及问题汇总/现场工作附图/附件图1.png");
    expect(report.getImages()).toHaveLength(4);
  });

  it("服务层生成可解压 ZIP：xlsx、原附件与 manifest 同包，默认 xlsx 兼容", async () => {
    const report = {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: PROJECT_ID,
      authorId: "33333333-3333-4333-8333-333333333333",
      authorName: "张三",
      date: "2026-09-01",
      state: "submitted" as const,
      headcount: 2,
      doneWork: "现场施工",
      plan: "继续施工",
      foundIssue: null,
      issueCategories: [],
      suggestion: null,
      stageKeys: [],
      stageNames: [],
      photos: [{ fileId: "file-report", name: "现场.png" }],
      issuePhotos: [],
      submittedAt: "2026-09-01T10:00:00.000Z",
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      version: 1,
    };
    const emptyPage = { items: [], page: 1, limit: 200, total: 0 };
    const emptyList = vi.fn().mockResolvedValue(emptyPage);
    const reportList = vi.fn().mockResolvedValue({ items: [report], page: 1, limit: 200, total: 1 });
    const refs = new Map([
      ["file-report", { id: "file-report", name: "现场.png", mime: "image/png", sizeBytes: 5, objectKey: "objects/report.png" }],
    ]);
    const storage = {
      getObjectStream: vi.fn().mockResolvedValue({ stream: Readable.from([Buffer.from("hello")]), sizeBytes: 5, contentType: "image/png" }),
      getObject: vi.fn().mockResolvedValue({ objectKey: "objects/report.png", bytes: PNG, contentType: "image/png", sizeBytes: PNG.byteLength }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectExportService(
      { getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, code: "LBGW-1", name: "英国项目", managerIds: [], managerNames: [] }) } as never,
      { list: emptyList } as never,
      { list: reportList } as never,
      { list: emptyList } as never,
      { listProjectChanges: emptyList } as never,
      { list: emptyList } as never,
      { listProjectFiles: emptyList, listExportFileRefs: vi.fn().mockResolvedValue(refs) } as never,
      { listUsers: emptyList } as never,
      { can: vi.fn().mockResolvedValue(true) } as never,
      audit as never,
      { db: {} } as never,
      storage as never,
      { env: { PROJECT_EXPORT_MODE: "legacy" } } as never,
    );
    const result = await service.exportProject(PROJECT_ID, "actor-1", "https://test-pm.libiaorobot.com", undefined, "zip");
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("预期 ZIP 文件结果");
    try {
      expect(result.fileName).toBe("[LBGW-1] 英国项目.zip");
      expect(result.sheetNames).toEqual(["英国项目", "日报及问题汇总", "变更管理", "干系人", "附件清单"]);
      const entries = readZipEntries(await readFile(result.filePath));
      const root = "[LBGW-1] 英国项目";
      expect(entries.has(root + "/" + root + ".xlsx")).toBe(true);
      expect(entries.get(root + "/附件/日报及问题汇总/现场工作附图/现场.png")?.toString("utf8")).toBe("hello");
      const manifest = JSON.parse(entries.get(root + "/manifest.json")!.toString("utf8")) as {
        workbook: string;
        summary: { attachmentCount: number; includedFileCount: number; attachmentBytes: number };
        attachments: Array<{ relativePath: string; status: string; sha256: string }>;
      };
      expect(manifest.workbook).toBe(root + ".xlsx");
      expect(manifest.summary).toMatchObject({ attachmentCount: 1, includedFileCount: 1, attachmentBytes: 5 });
      expect(manifest.attachments[0]).toMatchObject({
        relativePath: "附件/日报及问题汇总/现场工作附图/现场.png",
        status: "included",
      });
      expect(manifest.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(entries.get(root + "/" + root + ".xlsx")!.buffer as unknown as ArrayBuffer);
      const onsite = workbook.getWorksheet("日报及问题汇总")!.getCell(2, 5).value as { hyperlink?: string };
      expect(decodeURIComponent(onsite.hyperlink ?? "")).toBe("./附件/日报及问题汇总/现场工作附图/现场.png");
      expect(audit.record).toHaveBeenCalledOnce();
    } finally {
      await result.cleanup();
    }
  });
});

describe("项目导出的命名与请求边界", () => {
  it("文件名按「[项目编号] 项目名称.xlsx」；ZIP 保留方括号编号且格式参数严格校验", () => {
    expect(projectExportFileName({ code: "LBGW-20260331-1459", name: "英国-VANILLA-飞箱" })).toBe("[LBGW-20260331-1459] 英国-VANILLA-飞箱.xlsx");
    expect(projectExportFileName({ code: "A/B", name: "CON. " })).toBe("[A_B] CON.xlsx");
    expect(projectExportFileName({ code: "A", name: "a\"b<c>d|e" })).toBe("[A] a_b_c_d_e.xlsx");
    expect(projectExportArchiveStem({ code: "LBGW-20260331-1459", name: "UK-VANILLA-AIRROB" })).toBe("[LBGW-20260331-1459] UK-VANILLA-AIRROB");
    expect(projectExportArchiveWorkbookName({ code: "[A/B]", name: "CON. " })).toBe("[A_B] CON.xlsx");
    expect(projectExportArchiveFileName({ code: "A/B", name: "项目" })).toBe("[A_B] 项目.zip");
    expect(projectExportFormat(undefined)).toBe("xlsx");
    expect(projectExportFormat("xlsx")).toBe("xlsx");
    expect(projectExportFormat("zip")).toBe("zip");
    expect(() => projectExportFormat("rar")).toThrow("format 仅支持 xlsx 或 zip");
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
