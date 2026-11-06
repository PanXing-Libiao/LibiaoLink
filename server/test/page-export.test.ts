import ExcelJS from "exceljs";
import { access, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  PAGE_EXPORT_COLUMN_KEYS,
  PAGE_EXPORT_PREVIEW_PHOTO_LIMIT,
  PAGE_EXPORT_PREVIEW_ROW_LIMIT,
  PageExportRequestSchema,
  type DailyReport,
  type Issue,
  type Stakeholder,
} from "@libiaolink/contracts";
import { ProjectExportService } from "../src/modules/project-export/project-export.service.js";
import { pageExportColumnDefinition, pageExportSheetDefinition } from "../src/modules/project-export/page-export.catalog.js";
import { PROJECT_MANAGER_IMPLIED_KEYS, PROJECT_MEMBER_IMPLIED_KEYS, type ProjectAccessContext } from "../src/modules/permission/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const STAKEHOLDER_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_ID = "66666666-6666-4666-8666-666666666666";
const MISSING_IMAGE_ID = "77777777-7777-4777-8777-777777777777";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP3sAAAAASUVORK5CYII=",
  "base64",
);

const PROJECT_ACCESS: ProjectAccessContext = {
  projectId: PROJECT_ID,
  member: true,
  projectManager: false,
  groupAccessLevel: "view",
};

const NON_MEMBER_ACCESS: ProjectAccessContext = {
  ...PROJECT_ACCESS,
  member: false,
};

const report: DailyReport = {
  id: REPORT_ID,
  projectId: PROJECT_ID,
  authorId: USER_ID,
  authorName: "刘安安",
  date: "2026-11-05",
  state: "submitted",
  headcount: 3,
  doneWork: "完成现场勘查",
  plan: "开始安装",
  foundIssue: null,
  issueCategories: [],
  suggestion: null,
  stageKeys: ["install"],
  stageNames: ["硬件实施", "软件部署"],
  photos: [
    { fileId: IMAGE_ID, name: "现场.png" },
    { fileId: MISSING_IMAGE_ID, name: "缺失.jpg" },
  ],
  issuePhotos: [],
  submittedAt: "2026-11-05T10:00:00.000Z",
  createdAt: "2026-11-05T09:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  version: 1,
};

const issue: Issue = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  taskId: null,
  sourceReportId: REPORT_ID,
  title: "现场渗水",
  categories: ["客户原因", "客观原因"],
  state: "in_progress",
  reporterId: USER_ID,
  reporterName: "刘安安",
  ownerDepartment: "项目部",
  ownerId: USER_ID,
  ownerName: "刘安安",
  raisedAt: "2026-11-05",
  solution: "增加排水装置",
  photos: [{ fileId: IMAGE_ID, name: "问题.png" }],
  closedBy: null,
  closedAt: null,
  createdAt: "2026-11-05T10:10:00.000Z",
  updatedAt: "2026-11-05T10:20:00.000Z",
  version: 2,
};

const stakeholder: Stakeholder = {
  id: STAKEHOLDER_ID,
  name: "Christian Winkler",
  companyType: "customer",
  company: "Vanilla",
  title: "项目经理",
  phone: "+49 123",
  wechat: "wx-1",
  email: "christian@example.com",
  role: "客户接口",
  createdBy: USER_ID,
  createdByName: "刘安安",
  projects: [{ id: PROJECT_ID, code: "LBGW-1", name: "英国项目" }],
  createdAt: "2026-11-05T08:00:00.000Z",
  updatedAt: "2026-11-05T08:00:00.000Z",
};

function page<T>(items: readonly T[]) {
  return { items: [...items], page: 1, limit: 200, total: items.length };
}

type HarnessOptions = {
  mode?: "auto" | "legacy" | "stream";
  permissions?: readonly string[];
  projectAccess?: ProjectAccessContext;
  reports?: readonly DailyReport[];
  issues?: readonly Issue[];
  stakeholders?: readonly Stakeholder[];
  reportList?: ReturnType<typeof vi.fn>;
};

function harness(options: HarnessOptions = {}) {
  const permissions = new Set(options.permissions ?? ["project.view", "project.export", "report.view", "issue.view", "stakeholder.view", "stakeholder.contact.view"]);
  const projectAccess = options.projectAccess ?? PROJECT_ACCESS;
  const reportsList = options.reportList ?? vi.fn().mockResolvedValue(page(options.reports ?? [report]));
  const issuesList = vi.fn().mockResolvedValue(page(options.issues ?? [issue]));
  const stakeholdersList = vi.fn().mockResolvedValue(page(options.stakeholders ?? [stakeholder]));
  const usersList = vi.fn().mockResolvedValue(page([{ id: USER_ID, username: "lan", displayName: "刘安安", email: null, status: "active" }]));
  const fileRefs = new Map([
    [IMAGE_ID, { id: IMAGE_ID, name: "现场.png", mime: "image/png", sizeBytes: PNG.length, objectKey: "projects/image.png" }],
  ]);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const storage = { getObject: vi.fn().mockResolvedValue({ bytes: PNG }) };
  const permission = {
    can: vi.fn(async (_actorId: string, key: string, context?: ProjectAccessContext) =>
      permissions.has(key) ||
      (context?.projectManager === true && (PROJECT_MANAGER_IMPLIED_KEYS as readonly string[]).includes(key)) ||
      (context?.member === true && (PROJECT_MEMBER_IMPLIED_KEYS as readonly string[]).includes(key))),
  };
  const service = new ProjectExportService(
    { getProject: vi.fn().mockResolvedValue({ id: PROJECT_ID, code: "LBGW-1", name: "英国项目", managerIds: [], managerNames: [] }) } as never,
    { list: vi.fn().mockResolvedValue(page([])) } as never,
    { list: reportsList } as never,
    { list: issuesList } as never,
    { listProjectChanges: vi.fn().mockResolvedValue(page([])) } as never,
    { list: stakeholdersList } as never,
    {
      listExportFileRefs: vi.fn().mockResolvedValue(fileRefs),
      listProjectFiles: vi.fn().mockResolvedValue(page([])),
    } as never,
    { listUsers: usersList } as never,
    permission as never,
    audit as never,
    { db: {} } as never,
    storage as never,
    { env: { PROJECT_EXPORT_MODE: options.mode ?? "legacy" } } as never,
  );
  return { service, reportsList, issuesList, stakeholdersList, usersList, audit, permission, storage, fileRefs, projectAccess };
}

async function workbookOf(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

function headersOf(sheet: ExcelJS.Worksheet): unknown[] {
  return Array.from({ length: sheet.columnCount }, (_value, index) => sheet.getCell(1, index + 1).value);
}

describe("页面级 Excel 导出契约", () => {
  it("只接受 1～3 个已知 Sheet，拒绝空列、未知列、重复列和重复 Sheet", () => {
    const valid = { sheets: [{ sheet: "reports", columns: ["date", "doneWork"] }] };
    expect(PageExportRequestSchema.safeParse(valid).success).toBe(true);
    expect(PageExportRequestSchema.safeParse({ sheets: [] }).success).toBe(false);
    expect(PageExportRequestSchema.safeParse({ sheets: [{ sheet: "reports", columns: [] }] }).success).toBe(false);
    expect(PageExportRequestSchema.safeParse({ sheets: [{ sheet: "reports", columns: ["date", "unknown"] }] }).success).toBe(false);
    expect(PageExportRequestSchema.safeParse({ sheets: [{ sheet: "reports", columns: ["date", "date"] }] }).success).toBe(false);
    expect(PageExportRequestSchema.safeParse({ sheets: [
      { sheet: "reports", columns: ["date"] },
      { sheet: "reports", columns: ["author"] },
    ] }).success).toBe(false);
    expect(PageExportRequestSchema.safeParse({ sheets: [
      { sheet: "reports", columns: ["date"] },
      { sheet: "issues", columns: ["title"] },
      { sheet: "stakeholders", columns: ["name"] },
    ] }).success).toBe(true);
  });

  it("日报与干系人的扩展字段在契约层直接拒绝", () => {
    for (const column of ["headcount", "foundIssue", "suggestion", "issuePhotos"]) {
      expect(PageExportRequestSchema.safeParse({ sheets: [{ sheet: "reports", columns: [column] }] }).success).toBe(false);
    }
    for (const column of ["remark", "projects"]) {
      expect(PageExportRequestSchema.safeParse({ sheets: [{ sheet: "stakeholders", columns: [column] }] }).success).toBe(false);
    }
  });

  it("目录固定三页与中文表头；无 stakeholder.contact.view 时联系方式列不可选", async () => {
    const { service, issuesList, projectAccess } = harness({
      permissions: ["project.view", "project.export", "report.view", "stakeholder.view"],
      projectAccess: NON_MEMBER_ACCESS,
    });
    const catalog = await service.pageExportCatalog(PROJECT_ID, USER_ID, projectAccess);
    expect(catalog.sheets.map((item) => item.key)).toEqual(["reports", "issues", "stakeholders"]);
    expect(catalog.sheets[0]?.columns.map((column) => column.label)).toEqual(["时间", "填写者", "关联阶段", "当日完成工作", "明日计划", "现场工作附图"]);
    expect(catalog.sheets[0]?.rowCount).toBe(1);
    expect(catalog.sheets[1]?.allowed).toBe(false);
    expect(catalog.sheets[1]?.rowCount).toBe(0);
    expect(issuesList).not.toHaveBeenCalled();
    const contacts = catalog.sheets[2]?.columns.filter((column) => ["phone", "wechat", "email"].includes(column.key)) ?? [];
    expect(contacts.every((column) => !column.allowed)).toBe(true);
    expect(catalog.sheets[2]?.columns.find((column) => column.key === "title")?.allowed).toBe(true);
    expect(catalog.sheets[2]?.defaultColumns).not.toContain("phone");
    expect(catalog.sheets[0]?.previewRows).toEqual([{
      date: "2026年11月5日",
      author: "刘安安",
      stageNames: "硬件实施、软件部署",
      doneWork: "完成现场勘查",
      plan: "开始安装",
      photos: {
        kind: "photos",
        total: 2,
        items: [
          { fileId: IMAGE_ID, name: "现场.png" },
          { fileId: MISSING_IMAGE_ID, name: "缺失.jpg" },
        ],
      },
    }]);
    expect(catalog.sheets[1]?.previewRows).toEqual([]);
    const stakeholderPreview = catalog.sheets[2]?.previewRows?.[0] ?? {};
    expect(stakeholderPreview).toMatchObject({ name: "Christian Winkler", title: "项目经理", company: "客户 / Vanilla" });
    expect(stakeholderPreview).not.toHaveProperty("phone");
    expect(stakeholderPreview).not.toHaveProperty("wechat");
    expect(stakeholderPreview).not.toHaveProperty("email");
  });

  it("目录预览最多 20 条，长文本截断，不把未授权列带出服务端", async () => {
    const longReport = { ...report, doneWork: "长".repeat(300) };
    const reports = Array.from({ length: PAGE_EXPORT_PREVIEW_ROW_LIMIT + 1 }, (_value, index) => ({
      ...longReport,
      id: "88888888-8888-4888-8888-" + String(index).padStart(12, "0"),
    }));
    const { service, reportsList, projectAccess } = harness({
      reports,
    });
    const catalog = await service.pageExportCatalog(PROJECT_ID, USER_ID, projectAccess);
    const previews = catalog.sheets[0]?.previewRows ?? [];
    expect(catalog.sheets[0]?.rowCount).toBe(PAGE_EXPORT_PREVIEW_ROW_LIMIT + 1);
    expect(previews).toHaveLength(PAGE_EXPORT_PREVIEW_ROW_LIMIT);
    expect(String(previews[0]?.doneWork).length).toBe(240);
    expect(String(previews[0]?.doneWork).endsWith("…")).toBe(true);
    expect(reportsList).toHaveBeenCalledWith(PROJECT_ID, { page: 1, limit: PAGE_EXPORT_PREVIEW_ROW_LIMIT });
  });

  it("附图预览最多返回 4 个缩略图引用，并保留真实图片总数", async () => {
    const photos = Array.from({ length: PAGE_EXPORT_PREVIEW_PHOTO_LIMIT + 2 }, (_value, index) => ({
      fileId: "aaaaaaaa-aaaa-4aaa-8aaa-" + String(index).padStart(12, "0"),
      name: "现场" + String(index + 1) + ".png",
    }));
    const { service, projectAccess } = harness({ reports: [{ ...report, photos }] });
    const catalog = await service.pageExportCatalog(PROJECT_ID, USER_ID, projectAccess);
    expect(catalog.sheets[0]?.previewRows?.[0]?.photos).toEqual({
      kind: "photos",
      total: PAGE_EXPORT_PREVIEW_PHOTO_LIMIT + 2,
      items: photos.slice(0, PAGE_EXPORT_PREVIEW_PHOTO_LIMIT),
    });
  });

  it("请求含无权列时 403，不能静默遗漏或导出空列", async () => {
    const { service, permission, projectAccess } = harness({ permissions: ["project.view", "project.export", "stakeholder.view"] });
    await expect(service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "stakeholders", columns: ["name", "phone"] },
    ], projectAccess)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(permission.can).toHaveBeenCalledWith(USER_ID, "stakeholder.contact.view", projectAccess);
  });

  it("仅靠项目成员 / 项目经理隐含权限时，目录与导出均按项目上下文放行", async () => {
    const managerAccess: ProjectAccessContext = { ...PROJECT_ACCESS, projectManager: true };
    const { service, projectAccess } = harness({
      permissions: ["project.view", "project.export"],
      projectAccess: managerAccess,
    });
    const catalog = await service.pageExportCatalog(PROJECT_ID, USER_ID, projectAccess);
    expect(catalog.sheets.every((sheet) => sheet.allowed)).toBe(true);
    expect(catalog.sheets[2]?.columns.every((column) => column.allowed)).toBe(true);
    const result = await service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "reports", columns: ["date"] },
    ], projectAccess);
    expect(result.kind).toBe("buffer");
  });

  it("请求列只表达勾选，Excel 列序固定取系统目录，三个页面各自成表", async () => {
    const { service, audit, projectAccess } = harness();
    const result = await service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "reports", columns: ["doneWork", "date", "stageNames"] },
      { sheet: "issues", columns: ["state", "title", "categories"] },
      { sheet: "stakeholders", columns: ["company", "name"] },
    ], projectAccess);
    expect(result.kind).toBe("buffer");
    if (result.kind !== "buffer") throw new Error("预期内存工作簿");
    expect(result.sheetNames).toEqual(["日报记录", "问题追踪", "干系人"]);
    expect(result.rowCounts).toEqual({ reports: 1, issues: 1, stakeholders: 1 });
    const workbook = await workbookOf(result.buffer);
    const reports = workbook.getWorksheet("日报记录")!;
    const issues = workbook.getWorksheet("问题追踪")!;
    const stakeholders = workbook.getWorksheet("干系人")!;
    expect(headersOf(reports)).toEqual(["时间", "关联阶段", "当日完成工作"]);
    expect(reports.getCell(2, 1).value).toBe("2026年11月5日");
    expect(reports.getCell(2, 2).value).toBe("硬件实施、软件部署");
    expect(reports.getCell(2, 3).value).toBe("完成现场勘查");
    expect(reports.rowCount).toBe(2);
    expect(headersOf(issues)).toEqual(["问题描述", "问题归类", "问题是否处理"]);
    expect(issues.getCell(2, 1).value).toBe("现场渗水");
    expect(issues.getCell(2, 3).value).toBe("处理中");
    expect(issues.rowCount).toBe(2);
    expect(headersOf(stakeholders)).toEqual(["干系人姓名", "所属公司"]);
    expect(stakeholders.getCell(2, 1).value).toBe("Christian Winkler");
    expect(stakeholders.getCell(2, 2).value).toBe("客户 / Vanilla");
    expect(stakeholders.rowCount).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({
        columns: {
          reports: ["date", "stageNames", "doneWork"],
          issues: ["title", "categories", "state"],
          stakeholders: ["name", "company"],
        },
      }),
    }));
  });

  it("未勾选页面不读取业务数据；超过 20,000 条时拒绝导出", async () => {
    const { service, issuesList, stakeholdersList, projectAccess } = harness();
    await service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [{ sheet: "reports", columns: ["date"] }], projectAccess);
    expect(issuesList).not.toHaveBeenCalled();
    expect(stakeholdersList).not.toHaveBeenCalled();

    const tooLarge = harness({ reportList: vi.fn().mockResolvedValue({ items: [], page: 1, limit: 200, total: 20_001 }) });
    await expect(tooLarge.service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "reports", columns: ["date"] },
    ], tooLarge.projectAccess)).rejects.toThrow(/超过导出上限/);
  });

  it("legacy 动态图片列嵌图、保留缺失占位，并记录图片审计", async () => {
    const { service, audit, projectAccess } = harness();
    const result = await service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "reports", columns: ["photos", "date"] },
    ], projectAccess);
    if (result.kind !== "buffer") throw new Error("预期内存工作簿");
    expect(result.imageCount).toBe(1);
    expect(result.missingImageCount).toBe(1);
    const workbook = await workbookOf(result.buffer);
    const sheet = workbook.getWorksheet("日报记录")!;
    expect(headersOf(sheet)).toEqual(["时间", "现场工作附图"]);
    expect(sheet.getImages()).toHaveLength(1);
    expect(String(sheet.getCell(2, 2).value)).toContain("附图缺失");
    expect(sheet.getColumn(2).width).toBe(58);
    expect(sheet.getRow(2).height).toBeGreaterThan(24);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({ feature: "page_export", mode: "legacy", images: 1, missingImages: 1 }),
    }));
  });

  it("stream 模式改为文件名 + 项目文件视图链接，交付后可清理临时文件", async () => {
    const { service, audit, projectAccess } = harness({ mode: "stream" });
    const result = await service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [
      { sheet: "reports", columns: ["photos", "date"] },
    ], projectAccess);
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("预期文件工作簿");
    await expect(access(result.filePath)).resolves.toBeUndefined();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    const sheet = workbook.getWorksheet("日报记录")!;
    const value = sheet.getCell(2, 2).value as { text?: string; hyperlink?: string };
    expect(value.text).toContain("现场.png");
    expect(value.text).toContain("缺失.jpg");
    expect(value.hyperlink).toBe("https://pm.example/#/project/" + PROJECT_ID + "?view=files");
    expect(sheet.getImages()).toHaveLength(0);
    expect(result.imageLinkCount).toBe(2);
    expect(result.missingImageCount).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({ feature: "page_export", mode: "stream", imageLinks: 2, missingImages: 1 }),
    }));
    await result.cleanup();
    await expect(access(result.filePath)).rejects.toBeTruthy();
    await rm(result.filePath, { force: true }).catch(() => undefined);
  });

  it("新旧流式导出共用同一并发槽：页面导出进行中时第二个请求 429", async () => {
    let release: (() => void) | undefined;
    let dataStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { dataStarted = resolve; });
    const reportList = vi.fn(async (_projectId: string, query?: { limit?: number }) => {
      if (query?.limit === 1) return page([report]);
      dataStarted?.();
      await gate;
      return page([report]);
    });
    const { service, projectAccess } = harness({ mode: "stream", reportList });
    const first = service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [{ sheet: "reports", columns: ["date"] }], projectAccess);
    await started;
    await expect(service.exportPages(PROJECT_ID, USER_ID, "https://pm.example", [{ sheet: "reports", columns: ["date"] }], projectAccess))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
    release?.();
    const result = await first;
    if (result.kind !== "file") throw new Error("预期文件工作簿");
    await result.cleanup();
  });
});

describe("页面导出列目录", () => {
  it("每个 Sheet 的列 key 与契约白名单逐项同源", () => {
    for (const sheet of ["reports", "issues", "stakeholders"] as const) {
      const definition = pageExportSheetDefinition(sheet);
      expect(definition.columns.map((column) => column.key)).toEqual([...PAGE_EXPORT_COLUMN_KEYS[sheet]]);
    }
  });

  it("日报记录与干系人只导出页面当前列，不包含扩展字段", () => {
    expect([...PAGE_EXPORT_COLUMN_KEYS.reports]).toEqual(["date", "author", "stageNames", "doneWork", "plan", "photos"]);
    expect([...PAGE_EXPORT_COLUMN_KEYS.stakeholders]).toEqual(["name", "phone", "wechat", "email", "title", "company", "createdBy", "role"]);
    const reportKeys: readonly string[] = PAGE_EXPORT_COLUMN_KEYS.reports;
    const stakeholderKeys: readonly string[] = PAGE_EXPORT_COLUMN_KEYS.stakeholders;
    expect(reportKeys.filter((key) => ["headcount", "foundIssue", "suggestion", "issuePhotos"].includes(key))).toEqual([]);
    expect(stakeholderKeys.filter((key) => ["remark", "projects"].includes(key))).toEqual([]);
  });

  it("未知列在目录层直接报错，避免运行时静默丢列", () => {
    expect(() => pageExportColumnDefinition(pageExportSheetDefinition("reports"), "unknown")).toThrow(/未知页面导出列/);
  });
});
