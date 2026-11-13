/**
 * 任务节点库 / 任务模板接口封装（M3-05 余 · 第一段接线 + 第二段模板落库）：契约 shared/src/modules/templates.ts。
 * - 列表 GET /api/v1/task-nodes?stage=<九阶段或 inbound_review 板块 key>（任务模板页左列与「添加任务」卡片的「任务节点」标签同源）
 * - 新增 POST /api/v1/task-nodes（写 = 系统管理员 / 部门编辑账号；同板块同名 409 NODE_ALREADY_EXISTS）
 * - 编辑 PATCH /api/v1/task-nodes/{id}（写 = 公共节点库维护权（仅系统管理员）；乐观锁 version 必传：过期 409 VERSION_CONFLICT）
 * - 删除 DELETE /api/v1/task-nodes/{id}（写 = blueprint.manage；物理删行 + 审计留痕；已生成的项目任务不受影响）
 * - 模板内新增 POST /api/v1/task-templates/{id}/nodes（只写当前模板私有节点，不进入公共节点库）
 * 任务模板（第二段 · Push 182）：GET/POST /api/v1/task-templates、PATCH/DELETE /api/v1/task-templates/{id}
 *   —— 写同样 = 模板管理权（新建：管理员或有效项目经理；编辑 / 删除：创建人或管理员）；新建时可选 private（仅自己）/ public（有浏览权的人），
 *      创建后只有填写人本人可随 PATCH 切换可见范围；
 * 板块名 ↔ 板块 key：九阶段复用 taskApi 的 stageKeyOfName；「入库审核」是模板库特殊分组，映射 inbound_review。
 * 注意：任务侧还没有「节点库来源」字段（契约 taskNodeId 现解析为项目流程节点），
 * 「已添加」一律按「同阶段同名」折算（见 data/tasks.ts 的 addedNodeKeysOf）。
 */
import { apiRequest, apiSend } from "./api";
import { stageKeyOfName } from "./taskApi";

/** 任务模板页专属分组：不是项目阶段，只用于模板库。 */
const TEMPLATE_SECTION_KEYS_BY_NAME: Record<string, string> = {
  "入库审核": "inbound_review",
};

function templateSectionKeyOfName(sectionName: string): string | null {
  return stageKeyOfName(sectionName) ?? TEMPLATE_SECTION_KEYS_BY_NAME[sectionName] ?? null;
}

/** 契约 TaskNode（只取界面用得到的字段；服务端多给字段忽略即可）。 */
export type ApiTaskNode = {
  id: string;
  stageKey: string;
  seq: number;
  title: string;
  titleEn: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** 节点卡片 / 添加卡片通用的最小形状（与 data/templatePresets 的 TemplatePresetNode 同形；id = 节点库 UUID）。 */
export type TaskNodeItem = { id: string; title: string; titleEn: string; /** 编辑用的乐观锁版本（Push 181；读接口按行下发，PATCH 时原样回传） */ version: number };

export function toNodeItem(node: ApiTaskNode): TaskNodeItem {
  return { id: node.id, title: node.title, titleEn: node.titleEn ?? "", version: node.version };
}

/** 某个模板板块的节点库列表；板块名不认识 = 空列表（不发请求）。 */
export async function fetchStageNodes(stageName: string): Promise<TaskNodeItem[]> {
  const stageKey = templateSectionKeyOfName(stageName);
  if (stageKey === null) {
    return [];
  }
  const payload = await apiRequest<{ items: ApiTaskNode[]; total: number }>(
    "/api/v1/task-nodes?stage=" + encodeURIComponent(stageKey),
  );
  return payload.items.map(toNodeItem);
}

/** 新增节点（中文名必填、英文名可空；缺省追加到该板块末尾）；返回落库后的条目。 */
export async function createStageNode(stageName: string, title: string, titleEn: string): Promise<TaskNodeItem> {
  const stageKey = templateSectionKeyOfName(stageName);
  if (stageKey === null) {
    throw new Error("未知阶段：" + stageName);
  }
  const payload = await apiSend<ApiTaskNode>("/api/v1/task-nodes", "POST", {
    stageKey,
    title,
    titleEn: titleEn.trim() === "" ? null : titleEn,
  });
  return toNodeItem(payload);
}

/** 在指定模板内新增私有节点；返回值只用于追加当前模板草稿，不进入左侧公共节点库。 */
export async function createTemplateStageNode(
  templateId: string,
  title: string,
  titleEn: string,
): Promise<TaskNodeItem> {
  const payload = await apiSend<{ nodeId: string; seq: number; title: string; titleEn: string | null }>(
    "/api/v1/task-templates/" + encodeURIComponent(templateId) + "/nodes",
    "POST",
    { title, titleEn: titleEn.trim() === "" ? null : titleEn },
  );
  return { id: payload.nodeId, title: payload.title, titleEn: payload.titleEn ?? "", version: 0 };
}

/**
 * 编辑节点（PATCH /api/v1/task-nodes/{id}）：改名 / 英文名；不动的字段不传。
 * setTitleEn = 显式传 null 表示清空英文名（undefined = 保持原样）。
 * 乐观锁 version 必传（读接口带回来的那一个）：过期 = 409 VERSION_CONFLICT，由调用方刷新重试。
 */
export async function updateStageNode(
  id: string,
  patch: { title?: string; titleEn?: string | null; version: number },
): Promise<TaskNodeItem> {
  const payload = await apiSend<ApiTaskNode>("/api/v1/task-nodes/" + encodeURIComponent(id), "PATCH", patch);
  return toNodeItem(payload);
}

/** 删除节点（物理删行；已按该节点生成的项目任务不受影响）。 */
export function deleteTaskNode(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiRequest<{ id: string; deleted: boolean }>(
    "/api/v1/task-nodes/" + encodeURIComponent(id),
    { method: "DELETE" },
  );
}

/** 节点库写入失败的统一文案（409 NODE_ALREADY_EXISTS / 403 FORBIDDEN 等；服务端仍是最终裁决）。 */
export function nodeWriteMessage(error: { code: string; message: string }): string {
  if (error.code === "NODE_ALREADY_EXISTS") {
    return "该板块已有同名节点，换个名字试试";
  }
  if (error.code === "FORBIDDEN") {
    return "维护节点库需要编辑权限";
  }
  if (error.code === "VERSION_CONFLICT") {
    return "这个节点刚被别人改过，刷新后再试";
  }
  if (error.code === "NOT_FOUND") {
    return "这个节点已经不在节点库里了，刷新看看";
  }
  if (error.code === "VALIDATION_FAILED") {
    return "节点名称不合规：" + error.message;
  }
  return error.message;
}

// ---------- 任务模板（第二段 · A1-16 / A1-17）----------

/** 模板可见范围：private = 仅填写人可见；public = 有模板浏览权的人可见。 */
export type TemplateVisibility = "private" | "public";

/** 契约 TaskTemplate（只取界面用得到的字段）。 */
export type ApiTaskTemplate = {
  id: string;
  name: string;
  stageKey: string;
  visibility: TemplateVisibility;
  nodes: { nodeId: string; seq: number; title: string; titleEn: string | null }[];
  createdBy: string | null;
  createdByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** 界面用的模板形状：`nodes` 与节点卡片同形（id = 节点库 UUID），`version` 供 PATCH / DELETE 回传。 */
export type TemplateItem = {
  id: string;
  name: string;
  visibility: TemplateVisibility;
  nodes: TaskNodeItem[];
  createdBy: string | null;
  createdByName: string | null;
  version: number;
};

export function toTemplateItem(template: ApiTaskTemplate): TemplateItem {
  return {
    id: template.id,
    name: template.name,
    visibility: template.visibility,
    nodes: template.nodes.map((node) => ({
      id: node.nodeId,
      title: node.title,
      titleEn: node.titleEn ?? "",
      version: 0,
    })),
    createdBy: template.createdBy,
    createdByName: template.createdByName,
    version: template.version,
  };
}

/** 某个模板板块的模板列表；板块名不认识 = 空列表（不发请求）。 */
export async function fetchStageTemplates(stageName: string): Promise<TemplateItem[]> {
  const stageKey = templateSectionKeyOfName(stageName);
  if (stageKey === null) {
    return [];
  }
  const payload = await apiRequest<{ items: ApiTaskTemplate[]; total: number }>(
    "/api/v1/task-templates?stage=" + encodeURIComponent(stageKey),
  );
  return payload.items.map(toTemplateItem);
}

/** 新建模板（名称 + 所属板块 + 可见范围 + 节点顺序；nodeIds 允许空 —— 新建后逐步拖入）。 */
export async function createTaskTemplate(
  stageName: string,
  name: string,
  nodeIds: string[],
  visibility: TemplateVisibility,
): Promise<TemplateItem> {
  const stageKey = templateSectionKeyOfName(stageName);
  if (stageKey === null) {
    throw new Error("未知阶段：" + stageName);
  }
  const payload = await apiSend<ApiTaskTemplate>("/api/v1/task-templates", "POST", { name, stageKey, visibility, nodeIds });
  return toTemplateItem(payload);
}

/**
 * 保存模板（PATCH）：改名 / 可见范围 / `nodeIds` 全量替换（含增删与重排）；不动的字段不传。
 * `version` 必传（读接口带回来的那一个）：过期 = 409 VERSION_CONFLICT，由调用方提示刷新。
 */
export async function updateTaskTemplate(
  id: string,
  patch: { name?: string; visibility?: TemplateVisibility; nodeIds?: string[]; version: number },
): Promise<TemplateItem> {
  const payload = await apiSend<ApiTaskTemplate>("/api/v1/task-templates/" + encodeURIComponent(id), "PATCH", patch);
  return toTemplateItem(payload);
}

/** 删除模板（软删；`version` 乐观锁随 body 带上）—— 删除即生效，已生成的项目任务不变。 */
export async function deleteTaskTemplate(id: string, version: number): Promise<{ id: string; deletedAt: string }> {
  return apiSend<{ id: string; deletedAt: string }>("/api/v1/task-templates/" + encodeURIComponent(id), "DELETE", { version });
}

/** 模板写入失败的统一文案（409 VERSION_CONFLICT / 403 FORBIDDEN 等；服务端仍是最终裁决）。 */
export function templateWriteMessage(error: { code: string; message: string }): string {
  if (error.code === "FORBIDDEN") {
    return "仅模板创建人或系统管理员可以维护该模板";
  }
  if (error.code === "VERSION_CONFLICT") {
    return "此份模板已被他人改过";
  }
  if (error.code === "NOT_FOUND") {
    return "这份模板已经不在模板库里了";
  }
  if (error.code === "VALIDATION_FAILED") {
    return "模板内容不合规：" + error.message;
  }
  return error.message;
}
