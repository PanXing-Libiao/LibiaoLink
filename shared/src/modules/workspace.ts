import { z } from "../zod.ts";
import { DateOnlySchema, DateTimeSchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { FilePhotoRefSchema } from "./files.ts";
import { IssueCategoryListSchema, IssueStateSchema } from "./issues.ts";
import { ProjectSchema } from "./projects.ts";
import { TaskFileBriefSchema, TaskListItemSchema } from "./tasks.ts";

/**
 * 工作台（M6-05 · 系统功能书 A6-01 / A6-03）：跨项目的个人聚合读面 ——
 * 「我的任务」四组（今日待办 / 即将到期 / 已逾期 / 未排期）与「我的问题」（我处理 / 我提出的）。
 *
 * 口径（2026-09-30 业务复评修订：取消 7 天窗口 / 项目经理含我 / 未排期单列一组）：
 * - 「我的任务」= 任务未完成（status != done）、未删除，且满足其一：
 *   ① 任务负责人名单内任一位是我（A6-01 · Push 136 多负责人口径）；
 *   ② 任务所属项目的项目经理名单内任一位是我（A22 多值任一位命中）。
 *   时间不设窗口（原「今天起 7 天内」窗口随本次复评下线）：
 *   已逾期 = plannedEnd < 今天；今日待办 = plannedEnd = 今天；即将到期 = plannedEnd > 今天（远期照收）；
 *   未排期 = plannedEnd 为空（组内排末）。「我参与的任务」口径未定（差异登记，不含）。
 * - 归档项目（ADR-027 冻结）与软删项目下的任务 / 问题一律不进工作台（不再催办 / 不可见）。
 * - 「我的问题」= 我处理（ownerId = 我）与我提出的（reporterId = 我）两个清单；同一问题两边都命中时两个清单都出现。
 * - 排序：任务组内按 plannedEnd 升序、同日期按 id 升序（未排期空日期置末）；问题未关闭（state != done）在前 ——
 *   按提出日期（raisedAt）升序、id 升序；已完成后置。
 * - 记录级可见性：只含对我可见的项目（ADR-011；PERMISSION_ENFORCED 关闭期等价全量）。
 *
 * 2026-10-13 全字段修订（Push 302 · px 线代改 wmj 线契约，请 wmj / lan 复核）：
 * - 「我的任务」项由 9 列抽取面扩为**任务表全字段**（= TaskListItem 全字段 + projectCode / projectName + 随行文件清单 files）——
 *   原版只带 9 列，项目经理 / 输出成果文件 / 文件 / 项目进展描述 / 预计所需天数 / 预计所需施工人数 /
 *   是否按时交付 / 变更关联八列缺失，前端只能逐项目回打 GET /projects/{id}/tasks + GET /projects/{id} + 文件清单
 *   三路补齐，页面「先骨架、后逐列出现」且刷新卡顿；本修订后一次聚合读面即带全 15 列数据源与行内编辑所需的 version。
 * - 「我的问题」项补 solution（解决方案或建议）与 photos（问题附图）—— 问题追踪七列的最后两列数据源。
 * - 响应新增 projects（聚合涉及项目的项目卡，含 managerNames / managerIds / version）：工作台行内「项目经理」列
 *   与项目经理回写不再逐项目回查。
 */

/** 工作台任务四组（A6-01）：today 今日待办 / upcoming 即将到期 / overdue 已逾期 / unscheduled 未排期。 */
export const WORKSPACE_TASK_GROUPS = ["today", "upcoming", "overdue", "unscheduled"] as const;

export const WorkspaceTaskGroupSchema = z.enum(WORKSPACE_TASK_GROUPS).openapi("WorkspaceTaskGroup", {
  description:
    "工作台任务分组（基准日 = Asia/Shanghai 今天；2026-09-30 复评起不设天数窗口）：today 今日待办 / upcoming 即将到期（plannedEnd > 今天）/ overdue 已逾期 / unscheduled 未排期（plannedEnd 为空）",
});

export type WorkspaceTaskGroup = z.infer<typeof WorkspaceTaskGroupSchema>;

/**
 * 工作台任务项（跨项目 = TaskListItem 全字段 + 项目编号 / 名称 + 随行文件清单）。
 * 2026-10-13 全字段修订：任务表 15 列（含项目经理 / 输出成果文件 / 文件 / 进展描述 / 天数 / 人数 / 按时交付 /
 * 变更关联）全部随行下发，行内编辑用 version 也在行上 —— 前端不再逐项目回填。
 */
export const WorkspaceTaskItemSchema = TaskListItemSchema.extend({
  projectCode: z.string().openapi({ description: "项目编号（跨项目列表直接展示）" }),
  projectName: z.string(),
  files: z.array(TaskFileBriefSchema).openapi({
    description: "任务随行文件清单（口径同任务详情 files：排除回收站、创建时间倒序；工作台行内「文件」列下拉的数据源）",
  }),
}).openapi("WorkspaceTaskItem", {
  description: "工作台任务项（跨项目；按预计完成日期落入四组之一；任务表 15 列数据源随行下发）",
});

export const WorkspaceTasksSchema = z
  .object({
    today: z.array(WorkspaceTaskItemSchema).openapi({ description: "今日待办：plannedEnd = 今天且未完成" }),
    upcoming: z.array(WorkspaceTaskItemSchema).openapi({
      description: "即将到期：plannedEnd > 今天且未完成（2026-09-30 复评起不设天数窗口，远期照收）",
    }),
    overdue: z.array(WorkspaceTaskItemSchema).openapi({ description: "已逾期：plannedEnd < 今天且未完成" }),
    unscheduled: z.array(WorkspaceTaskItemSchema).openapi({ description: "未排期：plannedEnd 为空且未完成（组内排末）" }),
  })
  .openapi("WorkspaceTasks", { description: "我的任务四组（A6-01；组内按 plannedEnd 升序、id 升序，未排期置末）" });

/** 工作台问题项（跨项目；保留 version —— 工作台内快速流转 / 关闭确认时带乐观锁）。 */
export const WorkspaceIssueItemSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    projectCode: z.string(),
    projectName: z.string(),
    taskId: UuidSchema.nullable().openapi({ description: "所属任务（可空：问题可不挂任务）" }),
    title: z.string(),
    categories: IssueCategoryListSchema,
    state: IssueStateSchema,
    reporterId: UuidSchema,
    reporterName: z.string().nullable(),
    ownerDepartment: z.string().nullable(),
    ownerId: UuidSchema.nullable(),
    ownerName: z.string().nullable(),
    raisedAt: DateOnlySchema,
    solution: z.string().nullable().openapi({
      description: "解决方案或建议（A3-13；2026-10-13 全字段修订随行下发，工作台「提出/负责的问题」表直接渲染）",
    }),
    photos: z.array(FilePhotoRefSchema).openapi({
      description: "问题附图（file_links(object_type=issue)，插入序；2026-10-13 全字段修订随行下发，工作台表直接渲染）",
    }),
    updatedAt: DateTimeSchema,
    version: VersionSchema,
  })
  .openapi("WorkspaceIssueItem", { description: "工作台问题项（跨项目；问题追踪七列数据源随行下发）" });

export const WorkspaceIssuesSchema = z
  .object({
    handling: z.array(WorkspaceIssueItemSchema).openapi({ description: "我处理的（ownerId = 会话用户）" }),
    raised: z.array(WorkspaceIssueItemSchema).openapi({ description: "我提出的（reporterId = 会话用户）" }),
  })
  .openapi("WorkspaceIssues", {
    description: "我的问题两栏（A6-03）；同一问题两边都命中时两个清单都出现；未关闭在前、已完成后置",
  });

export const WorkspaceResponseSchema = z
  .object({
    today: DateOnlySchema.openapi({ description: "分组基准日（Asia/Shanghai 今天 · ADR-028），前端可据此渲染「今天」标注" }),
    myTasks: WorkspaceTasksSchema,
    myIssues: WorkspaceIssuesSchema,
    projects: z.array(ProjectSchema).openapi({
      description:
        "聚合涉及的项目卡（我的任务或我的问题命中的项目，按首次出现顺序去重；含 managerNames / managerIds / version）—— 2026-10-13 全字段修订：工作台行内「项目经理」列与项目经理回写不再逐项目回查",
    }),
  })
  .openapi("WorkspaceResponse", { description: "工作台聚合：我的任务四组 + 我的问题两栏 + 涉及项目卡" });

export type WorkspaceTaskItem = z.infer<typeof WorkspaceTaskItemSchema>;
export type WorkspaceIssueItem = z.infer<typeof WorkspaceIssueItemSchema>;
export type WorkspaceProject = z.infer<typeof WorkspaceResponseSchema>["projects"][number];
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;
