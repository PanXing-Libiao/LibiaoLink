/**
 * 工作台「我的任务」页（系统功能书 A6-01 / A6-03；M6-06 前端接线 · Push 230；任务表扩列 · Push 231；面板头「进入项目」深链 · Push 232；
 * Push 290 原「醒目模式」下架 → 任务 / 问题表统一改吃顶栏背景档位）。
 * 口径复评（2026-09-30 · 业务：「不能有 7 天内时间限制」「时间不限制 另外项目经理是我也要算在我的任务」）：
 * 「我的任务」= 未完成 且（任务负责人含我 或 项目项目经理含我）、不限完成日期窗口；未排期（无预计完成日期）单列一组。
 *
 * 业务口径（2026-09-30）：「同样做标签导航栏 我的任务 我提出的问题先做这两个」→「是这个页面导航栏」（指任务模板页
 * 的下划线标签栏，本页照同一套材质 —— 文字 + 选中下划线、无图标）→「我的任务 是折叠面板 未展开是项目名称和编号
 * 下拉是具体我的任务」→「我提出的问题就参考日报的问题追踪即可 也是折叠面板」→「表格内容要全」（问题表照
 * 「问题追踪」的完整六列：日期 / 问题描述 / 问题归类 / 解决方案或建议 / 问题附图 / 问题是否处理）→「直接把这个搬到
 * 我的任务不就好了」（任务表行口径照项目页任务表）→「这些字段一个不能少懂吗」（Push 231：任务表 = 项目页任务表
 * 全 15 列 —— 任务描述 / 项目经理 / 任务负责人 / 任务状态 / 紧急重要度 / 是否按时交付 / 输出成果文件 / 文件 /
 * 项目进展描述 / 开始日期 / 预计所需天数（窄列，表头空）/ 预计完成日期 / 预计所需施工人数 / 实际完成日期 / 变更关联）。
 * 表与项目页任务表逐列对齐（Push 279 起**行内可编辑**；Push 302 起行数据 = 聚合读面随行全字段，带 version）。
 * 折叠面板头常驻**「进入项目」**按钮
 * （Push 232 · 业务口径「增加进入项目按钮」）：落点由调用方给定 —— 「我的任务」= 项目详情缺省标签「项目总览」
 * `#/project/{id}`；「我提出的问题」= 该项目「日报及问题 → 问题追踪」（Push 253 起，见下条；Push 242 时为该页
 * 「日报记录」）；按钮在面板头右侧、不参与展开收起。
 *
 * Push 242（业务口径 2026-10-08「这个页面的列要对齐吧 不然不美观」+「删除在项目中查看 进入项目直接进入日报记录页面
 * 替代在项目中查看」）「我提出的问题」两处调整：① 问题表改 **`table-fixed` + `<colgroup>` 固定列宽** —— 各项目
 * 折叠面板的同名列一一对齐（原 `table-auto` 按各自内容算宽，换一个项目列就飘）；② 行尾「在项目中查看」下架，
 * 进入项目的入口收敛到面板头「进入项目」（Push 253 起的落点见下条）。
 *
 * Push 253（业务口径 2026-10-08「我提出的问题点击进入项目直接进入到问题追踪页面」）：「我提出的问题」面板头
 * 「进入项目」的落点由该项目「日报记录」改**该项目「问题追踪」**（`?view=daily&sub=issues`）—— 从哪张表点进
 * 去就停在项目页哪张表；「我的任务」标签的落点不变（项目详情「项目总览」`#/project/{id}`）。
 *
 * 「我的计划」标签（Push 234 · 业务口径「增加一个我的计划页面」→「你只要把导航栏设计好 后续详细设计再说」）：
 * 导航栏第三枚标签 + 路由 `?tab=plan` 本刀就位；页面内容（数据口径 / 布局）随后续详细设计再做 —— 本刀只落登记卡。
 *
 * 背景档位适配（Push 232 起原是「醒目模式」，Push 290 统一改吃顶栏**背景档位**；Push 293 起含「炫彩」）：铺色档
 * （适中 = 便签同款兑白 / 炫彩 = 同色相高饱和）= 任务表整行铺该任务状态行色 + 状态列收口成深色字
 * （TaskBoard 的同款色表 `STATUS_ROW_TINT` / `STATUS_ROW_TINT_VIVID` / `STATUS_TAG_TEXT_TIER_CLASS`）；
 * 切到「我提出的问题」同款（`ISSUE_ROW_TINT` / `ISSUE_ROW_TINT_VIVID` / `ISSUE_TAG_TEXT_TIER_CLASS`）；「简约」= 白底行 + 色签胶囊（原样）。
 *
 * 数据：
 * - 读面 = GET /api/v1/workspace（frontend/src/workspaceApi.ts）—— 跨项目个人读面，仅会话、无项目路径参数。
 *   四组任务并进本页「按项目」折叠面板：项目顺序 = 组序（已逾期 → 今日待办 → 即将到期 → 未排期）里的首次出现顺序
 *   （最急的在最上），组内保持服务端 plannedEnd 升序；分组 / 排序全由服务端给定，本页不做任何本地日期推导。
 * - 任务表 15 列 / 问题表七列的数据源**全在聚合读面本身**（Push 302 · 2026-10-13 全字段修订）：任务项 = 任务表全字段
 *   （含成果文件 / 文件摘要与文件名清单 / 进展描述 / 天数 / 人数 / 按时交付 / 变更关联 / version），问题项随行
 *   solution / photos，另带 projects（涉及项目卡，「项目经理」列与项目经理回写用）—— 首屏一次到位、无分批出现。
 *   Push 302 之前那套逐项目回填（按项目再打 /projects/{id}/tasks + /projects/{id} + 文件清单 + /projects/{id}/issues
 *   五路补齐扩列，未命中行降级只读）已整体删除。
 *
 * Push 260（业务口径 2026-10-09「在我提出的问题增加子标签导航栏 和日报那样 增加待我处理的问题」+「页面中的信息
 * 要包括图二的人员信息」+「问题是否解决的颜色要统一和项目里面的一致」+「我处理的问题就是提出问题里面分类的问题」
 * +「改成 提出/负责的问题」+「要居中这个状态」+「然后导航栏还是改成这样的吧」）：
 * ① 第二枚主标签由「我提出的问题」改**「提出/负责的问题」**（tab key 不变 `?tab=raised`），标签下挂两枚子视图
 * （我提出的问题 / 待我处理的问题）—— 形态按业务口径「然后导航栏还是改成这样的吧」（图 = 项目页「日报及问题」的
 * 下拉子菜单）收进**主标签栏的下拉面板**（Push 260 第一稿的另一排下划线子标签栏本刀撤掉；面板见
 * components/WorkspaceIssueSubMenu.tsx），地址口径不变：`?tab=raised&sub=`（缺省 raised 不落参数、
 * `?sub=handling` = 待我处理的问题；与「日报及问题」的 `?view=daily&sub=` 同一套「地址即状态」）；
 * ② 新页「待我处理的问题」= 契约 myIssues.handling（ownerId 我），页面结构与「我提出的问题」完全同构（同一张表、
 * 同一套问题归类色签 —— 业务口径「我处理的问题就是提出问题里面分类的问题」，不另立分类）；③ 问题表补第七列
 * **问题处理人 / 责任人**（ownerName，空「—」，与「问题追踪」同列）；④「问题是否处理」色签壳体收口到项目页
 * 同一档（ISSUE_TAG_SHELL）—— 底色 / 字色本就同源，本刀把壳也统一；⑤「问题是否处理」列**整列居中**
 * （业务口径「要居中这个状态」：表头 + 单元格 + 色签一处不落）；⑥「问题是否处理」**行内可改**（业务口径
 * 「我提出 我处理的问题这里的状态都要和项目内部一样可以点击」）—— 与项目页「问题追踪」共用同一枚行内下拉
 * （ReportIssuePanel 的 IssueStateCell），乐观更新 + PATCH（乐观锁 version）+ 失败回滚并出提示条；
 * 本地改完就地生效、不重排（刷新后按服务端「未关闭在前」口径回归）；⑦「已完成则不显示」（业务口径 2026-10-09）——
 * 两枚子视图同一口径：状态为「已完成」的问题不进这两张表（行内刚改成「已完成」的行即时消失、改失败回滚后重新出现并出
 * 提示条）；面板计数 / 汇总行（共 N 条）只算未完成的，项目全完成则该面板不出现；项目页「问题追踪」不受影响
 * （仍是全量展示）。
 *
 * 标签走地址（`#/my-tasks?tab=raised&sub=handling`，缺省「我的任务」/ 缺省子标签 raised 不落参数）—— 与列表筛选态 /
 * 详情页子视图同一口径。两个子视图共用同一组「已展开项目」记忆（workspaceOpenProjects.raised；同一标签下的两个问题
 * 视图，若后续要各记一组需契约扩键，随下一刀对齐 wmj 线）。
 *
 * Push 278（业务口径 2026-10-12「做我的任务页面也可以点击编辑即可 编辑行 也在右侧出现抽屉」）：「我的任务」任务表
 * 行**点击即开任务抽屉**（右侧滑出，与项目页同一枚 TaskDrawer）—— 全能力即时保存：项目经理（项目级回写项目）/
 * 任务负责人 / 日期区间（含联动天数）/ 施工人数 / 紧急重要度 / 进展描述 / 输出成果文件 / 四格进度 / 任务状态 /
 * 实际完成日期 / 定档与取消定档 / 文件上传 · 删除 · 改名 / 变更申请与变更记录两页；数据源 = 聚合读面全字段行
 * （Push 302；带 version，打开零新增请求）；写入口径与项目页逐一对齐（同一套 updateTask /
 * updateTaskProgress / finalizeTask / unfinalizeTask / 文件三件 + 项目经理 updateProject），写后防抖静默刷新
 * 聚合读面（不打断抽屉 —— 抽屉内 task 用写回响应就地更新、version 滚动前进）。任务级深链 `?task=`（跳项目页开
 * 抽屉的地址形态）仍不做：页内抽屉已覆盖「一键编辑」，深链属可分享地址增强、业务未提。
 *
 * Push 279（业务口径 2026-10-12「不用点开抽屉也要可以编辑」→「和项目总览一样」）：任务表的**行**从只读自绘壳换成
 * 项目页那枚 TaskRow —— 行内逐列可编辑（四格进度 / 项目经理 / 负责人 / 状态 / 紧急重要度 / 成果文件 /「文件」
 * 列下拉（预览 · 上传 · 删除）/ 进展描述 / 三段日期 / 人数；天数随日期联动写回、不单独开编辑，与项目页同口径），
 * 点行照旧开右侧抽屉；行数据 = 聚合读面全字段行（带 version），写后按响应就地更新 + 防抖静默刷新
 * （刷新一到本地覆盖即让位）。
 *
 * Push 302（2026-10-13 全字段修订 · 契约 shared/src/modules/workspace.ts 同批扩字段；业务口径「我的任务刷新 为什么会
 * 卡顿再出现一些字段和ui」的根治）：聚合读面由 9 列抽取面补成任务表全字段 + 问题七列全字段 + 涉及项目卡 ——
 * 本页删除 useTaskFull / useIssueFull 两段逐项目回填与只读降级行 fallbackTaskOf，行内编辑判定不再看「回填是否命中」，
 * 首屏即完整可编辑（状态列色框不再先无后有）。
 */
import { useEffect, useRef, useState } from "react";
import { keepLiveOrder } from "./liveSync";
import { useLiveRefresh } from "./useLiveRefresh";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import { ApiError } from "./api";
import { AppHeader } from "./components/AppHeader";
import { Toast } from "./components/Toast";
import { useFocusTrap } from "./components/useFocusTrap";
import { ImageZoomViewer } from "./components/ImageZoomViewer";
import { useBackgroundTier, type TintedTier } from "./backgroundTier";
import { WorkspaceIssueSubMenu } from "./components/WorkspaceIssueSubMenu";
import { MyPlanBoard } from "./components/MyPlanBoard";
import { TaskDrawer, type TaskEditSubmit } from "./components/TaskDrawer";
import { ISSUE_CATEGORY_CLASS, ISSUE_ROW_TINT, ISSUE_ROW_TINT_VIVID, ISSUE_TAG_CLASS, IssueStateCell } from "./components/ReportIssuePanel";
import { TaskRow, resolveColumns, tableGridTemplate, tableMinWidth, taskPatchBody, type ColumnDef, type TaskPatch } from "./components/TaskBoard";
import { TEMP_TASK_STAGE, type ProjectTask, type TaskStatus } from "./data/tasks";
import { memberNameOf, type Member } from "./data/members";
import type { IssueState, ReportPhoto } from "./data/reports";
import { recycleFile, renameFile, uploadFiles, usePhotoUrl, type TaskFileRef } from "./fileApi";
import { updateProject, type ApiProject } from "./projectApi";
import { ISSUE_STATE_NAMES, updateIssue } from "./reportApi";
import { fetchTaskDetail, finalizeTask, stageNameOf, statusWriteValue, toUiTask, unfinalizeTask, updateTask, updateTaskProgress, type ApiTask } from "./taskApi";
import { prefetchZhToEn } from "./translateApi";
import { fieldText, fullDateText, stageText, useLocale, useLocalizedTranslator, useT, workspaceLabelText } from "./i18n";
import { fetchWorkspace, type ApiWorkspace, type ApiWorkspaceIssue, type ApiWorkspaceTask } from "./workspaceApi";
import type { WorkspaceOpenProjects } from "./preferencesApi";
import { projectViewHref, type WorkspaceIssueView, type WorkspaceTab } from "./useHashRoute";
import type { MeResponse } from "./types";

type WorkspacePageProps = {
  me: MeResponse;
  /** 人员目录（App 层全局目录）：任务抽屉的「项目经理 / 任务负责人」多选候选（Push 278）。 */
  members: readonly Member[];
  /** 当前标签（地址派生：`#/my-tasks` 缺省「我的任务」/ `#/my-tasks?tab=raised`「我提出的问题」）。 */
  tab: WorkspaceTab;
  /** 切标签：同步渲染并写回地址（replace，不新增历史条目）。 */
  onChangeTab: (tab: WorkspaceTab) => void;
  /** 「我提出的问题」下的子标签（Push 260 · 地址派生：`?tab=raised&sub=handling` = 待我处理的问题；缺省 raised 不落参数）。 */
  sub: WorkspaceIssueView;
  /** 切子标签（replace，不新增历史条目）：只在「我提出的问题」标签下有意义。 */
  onChangeSub: (sub: WorkspaceIssueView) => void;
  /** 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）：按标签分记已展开的项目 id；null / 缺省 = 偏好尚未取到（按全收起渲染，不回写）。 */
  workspaceOpenProjects?: WorkspaceOpenProjects | null;
  /** 保存展开态（单键 PATCH）；返回 null = 成功，返回文案 = 失败提示。不传 = 不做服务端记忆（展开态仅本页内存）。 */
  onWorkspaceOpenProjectsChange?: (value: WorkspaceOpenProjects) => Promise<string | null>;
};

/** 工作台三态（首屏加载 / 失败 / 就绪）—— 与「日报及问题」三个列表子视图同一套口径。 */
type WorkspaceState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ApiWorkspace };

/** 任务四组：本页展示顺序 = 最急的「已逾期」在最前、未排期（无日期）收尾（键名与契约 WorkspaceTasks 同源）。 */
const TASK_GROUPS = ["overdue", "today", "upcoming", "unscheduled"] as const;
type TaskGroupKey = (typeof TASK_GROUPS)[number];

/** 任务分组色签（与项目总览状态色系同一张表：红 = 已逾期、琥珀 = 今天、天蓝 = 即将到期、灰 = 未排期）。 */
const TASK_GROUP_CHIP: Record<TaskGroupKey, string> = {
  overdue: "bg-rose-100 text-rose-700",
  today: "bg-amber-100 text-amber-800",
  upcoming: "bg-sky-100 text-sky-700",
  unscheduled: "bg-zinc-100 text-zinc-600",
};

/** 次按钮（重新加载）—— 与「日报及问题」的 BTN_SECONDARY 同一档材质。 */
const BTN_SECONDARY =
  "rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-sm font-medium text-zinc-600 transition hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-900";

/** 含年份的完整日期文案（Push 301）：中文「2026年9月5日」/ 英文「Sep 5, 2026」—— 统一走 i18n.fullDateText
 *  （跨项目列表可能跨年，年份要带；与「问题追踪」日期列同一口径）。 */

/** 契约三态（open / in_progress / done）→ 中文 + 色签；与「问题追踪」同源（ISSUE_STATE_NAMES / ISSUE_TAG_CLASS）。
 *  Push 290 起同源补背景档位铺色行色对（适中 = ISSUE_ROW_TINT 便签同款兑白；炫彩 = ISSUE_ROW_TINT_VIVID 高饱和配方）；
 *  未知值原样兜底（契约受控，兜底只为不炸）。 */
function issueStateOf(state: string, tier: TintedTier | false): { label: string; className: string; tint: { tint: string; hover: string } | null } {
  if (state === "open" || state === "in_progress" || state === "done") {
    return { label: ISSUE_STATE_NAMES[state], className: ISSUE_TAG_CLASS[state], tint: (tier === "vivid" ? ISSUE_ROW_TINT_VIVID : ISSUE_ROW_TINT)[state] };
  }
  return { label: state, className: "bg-zinc-100 text-zinc-600", tint: null };
}

type ProjectTasks = {
  projectId: string;
  projectCode: string;
  projectName: string;
  items: Array<{ group: TaskGroupKey; task: ApiWorkspaceTask }>;
};

/** 我的任务四组 → 按项目归并（项目顺序 = 组序里的首次出现顺序；组内保持服务端 plannedEnd 升序、未排期收尾）。 */
function groupTasksByProject(data: ApiWorkspace): ProjectTasks[] {
  const byProject = new Map<string, ProjectTasks>();
  for (const group of TASK_GROUPS) {
    for (const task of data.myTasks[group]) {
      let entry = byProject.get(task.projectId);
      if (entry === undefined) {
        entry = { projectId: task.projectId, projectCode: task.projectCode, projectName: task.projectName, items: [] };
        byProject.set(task.projectId, entry);
      }
      entry.items.push({ group, task });
    }
  }
  return Array.from(byProject.values());
}

type ProjectIssues = {
  projectId: string;
  projectCode: string;
  projectName: string;
  issues: ApiWorkspaceIssue[];
};

/** 我提出的问题（服务端已按「未关闭在前、提出日期升序」排好）→ 按项目归并（项目顺序 = 首次出现顺序）。 */
function groupIssuesByProject(issues: readonly ApiWorkspaceIssue[]): ProjectIssues[] {
  const byProject = new Map<string, ProjectIssues>();
  for (const issue of issues) {
    let entry = byProject.get(issue.projectId);
    if (entry === undefined) {
      entry = { projectId: issue.projectId, projectCode: issue.projectCode, projectName: issue.projectName, issues: [] };
      byProject.set(issue.projectId, entry);
    }
    entry.issues.push(issue);
  }
  return Array.from(byProject.values());
}

/** 2026-10-13 全字段修订（Push 302）：原「解决方案 / 问题附图」逐项目回填（useIssueFull）与「任务表扩列」
 *  逐项目回填（useTaskFull）+ 只读降级行（fallbackTaskOf）随聚合读面全字段化整体删除 ——
 *  任务 15 列 / 问题七列的数据源现在都在 GET /api/v1/workspace 一次下发里，首屏即完整、行内编辑直接吃随行 version。 */

/** 折叠面板（业务口径「未展开是项目名称和编号 下拉是具体我的任务」「也是折叠面板」）：
 *  收起 = 项目名称 + 编号（+ 右侧摘要 + 「进入项目」按钮）；展开 = 该项目下的内容（任务表 / 问题表）。
 *  「进入项目」是面板头里的独立锚点（Push 232）：点它走调用方给定的深链（Push 242 起按标签区分 ——
 *  「我的任务」= 总览 / 「我提出的问题」= 该项目「问题追踪」（Push 253 起），不切换展开态。
 *  展开态 Push 233 起受控 + 按账号记忆（业务口径「这个下拉要有记忆」）：由 App 层偏好 workspaceOpenProjects 按标签分记
 *  已展开的项目 id（刷新 / 同账号换设备保持；不进地址）；面板壳 = 白卡 + 圆角描边 + 行悬停（与站内表格壳同一套材质）。 */
function ProjectPanel({ projectId, projectCode, projectName, summary, href, open, onToggle, children }: {
  projectId: string;
  projectCode: string;
  projectName: string;
  /** 收起态右侧摘要（计数 / 逾期小签）。 */
  summary: ReactNode;
  /** 「进入项目」深链（Push 242 起由调用方给定：任务表 = 总览 / 问题表 = 该项目「问题追踪」）。 */
  href: string;
  /** 展开态（Push 233 起受控：由账号偏好按项目 id 记忆 —— 见 WorkspacePage 的 openProjects / openIds）。 */
  open: boolean;
  /** 切换展开态（点面板头触发；「进入项目」是独立锚点、不触发）。 */
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const localize = useLocalizedTranslator();
  return (
    <section data-workspace-panel={projectId} data-open={open ? "true" : "false"} className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 py-3 pl-4 pr-3 transition hover:bg-zinc-50">
        <button
          type="button"
          data-workspace-panel-toggle=""
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"h-4 w-4 shrink-0 text-zinc-400 transition-transform " + (open ? "rotate-90" : "")}>
            <path d="M9.5 5.5 16 12l-6.5 6.5" />
          </svg>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900">{localize(projectName)}</span>
          <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-600">{projectCode}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">{summary}</span>
        </button>
        <a
          href={href}
          data-workspace-project-link={projectId}
          title={t("ws.openProject.title", { name: localize(projectName), code: projectCode })}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
        >
          {t("ws.openProject")}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-3 w-3">
            <path d="M9.5 5.5 16 12l-6.5 6.5" />
          </svg>
        </a>
      </div>
      {open ? <div className="border-t border-zinc-100 px-4 pb-4 pt-3">{children}</div> : null}
    </section>
  );
}

/** 收起态摘要（我的任务）：共 N 项 + 逾期 / 今日 / 未排期三枚小签（要不要展开一眼能判）。 */
function TaskPanelSummary({ items }: { items: ProjectTasks["items"] }) {
  const t = useT();
  const overdue = items.filter((item) => item.group === "overdue").length;
  const today = items.filter((item) => item.group === "today").length;
  const unscheduled = items.filter((item) => item.group === "unscheduled").length;
  return (
    <>
      <span className="text-xs font-normal text-zinc-400">{t("ws.count.items", { n: items.length })}</span>
      {overdue === 0 ? null : (
        <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + TASK_GROUP_CHIP.overdue}>{t("ws.chip.overdue", { n: overdue })}</span>
      )}
      {today === 0 ? null : (
        <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + TASK_GROUP_CHIP.today}>{t("ws.chip.today", { n: today })}</span>
      )}
      {unscheduled === 0 ? null : (
        <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + TASK_GROUP_CHIP.unscheduled}>{t("ws.chip.unscheduled", { n: unscheduled })}</span>
      )}
    </>
  );
}

/** 展开区 ① 我的任务表：列口径 = 项目页任务表全列（Push 231 · 业务口径「这些字段一个不能少」）——
 *  表头 / 列壳 / 行一律复用项目页的 TASK_COLUMNS + TaskRow，15 列一个不少：
 *  任务描述（+ 四格进度点）/ 项目经理 / 任务负责人 / 任务状态 / 紧急重要度 / 是否按时交付 / 输出成果文件 /
 *  文件 / 项目进展描述 / 开始日期 / 预计所需天数（窄列，表头空）/ 预计完成日期 /
 *  预计所需施工人数 / 实际完成日期 / 变更关联。
 *  Push 279（业务口径 2026-10-12「不用点开抽屉也要可以编辑」→「和项目总览一样」）：行不再是只读自绘壳 ——
 *  直接用项目页那枚 TaskRow（行内逐列可编辑：四格进度 / 项目经理 / 负责人 / 状态 / 紧急重要度 / 成果文件 /
 *  「文件」列下拉（预览 · 上传 · 删除）/ 进展描述 / 三段日期 / 人数；天数随日期联动写回、不单独开编辑），
 *  点行仍开右侧任务抽屉（onSelect）。
 *  Push 302（2026-10-13 全字段修订）：行数据 = 聚合读面随行全字段（带 version），不再有「回填命中才可编辑」的
 *  降级概念 —— 首屏行即完整可编辑；项目经理列吃随行项目卡（project），「文件」列清单吃行上的 files。
 *  行外壳保留工作台自己的 data-workspace-task* 锚点（回放读数 / 排障），内里就是项目页的同款行。 */
const TASK_COLUMNS: ColumnDef[] = resolveColumns({});

/** 行内编辑回调（Push 279）：签名 = 项目页 TaskRow 那一套，只是先带 projectId 定位面板（同一组回调跨项目面板共用）。 */
type TaskTableHandlers = {
  onProgress: (projectId: string, taskId: string, progress: number) => void;
  onSetStatus: (projectId: string, taskId: string, status: TaskStatus) => void;
  onSetActualEnd: (projectId: string, taskId: string, iso: string) => void;
  onPatch: (projectId: string, taskId: string, patch: TaskPatch) => void;
  onChangeManagers: (projectId: string, managerIds: string[]) => void;
  onUploadFiles: (projectId: string, taskId: string, files: File[], onProgress?: (done: number, total: number) => void, finalize?: boolean) => Promise<void>;
  onDeleteFile: (fileId: string) => Promise<void>;
};

function TaskTable({ projectId, project, items, tierTint, members, onOpenTask, rowOf, handlers }: {
  projectId: string;
  /** 随行项目卡（Push 302）：项目经理列与项目经理回写的项目级数据源。 */
  project: ApiProject | undefined;
  items: ProjectTasks["items"];
  /** 背景档位「适中」（Push 290 统一口径）：整行铺任务状态行色 + 状态列收口成深色字（口径 = 项目页 TaskBoard）。 */
  tierTint: TintedTier | false;
  /** 人员目录（任务行内「项目经理 / 负责人」多选候选；Push 279）。 */
  members: readonly Member[];
  /** 点任务行打开右侧任务抽屉（Push 278）。 */
  onOpenTask: (task: ApiWorkspaceTask) => void;
  /** 行的当前数据（本地写回覆盖 → 聚合读面全字段行；Push 302 起聚合读面即行源，undefined 仅作防御）。 */
  rowOf: (taskId: string) => ProjectTask | undefined;
  /** 行内写入（Push 279）。 */
  handlers: TaskTableHandlers;
}) {
  // 与项目页任务表同一套列宽口径（2026-10-10）：fr 列带 minmax 硬下限 + 最小宽算上行内衬 —— 窄窗下横向滚动、不压列。
  const locale = useLocale();
  const gridTemplate = tableGridTemplate(TASK_COLUMNS);
  const minWidth = tableMinWidth(TASK_COLUMNS);
  const managers = (project?.managerNames ?? []).filter((name): name is string => name !== null && name !== "").join("、");
  return (
    <div data-workspace-task-table="" data-workspace-task-full="true" data-workspace-task-tint={tierTint ? "true" : "false"} className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          <div
            data-workspace-task-head=""
            className="grid items-center border-b border-zinc-200 bg-zinc-50 px-5 py-2.5 text-xs font-medium text-zinc-400"
            style={{ gridTemplateColumns: gridTemplate, minWidth: minWidth }}
          >
            {TASK_COLUMNS.map((column) =>
              column.key === "title" ? (
                <span key={column.key} data-column={column.key} className="truncate">{fieldText(locale, column.label)}</span>
              ) : (
                <span key={column.key} data-column={column.key} title={column.label === "" ? undefined : fieldText(locale, column.label)} className={"truncate text-center " + (column.headerClass ?? "")}>
                  {column.header ?? fieldText(locale, column.label)}
                </span>
              ),
            )}
          </div>
          <div className="divide-y divide-zinc-100">
            {items.map(({ task }) => {
              const row = rowOf(task.id);
              const ui = row ?? toUiTask(task);
              // Push 302：聚合读面全字段随行 —— 行内编辑入口一律就位（不再按「回填是否命中」分可编辑 / 只读两态）。
              const fileRefs: TaskFileRef[] = task.files.map((file) => ({ id: file.id, name: file.name, status: file.status }));
              const stage = stageNameOf(task.stageKey);
              const stageLabel = stage === "" ? TEMP_TASK_STAGE : stage;
              const subtitle = locale === "en"
                ? stageText(locale, stageLabel)
                : stageLabel + (task.titleEn === null || task.titleEn === "" ? "" : " · " + task.titleEn);
              return (
                <div
                  key={task.id}
                  data-workspace-task={task.id}
                  data-workspace-task-status={task.displayStatus}
                  data-workspace-task-dots={String(ui.progress)}
                  data-workspace-task-change={String(ui.changes.length)}
                >
                  <TaskRow
                    task={ui}
                    columns={TASK_COLUMNS}
                    selected={false}
                    tierTint={tierTint}
                    subtitle={subtitle}
                    onSelect={() => {
                      onOpenTask(task);
                    }}
                    onProgress={(progress) => { handlers.onProgress(projectId, task.id, progress); }}
                    managers={managers}
                    managerIds={project?.managerIds ?? []}
                    members={members}
                    onSetStatus={(status) => { handlers.onSetStatus(projectId, task.id, status); }}
                    onSetActualEnd={(iso) => { handlers.onSetActualEnd(projectId, task.id, iso); }}
                    onChangeManagers={project === undefined ? undefined : (managerIds) => { handlers.onChangeManagers(projectId, managerIds); }}
                    onPatch={(patch) => { handlers.onPatch(projectId, task.id, patch); }}
                    onUploadFiles={(taskId, files, onProgress, finalize) => handlers.onUploadFiles(projectId, taskId, files, onProgress, finalize)}
                    onDeleteFile={handlers.onDeleteFile}
                    files={fileRefs}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 问题归类色签组（与「问题追踪」同一张色表 ISSUE_CATEGORY_CLASS；空数组 = 「未归类」灰签）。 */
function CategoryTags({ values }: { values: readonly string[] }) {
  const locale = useLocale();
  const items = values.length === 0 ? ["未归类"] : values;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((item, index) => (
        <span key={item + "#" + String(index)} data-issue-category={item} className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 " + (ISSUE_CATEGORY_CLASS[item] ?? "bg-zinc-100")}>
          {fieldText(locale, item)}
        </span>
      ))}
    </span>
  );
}

/** 附图大图预览层（与「问题追踪」同款：点遮罩 / Esc 关闭；Push 216 口径）。
 *  Push 273（业务口径 2026-10-10「图片预览要有缩放功能」）：图改挂共享组件 ImageZoomViewer —— 滚轮 / ＋− / 双击 /
 *  拖动平移（25% ~ 800%）；点图不再关（留给缩放 / 拖动），关浮层 = 点遮罩 / Esc。 */
function PhotoPreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  /** 键盘焦点陷阱（Push 264 追订）：预览层打开时焦点进层内、Tab 在层内循环、关闭还原到缩略图。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  const t = useT();
  return createPortal(
    <div
      ref={trapRef}
      data-photo-preview=""
      role="dialog" data-live-sync-readonly="true"
      aria-label={t("ws.previewNamed", { name })}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/60 p-6"
    >
      <figure className="flex max-h-full max-w-full flex-col items-center">
        <ImageZoomViewer src={url} alt={name} />
        <figcaption className="relative z-10 mt-2 rounded-md bg-zinc-900/35 px-2 py-1 text-center text-xs text-white/80 backdrop-blur-sm">{name}</figcaption>
      </figure>
    </div>,
    document.body,
  );
}

/** 单枚问题附图瓦片：懒取服务端预览签名（usePhotoUrl），点开 = 大图预览层。 */
function IssuePhotoTile({ photo, onPreview }: { photo: ReportPhoto; onPreview: (url: string, name: string) => void }) {
  const url = usePhotoUrl(photo.fileId, photo.url);
  const t = useT();
  if (url === null) {
    return <span aria-hidden="true" className="inline-block h-24 w-32 shrink-0 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100" />;
  }
  return (
    <button
      type="button"
      data-issue-photo={photo.name}
      title={photo.name}
      aria-label={t("ws.previewNamed", { name: photo.name })}
      onClick={() => {
        onPreview(url, photo.name);
      }}
      className="shrink-0 rounded-lg transition hover:opacity-80"
    >
      <img src={url} alt={photo.name} className="h-24 w-32 rounded-lg border border-zinc-200 object-cover" />
    </button>
  );
}

/** 问题附图列（与「问题追踪」同一档：lg 大图瓦片约 128×96、多张折行；空 = 「—」）。 */
function IssuePhotos({ photos }: { photos: readonly ReportPhoto[] }) {
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  if (photos.length === 0) {
    return <span className="text-zinc-400">—</span>;
  }
  return (
    <span className="flex flex-wrap items-start gap-2">
      {photos.map((photo, index) => (
        <IssuePhotoTile
          key={photo.fileId + "#" + String(index)}
          photo={photo}
          onPreview={(url, name) => {
            setPreview({ url, name });
          }}
        />
      ))}
      {preview === null ? null : <PhotoPreview url={preview.url} name={preview.name} onClose={() => { setPreview(null); }} />}
    </span>
  );
}

/** 「问题是否处理」行内改的本地覆盖（Push 260）：乐观写入（state 立即生效、version 沿用服务器已知值），
 *  PATCH 回包后用服务器的新 version 覆盖；失败回滚（原先没有覆盖 → 删掉这条）。 */
type IssueStateOverride = { state: IssueState; version: number };

/** 聚合读面的 state 是宽类型（string）：三态之外的值按「未解决」兜底（与 issueStateOf 的兜底同一口径）。 */
function toIssueState(state: string): IssueState {
  return state === "in_progress" || state === "done" ? state : "open";
}

/** 展开区 ② 我提出的问题 / 待我处理的问题表（列口径照「问题追踪」完整七列）：日期 / 问题描述 / 问题归类 /
 *  问题处理人 · 责任人 / 解决方案或建议 / 问题附图 / 问题是否处理（窄屏横向滚动）。
 *  Push 242：① `table-fixed` + `<colgroup>` 定死列宽（见 ISSUE_COL_WIDTHS）—— 各项目面板的同名列一一对齐
 *  （原 `table-auto` 各自按内容算宽、换一个项目列就飘；业务口径「这个页面的列要对齐吧 不然不美观」）；
 *  ② 行尾「在项目中查看」下架 —— 进项目的入口收敛到面板头「进入项目」（Push 253 起定标 = 该项目「问题追踪」）。
 *  Push 260（业务口径「页面中的信息要包括图二的人员信息」+「问题是否解决的颜色要统一和项目里面的一致」）：
 *  ③ 在「问题归类」后补第七列「问题处理人 / 责任人」（ownerName；空 = 「—」，与「问题追踪」同列同口径）；
 *  ④ 「问题是否处理」色签改用项目页同一档壳体 ISSUE_TAG_SHELL（原先自带一档更小的壳 `rounded + px-1.5 + py-0.5`，
 *  底色 / 字色本就同源 ISSUE_TAG_CLASS，本刀把壳也收口 —— 业务口径「和项目里面的一致」）；
 *  ⑤ 「问题是否处理」列**整列居中**（业务口径「要居中这个状态」）：表头补 text-center（单元格本就是 text-center，色签在列内
 *  水平居中）—— 单元格保持 align-top 不动（与其它列同一条基线，只收水平向）。
 *  Push 302（2026-10-13 全字段修订）：「解决方案或建议 / 问题附图」两列改吃聚合读面随行的 solution / photos，
 *  原「逐项目向 /projects/{id}/issues 回填」整体删除。 */
const ISSUE_COL_WIDTHS = ["8%", "19%", "9%", "10%", "18%", "26%", "10%"] as const;

/** 聚合读面的问题附图（契约 FilePhotoRef）→ 展示模型（预览签名由瓦片懒取；url = null 即走 usePhotoUrl）。 */
function photosOf(issue: ApiWorkspaceIssue): ReportPhoto[] {
  return issue.photos.map((photo) => ({ fileId: photo.fileId, name: photo.name, url: null }));
}
function IssueTable({ issues, tierTint, overrides, onChangeState }: { issues: readonly ApiWorkspaceIssue[]; tierTint: TintedTier | false; /** 行内改状态的本地覆盖（Push 260）：按问题 id 取，同一问题在两个子视图里共用。 */ overrides: ReadonlyMap<string, IssueStateOverride>; onChangeState: (issue: ApiWorkspaceIssue, next: IssueState) => void }) {
  /** 手打内容（问题描述 / 解决方案）机翻显示：英文界面取译文，未就绪回退原文。 */
  const localize = useLocalizedTranslator();
  const t = useT();
  const locale = useLocale();
  return (
    <div data-workspace-issue-table="" data-workspace-issue-tint={tierTint ? "true" : "false"} className="overflow-x-auto rounded-lg border border-zinc-200">
      <table className="w-full min-w-[1400px] table-fixed border-collapse text-left text-sm">
        {/* 定死七列宽度：跨面板同名列的 x 坐标逐列一致；长文本按列宽换行、不再把列撑开 */}
        <colgroup>
          {ISSUE_COL_WIDTHS.map((width, index) => (
            <col key={String(index)} style={{ width }} />
          ))}
        </colgroup>
        <thead className="bg-zinc-50 text-zinc-500">
          <tr>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "日期")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "问题描述")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "问题归类")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "问题处理人 / 责任人")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "解决方案或建议")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 font-medium">{fieldText(locale, "问题附图")}</th>
            <th className="whitespace-nowrap border-b border-zinc-200 px-4 py-2.5 text-center font-medium">{fieldText(locale, "问题是否处理")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {issues.map((issue) => {
            const state = issueStateOf(overrides.get(issue.id)?.state ?? toIssueState(issue.state), tierTint);
            return (
              <tr key={issue.id} data-workspace-issue={issue.id} className={"align-top transition-colors " + (tierTint ? "issue-row-tint" + (tierTint === "vivid" ? " tint-vivid" : "") : "hover:bg-zinc-50/80")} style={tierTint && state.tint !== null ? ({ "--row-tint": state.tint.tint, "--row-tint-hover": state.tint.hover } as CSSProperties) : undefined}>
                <td className="whitespace-nowrap px-4 py-3 text-zinc-700">{fullDateText(locale, issue.raisedAt)}</td>
                <td className="px-4 py-3">
                  <span className="block whitespace-pre-line break-words leading-6 text-zinc-800">{localize(issue.title)}</span>
                </td>
                <td className="px-4 py-3">
                  <CategoryTags values={issue.categories} />
                </td>
                <td className="px-4 py-3 text-zinc-700">
                  {/* Push 260：问题处理人 / 责任人（ownerName；空 = 灰杠「—」，与「问题追踪」同列） */}
                  <span data-workspace-issue-owner="" className="block break-words">
                    {issue.ownerName === null || issue.ownerName === "" ? <span className="text-zinc-300">—</span> : issue.ownerName}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span data-workspace-issue-solution="" className="block whitespace-pre-line break-words leading-6 text-zinc-600">
                    {issue.solution === null || issue.solution === "" ? "—" : localize(issue.solution)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <IssuePhotos photos={photosOf(issue)} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-center">
                  {/* Push 260：状态列行内可改（业务口径「我提出 我处理的问题这里的状态都要和项目内部一样可以点击」）——
                      与项目页「问题追踪」同一枚 IssueStateCell（点色签弹三态下拉、选中即落库）；显示器仍是 IssueStateTag，
                      列内水平居中口径不变。 */}
                  <IssueStateCell
                    state={overrides.get(issue.id)?.state ?? toIssueState(issue.state)}
                    tierTint={tierTint}
                    ariaLabel={t("ws.issue.editAria", { date: fullDateText(locale, issue.raisedAt) })}
                    onPick={(next) => {
                      onChangeState(issue, next);
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 空态 / 加载态卡（与「日报及问题」子视图空态同一套虚线卡）。 */
function EmptyCard({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white/50 px-6 py-12 text-center">
      <p className="text-sm text-zinc-500">{text}</p>
      <p className="mt-1.5 text-xs text-zinc-400">{hint}</p>
    </div>
  );
}

/** 三枚标签（业务口径「我的任务 我提出的问题先做这两个」→ Push 234「增加一个我的计划页面」；样式 = 任务模板页的下划线标签栏，文字 + 选中下划线）。
 *  Push 260：第二枚标签由「我提出的问题」改**「提出/负责的问题」**（业务口径 2026-10-09「改成 提出/负责的问题」）—— 该标签下挂两枚子视图
 *  （我提出的问题 / 待我处理的问题；下拉子菜单 = 业务口径「然后导航栏还是改成这样的吧」，见 components/WorkspaceIssueSubMenu.tsx），
 *  父标签用「提出 / 负责」这组口径统住两栏；tab key 不变（`?tab=raised`）。 */
const TABS: ReadonlyArray<{ key: WorkspaceTab; label: string }> = [
  { key: "tasks", label: "我的任务" },
  { key: "raised", label: "提出/负责的问题" },
  { key: "plan", label: "我的计划" },
];

/** 两份人员名单是否一致（顺序敏感：名单顺序就是展示顺序，Push 136 —— 与项目页 sameIds 同口径）。 */
function sameMemberIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 标签 ① 我的任务：按项目的折叠面板 + 照项目页任务表全 15 列的任务表（Push 231）。
 *  Push 278：任务行**点击开任务抽屉**（业务口径「做我的任务页面也可以点击编辑即可 编辑行 也在右侧出现抽屉」）——
 *  抽屉 = 项目页同款 TaskDrawer（全能力即时保存）；数据源 = 聚合读面全字段行（Push 302；带 version，打开零新增请求）；
 *  写后防抖静默刷新聚合读面（抽屉不打断：task 用写回响应就地更新、version 滚动前进）。 */
function MyTasksView({ data, tierTint, openIds, onToggleProject, members, actorName, onReload }: { data: ApiWorkspace; tierTint: TintedTier | false; openIds: ReadonlySet<string>; onToggleProject: (projectId: string) => void; members: readonly Member[]; actorName: string; onReload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const projects = groupTasksByProject(data);
  const total = data.myTasks.overdue.length + data.myTasks.today.length + data.myTasks.upcoming.length + data.myTasks.unscheduled.length;
  /** Push 302：聚合读面全字段（含项目卡）→ 按 id 索引；行数据与项目级数据都取自同一份读面，不再逐项目回填。 */
  const allTasks = [...data.myTasks.overdue, ...data.myTasks.today, ...data.myTasks.upcoming, ...data.myTasks.unscheduled];
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const projectById = new Map(data.projects.map((project) => [project.id, project]));

  /** 抽屉里的当前任务（含 version；null = 抽屉关着）：写回响应就地更新 —— version 滚动前进，连续编辑不撞旧值。 */
  const [drawerTask, setDrawerTask] = useState<{ task: ProjectTask; projectId: string } | null>(null);
  /** 打开 / 保存失败文案（null = 无提示）：抽屉内的失败只出提示条，不回滚已在输入的内容。 */
  const [taskError, setTaskError] = useState<string | null>(null);
  /** 写后静默刷新（Push 278）：防抖 400ms 合并连续编辑 —— 重取聚合读面把行数据（进度 / 状态 / 文件计数 / 变更关联）
   *  带回来（Push 302 起聚合读面即全字段行源，重取即整行刷新，无「先骨架后补列」的二次渲染）。 */
  const reloadTimer = useRef<number | null>(null);
  const scheduleReload = (): void => {
    if (reloadTimer.current !== null) {
      window.clearTimeout(reloadTimer.current);
    }
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      onReload();
    }, 400);
  };
  useEffect(() => () => {
    if (reloadTimer.current !== null) {
      window.clearTimeout(reloadTimer.current);
    }
  }, []);

  /**
   * 「写进展描述即后台翻译」（业务口径 2026-10-13 · §6.16 ㉑）：聚合读面一到，就把非空进展描述 / 任务名 / 项目名
   * 丢进译文缓存后台预热 —— 工作台里改的描述，稍后到项目页导出不用再等机器翻译（Push 302 前本段在 useTaskFull
   * 回填里，数据源改聚合读面后原样保留；同日追订「因为页面有些内容是手打的 我建议是提前后台机翻」：任务名一并预热）。
   */
  useEffect(() => {
    prefetchZhToEn([
      ...allTasks.map((task) => task.note ?? ""),
      ...allTasks.map((task) => task.title),
      ...data.projects.map((project) => project.name),
    ]);
  }, [data]);

  /** 人员目录 → 姓名（聚合读面行 / 写回响应补姓名共用）。 */
  const resolveName = (id: string): string | undefined => memberNameOf(members, id);
  /** 行内写回覆盖（Push 279）：写成功用响应就地更新这一行（version 滚动前进）—— 聚合读面刷新一到即让位（见下）。 */
  const [patches, setPatches] = useState<Map<string, ProjectTask>>(new Map());
  // 聚合读面重取（首次加载 / 写后静默刷新）一到，本地覆盖清空：新读面行已含写后的值，覆盖只在两次读面之间兜住画面。
  useEffect(() => {
    setPatches(new Map());
  }, [data]);

  /** 行的当前数据：本地写回覆盖优先，其次聚合读面全字段行（Push 302：读面即完整行，无回填 / 降级态）。 */
  const rowOf = (taskId: string): ProjectTask | undefined => {
    const patch = patches.get(taskId);
    if (patch !== undefined) {
      return patch;
    }
    const task = taskById.get(taskId);
    return task === undefined ? undefined : toUiTask(task);
  };

  /** 写成功后就地更新行（Push 279 · 与项目页 replaceRow 同口径）：文件摘要 / 负责人姓名从旧行继承。 */
  const applyRowUpdate = (updated: ApiTask): void => {
    setPatches((current) => {
      const next = new Map(current);
      next.set(updated.id, toUiTask(updated, current.get(updated.id) ?? rowOf(updated.id), resolveName));
      return next;
    });
  };

  /** 行内写入统一出口（Push 279）：以当前行 version 提交（与项目页同一套写入口径）；成功 = 就地更新行 + 防抖静默刷新；
   *  失败走页内提示条（版本冲突顺带静默刷新 —— 下一次回填把最新行带回来）。 */
  const runRowWrite = (taskId: string, write: (row: ProjectTask) => Promise<ApiTask>): void => {
    const row = rowOf(taskId);
    if (row === undefined) {
      return;
    }
    void (async () => {
      try {
        const updated = await write(row);
        applyRowUpdate(updated);
        setTaskError(null);
        scheduleReload();
      } catch (error) {
        setTaskError(error instanceof ApiError ? error.message : t("ws.err.task"));
        if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
          scheduleReload();
        }
      }
    })();
  };

  /** 打开任务抽屉（Push 302）：聚合读面已带全字段（含 version），直接就地打开、零请求 —— 原「行不在回填里按 id
   *  单查」的兜底路径随全字段化删除。 */
  const openTask = (task: ApiWorkspaceTask): void => {
    setTaskError(null);
    setDrawerTask({ task: rowOf(task.id) ?? toUiTask(task), projectId: task.projectId });
  };

  /** 写操作统一出口：以抽屉当前 version 提交（与项目页同一套写入口径）；成功用响应就地更新抽屉 + 调度静默刷新。 */
  const runTaskWrite = async (write: (task: ProjectTask, projectId: string) => Promise<ApiTask>): Promise<number | null> => {
    const current = drawerTask;
    if (current === null) {
      return null;
    }
    try {
      const updated = await write(current.task, current.projectId);
      setDrawerTask((previous) => (previous === null || previous.task.id !== updated.id ? previous : { task: toUiTask(updated, previous.task, resolveName), projectId: previous.projectId }));
      // 抽屉写回同步到行（Push 279）：进度 / 状态 / 文件计数这类行上可见的字段当场跟着变。
      applyRowUpdate(updated);
      setTaskError(null);
      scheduleReload();
      return updated.version;
    } catch (error) {
      setTaskError(error instanceof ApiError ? error.message : t("ws.err.task"));
      return null;
    }
  };

  /** 抽屉「即改即存」提交：项目经理（项目级）变化回写项目；任务字段走 PATCH（与项目页 handlePatchTask 同一 body）。 */
  const handleDrawerSubmit = async (values: TaskEditSubmit): Promise<number | null> => {
    const current = drawerTask;
    if (current === null) {
      return null;
    }
    const project = projectById.get(current.projectId);
    if (values.managerChanged && project !== undefined && values.managerIds.length > 0 && !sameMemberIds(values.managerIds, project.managerIds)) {
      try {
        await updateProject(project.id, { code: project.code, name: project.name, region: project.region, projectType: project.projectType, managerIds: values.managerIds }, project.version);
        scheduleReload();
      } catch (error) {
        setTaskError(error instanceof ApiError ? error.message : t("ws.err.manager"));
        return null;
      }
    }
    return runTaskWrite((row, projectId) =>
      updateTask(projectId, row.id, {
        version: values.version,
        ownerIds: values.ownerIds,
        plannedStart: values.startDate === "" ? null : values.startDate,
        plannedEnd: values.dueDate === "" ? null : values.dueDate,
        estimatedDays: values.days,
        headcount: values.headcount,
        priority: values.priority,
        deliverableTypes: values.deliverableTypes,
        note: values.note,
      }),
    );
  };
  /** 任务描述改名（临时任务才出这一行，见 TaskDrawer 的 titleEditable 口径）。 */
  const handleDrawerRename = (_taskId: string, title: string, titleEn: string): void => {
    runTaskWrite((row, projectId) => updateTask(projectId, row.id, { version: row.version, title, titleEn: titleEn === "" ? null : titleEn }));
  };
  /** 四格进度 / 任务状态 / 实际完成日期：与项目页行内同一套接口（updateTaskProgress / updateTask）。 */
  const handleDrawerProgress = (_taskId: string, progress: number): void => {
    runTaskWrite((row, projectId) => updateTaskProgress(projectId, row.id, { progress, version: row.version }));
  };
  const handleDrawerStatus = (_taskId: string, status: TaskStatus): void => {
    runTaskWrite((row, projectId) => updateTask(projectId, row.id, { status: statusWriteValue(status), version: row.version }));
  };
  const handleDrawerActualEnd = (_taskId: string, iso: string): void => {
    runTaskWrite((row, projectId) => updateTaskProgress(projectId, row.id, iso === "" ? { progress: 0.75, version: row.version } : { progress: 1, actualEnd: iso, version: row.version }));
  };
  const handleDrawerFinalize = (_taskId: string): void => {
    runTaskWrite((row, projectId) => finalizeTask(projectId, row.id, row.version));
  };
  const handleDrawerUnfinalize = (_taskId: string): void => {
    runTaskWrite((row, projectId) => unfinalizeTask(projectId, row.id, row.version));
  };
  /** 文件上传 / 删除 / 改名：抽屉内部上传完成 / 失败后自动重取清单（filesTick），这里只管调接口 + 刷新行计数。 */
  const handleDrawerUploadFiles = (taskId: string, files: File[], onProgress?: (done: number, total: number) => void): Promise<void> => {
    const current = drawerTask;
    if (current === null) {
      return Promise.resolve();
    }
    return (async () => {
      try {
        await uploadFiles(current.projectId, files, { taskId, onProgress });
        scheduleReload();
      } catch (error) {
        scheduleReload();
        setTaskError(error instanceof ApiError ? error.message : t("ws.err.upload"));
      }
    })();
  };
  const handleDrawerDeleteFile = (fileId: string): Promise<void> => {
    return (async () => {
      try {
        await recycleFile(fileId);
        scheduleReload();
      } catch (error) {
        setTaskError(error instanceof ApiError ? error.message : t("ws.err.delete"));
      }
    })();
  };
  const handleDrawerRenameFile = (fileId: string, name: string): Promise<void> => {
    return (async () => {
      try {
        await renameFile(fileId, name);
        scheduleReload();
      } catch (error) {
        setTaskError(error instanceof ApiError ? error.message : t("ws.err.rename"));
      }
    })();
  };
  /** 变更提交成功（onChanged）：重取任务详情（变更关联 / 文件新状态带回来）→ 抽屉就地更新；行数据交给静默刷新。 */
  const handleDrawerChanged = (): void => {
    const current = drawerTask;
    if (current === null) {
      return;
    }
    void (async () => {
      try {
        const detail = await fetchTaskDetail(current.projectId, current.task.id);
        setDrawerTask((previous) => (previous === null || previous.task.id !== detail.id ? previous : { task: toUiTask(detail, previous.task, (id) => memberNameOf(members, id)), projectId: previous.projectId }));
      } catch {
        // 详情取不到不打断：文件清单由抽屉内 filesTick 自理，行数据交给静默刷新。
      }
      scheduleReload();
    })();
  };

  /** 行内编辑回调（Push 279）：逐列与项目页 TaskRow 同一套写入口径（回填行的 version + 防抖静默刷新）；
   *  项目经理是项目级字段（回写项目卡），文件两件走项目文件库（上传 / 回收站），失败都进同一条提示条。 */
  const rowHandlers: TaskTableHandlers = {
    onProgress: (projectId, taskId, progress) => {
      runRowWrite(taskId, (row) => updateTaskProgress(projectId, taskId, { progress, version: row.version }));
    },
    onSetStatus: (projectId, taskId, status) => {
      runRowWrite(taskId, (row) => updateTask(projectId, taskId, { status: statusWriteValue(status), version: row.version }));
    },
    onSetActualEnd: (projectId, taskId, iso) => {
      runRowWrite(taskId, (row) => updateTaskProgress(projectId, taskId, iso === "" ? { progress: 0.75, version: row.version } : { progress: 1, actualEnd: iso, version: row.version }));
    },
    onPatch: (projectId, taskId, patch) => {
      runRowWrite(taskId, (row) => updateTask(projectId, taskId, taskPatchBody(row.version, patch)));
    },
    onChangeManagers: (projectId, managerIds) => {
      const project = projectById.get(projectId);
      if (project === undefined || sameMemberIds(managerIds, project.managerIds)) {
        return;
      }
      void (async () => {
        try {
          await updateProject(project.id, { code: project.code, name: project.name, region: project.region, projectType: project.projectType, managerIds }, project.version);
          setTaskError(null);
          scheduleReload();
        } catch (error) {
          setTaskError(error instanceof ApiError ? error.message : t("ws.err.manager"));
        }
      })();
    },
    onUploadFiles: (projectId, taskId, files, onProgress, finalize) => {
      return (async () => {
        try {
          await uploadFiles(projectId, files, { taskId, onProgress, finalize });
          scheduleReload();
        } catch (error) {
          // 可能已部分成功（逐份直传中途失败 / 定档被拦）：先静默刷新让计数归位，再走统一错误出口。
          scheduleReload();
          setTaskError(error instanceof ApiError ? error.message : t("ws.err.upload"));
        }
      })();
    },
    onDeleteFile: (fileId) => {
      return (async () => {
        try {
          await recycleFile(fileId);
          scheduleReload();
        } catch (error) {
          setTaskError(error instanceof ApiError ? error.message : t("ws.err.delete"));
        }
      })();
    },
  };

  const drawerProject = drawerTask === null ? undefined : projectById.get(drawerTask.projectId);
  const drawerManagers = (drawerProject?.managerNames ?? []).filter((name): name is string => name !== null && name !== "").join("、");

  return (
    <section data-workspace-tasks="" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">{t("ws.title.myTasks")}</h2>
        <span data-workspace-task-total="" className="text-xs text-zinc-400">
          {t("ws.tasks.summary", { total, projects: projects.length, date: fullDateText(locale, data.today) })}
        </span>
      </div>
      {projects.length === 0 ? (
        <EmptyCard text={t("ws.tasks.empty")} hint={t("ws.tasks.emptyHint")} />
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <ProjectPanel
              key={project.projectId}
              projectId={project.projectId}
              projectCode={project.projectCode}
              projectName={project.projectName}
              summary={<TaskPanelSummary items={project.items} />}
              href={projectViewHref(project.projectId, "overview")}
              open={openIds.has(project.projectId)}
              onToggle={() => {
                onToggleProject(project.projectId);
              }}
            >
              <TaskTable projectId={project.projectId} project={projectById.get(project.projectId)} items={project.items} tierTint={tierTint} members={members} onOpenTask={openTask} rowOf={rowOf} handlers={rowHandlers} />
            </ProjectPanel>
          ))}
        </div>
      )}
      <TaskDrawer
        task={drawerTask?.task ?? null}
        managers={drawerManagers}
        managerIds={drawerProject?.managerIds ?? []}
        members={members}
        onSubmit={handleDrawerSubmit}
        onRename={handleDrawerRename}
        onProgress={handleDrawerProgress}
        onSetStatus={handleDrawerStatus}
        onSetActualEnd={handleDrawerActualEnd}
        onFinalize={handleDrawerFinalize}
        onUnfinalize={handleDrawerUnfinalize}
        onUploadFiles={handleDrawerUploadFiles}
        onDeleteFile={handleDrawerDeleteFile}
        onRenameFile={handleDrawerRenameFile}
        onChanged={handleDrawerChanged}
        actorName={actorName}
        projectId={drawerTask?.projectId}
        onClose={() => {
          setDrawerTask(null);
        }}
      />
      {taskError === null ? null : (
        <Toast kind="error" text={taskError} onClose={() => { setTaskError(null); }} anchor={{ name: "data-workspace-task-error", value: "" }} />
      )}
    </section>
  );
}

/** 「提出/负责的问题」标签下的两枚子视图（Push 260）—— 本刀按业务口径「然后导航栏还是改成这样的吧」收进主标签栏的
 *  下拉子菜单（子项定义与面板都在 components/WorkspaceIssueSubMenu.tsx，与项目页「日报及问题」同款；本文件只剩挂载与
 *  悬停 / 点击展开逻辑）：地址仍是 `?tab=raised&sub=`（缺省 raised 不落参数、`?sub=handling` = 待我处理的问题）。 */

/** 标签 ②「我提出的问题」/「待我处理的问题」（两枚子标签共用本视图）：按项目的折叠面板 + 照「问题追踪」七列的问题表。
 *  - 数据两栏不同源：raised = 我提出的（reporterId 我）、handling = 我处理的（ownerId 我）；同一问题两边都命中时两栏都出现
 *  （服务端口径，未关闭在前 —— 已完成也收；页面展示再按「已完成不显示」过滤，见下条）；
 *  - 「已完成则不显示」（Push 260 · 业务口径 2026-10-09）：状态为「已完成」的问题两栏都不进表 —— 过滤取「行内覆盖值 ??
 *  接口值」的有效状态（visibleIssues），行内刚改成「已完成」的行即时消失、改失败回滚后重新出现；面板计数 / 汇总行
 *  （共 N 条）只算未完成的，项目全完成则该面板不出现；项目页「问题追踪」不受影响（全量口径）；
 *  - 表 / 归类色签两栏完全同构（业务口径「我处理的问题就是提出问题里面分类的问题」—— 同一套「问题归类」，不另立分类）；
 *  - 「进入项目」落点两栏一致 = 该项目「问题追踪」（`?view=daily&sub=issues`；Push 253 口径）；折叠面板展开态两栏共用
 *  同一组「已展开项目」记忆（openedIds，见页面级说明）。 */
function IssuesView({ view, issues, tierTint, openIds, onToggleProject, overrides, onChangeState }: { view: WorkspaceIssueView; issues: readonly ApiWorkspaceIssue[]; tierTint: TintedTier | false; openIds: ReadonlySet<string>; onToggleProject: (projectId: string) => void; overrides: ReadonlyMap<string, IssueStateOverride>; onChangeState: (issue: ApiWorkspaceIssue, next: IssueState) => void }) {
  // 已完成不显示（Push 260 · 第七项）：按「覆盖值 ?? 接口值」的有效状态过滤（Push 302 起 solution / photos 就在行上，过滤不再牵动取数）。
  const visibleIssues = issues.filter((issue) => (overrides.get(issue.id)?.state ?? toIssueState(issue.state)) !== "done");
  const projects = groupIssuesByProject(visibleIssues);
  const t = useT();
  const raised = view === "raised";
  /** 「我提出的问题」（Push 301 追订 · 业务口径「图二为什么有中文有英文」）：问题标题 / 解决方案 / 项目名
   *  一到就后台预热译文 —— 英文界面整块出英文，不再一半中文一半英文（未就绪仍先显示原文）。 */
  useEffect(() => {
    prefetchZhToEn([
      ...issues.map((issue) => issue.title),
      ...issues.map((issue) => issue.solution ?? ""),
      ...issues.map((issue) => issue.projectName),
    ]);
  }, [issues]);
  return (
    <section data-workspace-issues="" data-workspace-issues-view={view} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">{raised ? t("ws.title.raised") : t("ws.title.assigned")}</h2>
        <span data-workspace-issue-total="" className="text-xs text-zinc-400">
          {visibleIssues.length === 1
            ? projects.length === 1
              ? t("ws.issues.summary.single")
              : t("ws.issues.summary.oneIssue", { projects: projects.length })
            : projects.length === 1
              ? t("ws.issues.summary.oneProject", { n: visibleIssues.length })
              : t("ws.issues.summary", { n: visibleIssues.length, projects: projects.length })}
        </span>
      </div>
      {projects.length === 0 ? (
        raised ? (
          <EmptyCard text={t("ws.issues.raisedEmpty")} hint={t("ws.issues.raisedHint")} />
        ) : (
          <EmptyCard text={t("ws.issues.assignedEmpty")} hint={t("ws.issues.assignedHint")} />
        )
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <ProjectPanel
              key={project.projectId}
              projectId={project.projectId}
              projectCode={project.projectCode}
              projectName={project.projectName}
              summary={<span className="text-xs font-normal text-zinc-400">{project.issues.length === 1 ? t("ws.issue.count.one") : t("ws.issue.count", { n: project.issues.length })}</span>}
              href={projectViewHref(project.projectId, "daily", "issues")}
              open={openIds.has(project.projectId)}
              onToggle={() => {
                onToggleProject(project.projectId);
              }}
            >
              <IssueTable issues={project.issues} tierTint={tierTint} overrides={overrides} onChangeState={onChangeState} />
            </ProjectPanel>
          ))}
        </div>
      )}
    </section>
  );
}

/** 标签 ③ 我的计划（Push 234 标签与路由就位 → Push 266 页面落地；页面形态照 MiniMemo 参考页照搬 —— 奶白背景 / 左侧分类栏 / 198 高圆角卡片）：
 *  便签墙本体在 components/MyPlanBoard.tsx（数据 / 存储口径见 src/myPlan.ts）——
 *  与其它两枚标签不同，它是纯本机数据（localStorage），不依赖 GET /api/v1/workspace：
 *  即使工作台聚合读面加载中 / 失败，便签墙照常可用（渲染分支把它排在加载 / 失败态之前）。
 *  锚点 data-workspace-plan 供回放断言「切到该标签」用。 */

/** 工作台「我的任务」页：三枚标签（我的任务 / 我提出的问题 / 我的计划）共用一份 GET /api/v1/workspace 聚合数据。
 *  Push 233：折叠面板展开态接账号偏好（workspaceOpenProjects，按标签各记一组项目 id）——「这个下拉要有记忆」。
 *  Push 234：第三枚标签「我的计划」就位（页面内容待详细设计）。
 *  Push 260：「我提出的问题」标签下再分两枚子标签（我提出的问题 / 待我处理的问题，`?sub=`，见 ISSUE_VIEW_TABS）——
 *  两枚子标签共用同一份读面（myIssues.raised / myIssues.handling）与同一组展开态记忆，只换数据栏与标题；
 *  展示口径 = 「已完成不显示」（Push 260 第七项 —— 见 IssuesView 的 visibleIssues 过滤）。 */
export default function WorkspacePage({ me, members, tab, onChangeTab, sub, onChangeSub, workspaceOpenProjects, onWorkspaceOpenProjectsChange }: WorkspacePageProps) {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  /** 重新加载令牌：bump 一次重新取数（错误态的「重新加载」用）。 */
  const [reloadToken, setReloadToken] = useState(0);
  /** 背景档位铺色档（Push 290 统一口径 · 原「醒目模式」；Push 293 起含「炫彩」）：顶栏下拉切档即生效（模块级 store，各页共用）；
   *  档位 = 适中 / 炫彩 → 任务 / 问题表整行铺行色（浓淡随档）+ 状态列收口；切回「简约」= 原样。 */
  const backgroundTier = useBackgroundTier();
  const tierTint: TintedTier | false = backgroundTier === "simple" ? false : backgroundTier;
  const t = useT();
  const locale = useLocale();

  /** 展开态（Push 233 · 业务口径「这个下拉要有记忆」）：偏好由 App 层持有并单键 PATCH；null / 缺省 = 偏好尚未取到 → 按全收起渲染。
   *  未接 onWorkspaceOpenProjectsChange 时退回本页内存态（面板仍可展开 / 收起，只是不跨刷新）。 */
  const [localOpenProjects, setLocalOpenProjects] = useState<WorkspaceOpenProjects>({ tasks: [], raised: [] });
  const openProjects = workspaceOpenProjects ?? localOpenProjects;
  /** 展开态保存失败文案（null = 无提示）：乐观更新 + 失败回滚在 App 层，本页只出提示条。 */
  const [panelError, setPanelError] = useState<string | null>(null);
  /** 切换某个项目面板：按标签各自去重增删（不按顺序消费），整个对象单键 PATCH。 */
  const handleToggleProject = (which: "tasks" | "raised", projectId: string): void => {
    const currentIds = which === "raised" ? openProjects.raised : openProjects.tasks;
    const nextIds = currentIds.includes(projectId) ? currentIds.filter((id) => id !== projectId) : currentIds.concat(projectId);
    const next: WorkspaceOpenProjects = which === "raised" ? { ...openProjects, raised: nextIds } : { ...openProjects, tasks: nextIds };
    if (onWorkspaceOpenProjectsChange === undefined) {
      setLocalOpenProjects(next);
      return;
    }
    void (async () => {
      setPanelError((await onWorkspaceOpenProjectsChange(next)) ?? null);
    })();
  };
  const taskOpenIds = new Set(openProjects.tasks);
  /** 两个问题子视图（我提出的 / 待我处理的）共用同一组「已展开项目」记忆（偏好键 workspaceOpenProjects.raised）。 */
  const raisedOpenIds = new Set(openProjects.raised);

  /** 「问题是否处理」行内改的本地覆盖（Push 260 · 业务口径「我提出 我处理的问题这里的状态都要和项目内部一样
   *  可以点击」）：与项目页「问题追踪」同一枚行内下拉 —— 乐观更新 + PATCH（乐观锁 version）+ 失败回滚、
   *  回包用服务器的新 version 覆盖；改完就地生效不重排（刷新后按服务端「未关闭在前」口径回归）。 */
  const [issueOverrides, setIssueOverrides] = useState<Map<string, IssueStateOverride>>(new Map());
  /** 状态改动失败文案（null = 无提示）：失败已回滚，这里只出提示条。 */
  const [issueError, setIssueError] = useState<string | null>(null);
  const handleChangeIssueState = (issue: ApiWorkspaceIssue, next: IssueState): void => {
    const known = issueOverrides.get(issue.id);
    const from = known ?? { state: toIssueState(issue.state), version: issue.version };
    if (from.state === next) {
      return;
    }
    setIssueOverrides((previous) => new Map(previous).set(issue.id, { state: next, version: from.version }));
    void updateIssue(issue.projectId, issue.id, { version: from.version, state: next })
      .then((updated) => {
        setIssueOverrides((previous) => new Map(previous).set(issue.id, { state: updated.state, version: updated.version }));
        setIssueError(null);
      })
      .catch((error: unknown) => {
        setIssueOverrides((previous) => {
          const rolled = new Map(previous);
          if (known === undefined) {
            rolled.delete(issue.id);
          } else {
            rolled.set(issue.id, known);
          }
          return rolled;
        });
        setIssueError(error instanceof ApiError ? error.message : t("ws.err.issue"));
      });
  };

  /**
   * 「提出/负责的问题」子菜单（业务口径 2026-10-09「然后导航栏还是改成这样的吧」= 项目页「日报及问题」那套
   * 「子视图集成到页面导航栏」）：两枚问题子视图收进主标签的下拉面板（面板见 components/WorkspaceIssueSubMenu.tsx）——
   * 悬停 / 点击父标签展开；面板左缘对齐父标签（展开时量一次）：标签栏可横向滚动，滚动即收起，避免锚点漂移。
   */
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuLeft, setSubmenuLeft] = useState(0);
  const maintabsRef = useRef<HTMLElement | null>(null);
  const raisedTabRef = useRef<HTMLButtonElement | null>(null);
  const submenuTimer = useRef<number | null>(null);

  const cancelSubmenuClose = (): void => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
  };

  const openSubmenu = (): void => {
    cancelSubmenuClose();
    const raisedTab = raisedTabRef.current;
    const bar = maintabsRef.current;
    if (raisedTab !== null && bar !== null) {
      setSubmenuLeft(Math.max(0, Math.round(raisedTab.getBoundingClientRect().left - bar.getBoundingClientRect().left)));
    }
    setSubmenuOpen(true);
  };

  const closeSubmenu = (): void => {
    cancelSubmenuClose();
    setSubmenuOpen(false);
  };

  /** 鼠标离开父标签 / 面板后延迟收起：给指针从标签移到面板（下移 8px）留一条过道。 */
  const scheduleSubmenuClose = (): void => {
    cancelSubmenuClose();
    submenuTimer.current = window.setTimeout(() => {
      submenuTimer.current = null;
      setSubmenuOpen(false);
    }, 160);
  };

  useEffect(() => {
    if (!submenuOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSubmenu();
      }
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (maintabsRef.current !== null && !maintabsRef.current.contains(event.target as Node)) {
        closeSubmenu();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [submenuOpen]);

  useEffect(() => () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await fetchWorkspace();
        if (!cancelled) {
          setState({ kind: "ready", data });
        }
      } catch {
        // 401 已由 apiRequest 统一跳登录；其余（网络 / 5xx…）落本页错误态
        if (!cancelled) {
          setState({ kind: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useLiveRefresh(["tasks", "projects", "issues", "reports", "files", "permissions", "users"], async () => {
    const next = await fetchWorkspace();
    return () => setState((previous) => {
      if (previous.kind !== "ready") return previous;
      return { kind: "ready", data: {
        ...next,
        myTasks: {
          overdue: keepLiveOrder(previous.data.myTasks.overdue, next.myTasks.overdue),
          today: keepLiveOrder(previous.data.myTasks.today, next.myTasks.today),
          upcoming: keepLiveOrder(previous.data.myTasks.upcoming, next.myTasks.upcoming),
          unscheduled: keepLiveOrder(previous.data.myTasks.unscheduled, next.myTasks.unscheduled),
        },
        myIssues: {
          raised: keepLiveOrder(previous.data.myIssues.raised, next.myIssues.raised),
          handling: keepLiveOrder(previous.data.myIssues.handling, next.myIssues.handling),
        },
      } };
    });
  }, String(reloadToken) + ":" + tab, state.kind === "ready" && tab !== "plan");

  /** 任务抽屉写后静默刷新（Push 278）：重取聚合读面但不置 loading（整页不闪）—— 行数据（进度 / 状态 / 文件计数 /
   *  变更关联）随写回滚；失败静默（抽屉内已就地更新，下次自然刷新兜底）。 */
  const refreshQuietly = (): void => {
    void fetchWorkspace()
      .then((next) => {
        setState({ kind: "ready", data: next });
      })
      .catch(() => {
        // 静默：抽屉内已就地更新；列表本次没刷新成功不影响继续编辑。
      });
  };

  return (
    <div className="min-h-screen">
      <AppHeader me={me} />
      <main className="w-full px-6 pb-10 pt-3">
        <div data-workspace-page="" className="w-full space-y-5">
          {/* 标签导航栏（Push 230：与任务模板页的下划线标签栏同一套材质 —— 文字 + 选中下划线）。
              Push 235 吸顶（业务口径「任务模版和我的任务都要做吸顶效果」）：滚动时停在应用顶栏（h-16 = 64px）正下方，
              站灰底 + 毛玻璃兜住滚动内容；-mx-6 -mt-3 + 同值内衬抵消：横幅铺满行宽、三枚标签位置与原来一致（原醒目模式开关位已随 Push 290 功能下架）。
              Push 260：「提出/负责的问题」标签下挂**下拉子菜单**（业务口径 2026-10-09「然后导航栏还是改成这样的吧」，
              = 项目页「日报及问题」那套「子视图集成到页面导航栏」；面板见 components/WorkspaceIssueSubMenu.tsx）——
              两枚子视图（我提出的问题 / 待我处理的问题）不占另一排子标签栏，收在主标签的下拉里；栏高回到单排 59px。 */}
          <nav data-workspace-tabs="" ref={maintabsRef} aria-label={t("ws.tabs.aria")} className="sticky top-16 z-20 -mx-6 -mt-3 border-b border-zinc-200 bg-[#f5f6f8]/95 px-6 pt-3 backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" onScroll={submenuOpen ? closeSubmenu : undefined}>
                {TABS.map((item) => {
                  const active = item.key === tab;
                  // 子菜单父项（业务口径 2026-10-09「然后导航栏还是改成这样的吧」·图 = 项目页「日报及问题」的下拉）：
                  // 两枚问题子视图收进这枚标签的下拉面板；悬停即展开；点击时已在该标签 = 保持展开，否则照旧先切标签。
                  const withSubmenu = item.key === "raised";
                  return (
                    <button
                      key={item.key}
                      ref={withSubmenu ? raisedTabRef : undefined}
                      type="button"
                      data-workspace-tab={item.key}
                      data-workspace-tab-parent={withSubmenu ? "true" : undefined}
                      onMouseEnter={withSubmenu ? openSubmenu : undefined}
                      onMouseLeave={withSubmenu ? scheduleSubmenuClose : undefined}
                      onClick={() => {
                        if (!withSubmenu) {
                          closeSubmenu();
                          onChangeTab(item.key);
                          return;
                        }
                        // 悬停已经展开时点击**保持展开**（不切换成收起：鼠标先到必然先 hover，切换会让「点开」永远点不开）
                        openSubmenu();
                        if (!active) {
                          onChangeTab(item.key);
                        }
                      }}
                      aria-current={active ? "page" : undefined}
                      aria-haspopup={withSubmenu ? "menu" : undefined}
                      aria-expanded={withSubmenu ? submenuOpen : undefined}
                      className={
                        "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition " +
                        (active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800")
                      }
                    >
                      {workspaceLabelText(locale, item.label)}
                      {withSubmenu ? (
                        <svg
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className={"h-3.5 w-3.5 transition-transform " + (submenuOpen ? "rotate-180" : "")}
                        >
                          <path d="M5.5 8l4.5 4.5L14.5 8" />
                        </svg>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 「提出/负责的问题」子菜单面板（材质 = 项目页「日报及问题」下拉：白色圆角面板 + 图标 + 子项）——
                左缘对齐父标签（展开时量一次），面板自己在鼠标进出时续命 / 延迟收起，避免指针过道断开；
                选完 = 收起面板 + 写回地址 ?tab=raised&sub=（已在 raised 标签下时只写 sub）。 */}
            {submenuOpen ? (
              <div
                data-workspace-submenu-anchor="true"
                className="absolute top-full z-30 mt-2"
                style={{ left: submenuLeft }}
                onMouseEnter={cancelSubmenuClose}
                onMouseLeave={scheduleSubmenuClose}
              >
                <WorkspaceIssueSubMenu
                  active={sub}
                  onSelect={(next) => {
                    closeSubmenu();
                    if (tab !== "raised") {
                      onChangeTab("raised");
                    }
                    onChangeSub(next);
                  }}
                />
              </div>
            ) : null}
          </nav>

          {panelError === null ? null : (
            <Toast kind="error" text={panelError} onClose={() => { setPanelError(null); }} anchor={{ name: "data-workspace-panel-error", value: "" }} />
          )}

          {issueError === null ? null : (
            <Toast kind="error" text={issueError} onClose={() => { setIssueError(null); }} anchor={{ name: "data-workspace-issue-error", value: "" }} />
          )}

          {tab === "plan" ? (
            <MyPlanBoard />
          ) : state.kind === "loading" ? (
            <EmptyCard text={t("common.loading")} hint={t("ws.loading.hint")} />
          ) : state.kind === "error" ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-white/50 px-6 py-12 text-center">
              <p className="text-sm text-zinc-500">{t("ws.error")}</p>
              <p className="text-xs text-zinc-400">{t("ws.error.hint")}</p>
              <button
                type="button"
                onClick={() => {
                  setReloadToken((previous) => previous + 1);
                }}
                className={BTN_SECONDARY}
              >
                {t("common.reload")}
              </button>
            </div>
          ) : tab === "raised" ? (
            <IssuesView
              view={sub}
              issues={sub === "handling" ? state.data.myIssues.handling : state.data.myIssues.raised}
              tierTint={tierTint}
              openIds={raisedOpenIds}
              onToggleProject={(projectId) => {
                handleToggleProject("raised", projectId);
              }}
              overrides={issueOverrides}
              onChangeState={handleChangeIssueState}
            />
          ) : (
            <MyTasksView
              data={state.data}
              tierTint={tierTint}
              openIds={taskOpenIds}
              members={members}
              actorName={me.user.displayName ?? ""}
              onReload={refreshQuietly}
              onToggleProject={(projectId) => {
                handleToggleProject("tasks", projectId);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
