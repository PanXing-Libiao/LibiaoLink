export type User = {
  name: string | null;
  displayName: string | null;
  email: string | null;
  id: string | null;
  owner: string | null;
};

export type MeResponse = {
  user: User;
  claims: Record<string, unknown>;
  expiresAt: number | null;
};

/**
 * 项目（M2-07 起为服务端数据，映射见 projectApi.ts 的 toUiProject）：
 * 编号、序号与人员字段命名对齐 shared 契约（code / seqNo / managerIds / managerNames）。
 * 主题色不再挂在这里 —— 取字典 projectType 条目的 metadata.accent（dicts.ts 的 typeAccent）。
 */
export type Project = {
  id: string;
  /** 项目序号（契约 seqNo ↔ projects.seq_no）：服务端创建时分配，全库唯一、不可修改、不回收；卡片两位补零展示。 */
  seqNo: number;
  code: string;
  /** 前端「项目描述」= 契约 name（唯一展示名）；备注长文本是契约 description（Push 280 起表单采集，见下 remark）。 */
  description: string;
  /** 备注（契约 description，与前端「项目描述」= name 不是一回事）：Push 280 起新建 / 编辑弹窗采集；空串 = 未填写（新建不发送、编辑清空发 null）。 */
  remark: string;
  /** 项目地区：契约 projects.region 存字典 region 的码；显示名走 dictLabel（已删除条目的存量值回落码本身）。 */
  region: string;
  /** 项目类型：契约 projects.projectType 存字典 projectType 的码；主题色由字典 metadata 下发（前端不硬编码）。 */
  projectType: string;
  /** 创建时间（契约 createdAt，展示用「YYYY-MM-DD HH:mm」，Asia/Shanghai）：创建时生成、编辑不修改。 */
  createdAt: string;
  /** 最近活动时间（契约 updatedAt）：主数据变更 / 阶段推进 / 任务变更刷新；「更新时间」排序维度（Push 175 起区间筛选与默认排序都看 createdAt）。 */
  updatedAt: string;
  /**
   * 项目经理（多位，Push 136）：至少一位、可多位，数组顺序 = 展示顺序。
   * 对齐契约 projects.manager_ids（uuid[]、非空）；筛选 filter[managerId] 命中「项目挂的任意一位经理」。
   */
  managerIds: string[];
  /** 经理姓名（契约 managerNames，与 managerIds 同下标一一对应；取不到时该位为 null）。 */
  managerNames: Array<string | null>;
  /** 乐观锁版本（契约 version）：编辑 / 删除时原样回传；冲突返回 409 VERSION_CONFLICT。 */
  version: number;
  /** 当前阶段 key（契约 stageKey）。 */
  stageKey: string;
  /** 项目状态（契约 status：active / paused / done / archived）。 */
  status: string;
  /** 进入项目回收站的时间（展示用「YYYY-MM-DD HH:mm」）；未删除 = null。 */
  deletedAt: string | null;
  /** 将项目移入回收站的用户 id；未删除 = null。 */
  deletedBy: string | null;
};

/** 项目状态取值（契约 projects.status：active / paused / done / archived）。 */
export type ProjectStatusValue = "active" | "paused" | "done" | "archived";

/** 项目状态顺序（卡片状态字 / 编辑弹窗四选一 / 地图图例共用同一套口径）。 */
export const PROJECT_STATUS_VALUES: readonly ProjectStatusValue[] = ["active", "paused", "done", "archived"];

/** 项目状态中文（Push 262：卡片状态字与编辑弹窗同源；与地图图例/操作记录口径一致）。 */
export const PROJECT_STATUS_TEXT: Record<ProjectStatusValue, string> = {
  active: "进行中",
  paused: "已暂停",
  done: "已完成",
  archived: "已归档",
};

/** 契约 status（string）→ 已知取值；未知值回落 null（调用方决定兜底展示 / 收敛）。 */
export function projectStatusOf(value: string): ProjectStatusValue | null {
  return (PROJECT_STATUS_VALUES as readonly string[]).includes(value) ? (value as ProjectStatusValue) : null;
}

/** 状态展示文案：已知取值走中文，未知值回落原文（不吞信息）。 */
export function projectStatusText(value: string): string {
  return (PROJECT_STATUS_TEXT as Record<string, string>)[value] ?? value;
}

/** 项目经理展示文本（多位按「、」连接；某位取不到姓名显示「—」）。 */
export function projectManagerText(project: Project): string {
  return project.managerNames.map((name) => (name === null || name === "" ? "—" : name)).join("、");
}
