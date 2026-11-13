/**
 * 导入表导入（直连 API 导入 · 业务口径 2026-10-14）前端接口封装：
 * 项目空间「导入项目」→ 选导入表 Excel → 项目空间内「大屏」面板解析 / 校验 / 确认 / 写入，全程不切页。
 * - POST /api/v1/project-imports/preview：multipart/form-data（字段 file）→ 解析 + 口径校验 → 预览报告（不写库）
 * - POST /api/v1/project-imports/commit：JSON（previewId + 落位确认）→ 建项目并写入全量数据
 * 转换口径（业务已回执，研究记录见 D:\LibiaoLink_help\_conv）：完成日期未填不算完成、进度五档（进行中封顶 75%）、
 * 日期笔误照原值导入 + 提醒、任务节点按精确及语义匹配复用或人工确认、变更阶段映射（实施→install、发货→assembly）、
 * 微盘图片出「需手动导入」清单、账号 = 拼音登录名 + 中文名加 -test 显示名 + 初始密码 123456；
 * 干系人（Push 324）：「干系人」表随导入落台账（公司分类自由写法映射四值 / 「填写者」匹配库内账号 / 提交时间）；
 * 干系人信息随导入表内的「干系人」表一并导入。
 * 字段面 = 前端消费面；正式契约由后端落 shared/src/modules/imports.ts（见《前端功能需求》§3.9）。
 */
import { apiRequest, apiSend } from "./api";
import type { TaskNodeRequestStatus } from "./templateApi";

/** 提醒等级：error = 阻断（处理完才能导入）；warning = 照原值导入只提示；info = 口径说明。 */
export type ImportIssueLevel = "error" | "warning" | "info";

/** 一条提醒（message 由服务端按口径渲染好，前端只展示）。 */
export type ImportIssue = {
  level: ImportIssueLevel;
  code: string;
  message: string;
  /** 源表行号（行级提醒才有：日期笔误 / 进度改写等）。 */
  row: number | null;
  /** 关联对象名（任务名等，可空）。 */
  subject: string | null;
};

/** 账号落位：isNew = 本次要新建；false = 已存在，导入时直接挂项目经理。 */
export type ImportAccount = {
  name: string;
  username: string;
  displayName: string;
  isNew: boolean;
};

/** 手动文件落位：task = 任务表「文件」列；change_after = 变更表「变更后文件」。 */
export type ImportManualFileKind = "task" | "change_after";

/** 需手动导入的文件（导入表里的微盘 / 本地路径，系统抓不到 —— 面板就地选文件，确认导入后一并上传）。 */
export type ImportManualImage = {
  /** 稳定标识（manual-<序号>；提交结果 manualTargets 按此回传任务 / 变更目标）。 */
  id: string;
  kind: ImportManualFileKind;
  task: string | null;
  name: string;
  reason: string;
};

/** 任务节点匹配：精确命中复用，语义建议逐条选择，保留原名可加入个人模板。 */
export type ImportTaskNode = {
  name: string;
  /** 节点英文名（节点库 title_en 口径 / 未匹配时取源表英文列）：节点库中英文名成对，导入新节点时一并落库；源表没英文 = null。 */
  nameEn: string | null;
  sourceNameEn: string | null;
  matched: boolean;
  groupIndex: number;
  stageKey: string | null;
  matchKind: "exact" | "semantic" | "new" | "uncertain" | "temporary";
  libraryId: string | null;
  tasks: Array<{ index: number; row: number }>;
  inStageScope: boolean;
  taskCount: number;
};

/** 解析预览（不写库）：项目落位 + 各域条数 + 三份清单 + 提醒清单。 */
export type ProjectImportPreview = {
  previewId: string;
  expiresAt: string;
  file: { name: string; size: number };
  project: {
    code: string;
    name: string;
    region: string | null;
    projectType: string | null;
    managerNames: string[];
  };
  counts: {
    tasks: number;
    reports: number;
    changes: number;
    /** 变更 ↔ 任务关联条数（「关联」列 + R01 输出成果文件匹配）。 */
    changesLinked: number;
    stakeholders: number;
    images: number;
    imagesManual: number;
    accountsNew: number;
    nodesNew: number;
  };
  accounts: ImportAccount[];
  imagesManual: ImportManualImage[];
  nodes: ImportTaskNode[];
  nodeLibrary: Array<{ id: string; stageKey: string; title: string; titleEn: string | null; version: number }>;
  personalTemplates: Array<{ id: string; name: string; stageKey: string; version: number }>;
  issues: ImportIssue[];
};

/** 确认导入（落位、人工确认及冲突选择）。 */
export type ProjectImportCommitInput = {
  previewId: string;
  /** 项目地区（标准国家 / 地区名或字典码）—— 源表识别不出时必须由用户在面板里选。 */
  region: string;
  /** 项目类型（字典 projectType 的码）；空串 = 未指定（解析按源表关键字给默认，如 AIRROB → 飞箱）。 */
  projectType: string;
  /** 兼容旧服务端，明确关闭节点补库。 */
  addMissingNodes?: false;
  nodeDecisions?: Array<{ groupIndex: number; action: "existing" | "standalone"; nodeId: string | null }>;
  personalTemplateSelections?: Array<{ groupIndex: number; templateId: string; version: number }>;
  /**
   * 公共节点申请（可选）：只允许对「保留 Excel 原名」的阶段内节点提交，同一 groupIndex 只能出现一次。
   * title 缺省 = 源表原名；titleEn 缺省 = 预览补全的英文；显式 null = 无英文。
   * 申请与导入同一事务提交 —— 申请失败不影响项目写入，反之亦然（整批回滚）。
   */
  nodeRequests?: Array<{ groupIndex: number; title?: string; titleEn?: string | null }>;
  conflictChoices?: Array<{ key: string; taskIndex: number }>;
};

/** 手动文件落位目标（提交结果回传；前端据此在导入后把选中的文件直传到对应任务 / 变更）。 */
export type ImportManualTarget = {
  id: string;
  taskId: string | null;
  changeId: string | null;
};

/** 导入结果（完成页展示 + 提醒复述）。 */
export type ProjectImportResult = {
  projectId: string;
  code: string;
  name: string;
  counts: {
    tasks: number;
    reports: number;
    changes: number;
    /** 变更 ↔ 任务关联条数（「关联」列 + R01 输出成果文件匹配）。 */
    changesLinked: number;
    stakeholders: number;
    images: number;
    accountsCreated: number;
    nodesAdded: number;
  };
  /** 手动文件落位目标（与预览 imagesManual 同序；旧服务端缺省 = 空数组）。 */
  manualTargets?: ImportManualTarget[];
  /** 本次随导入提交的公共节点申请（含合并到同名待审申请的；旧服务端缺省 = 空数组）。完成页据此提示「等待管理员审核」。 */
  nodeRequests?: Array<{ id: string; stageKey: string; title: string; status: TaskNodeRequestStatus }>;
  issues: ImportIssue[];
};

/** 前端先挡一道的文件闸（服务端仍会复检）：空文件 / 过大直接给提示，不浪费一次上传。 */
export const IMPORT_MAX_FILE_BYTES = 256 * 1024 * 1024;

export function previewProjectImport(file: File): Promise<ProjectImportPreview> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiRequest<ProjectImportPreview>("/api/v1/project-imports/preview", { method: "POST", body: form });
}

/** 确认导入（可取消）：传入 signal，abort → 服务端连接断开 → 单事务回滚（零残留），票据保留可再次确认。 */
export function commitProjectImport(input: ProjectImportCommitInput, signal?: AbortSignal): Promise<ProjectImportResult> {
  return apiSend<ProjectImportResult>("/api/v1/project-imports/commit", "POST", input, signal);
}

/** 导入补充附件回挂变更：文件直传完成后调用（变更后文件不再显示「待补」）。 */
export function attachManualChangeFile(projectId: string, changeId: string, fileId: string): Promise<void> {
  return apiSend<void>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/import-manual-files/attach-change",
    "POST",
    { changeId, fileId },
  );
}
