/**
 * 干系人接口封装（A27 · M6-06 前端接线）：契约 shared/src/modules/stakeholders.ts。
 * - 列表 GET /api/v1/stakeholders（filter[projectId] 反查本项目联系人；sort 缺省 updatedAt:desc「最近更新在前」）
 * - 新增 POST /api/v1/stakeholders（可带 projectIds 一并关联；项目「干系人」标签里新建时带上当前项目）
 * - 更新 PATCH /api/v1/stakeholders/{id}（部分更新：null = 清空该字段、缺键 = 不改）
 * - 删除 DELETE /api/v1/stakeholders/{id}（软删，回 { id, deleted: true }；页面本地移除即可）
 * 字段级脱敏（A5-07 / C3-08）：phone / wechat / email / company / title / remark 无权时响应里**没有该键** ——
 * role（干系人角色 · Push 225 契约增列）未登记字段级策略：恒返回（空为 null），不参与缺键口径。
 * 页面按「键是否存在」渲染占位（见 components/StakeholderPanel.tsx），缺键绝不回写（否则会把无权字段清空）。
 */
import { ApiError, apiSend, readAllPages } from "./api";
import { textOf, type Locale } from "./i18n";

/** 公司分类（契约 STAKEHOLDER_COMPANY_TYPES 同序；A5-02）。 */
export const STAKEHOLDER_COMPANY_TYPES = ["libiao", "supplier", "general_contractor", "customer"] as const;
export type StakeholderCompanyType = (typeof STAKEHOLDER_COMPANY_TYPES)[number];

/** 四类展示名（与契约 STAKEHOLDER_COMPANY_TYPE_NAMES 同形）。 */
export const STAKEHOLDER_COMPANY_TYPE_NAMES: Record<StakeholderCompanyType, string> = {
  libiao: "立镖机器人",
  supplier: "供应商",
  general_contractor: "总包单位",
  customer: "客户",
};

/** 四类色签（表格「所属公司」列与表单下拉同款）：立镖 = 品牌黄、供应商 = 蓝、总包单位 = 紫、客户 = 青绿。 */
export const STAKEHOLDER_COMPANY_TYPE_BADGE: Record<StakeholderCompanyType, string> = {
  libiao: "border-amber-200 bg-amber-50 text-amber-700",
  supplier: "border-sky-200 bg-sky-50 text-sky-700",
  general_contractor: "border-violet-200 bg-violet-50 text-violet-700",
  customer: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

/** 公司分类徽标文案：未知码回落原码（存量值不崩）。 */
export function stakeholderCompanyTypeName(code: string): string {
  return code in STAKEHOLDER_COMPANY_TYPE_NAMES ? STAKEHOLDER_COMPANY_TYPE_NAMES[code as StakeholderCompanyType] : code;
}

/** 公司分类色签：未知码回落中性灰（与项目类型「兜底色」同一口径）。 */
export function stakeholderCompanyTypeBadge(code: string): string {
  return code in STAKEHOLDER_COMPANY_TYPE_BADGE
    ? STAKEHOLDER_COMPANY_TYPE_BADGE[code as StakeholderCompanyType]
    : "border-zinc-200 bg-zinc-50 text-zinc-600";
}

/** 干系人关联的项目（契约 StakeholderProjectRef；A5-03 按干系人反查参与项目）。 */
export type StakeholderProjectRef = { id: string; code: string; name: string };

/**
 * 干系人（契约 Stakeholder 的前端投影）：受字段级策略保护的键（company / title / phone / wechat / email / remark）
 * 无权时**键不存在**（A5-07），因此一律可选。
 */
export type Stakeholder = {
  id: string;
  name: string;
  companyType: string;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  wechat?: string | null;
  email?: string | null;
  remark?: string | null;
  role: string | null;
  createdBy: string | null;
  createdByName: string | null;
  projects: StakeholderProjectRef[];
  createdAt: string;
  updatedAt: string;
};

export type StakeholderListResult = { items: Stakeholder[]; total: number };

/** 新增（A5-01 / A5-04）：name / companyType 必填；projectIds 一并关联（A5-03）。 */
export type StakeholderCreateInput = {
  name: string;
  companyType: string;
  company?: string;
  title?: string;
  phone?: string;
  wechat?: string;
  email?: string;
  role?: string;
  projectIds?: string[];
};

/** 更新（PATCH 合并语义）：只传变更键；null = 清空该字段。 */
export type StakeholderPatch = {
  name?: string;
  companyType?: string;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  wechat?: string | null;
  email?: string | null;
  role?: string | null;
};

/** 本项目关联的干系人台账（A5-03 按项目查看联系人清单；缺省「最近更新」在前）。 */
export async function fetchProjectStakeholders(projectId: string): Promise<StakeholderListResult> {
  const payload = await readAllPages<Stakeholder>(
    "/api/v1/stakeholders?filter[projectId]=" + encodeURIComponent(projectId),
  );
  return { items: payload.items, total: payload.total };
}

export function createStakeholder(input: StakeholderCreateInput): Promise<Stakeholder> {
  return apiSend<Stakeholder>("/api/v1/stakeholders", "POST", input);
}

export function updateStakeholder(id: string, patch: StakeholderPatch): Promise<Stakeholder> {
  return apiSend<Stakeholder>("/api/v1/stakeholders/" + id, "PATCH", patch);
}

export function deleteStakeholder(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiSend<{ id: string; deleted: boolean }>("/api/v1/stakeholders/" + id, "DELETE");
}

/** 写 / 读失败的用户可读文案（Push 301：随语言切换；403 / 404 按 A27 口径单独说清；其余用服务端 message）。 */
export function stakeholderErrorText(locale: Locale, action: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return textOf(locale, "sh.err.forbidden", { action });
    }
    if (error.status === 404) {
      return textOf(locale, "sh.err.notFound");
    }
    return textOf(locale, "sh.err.generic", { action, message: error.message });
  }
  return textOf(locale, "sh.err.network", { action });
}
