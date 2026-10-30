
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { IMPORT_MAX_FILE_BYTES } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { ObjectStorage } from "../src/storage/index.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { UserRow } from "../src/modules/identity/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { FlowService, ProjectMemberRepository, ProjectRepository } from "../src/modules/project/index.js";
import type { TaskNodeRepository } from "../src/modules/template/index.js";
import type { TranslateService } from "../src/modules/translate/index.js";
import type { ProjectImportRepository } from "../src/modules/project-import/index.js";
import { ProjectImportService } from "../src/modules/project-import/index.js";

/**
 * 导入表导入用例测试（服务端落地 · 业务口径 2026-10-14）：内存替身（不连库 / 不连对象存储）——
 * 用最小可解析 xlsx（zip store + inlineStr）驱动 preview 全链路（解析 → 转换 → 账号 / 节点对账 → 票据入库），
 * 再驱动 commit（管理员 / 兜底 / 补节点 / 图片挂接 / 票据状态机）。口径断言与 D:/LibiaoLink_help/_conv 干跑报告对齐。
 */

// ---------- 最小 xlsx 构造（zip method=0；xlsx.ts 的读取器不校验 CRC） ----------

interface ZipEntryInput {
  name: string;
  data: Buffer;
}

function zipStore(entries: ZipEntryInput[]): Buffer {
  const pieces: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    pieces.push(local, nameBytes, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...pieces, centralBuf, eocd]);
}

function xmlEscape(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;");
}

function colLetters(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => {
          if (cell === "") return "";
          const ref = colLetters(colIndex) + String(rowIndex + 1);
          return "<c r=" + String.fromCharCode(34) + ref + String.fromCharCode(34) + " t=" + String.fromCharCode(34) + "inlineStr" + String.fromCharCode(34) + "><is><t>" + xmlEscape(cell) + "</t></is></c>";
        })
        .join("");
      return "<row r=" + String.fromCharCode(34) + String(rowIndex + 1) + String.fromCharCode(34) + ">" + cells + "</row>";
    })
    .join("");
  return "<worksheet><sheetData>" + body + "</sheetData></worksheet>";
}

interface SheetInput {
  name: string;
  rows: string[][];
  /** 图片锚点（1 基行 / 列，media = xl/media 下文件名）：走 sheet rels + drawing xml，与真实 xlsx 同构。 */
  anchors?: Array<{ row: number; col: number; media: string }>;
}

/** 最小可解析工作簿：workbook.xml + rels + 各 sheet（含可选图片锚点链路）。 */
function buildWorkbook(sheets: SheetInput[]): Buffer {
  const entries: ZipEntryInput[] = [];
  const quote = String.fromCharCode(34);
  const sheetTags = sheets
    .map((sheet, index) => "<sheet name=" + quote + xmlEscape(sheet.name) + quote + " sheetId=" + quote + String(index + 1) + quote + " r:id=" + quote + "rId" + String(index + 1) + quote + "/>")
    .join("");
  entries.push({ name: "xl/workbook.xml", data: Buffer.from("<workbook><sheets>" + sheetTags + "</sheets></workbook>", "utf8") });
  const relTags = sheets
    .map((_, index) => "<Relationship Id=" + quote + "rId" + String(index + 1) + quote + " Target=" + quote + "worksheets/sheet" + String(index + 1) + ".xml" + quote + "/>")
    .join("");
  entries.push({ name: "xl/_rels/workbook.xml.rels", data: Buffer.from("<Relationships>" + relTags + "</Relationships>", "utf8") });
  sheets.forEach((sheet, index) => {
    const sheetPath = "xl/worksheets/sheet" + String(index + 1) + ".xml";
    entries.push({ name: sheetPath, data: Buffer.from(sheetXml(sheet.rows), "utf8") });
    const anchors = sheet.anchors ?? [];
    if (anchors.length === 0) return;
    entries.push({
      name: "xl/worksheets/_rels/sheet" + String(index + 1) + ".xml.rels",
      data: Buffer.from("<Relationships><Relationship Id=" + quote + "rIdDr" + quote + " Target=" + quote + "../drawings/drawing" + String(index + 1) + ".xml" + quote + "/></Relationships>", "utf8"),
    });
    const drawingPieces = anchors.map((anchor, anchorIndex) => {
      return (
        "<xdr:oneCellAnchor><xdr:from><xdr:col>" +
        String(anchor.col - 1) +
        "</xdr:col><xdr:row>" +
        String(anchor.row - 1) +
        "</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed=" +
        quote +
        "rIdImg" +
        String(anchorIndex + 1) +
        quote +
        "/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor>"
      );
    });
    entries.push({ name: "xl/drawings/drawing" + String(index + 1) + ".xml", data: Buffer.from("<xdr:wsDr>" + drawingPieces.join("") + "</xdr:wsDr>", "utf8") });
    const drawingRelTags = anchors
      .map((anchor, anchorIndex) => "<Relationship Id=" + quote + "rIdImg" + String(anchorIndex + 1) + quote + " Target=" + quote + "../media/" + anchor.media + quote + "/>")
      .join("");
    entries.push({ name: "xl/drawings/_rels/drawing" + String(index + 1) + ".xml.rels", data: Buffer.from("<Relationships>" + drawingRelTags + "</Relationships>", "utf8") });
  });
  return zipStore(entries);
}

// ---------- 内存替身 ----------

interface FakePreviewRow {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  objectKey: string;
  payload: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  committedAt: Date | null;
  committedProjectId: string | null;
}

interface FakeUser {
  id: string;
  username: string;
  displayName: string;
}

function createHarness() {
  const previews = {
    row: null as FakePreviewRow | null,
    users: [] as FakeUser[],
    codeExists: false,
    tasks: [] as Array<Record<string, unknown>>,
    reports: [] as Array<Record<string, unknown>>,
    issues: [] as Array<Record<string, unknown>>,
    changes: [] as Array<Record<string, unknown>>,
    stakeholders: [] as Array<Record<string, unknown>>,
    changeRefCalls: [] as Array<Array<{ taskId: string; changeIds: string[] }>>,
    files: [] as Array<Record<string, unknown>>,
    committedCalls: [] as string[],
    expiredCalls: [] as string[],
    async insertPreview(input: Record<string, unknown>, at: Date): Promise<FakePreviewRow> {
      const row: FakePreviewRow = {
        id: input.id as string,
        fileName: input.fileName as string,
        fileSizeBytes: input.fileSizeBytes as number,
        objectKey: input.objectKey as string,
        payload: input.payload as Record<string, unknown>,
        status: "pending",
        createdBy: input.createdBy as string,
        createdAt: at,
        expiresAt: input.expiresAt as Date,
        committedAt: null,
        committedProjectId: null,
      };
      this.row = row;
      return row;
    },
    async listExpiredPreviews(now: Date): Promise<FakePreviewRow[]> {
      return this.row !== null && this.row.status === "pending" && this.row.expiresAt.getTime() <= now.getTime() ? [this.row] : [];
    },
    async findPreview(id: string): Promise<FakePreviewRow | null> {
      return this.row !== null && this.row.id === id ? this.row : null;
    },
    async markCommitted(id: string, projectId: string): Promise<void> {
      this.committedCalls.push(id + ":" + projectId);
      if (this.row !== null) this.row.status = "committed";
    },
    async markExpired(id: string): Promise<void> {
      this.expiredCalls.push(id);
      if (this.row !== null && this.row.id === id) this.row.status = "expired";
    },
    async projectCodeExists(): Promise<boolean> {
      return this.codeExists;
    },
    async findUsersByUsernames(usernames: readonly string[]): Promise<UserRow[]> {
      return this.users.filter((user) => usernames.includes(user.username)) as unknown as UserRow[];
    },
    async findUsersByDisplayNames(names: readonly string[]): Promise<UserRow[]> {
      return this.users.filter((user) => names.includes(user.displayName)) as unknown as UserRow[];
    },
    async insertTasks(tx: unknown, projectId: string, rows: Array<Record<string, unknown>>): Promise<string[]> {
      this.tasks = rows;
      return rows.map((_, index) => "task-" + String(index));
    },
    async insertReports(tx: unknown, projectId: string, rows: Array<Record<string, unknown>>): Promise<string[]> {
      this.reports = rows;
      return rows.map((_, index) => "report-" + String(index));
    },
    async insertReportIssues(
      tx: unknown,
      projectId: string,
      reportIds: string[],
      rows: Array<Record<string, unknown>>,
    ): Promise<string[]> {
      this.issues = rows;
      return rows.map((_, index) => "issue-" + String(index));
    },
    async insertChangeRequests(tx: unknown, projectId: string, rows: Array<Record<string, unknown>>): Promise<string[]> {
      this.changes = rows;
      return rows.map((_, index) => "change-" + String(index));
    },
    async insertStakeholders(tx: unknown, projectId: string, rows: Array<Record<string, unknown>>): Promise<string[]> {
      this.stakeholders = rows;
      return rows.map((_, index) => "stakeholder-" + String(index));
    },
    async attachChangeRefs(tx: unknown, updates: Array<{ taskId: string; changeIds: string[] }>): Promise<void> {
      this.changeRefCalls.push(updates);
    },
    async attachChangeSummaryImages(
      tx: unknown,
      updates: Array<{ changeId: string; beforeFileIds: string[]; afterFileIds: string[] }>,
    ): Promise<void> {
      this.changeImageCalls.push(updates);
    },
    changeImageCalls: [] as Array<Array<{ changeId: string; beforeFileIds: string[]; afterFileIds: string[] }>>,
    manualAttachFile: null as {
      id: string;
      projectId: string;
      name: string;
      status: string;
      currentVersionId: string | null;
    } | null,
    manualChangeProjectId: null as string | null,
    manualAttachOutcome: "attached" as "attached" | "already" | "conflict" | "missing" | "missing_change",
    manualAttachCalls: [] as Array<{ fileId: string; versionId: string; changeId: string; actorId: string; at: Date }>,
    async findFileForManualAttach(): Promise<{
      id: string;
      projectId: string;
      name: string;
      status: string;
      currentVersionId: string | null;
    } | null> {
      return this.manualAttachFile;
    },
    async findChangeProjectId(): Promise<string | null> {
      return this.manualChangeProjectId;
    },
    async attachChangeFile(
      tx: unknown,
      input: { fileId: string; versionId: string; changeId: string; actorId: string; at: Date },
    ): Promise<"attached" | "already" | "conflict" | "missing" | "missing_change"> {
      this.manualAttachCalls.push(input);
      return this.manualAttachOutcome;
    },
    async insertFiles(
      tx: unknown,
      projectId: string,
      reportIds: string[],
      issueIds: string[],
      rows: Array<Record<string, unknown>>,
    ): Promise<void> {
      this.files = rows;
      this.lastLinkTargets = { reportIds, issueIds };
    },
    lastLinkTargets: { reportIds: [] as string[], issueIds: [] as string[] },
  };

  const projects = {
    inserted: [] as Array<Record<string, unknown>>,
    stageWrites: [] as string[],
    async insert(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      this.inserted.push(input);
      return {
        id: input.id as string,
        code: input.code as string,
        name: input.name as string,
        region: input.region as string,
        projectType: input.projectType as string,
        managerIds: input.managerIds as string[],
        stageKey: input.stageKey as string,
      };
    },
    async setStageKey(id: string, stageKey: string): Promise<void> {
      this.stageWrites.push(id + ":" + stageKey);
    },
  };

  const members = {
    upserts: [] as Array<{ projectId: string; userId: string; role: string }>,
    async upsert(projectId: string, userId: string, role: string): Promise<void> {
      this.upserts.push({ projectId, userId, role });
    },
  };

  const nodes = {
    library: [] as Array<{ id: string; stageKey: string; seq: number; title: string; titleEn: string | null }>,
    inserts: [] as Array<{ stageKey: string; seq: number; title: string; titleEn: string | null }>,
    maxSeqs: new Map<string, number>(),
    async list(): Promise<unknown[]> {
      return this.library;
    },
    async maxSeq(stageKey: string): Promise<number> {
      return this.maxSeqs.get(stageKey) ?? 0;
    },
    async insert(input: { stageKey: string; seq: number; title: string; titleEn: string | null }): Promise<{ id: string }> {
      this.inserts.push(input);
      return { id: "node-" + String(this.inserts.length) };
    },
  };

  const audit = {
    records: [] as Array<{ objectType: string; summary: string; action: string; objectId: string }>,
    async record(tx: unknown, input: { objectType: string; summary: string; action: string; objectId: string }): Promise<void> {
      this.records.push(input);
    },
  };

  const storage = {
    puts: [] as Array<{ objectKey: string; size: number }>,
    purged: [] as string[],
    objects: new Map<string, Buffer>(),
    getObjectCalls: 0,
    getObjectStreamCalls: 0,
    async putObject(input: { objectKey: string; body: Uint8Array }): Promise<{ etag: string | null }> {
      this.puts.push({ objectKey: input.objectKey, size: input.body.length });
      return { etag: null };
    },
    async putObjectStream(input: {
      objectKey: string;
      body: Readable;
      sizeBytes: number;
      contentType: string;
    }): Promise<void> {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of input.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes);
        total += bytes.length;
      }
      if (total !== input.sizeBytes) throw new Error("stream size mismatch");
      this.puts.push({ objectKey: input.objectKey, size: total });
    },
    async getObject(objectKey: string): Promise<{ objectKey: string; bytes: Uint8Array; contentType: null; sizeBytes: number } | null> {
      this.getObjectCalls += 1;
      const bytes = this.objects.get(objectKey);
      if (bytes === undefined) return null;
      return { objectKey, bytes, contentType: null, sizeBytes: bytes.length };
    },
    async getObjectStream(objectKey: string): Promise<{
      stream: Readable;
      sizeBytes: number;
      contentType: null;
    } | null> {
      this.getObjectStreamCalls += 1;
      const bytes = this.objects.get(objectKey);
      if (bytes === undefined) return null;
      return { stream: Readable.from([bytes]), sizeBytes: bytes.length, contentType: null };
    },
    purgeFailures: new Set<string>() as Set<string>,
    async purgeObject(objectKey: string): Promise<{ deletedVersions: number; deleteMarkers: number }> {
      this.purged.push(objectKey);
      if (this.purgeFailures.has(objectKey)) throw new Error("purge failed");
      return { deletedVersions: 1, deleteMarkers: 0 };
    },
  };

  const translate = {
    warmed: [] as string[],
    warmup(texts: readonly string[]): void {
      this.warmed.push(...texts);
    },
  };

  const flow = {
    async importSnapshot(): Promise<{ activeStageKey: string; blueprintVersion: number; stages: number; nodes: number; requirements: number }> {
      return { activeStageKey: "presale", blueprintVersion: 1, stages: 9, nodes: 12, requirements: 3 };
    },
  };

  const permission = {
    groupAccess: { enforced: false, admin: false, allEdit: true, ownEdit: true },
    async groupAccessOf(): Promise<{ enforced: boolean; admin: boolean; allEdit: boolean; ownEdit: boolean }> {
      return this.groupAccess;
    },
  };

  const database = {
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn({}),
    },
  };

  const service = new ProjectImportService(
    database as unknown as DatabaseService,
    previews as unknown as ProjectImportRepository,
    projects as unknown as ProjectRepository,
    members as unknown as ProjectMemberRepository,
    flow as unknown as FlowService,
    permission as unknown as PermissionService,
    nodes as unknown as TaskNodeRepository,
    audit as unknown as AuditService,
    storage as unknown as ObjectStorage,
    translate as unknown as TranslateService,
  );

  return { service, previews, projects, members, nodes, audit, storage, translate, flow, permission };
}

/** 导入表三种 sheet 的表头（与真实导入表同列名；列顺序可乱，按表头定位）。 */
const TASK_HEADER = [
  "任务描述",
  "阶段性里程",
  "任务状态",
  "项目进度",
  "任务负责人",
  "项目经理",
  "开始日期",
  "预计完成日期",
  "实际完成日期",
  "预计所需天数",
  "预计所需施工人数",
  "项目进展描述",
  "输出成果文件",
  "是否按时交付",
  "文件",
];
const REPORT_HEADER = [
  "日期",
  "填写者",
  "当日完成工作",
  "明日计划",
  "施工人数",
  "问题描述",
  "问题归类",
  "问题是否处理",
  "解决方案或建议",
];
const CHANGE_HEADER = ["变更时间", "变更阶段", "变更内容描述", "变更原因", "变更前", "变更后", "变更后文件", "变更后文件版本", "关联", "变更申请人", "填写者"];

const ACTOR_ID = "99999999-9999-4999-8999-999999999999";

/** 与 UK 导入表同形的三张表（项目 / 日报 / 变更）；干系人表由调用方追加（Push 324）。 */
function sampleSheets(
  extraAnchors: Array<{ row: number; col: number; media: string }> = [],
  reportIssueState = "处理中",
  changeRequester = "朱成荣(Eli)",
  changeFiller = "朱成荣(Eli)",
  changeAnchors: Array<{ row: number; col: number; media: string }> = [],
): SheetInput[] {
  return [
    {
      name: "UK-VANILLA- 任务",
      rows: [
        TASK_HEADER,
        ["人员进场、场地检查、施工对接" + String.fromCharCode(10) + "Personnel entry", "硬件实施", "已完成", "1", "贾海洋(haiyang)", "贾海洋(haiyang)", "2026-09-02", "2026-09-10", "2026-09-01", "10", "4", "", "", "按时交付", ""],
        ["通电测试" + String.fromCharCode(10) + "Power-on Test", "硬件实施", "已完成", "1", "高云(Helen)", "贾海洋(haiyang)", "2026-09-05", "2026-09-08", "", "3", "2", "", "", "", ""],
        ["运输", "组装发货", "进行中", "0.7", "赵纯德(ZCD)", "贾海洋(haiyang)", "2026-08-01", "2026-08-20", "", "5", "2", "", "", "延期交付", ""],
        ["现场补装", "现场调试", "待开始", "", "张亚庆(Crescent)", "贾海洋(haiyang)", "2026-09-10", "2026-09-12", "", "2", "1", "", "", "", "现场补装说明.docx"],
      ],
    },
    {
      name: "日报及问题汇总",
      rows: [
        REPORT_HEADER,
        ["2026年9月1日", "贾海洋(haiyang)", "货架组装完成", "电控接线", "5", "货架立柱尺寸不符", "设计变更", reportIssueState, "返工处理"],
        ["2026年9月2日", "贾海洋(haiyang)", "物流线调试", "联动测试", "4", "", "", "", ""],
      ],
      anchors: [
        { row: 2, col: 5, media: "image1.png" },
        { row: 2, col: 9, media: "image2.png" },
        ...extraAnchors,
      ],
    },
    {
      name: "变更管理",
      rows: [
        CHANGE_HEADER,
        ["2026-09-01", "实施阶段", "供应商货架立柱尺寸不符", "供应商原因", "", "", "Layout更新版.dwg", "V2", "", changeRequester, changeFiller],
      ],
      anchors: changeAnchors,
    },
  ];
}

/** 与 UK 导入表同形的最小样例：完成无日期 / 进度收敛 / 日期笔误 / 阶段外任务 / 图片锚点。 */
function sampleWorkbook(
  extraAnchors: Array<{ row: number; col: number; media: string }> = [],
  reportIssueState = "处理中",
): Buffer {
  return buildWorkbook(sampleSheets(extraAnchors, reportIssueState));
}

const STAKEHOLDER_HEADER = [
  "干系人姓名/name",
  "电话或whats app或微信号",
  "邮箱Email",
  "职务Position/责任板块",
  "所属公司company",
  "填写者",
  "提交时间",
];

/** 「干系人」表样例（Push 324）：分类四值映射 / 联系方式拆分 / 分类识别不出 / 提交时间与填写者。 */
function stakeholderSheet(): SheetInput {
  return {
    name: "干系人",
    rows: [
      STAKEHOLDER_HEADER,
      ["Christian Winkler", "", "christian@example.com", "项目经理", "客户customer", "倪里特(Ni Lite)", "2026年9月15日 17:40"],
      ["吕宗远", "+86 137 0000 0000", "", "施工现场负责人", "供应商supplier", "倪里特(Ni Lite)", "2026年9月15日 17:40"],
      ["tobi", "tobi_wechat", "", "IT", "总包单位", "倪里特(Ni Lite)", "2026年9月15日 17:40"],
      ["Jan Mueller", "", "", "", "德马科技", "倪里特(Ni Lite)", "2026年9月15日 17:40"],
      ["", "", "", "", "", "", ""],
    ],
  };
}

/** 主文件带「干系人」表（正常「一张表格」导出的形态）。 */
function sampleWorkbookWithStakeholders(): Buffer {
  return buildWorkbook([...sampleSheets(), stakeholderSheet()]);
}

/** 变更关联（Push 319）样例：变更管理「关联」列写任务描述；任务表 R 列「变更关联」写日期（第一行故意对不上）。 */
function linkWorkbook(): Buffer {
  const taskHeader = [...TASK_HEADER, "变更关联"];
  const taskRow = (title: string, titleEn: string, stage: string, changeRef: string): string[] => [
    title + String.fromCharCode(10) + titleEn,
    stage,
    "进行中",
    "0.5",
    "贾海洋(haiyang)",
    "贾海洋(haiyang)",
    "2026-09-01",
    "2026-09-20",
    "",
    "1",
    "1",
    "",
    "",
    "",
    "",
    changeRef,
  ];
  return buildWorkbook([
    {
      name: "UK-VANILLA- 任务",
      rows: [
        taskHeader,
        taskRow("通电测试", "Power-on Test", "硬件实施", "2026-08-30"),
        taskRow("运输", "Transportation", "组装发货", ""),
        taskRow("包装打包", "Packing", "硬件实施", "2026-07-01"),
      ],
    },
    {
      name: "变更管理",
      rows: [
        CHANGE_HEADER,
        ["2026-09-01", "实施阶段", "供应商货架立柱尺寸不符", "供应商原因", "", "", "", "", "通电测试Power-on Test", "朱成荣(Eli)", "朱成荣(Eli)"],
        ["2026-09-01", "发货阶段", "物流包装升级", "客户原因", "", "", "", "", "运输", "朱成荣(Eli)", "朱成荣(Eli)"],
        ["2026-09-01", "实施阶段", "关联不上的变更", "其他", "", "", "", "", "不存在的任务", "朱成荣(Eli)", ""],
      ],
    },
  ]);
}

/** R01（Push 398）样例：变更「关联」为空，但变更文件 = 任务输出成果文件（多值匹配）。 */
function r01Workbook(): Buffer {
  const taskHeader = [...TASK_HEADER];
  const taskRow = (title: string, output: string): string[] => [
    title,
    "组装发货",
    "进行中",
    "0.5",
    "贾海洋(haiyang)",
    "贾海洋(haiyang)",
    "2026-09-01",
    "2026-09-20",
    "",
    "1",
    "1",
    "",
    output,
    "",
    "",
  ];
  return buildWorkbook([
    {
      name: "UK-VANILLA- 任务",
      rows: [taskHeader, taskRow("物料清单完整版", "物料总清单")],
    },
    {
      name: "变更管理",
      rows: [
        ["变更时间", "变更阶段", "变更文件", "变更内容描述", "变更原因", "变更前", "变更后", "变更后文件", "变更后文件版本", "关联", "变更申请人", "填写者"],
        ["2026-09-01", "发货阶段", "物料总清单", "物料清单更新", "客户原因", "", "", "清单变更版.xlsx", "V2", "", "朱成荣(Eli)", "朱成荣(Eli)"],
      ],
    },
  ]);
}

function previewPayload(h: ReturnType<typeof createHarness>): Record<string, unknown> {
  const row = h.previews.row;
  if (row === null) throw new Error("预览票据未创建");
  return row.payload;
}

async function runPreview(h: ReturnType<typeof createHarness>, locale: "zh" | "en" = "zh") {
  h.nodes.library = [
    { id: "lib-1", stageKey: "install", seq: 10, title: "人员进场、场地检查、施工对接", titleEn: "Personnel entry, site inspection, construction docking" },
    { id: "lib-2", stageKey: "assembly", seq: 10, title: "运输", titleEn: "Transportation" },
  ];
  return h.service.preview({ bytes: sampleWorkbook(), fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx", actorId: ACTOR_ID, locale });
}

/** 提交时取回的源工作簿（只含 media；提交只解图，不再解析 sheet）。 */
function mediaZip(...names: string[]): Buffer {
  return zipStore(names.map((name) => ({ name: "xl/media/" + name, data: Buffer.from("media-" + name, "utf8") })));
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 AppError（" + code + "），但未抛出");
}

const COMMIT_BODY = { region: "英国", projectType: "飞箱", addMissingNodes: true };

// ---------- preview ----------

describe("ProjectImportService.preview（导入表解析预览）", () => {
  it("解析口径：条数 / 落位 / 节点匹配 / 账号 / 手动清单 / 提醒", async () => {
    const h = createHarness();
    const preview = await runPreview(h);

    expect(preview.counts).toEqual({ tasks: 4, reports: 2, changes: 1, changesLinked: 0, stakeholders: 0, images: 2, imagesManual: 2, accountsNew: 5, nodesNew: 1 });
    expect(preview.project).toEqual({
      code: "LBGW-20260331-1459",
      name: "UK-VANILLA-AIRROB",
      region: "英国",
      projectType: "飞箱",
      managerNames: ["贾海洋"],
    });
    expect(preview.file.name).toBe("[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx");

    const tasks = (previewPayload(h).parse as { tasks: Array<{ progress: number; onTime: boolean | null }> }).tasks;
    expect(tasks.map((task) => task.progress)).toEqual([1, 0.75, 0.75, 0]);
    expect(tasks[0]?.onTime).toBe(true);

    const codes = preview.issues.map((issue) => issue.code);
    expect(codes).toContain("DATE_ORDER");
    expect(codes).toContain("DONE_NO_DATE");
    expect(codes).toContain("PROGRESS_BINNED");
    expect(codes).toContain("UNKNOWN_STAGE");
    expect(codes).not.toContain("ACCOUNT_MISSING");

    const byName = new Map(preview.nodes.map((node) => [node.name, node]));
    expect(byName.get("人员进场、场地检查、施工对接")?.matched).toBe(true);
    expect(byName.get("人员进场、场地检查、施工对接")?.nameEn).toBe("Personnel entry, site inspection, construction docking");
    expect(byName.get("运输")?.matched).toBe(true);
    expect(byName.get("通电测试")?.matched).toBe(false);
    expect(byName.get("通电测试")?.nameEn).toBe("Power-on Test");
    expect(byName.get("通电测试")?.inStageScope).toBe(true);
    expect(byName.get("现场补装")?.inStageScope).toBe(false);
    expect(byName.get("现场补装")?.nameEn).toBeNull();

    expect(preview.accounts.map((account) => account.username).sort()).toEqual([
      "gaoyun",
      "jiahaiyang",
      "zhangyaqing",
      "zhaochunde",
      "zhuchengrong",
    ]);
    expect(preview.accounts.every((account) => account.isNew)).toBe(true);
    expect(preview.accounts.find((account) => account.username === "jiahaiyang")?.displayName).toBe("贾海洋");

    expect(preview.imagesManual.map((image) => image.name).sort()).toEqual(["Layout更新版.dwg", "现场补装说明.docx"]);
    expect(preview.imagesManual.map((image) => image.id)).toEqual(["manual-0", "manual-1"]);
    expect(preview.imagesManual.find((image) => image.name === "Layout更新版.dwg")).toMatchObject({
      kind: "change_after",
      task: "供应商货架立柱尺寸不符",
    });
    expect(preview.imagesManual.find((image) => image.name === "现场补装说明.docx")).toMatchObject({
      kind: "task",
      task: "现场补装",
    });
    expect(preview.imagesManual[0]?.reason).toContain("手动上传");
  });

  it("生产入参 sourceFile：按临时文件偏移解析并流式写入对象存储", async () => {
    const h = createHarness();
    const source = sampleWorkbook();
    const prefix = Buffer.alloc(23, 0x7f);
    const directory = await mkdtemp(join(tmpdir(), "libiaolink-import-preview-"));
    const path = join(directory, "multipart-body.bin");
    await writeFile(path, Buffer.concat([prefix, source]));
    try {
      const preview = await h.service.preview({
        sourceFile: { path, offset: prefix.length, sizeBytes: source.length },
        fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
        actorId: ACTOR_ID,
        locale: "zh",
      });
      expect(preview.counts.tasks).toBe(4);
      expect(h.storage.puts).toHaveLength(1);
      expect(h.storage.puts[0]?.size).toBe(source.length);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("提醒文案随 Accept-Language：en 出英文（同一条提醒）", async () => {
    const h = createHarness();
    const preview = await runPreview(h, "en");
    const doneNoDate = preview.issues.find((issue) => issue.code === "DONE_NO_DATE");
    expect(doneNoDate?.message).toContain("No finish date");
    const dateOrder = preview.issues.find((issue) => issue.code === "DATE_ORDER");
    expect(dateOrder?.message).toContain("earlier than");
  });

  it("文件闸 400：非 .xlsx / .xlsm；解析失败 422", async () => {
    const h = createHarness();
    await expectCode(
      () => h.service.preview({ bytes: sampleWorkbook(), fileName: "老数据.xls", actorId: ACTOR_ID, locale: "zh" }),
      "IMPORT_FILE_INVALID",
    );
    await expectCode(
      () => h.service.preview({ bytes: Buffer.from("not a workbook", "utf8"), fileName: "老数据.xlsx", actorId: ACTOR_ID, locale: "zh" }),
      "IMPORT_PARSE_FAILED",
    );
  });

  it("图片锚点行不是有效日报：计入提醒（IMAGE_ROW_MISSING），不阻断", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: sampleWorkbook([{ row: 9, col: 5, media: "image9.png" }]),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    expect(preview.counts.images).toBe(3);
    expect(preview.counts.nodesNew).toBe(3);
    expect(preview.issues.map((issue) => issue.code)).toContain("IMAGE_ROW_MISSING");
  });

  it("变更前 / 变更后附图（Push 349）：锚点按列按行对变更记录；列外锚点出提醒、不导入", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: buildWorkbook(
        sampleSheets([], "处理中", "朱成荣(Eli)", "朱成荣(Eli)", [
          { row: 2, col: 5, media: "image3.png" },
          { row: 2, col: 6, media: "image4.png" },
          { row: 2, col: 3, media: "image5.png" },
        ]),
      ),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    expect(preview.counts.images).toBe(4);
    const images = (previewPayload(h).parse as { images: Array<{ kind: string }> }).images;
    expect(images.map((image) => image.kind)).toEqual(["onsite", "issue", "change_before", "change_after"]);
    const codes = preview.issues.map((issue) => issue.code);
    expect(codes).toContain("CHANGE_IMAGE_UNPLACED");
    expect(preview.issues.find((issue) => issue.code === "CHANGE_IMAGE_UNPLACED")?.subject).toBe("1 张");
  });

  it("变更关联（Push 319）：「关联」列命中任务 → changeLinks；未命中 / 日期不一致 / 汇总进提醒", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: linkWorkbook(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });

    expect(preview.counts.changes).toBe(3);
    expect(preview.counts.changesLinked).toBe(2);
    const links = (previewPayload(h).parse as { changeLinks: Array<{ changeIndex: number; taskIndex: number }> }).changeLinks;
    expect(links).toEqual([
      { changeIndex: 0, taskIndex: 0 },
      { changeIndex: 1, taskIndex: 1 },
    ]);
    const codes = preview.issues.map((issue) => issue.code);
    expect(codes).toContain("CHANGE_LINK_SUMMARY");
    expect(codes).toContain("CHANGE_RELATED_UNMATCHED");
    expect(codes).toContain("CHANGE_DATE_MISMATCH");
    expect(codes).toContain("TASK_CHANGE_REF_UNMATCHED");
    const summary = preview.issues.find((issue) => issue.code === "CHANGE_LINK_SUMMARY");
    expect(summary?.message).toContain("写入任务变更关联 2 条");
  });

  it("R01（Push 398）：「关联」为空但变更文件命中任务输出成果文件 → changeLinks", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: r01Workbook(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });

    expect(preview.counts.changesLinked).toBe(1);
    const links = (previewPayload(h).parse as { changeLinks: Array<{ changeIndex: number; taskIndex: number }> }).changeLinks;
    expect(links).toEqual([{ changeIndex: 0, taskIndex: 0 }]);
    const summary = preview.issues.find((issue) => issue.code === "CHANGE_LINK_SUMMARY");
    expect(summary?.message).toContain("覆盖 1 条变更");
    expect(summary?.message).toContain("未关联 0 条");
  });

  it("干系人（Push 324）：主文件含「干系人」表 → 条数 / 分类四值映射 / 联系方式拆分 / 提交时间", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: sampleWorkbookWithStakeholders(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    expect(preview.counts.stakeholders).toBe(4);
    const parse = previewPayload(h).parse as {
      stakeholderSheetName: string | null;
      stakeholders: Array<{
        name: string;
        companyType: string;
        company: string | null;
        phone: string | null;
        wechat: string | null;
        title: string | null;
        filler: string | null;
        submittedAt: string | null;
      }>;
    };
    expect(parse.stakeholderSheetName).toBe("干系人");
    const byName = new Map(parse.stakeholders.map((row) => [row.name, row]));
    expect(byName.get("Christian Winkler")?.companyType).toBe("customer");
    expect(byName.get("Christian Winkler")?.company).toBeNull();
    expect(byName.get("Christian Winkler")?.title).toBe("项目经理");
    expect(byName.get("Christian Winkler")?.submittedAt).toBe("2026-09-15");
    expect(byName.get("Christian Winkler")?.filler).toBe("倪里特(Ni Lite)");
    expect(byName.get("吕宗远")?.companyType).toBe("supplier");
    expect(byName.get("吕宗远")?.phone).toBe("+86 137 0000 0000");
    expect(byName.get("tobi")?.companyType).toBe("general_contractor");
    expect(byName.get("tobi")?.wechat).toBe("tobi_wechat");
    expect(byName.get("Jan Mueller")?.companyType).toBe("customer");
    expect(byName.get("Jan Mueller")?.company).toBe("德马科技");
    const codes = preview.issues.map((issue) => issue.code);
    expect(codes).toContain("STAKEHOLDER_COMPANY_UNMATCHED");
    expect(codes).toContain("STAKEHOLDER_FILLER_MISSING");
    expect(codes).not.toContain("STAKEHOLDER_SHEET_MISSING");
  });

  it("干系人（Push 324）：导入表没有该表 → info 提醒，不导入干系人", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: sampleWorkbook(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    expect(preview.counts.stakeholders).toBe(0);
    expect(preview.issues.map((issue) => issue.code)).toContain("STAKEHOLDER_SHEET_MISSING");
  });

  it("问题已处理（done）：默认处理人留空，不出 ISSUE_OWNER_FALLBACK 提醒", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: sampleWorkbook([], "已完成"),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));
    expect(preview.issues.map((issue) => issue.code)).not.toContain("ISSUE_OWNER_FALLBACK");

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");
    expect(h.previews.issues[0]?.state).toBe("done");
    expect(h.previews.issues[0]?.ownerId).toBeNull();
    expect(result.issues.map((issue) => issue.code)).not.toContain("ISSUE_OWNER_FALLBACK");
  });
});

// ---------- commit ----------

describe("ProjectImportService.commit（确认导入 · 单事务）", () => {
  it("手动补充附件回挂变更：写版本变更 id + 定档 + 审计；冲突 / 跨项目拒绝", async () => {
    const h = createHarness();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const changeId = "22222222-2222-4222-8222-222222222222";
    const fileId = "33333333-3333-4333-8333-333333333333";
    const versionId = "44444444-4444-4444-8444-444444444444";
    h.previews.manualAttachFile = {
      id: fileId,
      projectId,
      name: "Layout-更新版.dwg",
      status: "draft",
      currentVersionId: versionId,
    };
    h.previews.manualChangeProjectId = projectId;

    await h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID);

    expect(h.previews.manualAttachCalls).toHaveLength(1);
    expect(h.previews.manualAttachCalls[0]).toMatchObject({ fileId, versionId, changeId, actorId: ACTOR_ID });
    expect(h.audit.records.some((record) => record.objectType === "change" && record.objectId === changeId)).toBe(true);

    const auditCount = h.audit.records.length;
    h.previews.manualAttachOutcome = "already";
    await h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID);
    expect(h.audit.records.length).toBe(auditCount);

    h.previews.manualAttachOutcome = "missing";
    await expectCode(() => h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID), "NOT_FOUND");

    h.previews.manualAttachOutcome = "missing_change";
    await expectCode(() => h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID), "NOT_FOUND");

    h.previews.manualAttachOutcome = "conflict";
    await expectCode(() => h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID), "VALIDATION_FAILED");

    h.previews.manualAttachFile = {
      id: fileId,
      projectId,
      name: "Layout-更新版.dwg",
      status: "archived",
      currentVersionId: versionId,
    };
    await expectCode(() => h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID), "VALIDATION_FAILED");

    h.previews.manualAttachFile = {
      id: fileId,
      projectId: "55555555-5555-4555-8555-555555555555",
      name: "Layout-更新版.dwg",
      status: "draft",
      currentVersionId: versionId,
    };
    await expectCode(() => h.service.attachManualChangeFile(projectId, changeId, fileId, ACTOR_ID), "NOT_FOUND");
  });

  it("写入取消（Push 321）：上传途中 abort → 回滚零残留（票据仍可提交 + 源文件保留 + 已传图片清理）", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png", "image2.png"));
    const controller = new AbortController();
    const put = h.storage.putObject.bind(h.storage);
    h.storage.putObject = async (input: { objectKey: string; body: Uint8Array }): Promise<{ etag: string | null }> => {
      const result = await put(input);
      controller.abort();
      return result;
    };
    await expectCode(
      () => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh", controller.signal),
      "IMPORT_CANCELLED",
    );
    expect(h.projects.inserted.length).toBe(0);
    expect(h.previews.row === null ? "" : h.previews.row.status).toBe("pending");
    expect(h.storage.purged.filter((key) => key.startsWith("projects/")).length).toBe(1);
    expect(h.storage.purged).not.toContain(sourceKey);
    const done = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");
    expect(done.code).toBe(preview.project.code);
    expect(h.storage.purged).toContain(sourceKey);
  });

  it("写入取消（Push 321）：事务内 abort → 回滚（已传图片全部清理、源文件保留）", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png", "image2.png"));
    const controller = new AbortController();
    const insert = h.projects.insert.bind(h.projects);
    h.projects.insert = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const row = await insert(input);
      controller.abort();
      return row;
    };
    await expectCode(
      () => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh", controller.signal),
      "IMPORT_CANCELLED",
    );
    expect(h.previews.row === null ? "" : h.previews.row.status).toBe("pending");
    expect(h.storage.purged.filter((key) => key.startsWith("projects/")).length).toBe(2);
    expect(h.storage.purged).not.toContain(sourceKey);
  });

  it("主链路：建项目 + 补节点 + 任务 / 日报 / 问题 / 变更 / 图片，落位按面板确认值", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png", "image2.png"));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(result.code).toBe("LBGW-20260331-1459");
    expect(h.storage.getObjectStreamCalls).toBe(1);
    expect(h.storage.getObjectCalls).toBe(0);
    expect(result.name).toBe("UK-VANILLA-AIRROB");
    expect(result.counts).toEqual({ tasks: 4, reports: 2, changes: 1, changesLinked: 0, stakeholders: 0, images: 2, accountsCreated: 5, nodesAdded: 1 });
    expect(result.manualTargets).toEqual([
      { id: "manual-0", taskId: null, changeId: "change-0" },
      { id: "manual-1", taskId: "task-3", changeId: null },
    ]);

    // 项目落位：编号 / 地区 / 类型 / 项目经理（贾海洋 不在库 → 回落导入人）
    const inserted = h.projects.inserted[0]!;
    expect(inserted.code).toBe("LBGW-20260331-1459");
    expect(inserted.region).toBe("英国");
    expect(inserted.projectType).toBe("飞箱");
    expect(inserted.managerIds).toEqual([ACTOR_ID]);
    expect(h.members.upserts[0]?.role).toBe("project_manager");
    expect(h.members.upserts[0]?.userId).toBe(ACTOR_ID);

    // 节点：命中直接挂、未命中补库（maxSeq 0 + 10）、阶段外临时任务不补
    expect(h.nodes.inserts).toEqual([{ stageKey: "install", seq: 10, title: "通电测试", titleEn: "Power-on Test" }]);
    expect(h.previews.tasks.map((task) => task.taskNodeId)).toEqual(["lib-1", "node-1", "lib-2", null]);
    expect(h.previews.tasks.map((task) => task.sortIndex)).toEqual([0, 1, 0, 0]);

    // 日报 / 问题：作者缺失回落导入人；问题图随问题转挂 issue 侧
    expect(h.previews.reports[0]?.authorId).toBe(ACTOR_ID);
    expect(h.previews.issues.length).toBe(1);
    expect(h.previews.issues[0]?.reporterId).toBe(ACTOR_ID);
    expect(h.previews.issues[0]?.state).toBe("in_progress");
    expect(h.previews.issues[0]?.ownerId).toBe(ACTOR_ID);
    expect(h.previews.lastLinkTargets.issueIds).toEqual(["issue-0"]);

    // 变更：内容 + 原因合并；变更后文件只进「需手动导入」清单（不建文件行）
    expect(h.previews.changes[0]?.reason).toBe("供应商货架立柱尺寸不符；原因：供应商原因");
    expect(h.previews.changes[0]?.stageKey).toBe("install");
    // 变更申请人 / 填写者（Push 347）：库内无账号命中 → 申请人回落导入人（提醒）、填写者留空（提醒）
    expect(h.previews.changes[0]?.appliedBy).toBe(ACTOR_ID);
    expect(h.previews.changes[0]?.writerBy).toBeNull();

    // 图片：两张（现场图挂日报 / 问题图挂问题），对象键 = 契约键（projects/<projectId>/files/<fileId>/v1/<hash>.png）
    expect(h.previews.files.length).toBe(2);
    const filePuts = h.storage.puts.filter((put) => put.objectKey.startsWith("projects/"));
    expect(filePuts.length).toBe(2);
    expect(filePuts[0]?.objectKey).toContain("/files/");
    expect(h.previews.files[0]?.kind).toBe("onsite");
    expect(h.previews.files[0]?.issueIndex).toBeNull();
    expect(h.previews.files[1]?.issueIndex).toBe(0);

    // 提醒：解析期 + 提交期兜底；票据已置 committed、源文件已清理、项目名预热翻译
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("MANAGER_FALLBACK");
    expect(codes).toContain("OWNER_MISSING");
    expect(codes).toContain("AUTHOR_MISSING");
    expect(codes).toContain("ISSUE_OWNER_FALLBACK");
    expect(codes).toContain("CHANGE_APPLICANT_MISSING");
    expect(codes).toContain("CHANGE_WRITER_MISSING");
    const ownerFallback = result.issues.find((issue) => issue.code === "ISSUE_OWNER_FALLBACK");
    expect(ownerFallback?.level).toBe("info");
    expect(ownerFallback?.message).toContain("导入人");
    expect(h.previews.committedCalls).toEqual([preview.previewId + ":" + result.projectId]);
    expect(h.storage.purged).toContain(sourceKey);
    expect(h.translate.warmed).toContain("UK-VANILLA-AIRROB");
    expect(h.audit.records.filter((record) => record.objectType === "project").length).toBe(1);
    expect(h.audit.records.filter((record) => record.objectType === "task_node").length).toBe(1);
  });

  it("干系人（Push 324）：提交写入台账 + 项目关联（分类 / 提交时间 / 填写者匹配账号）", async () => {
    const h = createHarness();
    h.nodes.library = [];
    h.previews.users = [{ id: "user-ni", username: "nilite", displayName: "倪里特-test" }];
    const preview = await h.service.preview({
      bytes: sampleWorkbookWithStakeholders(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(result.counts.stakeholders).toBe(4);
    expect(h.previews.stakeholders.length).toBe(4);
    const first = h.previews.stakeholders[0]!;
    expect(first.name).toBe("Christian Winkler");
    expect(first.companyType).toBe("customer");
    expect(first.createdBy).toBe("user-ni");
    expect((first.createdAt as Date).toISOString()).toBe("2026-09-15T00:00:00.000Z");
    const jan = h.previews.stakeholders.find((row) => row.name === "Jan Mueller")!;
    expect(jan.company).toBe("德马科技");
    expect(result.issues.map((issue) => issue.code)).not.toContain("STAKEHOLDER_FILLER_MISSING");
  });

  it("变更关联（Push 319）：提交事务回写任务 change_refs（追加序 = 变更表行序）", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: linkWorkbook(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, zipStore([{ name: "xl/media/none.png", data: Buffer.from("x", "utf8") }]));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(result.counts.changesLinked).toBe(2);
    expect(h.previews.changeRefCalls).toEqual([
      [
        { taskId: "task-0", changeIds: ["change-0"] },
        { taskId: "task-1", changeIds: ["change-1"] },
      ],
    ]);
    expect(result.issues.map((issue) => issue.code)).toContain("CHANGE_LINK_SUMMARY");
  });

  it("R01（Push 398）：提交回写任务 change_refs，手动变更后文件的目标任务同源", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: r01Workbook(),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, zipStore([{ name: "xl/media/none.png", data: Buffer.from("x", "utf8") }]));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(h.previews.changeRefCalls).toEqual([[{ taskId: "task-0", changeIds: ["change-0"] }]]);
    expect(result.manualTargets).toEqual([{ id: "manual-0", taskId: "task-0", changeId: "change-0" }]);
  });

  it("变更申请人 / 填写者（Push 347）：源表两列命中库内账号 → applied_by / writer_by 按文件落人 + 无缺号提醒", async () => {
    const h = createHarness();
    h.nodes.library = [];
    h.previews.users = [
      { id: "user-jia", username: "jiahaiyang", displayName: "贾海洋" },
      { id: "user-zhu", username: "zhuchengrong", displayName: "朱成荣-test" },
    ];
    const preview = await h.service.preview({
      bytes: buildWorkbook(sampleSheets([], "处理中", "贾海洋(haiyang)", "朱成荣(Eli)")),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    const previewCodes = preview.issues.map((issue) => issue.code);
    expect(previewCodes).not.toContain("CHANGE_APPLICANT_MISSING");
    expect(previewCodes).not.toContain("CHANGE_WRITER_MISSING");
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(h.previews.changes.length).toBe(1);
    expect(h.previews.changes[0]?.appliedBy).toBe("user-jia");
    expect(h.previews.changes[0]?.writerBy).toBe("user-zhu");
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).not.toContain("CHANGE_APPLICANT_MISSING");
    expect(codes).not.toContain("CHANGE_WRITER_MISSING");
  });

  it("变更前 / 变更后附图（Push 349）：提交落 files 并回填 change_requests 两列（不落 file_links）", async () => {
    const h = createHarness();
    h.nodes.library = [];
    const preview = await h.service.preview({
      bytes: buildWorkbook(
        sampleSheets([], "处理中", "朱成荣(Eli)", "朱成荣(Eli)", [
          { row: 2, col: 5, media: "image3.png" },
          { row: 2, col: 6, media: "image4.png" },
        ]),
      ),
      fileName: "[LBGW-20260331-1459] UK-VANILLA-AIRROB.xlsx",
      actorId: ACTOR_ID,
      locale: "zh",
    });
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png", "image2.png", "image3.png", "image4.png"));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");

    expect(result.counts.images).toBe(4);
    const changeFiles = h.previews.files.filter((row) => row.kind === "change_before" || row.kind === "change_after");
    expect(changeFiles.map((row) => row.name)).toEqual(["变更前附图 2026-09-01 01.png", "变更后附图 2026-09-01 01.png"]);
    expect(changeFiles.map((row) => row.reportIndex)).toEqual([null, null]);
    expect(changeFiles.map((row) => row.changeIndex)).toEqual([0, 0]);
    expect(h.previews.changeImageCalls).toEqual([
      [{ changeId: "change-0", beforeFileIds: [changeFiles[0]!.id], afterFileIds: [changeFiles[1]!.id] }],
    ]);
  });

  it("账号已在库：项目经理 / 负责人 / 日报作者都直接挂人，不再回落", async () => {
    const h = createHarness();
    h.previews.users = [{ id: "user-jia", username: "jiahaiyang", displayName: "贾海洋" }];
    const preview = await runPreview(h);
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));

    expect(preview.accounts.find((account) => account.username === "jiahaiyang")?.isNew).toBe(false);
    expect(preview.counts.accountsNew).toBe(4);

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");
    expect(h.projects.inserted[0]?.managerIds).toEqual(["user-jia"]);
    expect(h.previews.tasks[0]?.ownerIds).toEqual(["user-jia"]);
    expect(h.previews.reports[0]?.authorId).toBe("user-jia");
    expect(h.previews.issues[0]?.reporterId).toBe("user-jia");
    expect(h.previews.issues[0]?.ownerId).toBe("user-jia");
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).not.toContain("MANAGER_FALLBACK");
    expect(codes).not.toContain("AUTHOR_MISSING");
    expect(codes).toContain("ISSUE_OWNER_FALLBACK");
    const ownerFallback = result.issues.find((issue) => issue.code === "ISSUE_OWNER_FALLBACK");
    expect(ownerFallback?.message).toContain("贾海洋");
    // 其余负责人（高云 / 赵纯德 / 张亚庆）仍不在库 → 照常提醒，不阻断
    const ownerIssue = result.issues.find((issue) => issue.code === "OWNER_MISSING");
    expect(ownerIssue?.subject).toContain("高云");
  });

  it("仅自己的项目编辑：导入项目时自动把创建人加入项目经理", async () => {
    const h = createHarness();
    h.previews.users = [{ id: "user-jia", username: "jiahaiyang", displayName: "贾海洋" }];
    const preview = await runPreview(h);
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));
    h.permission.groupAccess = { enforced: true, admin: false, allEdit: false, ownEdit: true };

    await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");
    expect(h.projects.inserted[0]?.managerIds).toEqual(["user-jia", ACTOR_ID]);
    expect(h.members.upserts.map((item) => item.userId)).toEqual(["user-jia", ACTOR_ID]);
  });

  it("不勾选补节点：任务按文件原名导入（taskNodeId 为空），节点库不动", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    h.storage.objects.set(h.previews.row === null ? "" : h.previews.row.objectKey, mediaZip("image1.png", "image2.png"));

    const result = await h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY, addMissingNodes: false }, ACTOR_ID, "zh");
    expect(h.nodes.inserts).toEqual([]);
    expect(result.counts.nodesAdded).toBe(0);
    expect(h.previews.tasks.map((task) => task.taskNodeId)).toEqual(["lib-1", null, "lib-2", null]);
  });

  it("票据状态机：过期 410（惰性置 expired + 清对象）/ 他人 403 / 已提交 400 / 编号占用 409", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png", "image2.png"));

    await expectCode(
      () => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, "88888888-8888-4888-8888-888888888888", "zh"),
      "FORBIDDEN",
    );

    h.previews.codeExists = true;
    await expectCode(() => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh"), "PROJECT_CODE_EXISTS");
    h.previews.codeExists = false;

    h.previews.row!.expiresAt = new Date(Date.now() - 1000);
    await expectCode(() => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh"), "IMPORT_PREVIEW_EXPIRED");
    expect(h.previews.expiredCalls).toEqual([preview.previewId]);
    expect(h.storage.purged).toContain(sourceKey);

    const h2 = createHarness();
    const preview2 = await runPreview(h2);
    h2.storage.objects.set(h2.previews.row === null ? "" : h2.previews.row.objectKey, mediaZip("image1.png", "image2.png"));
    await h2.service.commit({ previewId: preview2.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh");
    await expectCode(() => h2.service.commit({ previewId: preview2.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh"), "VALIDATION_FAILED");
  });

  it("过期票据清扫：删除源对象后置 expired；删除失败保留 pending 等下轮重试", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    const sourceKey = h.previews.row === null ? "" : h.previews.row.objectKey;
    h.storage.objects.set(sourceKey, mediaZip("image1.png"));
    h.previews.row!.expiresAt = new Date(Date.now() - 1000);

    const result = await h.service.sweepExpiredPreviews(new Date());
    expect(result).toEqual({ scanned: 1, expired: 1 });
    expect(h.storage.purged).toEqual([sourceKey]);
    expect(h.previews.row?.status).toBe("expired");

    const h2 = createHarness();
    const preview2 = await runPreview(h2);
    const sourceKey2 = h2.previews.row === null ? "" : h2.previews.row.objectKey;
    h2.storage.objects.set(sourceKey2, mediaZip("image1.png"));
    h2.previews.row!.expiresAt = new Date(Date.now() - 1000);
    h2.storage.purgeFailures = new Set([sourceKey2]);

    const result2 = await h2.service.sweepExpiredPreviews(new Date());
    expect(result2).toEqual({ scanned: 1, expired: 0 });
    expect(h2.storage.purged).toEqual([sourceKey2]);
    expect(h2.previews.row?.status).toBe("pending");
  });

  it("源文件被清理（对象缺失）：410 IMPORT_PREVIEW_EXPIRED，提示重新解析", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    await expectCode(() => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh"), "IMPORT_PREVIEW_EXPIRED");
  });

  it("源对象声明超限：410 且销毁已打开的读取流", async () => {
    const h = createHarness();
    const preview = await runPreview(h);
    let destroyed = false;
    const stream = new Readable({
      read(): void {},
      destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        destroyed = true;
        callback(error);
      },
    });
    h.storage.getObjectStream = async () => ({
      stream,
      sizeBytes: IMPORT_MAX_FILE_BYTES + 1,
      contentType: null,
    });

    await expectCode(() => h.service.commit({ previewId: preview.previewId, ...COMMIT_BODY }, ACTOR_ID, "zh"), "IMPORT_PREVIEW_EXPIRED");
    expect(destroyed).toBe(true);
  });
});
