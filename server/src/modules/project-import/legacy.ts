import { DOC_TYPES, ISSUE_CATEGORIES, STAGE_NAMES } from "@libiaolink/contracts";
import type { ImportIssueLevel, StageKey } from "@libiaolink/contracts";
import type { ParsedWorkbook, SheetGrid } from "./xlsx.js";

/**
 * 导入表 → 标准导入模型（口径与 D:/LibiaoLink_help/_conv/legacy-convert.mjs 逐条对齐；业务已回执）：
 * - 完成判定：实际完成日期未填 = 不算完成（进度按进行中封顶 75%）；提前完成 → done + statusOverride early_done；
 * - 进度五档：已完成 / 提前完成 100%、待开始 0%、进行中就近取档并封顶 75%；待开始有进度 → 归零；
 * - 日期笔误（完成早于开始 / 开始晚于预计完成）照原值导入 + 提醒；日期解析失败留空 + 提醒；
 * - 任务节点：按标题逐字比对节点库（服务层做），这里只出标题与英文名（源表英文列）；
 * - 变更阶段映射：实施 → install、发货 → assembly；x x x 占位 → 标记待补；
 * - 变更关联：变更管理「关联」列按任务描述匹配（提交时回写任务 change_refs，追加序 = 变更表行序）；任务表「变更关联」（日期）与变更时间核对，对不上出提醒；
 * - 图片：按锚点挂行（日报现场图 col E / 问题图 col I 内嵌图随导入；变更后文件等文件名 → 需手动导入清单）；
 * - 干系人（Push 324）：「干系人」表 → 台账模型（公司分类自由写法映射四值 / 填写者 / 提交时间；另附文件在服务层合并）。
 */

export interface LegacyIssueSeed {
  level: ImportIssueLevel;
  code: string;
  row: number | null;
  subject: string | null;
  zh: string;
  en: string;
}

export interface LegacyTask {
  row: number;
  title: string;
  titleEn: string | null;
  stageRaw: string;
  stageKey: StageKey | null;
  baseStatus: "pending" | "active" | "done";
  statusOverride: "overdue" | "early_done" | null;
  progress: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  deliverableTypes: string[];
  note: string | null;
  /** 是否按时交付（原表取值；导入落 tasks.on_time —— 读面派生不出时回落该存储值）。 */
  onTime: boolean | null;
  ownerRaw: string;
  ownerNames: string[];
  managerName: string | null;
  /** 任务表「变更关联」（导入表写变更日期；提交按变更表「关联」列回写 change_refs，这里保留原值供核对 / 提醒）。 */
  changeRefRaw: string | null;
}

export interface LegacyReportIssue {
  title: string;
  categories: string[];
  state: "open" | "in_progress" | "done";
  solution: string | null;
}

export interface LegacyReport {
  row: number;
  reportDate: string;
  authorName: string;
  doneWork: string;
  plan: string | null;
  headcount: number | null;
  issue: LegacyReportIssue | null;
}

export interface LegacyChange {
  row: number;
  appliedAt: string | null;
  stageRaw: string;
  stageKey: StageKey | null;
  docType: string | null;
  content: string;
  before: string | null;
  after: string | null;
  reason: string;
  requester: string;
  /** 「填写者」列（0054 / Push 347；旧表缺列 = 空串）。 */
  filler: string;
  afterFileName: string | null;
  afterFileVersion: string | null;
  related: string | null;
  placeholder: boolean;
  /** 变更内容描述含 x x x 占位（导入时追加「（内容待补）」标记）。 */
  contentPlaceholder: boolean;
  /** 变更原因含 x x x 占位（导入时追加「（原因待补）」标记）。 */
  reasonPlaceholder: boolean;
}

export interface LegacyImage {
  sheet: string;
  /** 1 based 行（对应所在 sheet 的行号；第 2 行起为数据行）。 */
  row: number;
  col: number;
  /** onsite / issue = 日报 sheet 的现场图 / 问题图；change_before / change_after = 变更表「变更前」「变更后」列内嵌图（Push 349）。 */
  kind: "onsite" | "issue" | "change_before" | "change_after";
  media: string;
}

export interface LegacyManualFile {
  /** task = 任务表「文件」列；change_after = 变更表「变更后文件」。 */
  kind: "task" | "change_after";
  /** 任务表数据行下标（parse.tasks 同序；change_after = null）。 */
  taskIndex: number | null;
  /** 变更表数据行下标（parse.changes 同序；task = null）。 */
  changeIndex: number | null;
  name: string;
  subject: string | null;
  reason: string;
  zh: string;
  en: string;
}

/** 干系人公司分类（A5-02 四值：立镖机器人 / 供应商 / 总包单位 / 客户）。 */
export type LegacyStakeholderCompanyType = "libiao" | "supplier" | "general_contractor" | "customer";

/** 干系人行（「干系人」表 7 列口径 · Push 324）：提交时落 stakeholders + project_stakeholders。 */
export interface LegacyStakeholder {
  /** 1 based 行（第 2 行起为数据行）。 */
  row: number;
  name: string;
  /** 公司分类（源表自由写法映射四值；识别不出 = 按 customer 兜底 + 逐行提醒）。 */
  companyType: LegacyStakeholderCompanyType;
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  role: string | null;
  /** 源表「填写者」原文（提交时匹配库内账号 → created_by；匹配不到留空 + 提醒）。 */
  filler: string | null;
  /** 源表「提交时间」→ created_at（YYYY-MM-DD；解析不出 = null → 用导入时间）。 */
  submittedAt: string | null;
}

export interface LegacyProjectPlacement {
  code: string;
  name: string;
  region: string | null;
  projectType: string | null;
  managerNames: string[];
}

/** 变更 ↔ 任务关联（变更管理「关联」列命中任务描述）：下标分别对应 parse.changes / parse.tasks。 */
export interface LegacyChangeLink {
  changeIndex: number;
  taskIndex: number;
}

export interface LegacyParse {
  project: LegacyProjectPlacement;
  tasks: LegacyTask[];
  reports: LegacyReport[];
  changes: LegacyChange[];
  /** 变更 ↔ 任务关联（变更表「关联」列命中任务描述；提交时回写任务 change_refs）。 */
  changeLinks: LegacyChangeLink[];
  /** 干系人（Push 324）：「干系人」表直接解析（主文件）；另附文件在服务层合并。 */
  stakeholders: LegacyStakeholder[];
  stakeholderSheetName: string | null;
  images: LegacyImage[];
  manualFiles: LegacyManualFile[];
  issues: LegacyIssueSeed[];
  year: number;
  yearDefaulted: boolean;
  sheetNames: string[];
  taskSheetName: string | null;
  reportSheetName: string | null;
  changeSheetName: string | null;
}

const ZWSP = String.fromCharCode(8203);
const NEWLINE = String.fromCharCode(10);
const DONE_STATUS = new Set(["已完成", "提前完成"]);
const BINS = [0, 0.25, 0.5, 0.75, 1];

const STAGE_KEY_BY_NAME: Record<string, StageKey> = {};
for (const [key, name] of Object.entries(STAGE_NAMES)) STAGE_KEY_BY_NAME[name] = key as StageKey;

const DOC_CANON = new Map<string, string>();
for (const doc of DOC_TYPES) {
  DOC_CANON.set(normalizeDocKey(doc), doc);
}

function normalizeDocKey(value: string): string {
  return clean(value).toLowerCase().split(" ").join("");
}

export function clean(value: unknown): string {
  return String(value === null || value === undefined ? "" : value).split(ZWSP).join("").trim();
}

function squashSpaces(value: string): string {
  return clean(value).split(" ").map((part) => part.trim()).filter(Boolean).join(" ");
}

/** 变更关联匹配键（去全部空白 + 小写；中英混排标题的行内空格不参与比对）。 */
function linkKey(value: string): string {
  return clean(value).replace(/\s+/g, "").toLowerCase();
}

function bin(value: unknown): number | null {
  const text = clean(value);
  if (text === "") return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return BINS.reduce((left, right) => (Math.abs(right - number) < Math.abs(left - number) ? right : left));
}

export function splitNames(value: string): string[] {
  return clean(value)
    .replace(/，|、|；|;/g, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseDateStr(raw: unknown, year: number): string | null {
  const text = clean(raw);
  if (text === "") return null;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return text;
  const parts = text
    .split("年").join(" ")
    .split("月").join(" ")
    .split("日").join(" ")
    .split("号").join(" ")
    .split("/").join(" ")
    .split(".").join(" ")
    .split("-").join(" ")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
  const fix = (value: number) => String(value).padStart(2, "0");
  if (parts.length >= 3) {
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return y + "-" + fix(m) + "-" + fix(d);
    return null;
  }
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const d = Number(parts[1]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return year + "-" + fix(m) + "-" + fix(d);
    return null;
  }
  return null;
}

/** 任务描述拆分：首行中文标题 + 其后英文名（多行 / 中文尾部接英文两种形态）。 */
function splitTitle(desc: string): { title: string; titleEn: string | null } {
  const text = clean(desc);
  const lines = text.split(NEWLINE).map(squashSpaces).filter(Boolean);
  if (lines.length >= 2) return { title: lines[0] ?? "", titleEn: lines.slice(1).join(" ") };
  let lastCjk = -1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 19968 && code <= 40959) lastCjk = i;
  }
  if (lastCjk >= 0) {
    const tail = text.slice(lastCjk + 1);
    let enStart = -1;
    for (let i = 0; i < tail.length; i += 1) {
      const code = tail.charCodeAt(i);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        enStart = i;
        break;
      }
    }
    if (enStart >= 0) {
      const en = squashSpaces(tail.slice(enStart));
      if (en !== "") return { title: squashSpaces(text.slice(0, lastCjk + 1)), titleEn: en };
    }
    return { title: squashSpaces(text), titleEn: null };
  }
  return { title: squashSpaces(text), titleEn: null };
}

function headerIndex(sheet: SheetGrid): Map<string, number> {
  const index = new Map<string, number>();
  const header = sheet.rows[0] ?? [];
  header.forEach((value, column) => {
    const name = clean(value);
    if (name !== "") index.set(name, column);
  });
  return index;
}

function pickSheet(sheets: SheetGrid[], mustHave: string[]): { sheet: SheetGrid; index: Map<string, number> } | null {
  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue;
    const index = headerIndex(sheet);
    if (mustHave.every((key) => index.has(key))) return { sheet, index };
  }
  return null;
}

function cellAt(sheet: SheetGrid, row: number, index: Map<string, number>, key: string): string {
  const column = index.get(key);
  if (column === undefined) return "";
  const rowCells = sheet.rows[row];
  if (rowCells === undefined) return "";
  return clean(rowCells[column]);
}

/** 干系人表列定位（表头中英混排，如「干系人姓名/name」）：逐字候选 + 包含兜底；缺列 = null。 */
const STAKEHOLDER_COLUMN_CANDIDATES = {
  name: ["干系人姓名/name", "干系人姓名"],
  contact: ["电话或whatsapp或微信号", "电话或whats app或微信号", "联系方式"],
  email: ["邮箱Email", "邮箱"],
  title: ["职务Position/责任板块", "职务", "责任板块"],
  company: ["所属公司company", "所属公司"],
  filler: ["填写者"],
  submitted: ["提交时间"],
  role: ["干系人角色/role", "干系人角色"],
} as const;

type StakeholderColumnKey = keyof typeof STAKEHOLDER_COLUMN_CANDIDATES;

function findHeaderColumn(index: Map<string, number>, candidates: readonly string[]): number | null {
  for (const candidate of candidates) {
    const hit = index.get(candidate);
    if (hit !== undefined) return hit;
  }
  for (const [header, column] of index) {
    const lower = header.toLowerCase();
    for (const candidate of candidates) {
      if (candidate.length >= 2 && lower.includes(candidate.toLowerCase())) return column;
    }
  }
  return null;
}

function pickStakeholderSheet(
  sheets: SheetGrid[],
): { sheet: SheetGrid; columns: Record<StakeholderColumnKey, number | null> } | null {
  for (const sheet of sheets) {
    if (sheet.rows.length === 0) continue;
    const index = headerIndex(sheet);
    const name = findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.name);
    if (name === null) continue;
    return {
      sheet,
      columns: {
        name,
        contact: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.contact),
        email: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.email),
        title: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.title),
        company: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.company),
        filler: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.filler),
        submitted: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.submitted),
        role: findHeaderColumn(index, STAKEHOLDER_COLUMN_CANDIDATES.role),
      },
    };
  }
  return null;
}

/** 公司分类关键词 → 四值（A5-02 口径；中文标签 / 英文别名都认；命中词全部剔除后的剩余文本 = 具体公司名）。 */
const COMPANY_TYPE_LABELS: [string, LegacyStakeholderCompanyType][] = [
  ["立镖机器人", "libiao"],
  ["libiao", "libiao"],
  ["总包单位", "general_contractor"],
  ["general_contractor", "general_contractor"],
  ["contractor", "general_contractor"],
  ["供应商", "supplier"],
  ["supplier", "supplier"],
  ["客户", "customer"],
  ["customer", "customer"],
];

/** 公司列自由写法解析（如「客户customer」→ customer + 空；「供应商 Acme」→ supplier +「Acme」）。 */
function parseCompanyType(raw: string): { companyType: LegacyStakeholderCompanyType | null; company: string | null } {
  let rest = clean(raw);
  if (rest === "") return { companyType: null, company: null };
  let companyType: LegacyStakeholderCompanyType | null = null;
  for (const [label, mapped] of COMPANY_TYPE_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(escaped, "i").test(rest)) continue;
    if (companyType === null) companyType = mapped;
    rest = rest.replace(new RegExp(escaped, "gi"), " ");
  }
  const company = rest.replace(/[\s/\\·,，、;；:：\-|]+/g, " ").trim();
  return { companyType, company: company === "" ? null : company };
}

/** 联系方式单列拆分（源表一列混写电话 / WhatsApp / 微信）：含「微信 / WeChat」字样 → wechat，其余整段落 phone。 */
function splitContact(raw: string): { phone: string | null; wechat: string | null } {
  const text = clean(raw);
  if (text === "") return { phone: null, wechat: null };
  if (/微信|wechat|weixin/i.test(text)) return { phone: null, wechat: text };
  return { phone: text, wechat: null };
}

/**
 * 「干系人」表 → 标准干系人模型（Push 324 口径，与字段对照清单.md §1 对齐）：姓名必填（空行跳过）；
 * 公司分类按自由写法映射四值，识别不出 = 按「客户」兜底 + 逐行提醒；联系方式整段落 phone（含微信字样落 wechat）；
 * 填写者 / 提交时间原样带出（提交时「填写者」匹配库内账号 → created_by；「提交时间」→ created_at）。
 */
export function convertStakeholders(
  sheets: SheetGrid[],
  year: number,
): { sheetName: string | null; stakeholders: LegacyStakeholder[]; issues: LegacyIssueSeed[] } {
  const picked = pickStakeholderSheet(sheets);
  if (picked === null) return { sheetName: null, stakeholders: [], issues: [] };
  const { sheet, columns } = picked;
  const stakeholders: LegacyStakeholder[] = [];
  const issues: LegacyIssueSeed[] = [];
  const cellOf = (row: number, column: number | null): string => {
    if (column === null) return "";
    const cells = sheet.rows[row];
    if (cells === undefined) return "";
    return clean(cells[column]);
  };
  for (let row = 1; row < sheet.rows.length; row += 1) {
    const name = cellOf(row, columns.name);
    if (name === "") continue;
    const rawCompany = cellOf(row, columns.company);
    const parsed = parseCompanyType(rawCompany);
    if (parsed.companyType === null && rawCompany !== "") {
      issues.push(
        createIssue(
          "warning",
          "STAKEHOLDER_COMPANY_UNMATCHED",
          row + 1,
          name,
          "公司分类识别不出（" + rawCompany + "）：已按「客户」导入，请在项目「干系人」里核对",
          "Company category not recognized (" + rawCompany + "): imported as customer; please verify in the project stakeholders tab.",
        ),
      );
    }
    const contact = splitContact(cellOf(row, columns.contact));
    stakeholders.push({
      row: row + 1,
      name,
      companyType: parsed.companyType ?? "customer",
      company: parsed.company,
      title: cellOf(row, columns.title) === "" ? null : cellOf(row, columns.title),
      phone: contact.phone,
      wechat: contact.wechat,
      email: cellOf(row, columns.email) === "" ? null : cellOf(row, columns.email),
      role: cellOf(row, columns.role) === "" ? null : cellOf(row, columns.role),
      filler: cellOf(row, columns.filler) === "" ? null : cellOf(row, columns.filler),
      submittedAt: parseDateStr(cellOf(row, columns.submitted), year),
    });
  }
  return { sheetName: sheet.name, stakeholders, issues };
}

/** 年份识别：任意单元格里第一个「YYYY 年」。 */
export function sniffYear(sheets: SheetGrid[]): number | null {
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        const match = clean(cell).match(/([0-9]{4})年/);
        if (match !== null && match[1] !== undefined) return Number(match[1]);
      }
    }
  }
  return null;
}

function createIssue(
  level: ImportIssueLevel,
  code: string,
  row: number | null,
  subject: string | null,
  zh: string,
  en: string,
): LegacyIssueSeed {
  return { level, code, row, subject, zh, en };
}

const REGION_GUESS: [string, string][] = [
  ["UK", "英国"],
  ["英国", "英国"],
  ["爱尔兰", "爱尔兰"],
  ["美国", "美国"],
  ["越南", "越南"],
  ["德国", "德国"],
  ["法国", "法国"],
  ["荷兰", "荷兰"],
  ["西班牙", "西班牙"],
  ["波兰", "波兰"],
  ["日本", "日本"],
  ["韩国", "韩国"],
  ["澳大利亚", "澳大利亚"],
  ["澳洲", "澳大利亚"],
];

const TYPE_GUESS: [string, string][] = [
  ["AIRROB", "飞箱"],
  ["飞箱", "飞箱"],
  ["T-SORT", "T-sort"],
  ["TSORT", "T-sort"],
  ["3D", "3D分拣"],
];

/** 主入口：解析后的工作簿 → 标准导入模型 + 提醒清单。 */
export function convertLegacyWorkbook(workbook: ParsedWorkbook, fileName: string): LegacyParse {
  const sheets = workbook.sheets;
  const sheetNames = sheets.map((sheet) => sheet.name);
  const taskSheet = pickSheet(sheets, ["任务描述", "任务状态", "阶段性里程"]);
  const reportSheet = pickSheet(sheets, ["填写者", "当日完成工作", "施工人数"]);
  const changeSheet = pickSheet(sheets, ["变更时间", "变更原因"]);
  const issues: LegacyIssueSeed[] = [];
  if (taskSheet === null) {
    throw new Error("未找到任务 sheet（需含 任务描述 / 任务状态 / 阶段性里程 表头）；现有 sheet：" + sheetNames.join("、"));
  }

  let year: number | null = null;
  if (reportSheet !== null) {
    outer: for (const row of reportSheet.sheet.rows) {
      for (const cell of row) {
        const text = clean(cell);
        const match = text.match(/([0-9]{4})年/);
        if (match !== null) {
          year = Number(match[1]);
          break outer;
        }
      }
    }
  }
  const yearDefaulted = year === null;
  if (year === null) year = new Date().getFullYear();
  const baseYear = year;

  const people = new Map<string, number>();
  const addPerson = (name: string) => {
    if (name !== "") people.set(name, (people.get(name) ?? 0) + 1);
  };

  const tasks: LegacyTask[] = [];
  const { sheet, index } = taskSheet;
  for (let row = 1; row < sheet.rows.length; row += 1) {
    const descRaw = cellAt(sheet, row, index, "任务描述");
    if (descRaw === "") continue;
    const split = splitTitle(descRaw);
    const title = split.title === "" ? squashSpaces(descRaw) : split.title;
    const stageRaw = cellAt(sheet, row, index, "阶段性里程");
    const stageKey = STAGE_KEY_BY_NAME[stageRaw] ?? null;
    if (stageRaw !== "" && stageKey === null) {
      issues.push(
        createIssue(
          "warning",
          "UNKNOWN_STAGE",
          row + 1,
          title,
          "阶段性里程「" + stageRaw + "」不在九阶段内：该任务按临时任务导入（不占阶段范围）",
          "Stage value " + stageRaw + " is not one of the nine stages; the task is imported as a temporary task.",
        ),
      );
    }
    const docs: string[] = [];
    const unknownDocs: string[] = [];
    for (const part of cellAt(sheet, row, index, "输出成果文件").replace(/，|、|；|;/g, ",").split(",")) {
      const text = clean(part);
      if (text === "") continue;
      const canon = DOC_CANON.get(normalizeDocKey(text));
      if (canon === undefined) unknownDocs.push(text);
      else docs.push(canon);
    }
    if (unknownDocs.length > 0) {
      issues.push(
        createIssue(
          "warning",
          "UNKNOWN_DOC",
          row + 1,
          title,
          "输出成果文件类型无法识别（未写入）：" + unknownDocs.join(" / "),
          "Unknown deliverable types were skipped: " + unknownDocs.join(" / "),
        ),
      );
    }
    const statusRaw = cellAt(sheet, row, index, "任务状态");
    const progressRaw = cellAt(sheet, row, index, "项目进度");
    const ownerRaw = cellAt(sheet, row, index, "任务负责人");
    const managerRaw = cellAt(sheet, row, index, "项目经理");
    const changeRefRaw = cellAt(sheet, row, index, "变更关联");
    const plannedStart = parseDateStr(cellAt(sheet, row, index, "开始日期"), baseYear);
    const plannedEnd = parseDateStr(cellAt(sheet, row, index, "预计完成日期"), baseYear);
    const actualEnd = parseDateStr(cellAt(sheet, row, index, "实际完成日期"), baseYear);
    const daysRaw = cellAt(sheet, row, index, "预计所需天数");
    const headRaw = cellAt(sheet, row, index, "预计所需施工人数");
    const noteRaw = cellAt(sheet, row, index, "项目进展描述");

    const statusKey: "pending" | "active" | "done" | null =
      DONE_STATUS.has(statusRaw) ? "done" : statusRaw === "进行中" || statusRaw === "已延期" ? "active" : statusRaw === "待开始" ? "pending" : null;
    if (statusRaw !== "" && statusKey === null) {
      issues.push(
        createIssue("warning", "UNKNOWN_STATUS", row + 1, title, "任务状态无法识别（按待开始处理）：" + statusRaw, "Unknown task status (treated as not started): " + statusRaw),
      );
    }
    for (const item of [
      ["开始日期", cellAt(sheet, row, index, "开始日期"), plannedStart],
      ["预计完成日期", cellAt(sheet, row, index, "预计完成日期"), plannedEnd],
      ["实际完成日期", cellAt(sheet, row, index, "实际完成日期"), actualEnd],
    ] as [string, string, string | null][]) {
      if (item[1] !== "" && item[2] === null) {
        issues.push(
          createIssue("warning", "DATE_UNPARSED", row + 1, title, item[0] + "无法识别（已留空）：" + item[1], item[0] + " could not be parsed and was left empty: " + item[1]),
        );
      }
    }
    if (plannedStart !== null && plannedEnd !== null && plannedStart > plannedEnd) {
      issues.push(
        createIssue("warning", "DATE_ORDER_END", row + 1, title, "开始日期晚于预计完成日期（照原值导入，请核对）", "Start date is later than the planned finish date (imported as-is; please verify)."),
      );
    }
    if (plannedStart !== null && actualEnd !== null && actualEnd < plannedStart) {
      issues.push(
        createIssue("warning", "DATE_ORDER", row + 1, title, "实际完成早于开始（照原值导入，请核对）", "Finish date is earlier than the start date (imported as-is; please verify)."),
      );
    }
    const progressNumber = Number(progressRaw);
    if (actualEnd !== null && !DONE_STATUS.has(statusRaw)) {
      issues.push(
        createIssue("warning", "WITH_DATE_NOT_DONE", row + 1, title, "已填实际完成日期但任务状态是「" + statusRaw + "」：按原状态导入，请核对", "A finish date exists but the status is not done; imported by the original status."),
      );
    }
    if (statusRaw === "进行中" && progressRaw === "1") {
      issues.push(
        createIssue("warning", "STATUS_PROGRESS", row + 1, title, "进行中但原表进度 = 1：按进行中封顶 75%", "In progress but progress was 1; capped at 75%."),
      );
    }
    if (DONE_STATUS.has(statusRaw) && progressRaw !== "" && progressNumber < 1) {
      issues.push(
        createIssue("warning", "STATUS_PROGRESS", row + 1, title, "完成态但原表进度 < 1：按完成态导入（进度 100%）", "Done but progress was below 1; imported as done (100%)."),
      );
    }
    let progress: number;
    if (statusKey === "done") {
      if (actualEnd !== null) {
        progress = 1;
      } else {
        progress = 0.75;
        issues.push(
          createIssue("warning", "DONE_NO_DATE", row + 1, title, "完成日期未填，不算完成：进度按进行中处理（封顶 75%）", "No finish date: not counted as done; progress capped at 75%."),
        );
      }
    } else if (statusKey === "pending") {
      progress = 0;
      if (progressRaw !== "" && Number(progressRaw) !== 0) {
        issues.push(
          createIssue("info", "PENDING_WITH_PROGRESS", row + 1, title, "待开始任务的进度按口径归零：原表 " + progressRaw + " → 0", "Not-started task progress reset to 0 (was " + progressRaw + ")."),
        );
      }
    } else {
      const binned = bin(progressRaw);
      progress = Math.min(binned === null ? 0 : binned, 0.75);
      if (progressRaw !== "" && binned === 1) {
        issues.push(
          createIssue("info", "PROGRESS_BINNED", row + 1, title, "进度按五档口径收敛：" + progressRaw + " → 0.75（进行中封顶 75%）", "Progress mapped to the 5-step scale: " + progressRaw + " -> 0.75 (capped)."),
        );
      } else if (progressRaw !== "" && Number(progressRaw) !== progress) {
        issues.push(
          createIssue("info", "PROGRESS_BINNED", row + 1, title, "进度按五档口径收敛：" + progressRaw + " → " + progress, "Progress mapped to the 5-step scale: " + progressRaw + " -> " + progress + "."),
        );
      }
    }
    const onTimeRaw = cellAt(sheet, row, index, "是否按时交付");
    if (onTimeRaw !== "" && onTimeRaw !== "按时交付" && onTimeRaw !== "延期交付") {
      issues.push(
        createIssue("warning", "ONTIME_VALUE", row + 1, title, "是否按时交付取值无法识别：" + onTimeRaw, "Unknown on-time value: " + onTimeRaw),
      );
    }
    if (onTimeRaw !== "" && actualEnd !== null && plannedEnd !== null) {
      const expected = actualEnd <= plannedEnd ? "按时交付" : "延期交付";
      if (expected !== onTimeRaw) {
        issues.push(
          createIssue("warning", "ONTIME_MISMATCH", row + 1, title, "是否按时交付与原表日期推导不一致：原表 " + onTimeRaw + " / 推导 " + expected, "On-time flag conflicts with the dates: sheet " + onTimeRaw + " / derived " + expected),
        );
      }
    }
    tasks.push({
      row: row + 1,
      title,
      titleEn: split.titleEn,
      stageRaw,
      stageKey,
      baseStatus: statusKey === null ? "pending" : statusKey,
      statusOverride: statusRaw === "已延期" ? "overdue" : statusRaw === "提前完成" ? "early_done" : null,
      progress,
      plannedStart,
      plannedEnd,
      actualEnd,
      estimatedDays: daysRaw === "" ? null : Number(daysRaw),
      headcount: headRaw === "" ? null : Number(headRaw),
      deliverableTypes: docs,
      note: noteRaw === "" ? null : noteRaw,
      onTime: onTimeRaw === "按时交付" ? true : onTimeRaw === "延期交付" ? false : null,
      ownerRaw,
      ownerNames: splitNames(ownerRaw),
      managerName: managerRaw === "" ? null : managerRaw,
      changeRefRaw: changeRefRaw === "" ? null : changeRefRaw,
    });
  }

  const managerCounts = new Map<string, number>();
  for (const task of tasks) {
    if (task.managerName !== null) managerCounts.set(task.managerName, (managerCounts.get(task.managerName) ?? 0) + 1);
  }
  let majorityManager: string | null = null;
  let majorityCount = 0;
  for (const [name, count] of managerCounts) {
    if (count > majorityCount) {
      majorityManager = name;
      majorityCount = count;
    }
  }
  for (const task of tasks) {
    if (task.managerName === null && majorityManager !== null) {
      task.managerName = majorityManager;
      issues.push(
        createIssue("info", "MANAGER_FILLED", task.row, task.title, "原表项目经理为空，按全表口径补「" + majorityManager + "」", "Manager was empty in the sheet; filled with " + majorityManager + " (sheet-wide value)."),
      );
    }
    addPerson(task.managerName ?? "");
    for (const owner of task.ownerNames) addPerson(owner);
  }

  const reports: LegacyReport[] = [];
  if (reportSheet !== null) {
    const sheetRef = reportSheet.sheet;
    const reportIndex = reportSheet.index;
    for (let row = 1; row < sheetRef.rows.length; row += 1) {
      const dateRaw = cellAt(sheetRef, row, reportIndex, "日期");
      let reportDate = parseDateStr(dateRaw, baseYear);
      if (dateRaw === "") continue;
      if (reportDate === null) {
        const match = dateRaw.match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
        if (match !== null) {
          reportDate = match[1] + "-" + String(match[2]).padStart(2, "0") + "-" + String(match[3]).padStart(2, "0");
        }
      }
      if (reportDate === null) {
        issues.push(
          createIssue("warning", "REPORT_BAD_DATE", row + 1, null, "日报日期无法识别，该行未导入：" + dateRaw, "Report date could not be parsed; the row was skipped: " + dateRaw),
        );
        continue;
      }
      const authorName = cellAt(sheetRef, row, reportIndex, "填写者");
      const found = cellAt(sheetRef, row, reportIndex, "问题描述");
      const categories: string[] = [];
      const known = new Set<string>(ISSUE_CATEGORIES as readonly string[]);
      const badCategories: string[] = [];
      for (const part of cellAt(sheetRef, row, reportIndex, "问题归类").replace(/，|、|；|;/g, ",").split(",")) {
        const text = clean(part);
        if (text === "") continue;
        if (known.has(text)) categories.push(text);
        else badCategories.push(text);
      }
      if (badCategories.length > 0) {
        issues.push(
          createIssue("warning", "ISSUE_BAD_CATEGORY", row + 1, found === "" ? null : found, "问题归类不在十项内（按「其它原因」导入）：" + badCategories.join(" / "), "Unknown issue categories were imported as 其它原因: " + badCategories.join(" / ")),
        );
      }
      if (found !== "" && categories.length === 0) {
        categories.push("其它原因");
        issues.push(
          createIssue("info", "ISSUE_NO_CATEGORY", row + 1, found, "问题归类为空：按「其它原因」兜底", "Issue category was empty; defaulted to 其它原因."),
        );
      }
      const stateRaw = cellAt(sheetRef, row, reportIndex, "问题是否处理");
      let issueState: "open" | "in_progress" | "done" | null = null;
      if (stateRaw === "已完成") issueState = "done";
      else if (stateRaw === "处理中") issueState = "in_progress";
      else if (stateRaw === "未解决") issueState = "open";
      else if (stateRaw !== "") {
        issues.push(
          createIssue("warning", "UNKNOWN_STATE", row + 1, found === "" ? null : found, "问题是否处理取值无法识别（按未解决处理）：" + stateRaw, "Unknown issue state (treated as open): " + stateRaw),
        );
        issueState = "open";
      }
      const solution = cellAt(sheetRef, row, reportIndex, "解决方案或建议");
      const headRaw = cellAt(sheetRef, row, reportIndex, "施工人数");
      const doneWork = cellAt(sheetRef, row, reportIndex, "当日完成工作");
      reports.push({
        row: row + 1,
        reportDate,
        authorName,
        doneWork: doneWork === "" ? "（原文为空）" : doneWork,
        plan: cellAt(sheetRef, row, reportIndex, "明日计划") || null,
        headcount: headRaw === "" ? null : Number(headRaw),
        issue:
          found === ""
            ? null
            : {
                title: found,
                categories,
                state: issueState ?? "open",
                solution: solution === "" ? null : solution,
              },
      });
    }
  }

  const changes: LegacyChange[] = [];
  // 变更前 / 变更后列（1 based 列号；缺列 = null）：列内嵌图随变更行导入（Push 349，锚点行 = 变更行）。
  const changeBeforeColumn = changeSheet === null || !changeSheet.index.has("变更前") ? null : changeSheet.index.get("变更前")! + 1;
  const changeAfterColumn = changeSheet === null || !changeSheet.index.has("变更后") ? null : changeSheet.index.get("变更后")! + 1;
  if (changeSheet !== null) {
    const sheetRef = changeSheet.sheet;
    const changeIndex = changeSheet.index;
    // 只有图的变更行也要导入（业务口径 2026-10-16「变更记录也是有图片的这个也要导入的」）：锚点行同样算数据行。
    const anchoredRows = new Set<number>();
    for (const anchor of workbook.anchors) {
      if (anchor.sheet !== sheetRef.name) continue;
      if (anchor.col === changeBeforeColumn || anchor.col === changeAfterColumn) anchoredRows.add(anchor.row);
    }
    for (let row = 1; row < sheetRef.rows.length; row += 1) {
      const cells = sheetRef.rows[row] ?? [];
      if (!cells.some((value) => clean(value) !== "") && !anchoredRows.has(row + 1)) continue;
      const stageRaw = cellAt(sheetRef, row, changeIndex, "变更阶段");
      const content = cellAt(sheetRef, row, changeIndex, "变更内容描述");
      const reason = cellAt(sheetRef, row, changeIndex, "变更原因");
      const stageKey: StageKey | null = stageRaw.includes("实施") ? "install" : stageRaw.includes("发货") ? "assembly" : null;
      const docRaw = cellAt(sheetRef, row, changeIndex, "变更文件");
      const contentClean = content.split(" ").join("");
      const reasonClean = reason.split(" ").join("");
      const contentPlaceholder = /x{2,}/i.test(contentClean);
      const reasonPlaceholder = /x{2,}/i.test(reasonClean);
      const placeholder = contentPlaceholder || reasonPlaceholder;
      changes.push({
        row: row + 1,
        appliedAt: parseDateStr(cellAt(sheetRef, row, changeIndex, "变更时间"), baseYear),
        stageRaw,
        stageKey,
        docType: docRaw === "" ? null : DOC_CANON.get(normalizeDocKey(docRaw)) ?? docRaw,
        content,
        before: cellAt(sheetRef, row, changeIndex, "变更前") || null,
        after: cellAt(sheetRef, row, changeIndex, "变更后") || null,
        reason,
        requester: cellAt(sheetRef, row, changeIndex, "变更申请人"),
        filler: cellAt(sheetRef, row, changeIndex, "填写者"),
        afterFileName: cellAt(sheetRef, row, changeIndex, "变更后文件") || null,
        afterFileVersion: cellAt(sheetRef, row, changeIndex, "变更后文件版本") || null,
        related: cellAt(sheetRef, row, changeIndex, "关联") || null,
        placeholder,
        contentPlaceholder,
        reasonPlaceholder,
      });
      addPerson(cellAt(sheetRef, row, changeIndex, "变更申请人"));
    }
  }

  // 变更关联（业务口径 2026-10-14「表格中变更关联的字样没有写」）：变更管理「关联」列（多值按逗号 / 顿号拆）
  // 按任务描述匹配（键 = 去全部空白 + 小写，对「标题+英文名」「标题」「英文名」三串）；命中 → changeLinks
  //（提交时回写任务 change_refs，追加序 = 变更表行序）。两侧对不上 / 日期不一致出提醒（照常导入，不阻断）。
  const changeLinks: LegacyChangeLink[] = [];
  {
    const taskKeys = tasks.map((task) => {
      const keys = new Set<string>();
      for (const text of [task.title + (task.titleEn === null ? "" : task.titleEn), task.title, task.titleEn ?? ""]) {
        const key = linkKey(text);
        if (key !== "") keys.add(key);
      }
      return keys;
    });
    const linkedTasks = new Set<number>();
    changes.forEach((change, changeIndex) => {
      if (change.related === null) return;
      const wanted = change.related
        .replace(/，|、|；|;/g, ",")
        .split(",")
        .map(linkKey)
        .filter((key) => key !== "");
      let hit: number | null = null;
      let ambiguous = false;
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        if (!wanted.some((key) => taskKeys[taskIndex]!.has(key))) continue;
        if (hit === null) hit = taskIndex;
        else ambiguous = true;
      }
      if (hit === null) {
        issues.push(
          createIssue(
            "warning",
            "CHANGE_RELATED_UNMATCHED",
            change.row,
            change.content === "" ? null : change.content,
            "变更「关联」在任务表找不到对应任务：未写入任务变更关联 —— " + change.related,
            "The change 关联 value did not match any task title; it was not linked to a task: " + change.related,
          ),
        );
        return;
      }
      changeLinks.push({ changeIndex, taskIndex: hit });
      linkedTasks.add(hit);
      const task = tasks[hit]!;
      if (ambiguous) {
        issues.push(
          createIssue(
            "warning",
            "CHANGE_RELATED_AMBIGUOUS",
            change.row,
            task.title,
            "变更「关联」命中多个任务，已挂到第一个：请核对 —— " + change.related,
            "The change 关联 value matched multiple tasks; linked to the first one: " + change.related,
          ),
        );
      }
      const refDate = task.changeRefRaw === null ? null : parseDateStr(task.changeRefRaw, baseYear);
      if (refDate !== null && change.appliedAt !== null && refDate !== change.appliedAt) {
        issues.push(
          createIssue(
            "warning",
            "CHANGE_DATE_MISMATCH",
            task.row,
            task.title,
            "「变更关联」日期（" + refDate + "）与变更时间（" + change.appliedAt + "）不一致：已按「关联」列挂接，请核对",
            "The 变更关联 date (" + refDate + ") differs from the change date (" + change.appliedAt + "); linked by the 关联 column, please verify.",
          ),
        );
      }
    });
    tasks.forEach((task, taskIndex) => {
      if (task.changeRefRaw === null || linkedTasks.has(taskIndex)) return;
      issues.push(
        createIssue(
          "warning",
          "TASK_CHANGE_REF_UNMATCHED",
          task.row,
          task.title,
          "任务表「变更关联」写了「" + task.changeRefRaw + "」但没匹配到变更记录：未写入变更关联（请核对）",
          "The task sheet 变更关联 value (" + task.changeRefRaw + ") did not match any change record; nothing was linked (please verify).",
        ),
      );
    });
    if (changes.length > 0) {
      const linked = changeLinks.length;
      issues.push(
        createIssue(
          "info",
          "CHANGE_LINK_SUMMARY",
          null,
          null,
          "变更记录 " + String(changes.length) + " 条：按「关联」列写入任务变更关联 " + String(linked) + " 条；未关联 " + String(changes.length - linked) + " 条（只存记录，不挂任务）",
          "Change records: " + String(changes.length) + " imported; " + String(linked) + " linked to tasks via the 关联 column; " + String(changes.length - linked) + " unlinked (kept as records only).",
        ),
      );
    }
  }
  // 干系人（Push 324）：「干系人」表直接解析（没有该表 = 空数组；另附文件在服务层合并）。
  const stakeholderConvert = convertStakeholders(sheets, baseYear);
  issues.push(...stakeholderConvert.issues);

  const images: LegacyImage[] = [];
  if (reportSheet !== null) {
    for (const anchor of workbook.anchors) {
      if (anchor.sheet !== reportSheet.sheet.name) continue;
      if (anchor.col !== 5 && anchor.col !== 9) continue;
      if (anchor.row < 2) continue;
      images.push({ sheet: anchor.sheet, row: anchor.row, col: anchor.col, kind: anchor.col === 5 ? "onsite" : "issue", media: anchor.media });
    }
  }
  // 变更表「变更前 / 变更后」列内嵌图（Push 349）：按列定位、按行对变更记录；列外 / 表头行锚点出提醒、不导入。
  if (changeSheet !== null) {
    let unplaced = 0;
    for (const anchor of workbook.anchors) {
      if (anchor.sheet !== changeSheet.sheet.name) continue;
      const kind =
        anchor.row >= 2 && anchor.col === changeBeforeColumn
          ? "change_before"
          : anchor.row >= 2 && anchor.col === changeAfterColumn
            ? "change_after"
            : null;
      if (kind === null) {
        unplaced += 1;
        continue;
      }
      images.push({ sheet: anchor.sheet, row: anchor.row, col: anchor.col, kind, media: anchor.media });
    }
    if (unplaced > 0) {
      issues.push(
        createIssue(
          "warning",
          "CHANGE_IMAGE_UNPLACED",
          null,
          String(unplaced) + " 张",
          "变更表有 " + String(unplaced) + " 张图片不在「变更前 / 变更后」列（或锚在表头行）：未导入，请导入后在变更记录里手工补图",
          "The change sheet has " + String(unplaced) + " image(s) outside the 变更前 / 变更后 columns (or anchored on the header row); they were skipped — please add them manually in the change records.",
        ),
      );
    }
  }
  const manualFiles: LegacyManualFile[] = [];
  changes.forEach((change, changeIndex) => {
    if (change.afterFileName !== null) {
      manualFiles.push({
        kind: "change_after",
        taskIndex: null,
        changeIndex,
        name: change.afterFileName,
        subject: change.content === "" ? null : change.content,
        reason: "变更后文件（微盘 / 本地路径）：需手动上传",
        zh: "导入表只写了文件名（源文件在微盘 / 本地路径）：导入后请按清单手动上传",
        en: "The workbook only lists the file name (file lives in WeDrive or a local path); please upload it manually after import.",
      });
    }
  });
  if (taskSheet !== null) {
    const sheetRef = taskSheet.sheet;
    const taskIndex = taskSheet.index;
    const taskRowIndexes = new Map(tasks.map((task, index) => [task.row, index]));
    for (let row = 1; row < sheetRef.rows.length; row += 1) {
      const fileName = cellAt(sheetRef, row, taskIndex, "文件");
      if (fileName === "") continue;
      const title = splitTitle(cellAt(sheetRef, row, taskIndex, "任务描述")).title;
      const parsedTaskIndex = taskRowIndexes.get(row + 1) ?? null;
      for (const part of splitNames(fileName)) {
        manualFiles.push({
          kind: "task",
          taskIndex: parsedTaskIndex,
          changeIndex: null,
          name: part,
          subject: title,
          reason: "任务附件（微盘 / 本地路径）：需手动上传",
          zh: "导入表只写了文件名（源文件在微盘 / 本地路径）：导入后请按清单手动上传",
          en: "The workbook only lists the file name (file lives in WeDrive or a local path); please upload it manually after import.",
        });
      }
    }
  }

  const noExt = fileName.toLowerCase().endsWith(".xlsx") ? fileName.slice(0, fileName.length - 5) : fileName;
  let code: string | null = null;
  let projectName = noExt;
  if (noExt.startsWith("[")) {
    const close = noExt.indexOf("]");
    if (close > 0) {
      code = noExt.slice(1, close).trim();
      projectName = noExt.slice(close + 1).trim() || noExt;
    }
  }
  const regionHit = REGION_GUESS.find(([key]) => noExt.includes(key));
  const upper = noExt.toUpperCase();
  const typeHit = TYPE_GUESS.find(([key]) => upper.includes(key));
  const project: LegacyProjectPlacement = {
    code: code === null || code === "" ? projectName.slice(0, 64) : code,
    name: projectName.slice(0, 200),
    region: regionHit === undefined ? null : regionHit[1],
    projectType: typeHit === undefined ? null : typeHit[1],
    managerNames: majorityManager === null ? [] : [majorityManager],
  };
  if (regionHit === undefined) {
    issues.push(
      createIssue("warning", "REGION_UNRESOLVED", null, null, "未能从文件名识别地区：请在面板选择项目地区（必选）", "Region could not be inferred from the file name; please pick it in the panel."),
    );
  }

  return {
    project,
    tasks,
    reports,
    changes,
    changeLinks,
    stakeholders: stakeholderConvert.stakeholders,
    stakeholderSheetName: stakeholderConvert.sheetName,
    images,
    manualFiles,
    issues,
    year: baseYear,
    yearDefaulted,
    sheetNames,
    taskSheetName: taskSheet.sheet.name,
    reportSheetName: reportSheet === null ? null : reportSheet.sheet.name,
    changeSheetName: changeSheet === null ? null : changeSheet.sheet.name,
  };
}
