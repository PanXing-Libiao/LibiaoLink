import { useEffect, useMemo, useRef, useState } from "react";
import { keepLiveOrder } from "./liveSync";
import { useLiveRefresh } from "./useLiveRefresh";
import { AppHeader } from "./components/AppHeader";
import { ColumnPicker } from "./components/ColumnPicker";
import { DailySubMenu } from "./components/DailySubMenu";
import { ExportOverviewButton } from "./components/ExportOverviewButton";
import { GanttChart } from "./components/GanttChart";
import { ReportIssuePanel } from "./components/ReportIssuePanel";
import { StakeholderPanel } from "./components/StakeholderPanel";
import { Toast, ToastConfirm } from "./components/Toast";
import { useFocusTrap } from "./components/useFocusTrap";
import { TableScrollbar } from "./components/TableScrollbar";
import { DEFAULT_VISIBLE_COLUMNS, ProjectSummary, TaskBoard, hiddenColumnsOf, taskPatchBody, visibleColumnsFromHidden, type ColumnKey, type TaskPatch, type VisibleColumns } from "./components/TaskBoard";
import type { TaskEditSubmit } from "./components/TaskDrawer";
import { TaskKanban, type KanbanAddContext } from "./components/TaskKanban";
import type { StagePlacement } from "./components/StageAddCard";
import { PROJECT_STAGES } from "./data/projects";
import { memberNameOf, type Member } from "./data/members";
import { lockBodyScroll } from "./scrollLock";
import { TEMP_TASK_STAGE, isTaskDone, type ProjectTask, type TaskStatus } from "./data/tasks";
import type { TemplatePresetNode } from "./data/templatePresets";
import { fetchTaskFiles, recycleFile, renameFile, uploadFiles, type TaskFileRef } from "./fileApi";
import { exportProjectOverviewPdf } from "./exportOverviewPdf";
import type { OverviewExportLanguage } from "./overviewExportShared";
import { prefetchLocalizedText, useLocale, useT, viewTabText } from "./i18n";
import { ExportProgressOverlay, type ExportTranslateProgress } from "./components/ExportProgressOverlay";
import { useBackgroundTier, type TintedTier } from "./backgroundTier";
import { projectManagerText } from "./types";
import type { MeResponse, Project } from "./types";
import { replaceProjectSubView, replaceProjectView, type DailySubView, type ProjectView } from "./useHashRoute";
import { ApiError } from "./api";
import {
  createTask,
  deleteTask,
  fetchProjectSummary,
  fetchProjectTasks,
  finalizeTask,
  stageKeyOfName,
  statusWriteValue,
  taskWriteMessage,
  toUiTask,
  unfinalizeTask,
  updateTask,
  updateTaskProgress,
  type ApiProjectSummary,
  type ApiTask,
  type ApiTaskListItem,
  type TaskCreateInput,
  createTasksFromTemplate,
} from "./taskApi";

/** 阶段名（不含「项目总览」汇总视图）。 */
const STAGE_NAMES: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");
/**
 * 「项目总览」任务表的全部固定分组（Push 196）：九个施工阶段 + 垫底的「临时任务」（无阶段任务的分组，原「未分组」）——
 * 骨架常显、一键收起 / 全部展开都按这一份。
 */
const BOARD_STAGES: readonly string[] = [...STAGE_NAMES, TEMP_TASK_STAGE];

/** 两份项目经理名单是否一致（顺序敏感：名单顺序就是展示顺序，Push 136）。 */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * 阶段序号（Push 111）：展示顺序以**阶段为主键**，顺序就是项目总览的分组顺序（售前规划 → … → 验收）。
 * 不在九阶段里的（看板「添加 → 临时任务」建的空任务）= 「临时任务」，垫底 —— 与项目总览里「临时任务」固定最后一组的口径一致（Push 196 改名）。
 */
function stageRankOf(stage: string): number {
  const at = STAGE_NAMES.indexOf(stage);
  return at < 0 ? STAGE_NAMES.length : at;
}

/**
 * 顶部视图标签（Push 82 定稿）：阶段标签不再各占一格，改成「项目总览 + 两块看板」；
 * Push 128：再往后加第四个视图「日报及问题」（口径见 components/ReportIssuePanel.tsx）；
 * Push 142：「项目总览」之后再加「甘特图」（口径见 components/GanttChart.tsx）；
 * Push 154：当前标签走地址 `?view=`，刷新 / 收藏 / 分享都停在同一块标签。
 */
/** Push 221：再往后加第六个视图「干系人」（排最右侧；A27 台账前端接线，口径见 components/StakeholderPanel.tsx）。 */
const VIEW_TABS = ["项目总览", "甘特图", "人员任务分配", "任务进展", "日报及问题", "干系人"] as const;
type ViewTab = (typeof VIEW_TABS)[number];

/** 顶部标签 ↔ 地址参数（`?view=`）：缺省「项目总览」（overview）不落参数。 */
const VIEW_KEYS: Record<ViewTab, ProjectView> = {
  "项目总览": "overview",
  "甘特图": "gantt",
  "人员任务分配": "owners",
  "任务进展": "progress",
  "日报及问题": "daily",
  "干系人": "stakeholders",
};


type ProjectDetailProps = {
  me: MeResponse;
  project: Project | null;
  /** 顶部标签的当前视图（Push 154 起由地址 `?view=` 派生，缺省「项目总览」）。 */
  view: ProjectView;
  /** 「日报及问题」的页内子视图（Push 214 起由地址 `?view=daily&sub=` 派生，缺省「日报填写」form）；其它标签下无意义。 */
  dailySub: DailySubView;
  /** 人员候选（GET /api/v1/users → directoryMemberOptions）：项目经理列 / 任务负责人 / 任务详情抽屉的多选共用。 */
  members: readonly Member[];
  /** 任务编辑里改「项目经理」时回写项目（项目经理是项目级字段，Push 136 起可多位）。 */
  onChangeManagers?: (projectId: string, managerIds: string[]) => Promise<boolean>;
  /** 任务字段被编辑（按口径刷新项目时间 updatedAt）。 */
  onTaskEdited?: (projectId: string) => void;
  /** 任务表列显隐（A4 · Push 170）：服务端偏好里的隐藏列 key；null / 缺省 = 尚未取到（先用页面默认列）。 */
  taskHiddenColumns?: string[] | null;
  /** 保存列显隐（整体替换 PATCH）；返回 null = 成功，返回文案 = 失败提示。 */
  onTaskHiddenColumnsChange?: (keys: string[]) => Promise<string | null>;
  /** 干系人写入口（Push 221 · A27）：= stakeholder.manage（画像未到时乐观放行，服务端逐请求仍是最终裁决）。 */
  canManageStakeholders: boolean;
  /** 验收完成后设为已完成的写入口（无 project.update 权限时父层不传）；false = 写失败，父层已提示。 */
  onSetProjectDone?: (projectId: string) => Promise<boolean>;
};

export default function ProjectDetail({ me, project, view, dailySub, members, onChangeManagers, onTaskEdited, taskHiddenColumns, onTaskHiddenColumnsChange, canManageStakeholders, onSetProjectDone }: ProjectDetailProps) {
  /** 顶部视图（Push 82 / 121）：阶段标签收进「项目总览」，另两块是看板视图，最后一块是「日报及问题」；Push 154 起当前标签由地址 `?view=` 派生。 */
  const locale = useLocale();
  const t = useT();
  const activeView = VIEW_TABS.find((tab) => VIEW_KEYS[tab] === view) ?? VIEW_TABS[0];
  const projectId = project?.id ?? null;

  /**
   * 任务数据（M3-07 刀 1 后半接线）：列表与汇总卡全部来自服务端任务接口（GET /projects/{id}/tasks 与 /summary）。
   * 原「五层内存覆盖」（进度 / 字段编辑 / 看板顺序 / 行内删除 / 新增任务）随接线整体下线 —— 写成功即回读。
   */
  const [rawTasks, setRawTasks] = useState<ProjectTask[]>([]);
  const [preserveTaskOrder, setPreserveTaskOrder] = useState(false);
  /** 任务 → 文件引用数组（Push 226 续二；Push 246 起携 id——「文件」列下拉预览 / 删除用）：随整表重取一起刷新
   *  （列表接口不带文件名，这里按项目走文件库列表一次拉全量，见 fileApi.fetchTaskFiles）。 */
  const [taskFiles, setTaskFiles] = useState<Map<string, TaskFileRef[]>>(new Map());
  const [summary, setSummary] = useState<ApiProjectSummary | null>(null);
  /** 取数版本号：换项目、或新建 / 删除 / 排序 / 版本冲突后需要整表重取时 +1。 */
  const [dataVersion, setDataVersion] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  /** 待确认删除的任务行（Push 264 追订 · 业务口径「任务行内删除无二次确认」）：第一下只开顶部确认 Toast，第二下才真删。 */
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内、Tab 在条内循环、关闭还原到行内删除按钮。 */
  const deleteTaskConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDeleteTaskId !== null);
  /** 验收交付完成询问（2026-10-22）：只在本次写入让验收阶段首次全部完成时打开一次。 */
  const [acceptanceDonePromptOpen, setAcceptanceDonePromptOpen] = useState(false);
  const [acceptanceDonePending, setAcceptanceDonePending] = useState(false);
  const [acceptanceDoneClosing, setAcceptanceDoneClosing] = useState(false);
  const acceptanceDonePromptOpenRef = useRef(false);
  const acceptanceDoneCloseTimer = useRef<number | null>(null);
  const acceptanceDonePromptTrapRef = useFocusTrap<HTMLDivElement>(acceptanceDonePromptOpen);

  /** 关闭验收完成询问（暂不 / Esc）：先播 180ms 的 toast 退出，再卸载；不改项目状态。 */
  const closeAcceptanceDonePrompt = (): void => {
    if (!acceptanceDonePromptOpenRef.current) {
      return;
    }
    acceptanceDonePromptOpenRef.current = false;
    setAcceptanceDoneClosing(true);
    if (acceptanceDoneCloseTimer.current !== null) {
      window.clearTimeout(acceptanceDoneCloseTimer.current);
    }
    acceptanceDoneCloseTimer.current = window.setTimeout(() => {
      acceptanceDoneCloseTimer.current = null;
      setAcceptanceDonePromptOpen(false);
      setAcceptanceDoneClosing(false);
      setAcceptanceDonePending(false);
    }, 180);
  };

  /**
   * 「日报及问题」子菜单（业务口径 2026-09-30「日报及问题页面的导航栏按钮集成到页面导航栏 如图一的效果」）：
   * 四块子视图从页内键帽导航栏搬进主标签栏的下拉子菜单（面板见 components/DailySubMenu.tsx）——
   * 悬停 / 点击父标签展开；面板左缘对齐父标签（展开时量一次）：标签栏可横向滚动，滚动即收起，避免锚点漂移。
   */
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuLeft, setSubmenuLeft] = useState(0);
  const maintabsRef = useRef<HTMLDivElement | null>(null);
  const dailyTabRef = useRef<HTMLButtonElement | null>(null);
  const submenuTimer = useRef<number | null>(null);

  const cancelSubmenuClose = () => {
    if (submenuTimer.current !== null) {
      window.clearTimeout(submenuTimer.current);
      submenuTimer.current = null;
    }
  };

  const openSubmenu = () => {
    cancelSubmenuClose();
    const tab = dailyTabRef.current;
    const bar = maintabsRef.current;
    if (tab !== null && bar !== null) {
      setSubmenuLeft(Math.max(0, Math.round(tab.getBoundingClientRect().left - bar.getBoundingClientRect().left)));
    }
    setSubmenuOpen(true);
  };

  const closeSubmenu = () => {
    cancelSubmenuClose();
    setSubmenuOpen(false);
  };

  /** 鼠标离开父标签 / 面板后延迟收起：给指针从标签移到面板（下移 8px）留一条过道。 */
  const scheduleSubmenuClose = () => {
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
    if (acceptanceDoneCloseTimer.current !== null) {
      window.clearTimeout(acceptanceDoneCloseTimer.current);
    }
  }, []);

  /** 换项目 / 项目已完成或归档时收起询问，避免旧项目的提示串到下一页。 */
  useEffect(() => {
    if (projectId === null || project?.status === "done" || project?.status === "archived") {
      acceptanceDonePromptOpenRef.current = false;
      if (acceptanceDoneCloseTimer.current !== null) {
        window.clearTimeout(acceptanceDoneCloseTimer.current);
        acceptanceDoneCloseTimer.current = null;
      }
      setAcceptanceDonePromptOpen(false);
      setAcceptanceDoneClosing(false);
      setAcceptanceDonePending(false);
    }
  }, [projectId, project?.status]);

  /** 验收询问是模态层：打开期间锁页面滚动，避免滚轮穿透到后方的任务表。 */
  useEffect(() => {
    if (!acceptanceDonePromptOpen) {
      return undefined;
    }
    return lockBodyScroll();
  }, [acceptanceDonePromptOpen]);

  /** Esc = 暂不；捕获阶段截住，避免同一次 Esc 又关掉后方任务抽屉；写入中只截住、不关层。 */
  useEffect(() => {
    if (!acceptanceDonePromptOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!acceptanceDonePending) {
        closeAcceptanceDonePrompt();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [acceptanceDonePromptOpen, acceptanceDonePending]);

  /** 整表重取（新建 / 删除 / 排序 / 版本冲突后调用；换项目由下面这个 effect 自动触发）。 */
  const reloadAll = () => {
    setDataVersion((previous) => previous + 1);
  };

  useLiveRefresh(["tasks", "projects", "files", "templates", "permissions", "users"], async () => {
    if (projectId === null) return () => {};
    const [list, card, files] = await Promise.all([fetchProjectTasks(projectId), fetchProjectSummary(projectId), fetchTaskFiles(projectId)]);
    return () => {
      setRawTasks((previous) => keepLiveOrder(previous, list.items.map((item) => toUiTask(item))));
      setPreserveTaskOrder(true);
      setSummary(card);
      setTaskFiles(files);
      setDataError(null);
    };
  }, String(projectId) + ":" + String(dataVersion), projectId !== null && !dataLoading && summary !== null);

  useEffect(() => {
    if (projectId === null) {
      setRawTasks([]);
      setSummary(null);
      setTaskFiles(new Map());
      return undefined;
    }
    let alive = true;
    setDataLoading(true);
    void (async () => {
      try {
        const [list, card, files] = await Promise.all([
          fetchProjectTasks(projectId),
          fetchProjectSummary(projectId),
          // 文件映射是次要信息：取不到就退回「N 份」计数展示，不打断整表
          fetchTaskFiles(projectId).catch(() => new Map<string, TaskFileRef[]>()),
        ]);
        if (!alive) {
          return;
        }
        setRawTasks(list.items.map((item) => toUiTask(item)));
        setPreserveTaskOrder(false);
        setSummary(card);
        setTaskFiles(files);
        setDataError(null);
        // 列表一次取满（契约 limit 上限 200）：超了先提示，按需分页随搜索那一刀接线
        if (list.total > list.items.length) {
          setToolError(t("pd.tasks.truncated", { total: list.total, shown: list.items.length }));
        }
      } catch (error) {
        if (alive) {
          setDataError(error instanceof ApiError ? error.message : t("pd.tasks.loadFailed"));
        }
      } finally {
        if (alive) {
          setDataLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, dataVersion]);

  /**
   * 展示顺序（Push 111 / A19）：**阶段为主键**（九阶段按项目总览顺序、「临时任务」垫底）、**组内按服务端位次 sortIndex** ——
   * 与服务端默认读序（阶段序 → sort_index → id）同一口径；三块视图共用这一份顺序。
   */
  const tasks = useMemo(
    () => preserveTaskOrder ? rawTasks : [...rawTasks].sort((left, right) => stageRankOf(left.stage) - stageRankOf(right.stage) || left.sortIndex - right.sortIndex),
    [rawTasks, preserveTaskOrder],
  );

  /**
   * 「写进展描述即后台翻译」（业务口径 2026-10-13 · §6.16 ㉑）：项目数据一到 / 每次写入回写（tasks 变化 ——
   * 行内编辑、抽屉保存、进度 / 状态写入……）就把「项目名 + 全部非空进展描述」丢进译文缓存后台预热；
   * 用户写完进展描述几秒内译文就绪，导出时直接命中、不再等机器翻译（缓存与去重见 src/translateApi.ts）。
   * 同日追订（「因为页面有些内容是手打的 我建议是提前后台机翻」）：无英文名（titleEn 空）的任务名一并预热；日 / 韩界面不采用 titleEn，
   * 因此全部任务名都要按目标语言预热（英文界面有 titleEn 的任务名仍不进机翻通道）。
   */
  useEffect(() => {
    prefetchLocalizedText([
      project === null ? "" : project.description,
      ...tasks.map((task) => task.note),
      ...tasks.filter((task) => task.titleEn === "" || locale === "ja" || locale === "ko").map((task) => task.title),
    ]);
  }, [project, tasks, locale]);

  /** 当前行（写入要回传它的 version / sortIndex 等）。 */
  const rowOf = (taskId: string): ProjectTask | undefined => tasks.find((task) => task.id === taskId);

  /**
   * 验收交付完成询问（2026-10-22 · 业务口径「当验收交付完成后 弹出一个弹出显示是否需要将项目设为已完成」）：
   * 本次写入把「验收」阶段最后一颗未完成任务改成完成态时打开询问；打开 / 刷新已全部完成的项目不弹。
   * 验收完成 = 该阶段至少有一条任务，且全部为已完成 / 提前完成；写回状态以服务端响应为准。
   */
  const promptAfterAcceptanceCompletion = (updated: ApiTaskListItem | ApiTask): void => {
    if (
      onSetProjectDone === undefined ||
      project === null ||
      project.status === "done" ||
      project.status === "archived" ||
      acceptanceDonePromptOpenRef.current
    ) {
      return;
    }
    const previous = tasks.find((task) => task.id === updated.id);
    if (previous === undefined) {
      return;
    }
    const next = toUiTask(updated, previous, (id) => memberNameOf(members, id));
    if (next.stageKey !== "acceptance" || !isTaskDone(next)) {
      return;
    }
    const acceptanceTasks = tasks.filter((task) => task.stageKey === "acceptance");
    if (acceptanceTasks.length === 0 || acceptanceTasks.every(isTaskDone)) {
      return;
    }
    if (!acceptanceTasks.every((task) => task.id === updated.id || isTaskDone(task))) {
      return;
    }
    acceptanceDonePromptOpenRef.current = true;
    if (acceptanceDoneCloseTimer.current !== null) {
      window.clearTimeout(acceptanceDoneCloseTimer.current);
      acceptanceDoneCloseTimer.current = null;
    }
    setAcceptanceDoneClosing(false);
    setAcceptanceDonePending(false);
    setAcceptanceDonePromptOpen(true);
  };

  /** 确认设为已完成：成功才关弹窗；失败保留弹窗供重试，错误由父层顶部 Toast 提示。 */
  const confirmAcceptanceDonePrompt = (): void => {
    if (acceptanceDonePending || project === null || onSetProjectDone === undefined) {
      return;
    }
    const id = project.id;
    setAcceptanceDonePending(true);
    void (async () => {
      const ok = await onSetProjectDone(id);
      setAcceptanceDonePending(false);
      if (ok) {
        closeAcceptanceDonePrompt();
      }
    })();
  };

  /**
   * 单行替换（PATCH / 进度写入都回单行）：文件摘要从旧行继承；
   * 负责人姓名走用户目录（写回响应不带 ownerNames —— 不补的话改完负责人要刷新才显示）。
   */
  const replaceRow = (view: ApiTaskListItem | ApiTask): void => {
    setRawTasks((current) =>
      current.map((row) => (row.id === view.id ? toUiTask(view, row, (id) => memberNameOf(members, id)) : row)),
    );
  };

  /** 汇总卡重取（最慢 / 最新阶段、逾期与完成数都可能被一次写入改动）。 */
  const refreshSummary = async (): Promise<void> => {
    if (projectId === null) {
      return;
    }
    try {
      setSummary(await fetchProjectSummary(projectId));
    } catch {
      // 汇总卡是次要信息：取不到就保持上一次的值，不打断主流程
    }
  };

  /** 写入失败的统一出口：409 版本冲突顺带整表重取（本地这份已经过期）。 */
  const reportWriteError = (error: unknown): void => {
    if (error instanceof ApiError) {
      setToolError(taskWriteMessage(locale, error));
      if (error.code === "VERSION_CONFLICT") {
        reloadAll();
      }
      return;
    }
    setToolError(error instanceof Error ? error.message : t("pd.tasks.writeFailed"));
  };

  /** 一次成功写入的收尾：刷新汇总卡 + 通知项目时间变化。 */
  const afterWrite = async (): Promise<void> => {
    await refreshSummary();
    if (projectId !== null) {
      onTaskEdited?.(projectId);
    }
  };

  /**
   * 任务文件上传（Push 226 · 「文件」列与任务抽屉共用一条链路）：逐份分片直传文件库并关联任务（taskId），
   * 完成后整表重取刷新文件计数（文件不改变项目时间，不触发 onTaskEdited）；失败走统一写入错误出口（toolError 提示条）。
   * finalize（Push 249 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」）：
   * 每份传完即定档（files.finalize），任务随文件定档一并锁定（此后写口一律 409 TASK_FINALIZED）。
   */
  const handleUploadTaskFiles = (taskId: string, files: File[], onProgress?: (done: number, total: number) => void, finalize = false): Promise<void> => {
    if (projectId === null) {
      return Promise.resolve();
    }
    return (async () => {
      try {
        await uploadFiles(projectId, files, { taskId, onProgress, finalize });
        reloadAll();
      } catch (error) {
        // 可能已部分成功（逐份直传中途失败 / 定档被 409 拦下）：先整表重取让计数与状态归位，再走统一错误出口
        reloadAll();
        reportWriteError(error);
      }
    })();
  };

  /**
   * 任务文件删除（Push 226 续）：清单里「删除」= 移入回收站（M4-02，30 天内可恢复），
   * 完成后整表重取刷新文件计数；失败走统一写入错误出口（toolError 提示条）。
   */
  const handleDeleteTaskFile = (fileId: string): Promise<void> => {
    return (async () => {
      try {
        await recycleFile(fileId);
        reloadAll();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /**
   * 任务文件改名（Push 226 续二 · 业务口径「名称要可以修改」）：抽屉清单里点名字进编辑、回车 / 失焦提交
   * （只改主名、后缀由系统保留）；成功后整表重取刷新清单与「文件」列文件名。
   */
  const handleRenameTaskFile = (fileId: string, name: string): Promise<void> => {
    return (async () => {
      try {
        await renameFile(fileId, name);
        reloadAll();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /**
   * 点四格进度条 / 甘特进度圆点（Push 65 / 67 · §6.4）：只写进度，状态与完成日期的联动（0 格 = 待开始、
   * 1~3 格 = 进行中、4 格 = 完成；已过预计完成日期仍保持「已延期」）由服务端裁决 —— 与原型联动口径一致。
   */
  const handleSetProgress = (taskId: string, progress: number) => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        const updated = await updateTaskProgress(projectId, taskId, { progress, version: row.version });
        replaceRow(updated);
        promptAfterAcceptanceCompletion(updated);
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /**
   * 状态下拉 / 看板拖列（五态可写 · 2026-09-24 定案）：pending / active / done 为基础三态（服务端同事务联动进度与完成日期），
   * overdue（已延期）/ early_done（提前完成）为显式覆盖 —— 覆盖的生效边界与清除时机全在服务端，前端只提交五态值。
   */
  const handleSetStatus = (taskId: string, status: TaskStatus) => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        const updated = await updateTask(projectId, taskId, { status: statusWriteValue(status), version: row.version });
        replaceRow(updated);
        promptAfterAcceptanceCompletion(updated);
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /** 实际完成日期（§6.9）：填 = 完成（满格 + 该日期）、清 = 退回进行中（3/4 格，服务端同时清掉完成日期）。 */

  /**
   * 任务定档（Push 252 · 抽屉头部「定档」开关 + 二次确认）：未定档 → 置位锁定（此后写口全 409 TASK_FINALIZED；文件修改走变更）；
   * 已定档 → 服务端幂等原样返回（响应仍整行替换，开关停在「已」态）。
   */
  const handleFinalizeTask = (taskId: string) => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        replaceRow(await finalizeTask(projectId, taskId, row.version));
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };
  /**
   * 任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：已定档开关再次点击 → 二次确认 →
   * 清位重开（version+1、留痕「取消定档」；文件级定档不回退，文件修改仍走变更）；未定档 → 服务端幂等原样返回。
   */
  const handleUnfinalizeTask = (taskId: string) => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        replaceRow(await unfinalizeTask(projectId, taskId, row.version));
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };
  const handleSetActualEnd = (taskId: string, iso: string) => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        const body = iso === "" ? { progress: 0.75, version: row.version } : { progress: 1, actualEnd: iso, version: row.version };
        const updated = await updateTaskProgress(projectId, taskId, body);
        replaceRow(updated);
        promptAfterAcceptanceCompletion(updated);
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /** 表格行内 / 甘特拖动改字段（Push 88）：负责人、开始与预计完成日期（含联动天数）、施工人数、紧急重要度、进展描述。 */
  const handlePatchTask = async (taskId: string, patch: TaskPatch, version?: number): Promise<number | null> => {
    const row = rowOf(taskId);
    if (projectId === null || row === undefined) {
      return null;
    }
    // patch → body 的字段口径（空串 = 清空等）抽到 TaskBoard.taskPatchBody（Push 279）：与工作台行内编辑同源
    const body = taskPatchBody(version ?? row.version, patch);
    try {
      const updated = await updateTask(projectId, taskId, body);
      replaceRow(updated);
      void afterWrite();
      return updated.version;
    } catch (error) {
      reportWriteError(error);
      return null;
    }
  };

  /** 任务详情抽屉保存：项目经理（项目级）回写项目，其余字段与行内编辑同一套写入口径。 */
  const handleSubmitTaskEdit = async (values: TaskEditSubmit): Promise<number | null> => {
    if (project === null) {
      return null;
    }
    if (values.managerChanged && values.managerIds.length > 0 && !sameIds(values.managerIds, project.managerIds)) {
      if (onChangeManagers === undefined || !(await onChangeManagers(project.id, values.managerIds))) return null;
    }
    return handlePatchTask(values.taskId, {
      ownerIds: values.ownerIds,
      startDate: values.startDate,
      dueDate: values.dueDate,
      days: values.days,
      headcount: values.headcount,
      priority: values.priority,
      deliverableTypes: values.deliverableTypes,
      note: values.note,
    }, values.version);
  };

  /**
   * 任务描述改名（Push 196：临时任务）：抽屉里失焦即存 —— 中文名必填、英文名可清空；
   * 节点 / 模板生成的任务服务端 400 兜底（抽屉内也不会给改）。
   */
  const handleRenameTask = (taskId: string, title: string, titleEn: string) => {
    handlePatchTask(taskId, { title, titleEn });
  };

  /** 表格行内改「项目经理」：项目级字段（多位，Push 136），回写项目卡片。 */
  const handleBoardManagerChange = (nextManagerIds: string[]) => {
    if (project === null || sameIds(nextManagerIds, project.managerIds)) {
      return;
    }
    onChangeManagers?.(project.id, nextManagerIds);
  };

  /** 任务表行内删除第一下（Push 141 / A25；Push 264 追订加二次确认 · 业务口径「任务行内删除无二次确认」）：只挂起这一行，第二下在顶部确认 Toast 上。
   *  已定档任务的删除服务端一律 409（assertTaskMutable 覆盖 remove）—— 照定档行「点击即弹提示」的口径，不进入确认条。 */
  const requestDeleteTask = (taskId: string) => {
    const row = rowOf(taskId);
    if (row === undefined) {
      return;
    }
    if (row.finalizedAt !== null) {
      setToolError(taskWriteMessage(locale, { code: "TASK_FINALIZED", message: "" }));
      return;
    }
    setPendingDeleteTaskId(taskId);
  };
  /** 顶部确认 Toast 的第二下：软删走接口（有变更引用时 409 TASK_HAS_REFERENCES），成功后本地摘掉这一行。 */
  const confirmDeleteTask = () => {
    const taskId = pendingDeleteTaskId;
    const row = taskId === null ? undefined : rowOf(taskId);
    setPendingDeleteTaskId(null);
    if (projectId === null || taskId === null || row === undefined) {
      return;
    }
    void (async () => {
      try {
        await deleteTask(projectId, taskId, row.version);
        setRawTasks((current) => current.filter((task) => task.id !== taskId));
        await afterWrite();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /**
   * 看板拖动排序（A19 / A20 · Push 105）：把这张任务插到锚点任务前 / 后 —— 换算成**组内位次**（sortIndex）写回服务端。
   * 位次按「同一项目 + 同一阶段」一组定义（看板列 = 展示顺序的子序列）：锚点与这张任务不在同一阶段时不写顺序
   * （跨阶段拖动由服务端读序还原到自己的阶段段里）。
   */
  const handleReorderTask = (taskId: string, beforeTaskId: string | null, afterTaskId: string | null) => {
    const task = rowOf(taskId);
    const anchorId = beforeTaskId ?? afterTaskId;
    if (projectId === null || task === undefined || anchorId === null) {
      return;
    }
    const anchor = rowOf(anchorId);
    if (anchor === undefined || anchor.stageKey !== task.stageKey) {
      return;
    }
    const group = tasks.filter((item) => item.stageKey === task.stageKey);
    const current = group.findIndex((item) => item.id === taskId);
    const at = group.filter((item) => item.id !== taskId).findIndex((item) => item.id === anchorId);
    if (at < 0) {
      return;
    }
    const target = beforeTaskId === null ? at + 1 : at;
    if (target === current) {
      return;
    }
    void (async () => {
      try {
        await updateTask(projectId, taskId, { sortIndex: target, version: task.version });
        reloadAll();
      } catch (error) {
        reportWriteError(error);
      }
    })();
  };

  /**
   * 位置浮层（Push 111-113）的落点 → 组内位次（A20）：锚点任务在它那一组里的下标，before = 原位、after = 后一位；
   * 组尾（`last`）/ 找不到锚点 = 不给 sortIndex（服务端追加到组尾）。
   */
  const sortIndexFor = (placement: StagePlacement): number | undefined => {
    if (placement.kind === "last") {
      return undefined;
    }
    const anchor = rowOf(placement.taskId);
    if (anchor === undefined) {
      return undefined;
    }
    const at = tasks.filter((task) => task.stageKey === anchor.stageKey).findIndex((task) => task.id === anchor.id);
    if (at < 0) {
      return undefined;
    }
    return placement.kind === "before" ? at : at + 1;
  };

  /**
   * 建一条任务（临时任务 / 模板节点）：POST 只回契约 Task（不带负责人姓名与文件摘要）、且服务端要重排组内位次 ——
   * 所以成功一律整表重取；预设节点自带的列状态（看板「进展」列上下文）在创建后补一次状态写入（创建体没有 status 字段）。
   */
  const createOne = async (body: TaskCreateInput, status: TaskStatus): Promise<ApiTask | null> => {
    if (projectId === null) {
      return null;
    }
    try {
      const created = await createTask(projectId, body);
      if (status !== "待开始") {
        await updateTask(projectId, created.id, { status: statusWriteValue(status), version: created.version });
      }
      return created;
    } catch (error) {
      reportWriteError(error);
      return null;
    }
  };

  /** 建完的收尾：整表重取（拿新行的姓名 / 文件摘要与重排后的位次）+ 刷新项目时间。 */
  const afterCreate = () => {
    reloadAll();
    if (projectId !== null) {
      onTaskEdited?.(projectId);
    }
  };

  /**
   * 看板「添加 → 临时任务」（Push 86）：标题由用户自己填，挂到该列（负责人 / 状态按列给，阶段留空 = 垫底「临时任务」组）。
   * 返回新任务 id（Push 196）—— 看板拿到后直接打开它的详情抽屉（确认时间等细节）；失败 = null。
   */
  const handleQuickAdd = async (context: KanbanAddContext, values: { title: string; titleEn: string }): Promise<string | null> => {
    const created = await createOne(
      { stageKey: null, title: values.title, titleEn: values.titleEn === "" ? null : values.titleEn, ownerIds: context.ownerIds, priority: "中" },
      context.status,
    );
    if (created === null) {
      return null;
    }
    afterCreate();
    return created.id;
  };

  /**
   * 「＋ 添加 / 整套添加」（项目总览的添加卡片与看板「添加 → 阶段任务」，Push 113）：按阶段建任务，
   * 位置浮层的锚点换算成组内位次；一次多条按传入顺序依次落位（第 k 条的位次 = 锚点位次 + k，整体不颠倒）。
   * M3-07 刀 3 起都带**来源节点库节点**（`sourceNodeId`）：判重由服务端按（项目 × 节点）精确裁决；
   * 来自某块模板的「整套添加」改走模板实例化接口（`POST …/tasks/from-template`，整批同事务 + skipped 清单）。
   */
  const handleAddNodes = (stage: string, nodes: readonly TemplatePresetNode[], placement: StagePlacement, templateId?: string) => {
    const stageKey = stageKeyOfName(stage);
    const base = sortIndexFor(placement);
    void (async () => {
      if (templateId !== undefined && projectId !== null && nodes.length > 0) {
        try {
          const result = await createTasksFromTemplate(projectId, {
            templateId,
            nodeIds: nodes.map((node) => node.id),
            skipExisting: true,
            priority: "中",
            ...(base === undefined ? {} : { sortIndex: base }),
          });
          if (result.skipped.length > 0) {
            setToolError(t("pd.nodes.skipped", { n: result.skipped.length }));
          }
          if (result.created.length > 0) {
            afterCreate();
          } else {
            reloadAll();
          }
          return;
        } catch (error) {
          reportWriteError(error);
          return;
        }
      }
      let created = false;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const body: TaskCreateInput = { stageKey, title: node.title, titleEn: node.titleEn === "" ? null : node.titleEn, sourceNodeId: node.id, priority: "中" };
        if (base !== undefined) {
          body.sortIndex = base + index;
        }
        created = (await createOne(body, "待开始")) !== null || created;
      }
      if (created) {
        afterCreate();
      }
    })();
  };

  /** 添加卡片「任务节点」标签里点一条（Push 61）：直接追加到该阶段末尾（不弹位置浮层）。 */
  const handleAddNode = (stage: string, node: TemplatePresetNode) => {
    handleAddNodes(stage, [node], { kind: "last" });
  };

  /** 看板「添加 → 阶段任务」：节点自带阶段，并带上所在列的负责人 / 状态（与「临时任务」同一套列上下文）。 */
  const handleKanbanAddNode = (context: KanbanAddContext, stage: string, nodes: readonly TemplatePresetNode[], placement: StagePlacement, templateId?: string) => {
    const stageKey = stageKeyOfName(stage);
    const base = sortIndexFor(placement);
    void (async () => {
      // 来自某块模板的「整套添加」（M3-07 刀 3）：走模板实例化接口一次落库，再按所在列补一次状态写入（创建体没有 status）
      if (templateId !== undefined && projectId !== null && nodes.length > 0) {
        try {
          const result = await createTasksFromTemplate(projectId, {
            templateId,
            nodeIds: nodes.map((node) => node.id),
            skipExisting: true,
            ownerIds: context.ownerIds,
            priority: "中",
            ...(base === undefined ? {} : { sortIndex: base }),
          });
          if (context.status !== "待开始") {
            for (const task of result.created) {
              await updateTask(projectId, task.id, { status: statusWriteValue(context.status), version: task.version });
            }
          }
          if (result.skipped.length > 0) {
            setToolError(t("pd.nodes.skipped", { n: result.skipped.length }));
          }
          if (result.created.length > 0) {
            afterCreate();
          } else {
            reloadAll();
          }
          return;
        } catch (error) {
          reportWriteError(error);
          return;
        }
      }
      let created = false;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const body: TaskCreateInput = { stageKey, title: node.title, titleEn: node.titleEn === "" ? null : node.titleEn, sourceNodeId: node.id, ownerIds: context.ownerIds, priority: "中" };
        if (base !== undefined) {
          body.sortIndex = base + index;
        }
        created = (await createOne(body, context.status)) !== null || created;
      }
      if (created) {
        afterCreate();
      }
    })();
  };

  /** 项目经理：项目级字段，姓名随项目下发（契约 managerNames），多位按「、」连接；任务表「项目经理」列与任务详情都用它。 */
  const managers = project === null ? "" : projectManagerText(project);

  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [tableOverflow, setTableOverflow] = useState(false);

  const [visibleColumns, setVisibleColumns] = useState<VisibleColumns>(() => ({ ...DEFAULT_VISIBLE_COLUMNS }));
  // 列显隐偏好异步到达：只在首次拿到时套用（之后以用户自己的勾选为准，不被回写覆盖）；保存失败的提示条见 toolError
  const appliedColumnPrefsRef = useRef(false);
  /** 标签栏右侧工具区（列显隐）的保存失败文案；null = 无提示。 */
  const [toolError, setToolError] = useState<string | null>(null);
  useEffect(() => {
    if (appliedColumnPrefsRef.current || taskHiddenColumns === null || taskHiddenColumns === undefined) {
      return;
    }
    appliedColumnPrefsRef.current = true;
    setVisibleColumns(visibleColumnsFromHidden(taskHiddenColumns));
  }, [taskHiddenColumns]);
  /**
   * 背景档位（Push 289 追订「选择适中模式 进入某个项目内部 项目总览的颜色应该也要变」→ 定稿「用 c」；
   * Push 290 起「醒目模式」下架，档位 = 项目总览 / 问题追踪观感的唯一开关；Push 293 起含「炫彩」档）：
   * 项目总览任务行整行铺**任务状态色**，深浅随档（适中 = 状态色 × 0.15 兑白便签同款、悬停 × 0.32；
   * 炫彩 = 同色相高饱和 × 0.62 兑白、悬停 × 0.82 —— 见 TaskBoard 的 STATUS_ROW_TINT / STATUS_ROW_TINT_VIVID）——
   * 行色仍然承载状态（业务口径「颜色本身不要换 不然我怎么区分状态啊」），状态列收口成深色字。
   */
  const backgroundTier = useBackgroundTier();
  const tintRows: TintedTier | false = backgroundTier === "simple" ? false : backgroundTier;
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>({});
  /**
   * 阶段骨架常显（Push 61 调整）：没有任务的阶段也保留分组头（只有阶段名、组内没有任务行），
   * 所以点「添加任务」加出任务后，其余阶段的分组头不会消失。
   */
  const visibleStageNames = BOARD_STAGES;
  const allCollapsed = visibleStageNames.length > 0 && visibleStageNames.every((stage) => collapsedStages[stage] === true);
  const toggleAllStages = () => {
    if (allCollapsed) {
      setCollapsedStages({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const stage of visibleStageNames) {
      next[stage] = true;
    }
    setCollapsedStages(next);
  };
  const toggleStage = (stage: string) => {
    setCollapsedStages((previous) => ({ ...previous, [stage]: previous[stage] !== true }));
  };

  // 列显隐改动 = 立即生效 + 整体替换 PATCH（父层乐观更新 + 失败回滚）；返回文案时在标签栏下方出提示条。
  // 失败时表格保持本次改动（提示条说明「没保存到账号」），下一次改动会带上当前状态整体重存 —— 自愈，不会半套状态。
  const persistColumns = async (next: VisibleColumns): Promise<void> => {
    setToolError((await onTaskHiddenColumnsChange?.(hiddenColumnsOf(next))) ?? null);
  };
  const handleToggleColumn = (key: ColumnKey, checked: boolean) => {
    const next = { ...visibleColumns, [key]: checked };
    setVisibleColumns(next);
    void persistColumns(next);
  };

  const resetColumns = () => {
    const next = { ...DEFAULT_VISIBLE_COLUMNS };
    setVisibleColumns(next);
    void persistColumns(next);
  };

  // 导出等待期（导出前先补「项目进展描述」列英译，§6.16 ⑯）：按钮转「生成中…」并防重复点击。
  const [exportingOverview, setExportingOverview] = useState(false);
  /** 译文进度（§6.16 ⑳ 导出等待浮层）：done / total；null = 翻译尚未开始（数据准备中，浮层走扫描态）。 */
  const [exportTranslateProgress, setExportTranslateProgress] = useState<ExportTranslateProgress | null>(null);
  /** 导出等待浮层可见性（§6.16 ㉑ 防闪烁）：译文全命中缓存时导出近乎瞬时，浮层迟 250ms 才出现。 */
  const [exportOverlayVisible, setExportOverlayVisible] = useState(false);

  /**
   * 导出项目总览（PDF · 业务口径 2026-10-09 · §6.16）：把页面当前的 project / tasks / summary 交给报告模块
   * （exportOverviewPdf.ts）拼 A4 横版报告，唤起系统打印窗口由用户选「另存为 PDF」；
   * 2026-10-10 起导出前经翻译通道补「项目进展描述」列英文小字（translateApi.ts；通道不通静默降级）；导出不改数据。
   * 2026-10-13 起译文已在「写进展描述」时后台预热（§6.16 ㉑）—— 命中缓存即取，只有未预热条目才现场翻。
   */
  const exportOverview = async (primary: OverviewExportLanguage): Promise<void> => {
    if (project === null || exportingOverview) {
      return;
    }
    setExportingOverview(true);
    setExportTranslateProgress(null);
    // 译文全命中缓存时导出近乎瞬时（§6.16 ㉑）：浮层迟 250ms 出现，避免「没有等待」的导出闪一层小车动画
    const overlayTimer = window.setTimeout(() => {
      setExportOverlayVisible(true);
    }, 250);
    try {
      await exportProjectOverviewPdf({ project, tasks, summary }, primary, (done, total) => {
        setExportTranslateProgress({ done, total });
      });
    } finally {
      window.clearTimeout(overlayTimer);
      setExportingOverview(false);
      setExportTranslateProgress(null);
      setExportOverlayVisible(false);
    }
  };

  if (project === null) {
    return (
      <div className="min-h-screen">
        <AppHeader me={me} />
        <main className="w-full px-6 py-10">
          <p className="text-sm text-zinc-500">{t("project.notFound")}</p>
          <a href="#/projects" className="mt-4 inline-block text-sm font-medium text-zinc-700 underline underline-offset-4">
            {t("project.back")}
          </a>
        </main>
      </div>
    );
  }

  /** 顶部确认 Toast 上的那一行（从最新任务列表里取标题 / 版本；任务已被别处删除时自动为 undefined = 不显示确认）。 */
  const pendingDeleteTask = pendingDeleteTaskId === null ? undefined : rowOf(pendingDeleteTaskId);

  return (
    <div className="min-h-screen">
      <AppHeader me={me} project={project} />
      <main className="w-full px-6 pb-10 pt-3">
        {/* 主标签栏吸顶（Push 201 业务口径「这个也做吸顶效果吧」）：滚动时停在应用顶栏（h-16 = 64px）正下方，
            站灰底 + 毛玻璃兜住滚动内容；-mx-6 / -mt-3 + 同值内衬抵消：横幅铺满行宽、标签位置与原来一致。
            自身高 59px（pt-3 12 + 标签 46 + 底边 1）—— 页面里的其它吸顶元素一律叠在它下面（top = 64 + 59 = 123px）：
            项目总览的任务表头、日报及问题的页内导航栏。 */}
        <div ref={maintabsRef} data-maintabs="true" className="sticky top-16 z-20 -mx-6 -mt-3 border-b border-zinc-200 bg-[#f5f6f8]/95 px-6 pt-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" onScroll={submenuOpen ? closeSubmenu : undefined}>
              {VIEW_TABS.map((tab) => {
                const active = tab === activeView;
                // 子菜单父项（业务口径 2026-09-30「日报及问题页面的导航栏按钮集成到页面导航栏 如图一的效果」）：
                // 四块子视图收进这枚标签的下拉面板；悬停即展开；点击时已在该视图 = 切换展开态，否则照旧先切视图。
                const withSubmenu = tab === "日报及问题";
                return (
                  <button
                    key={tab}
                    ref={withSubmenu ? dailyTabRef : undefined}
                    type="button"
                    data-maintabs-item={tab}
                    data-maintabs-parent={withSubmenu ? "true" : undefined}
                    onMouseEnter={withSubmenu ? openSubmenu : undefined}
                    onMouseLeave={withSubmenu ? scheduleSubmenuClose : undefined}
                    onClick={() => {
                      if (!withSubmenu) {
                        closeSubmenu();
                        replaceProjectView(project.id, VIEW_KEYS[tab]);
                        return;
                      }
                      // 悬停已经展开时点击**保持展开**（不切换成收起：鼠标先到必然先 hover，切换会让「点开」永远点不开）
                      openSubmenu();
                      if (!active) {
                        replaceProjectView(project.id, VIEW_KEYS[tab]);
                      }
                    }}
                    aria-current={active ? "page" : undefined}
                    aria-haspopup={withSubmenu ? "menu" : undefined}
                    aria-expanded={withSubmenu ? submenuOpen : undefined}
                    className={
                      "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition " +
                      (active
                        ? "border-zinc-900 text-zinc-900"
                        : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800")
                    }
                  >
                    {viewTabText(locale, tab)}
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
            {/* 标签栏右侧工具区（Push 290 起「醒目模式」已下架、观感统一走顶栏背景档位）：只剩「导出 PDF」+ 列显隐，
                两枚都按原口径只在「项目总览」出现 —— 原「日报及问题」视图最右侧那枚醒目模式开关随功能一并删除。 */}
            {activeView === "项目总览" ? (
              <div className="flex shrink-0 items-center gap-4">
                {/* 导出 PDF（业务口径 2026-10-09 · §6.16）：数据 = 页面已取到的 project / tasks / summary，
                    生成 A4 横版报告后在系统打印窗口里另存为 PDF；
                    任务数据加载中 / 加载失败时置灰 —— 导出的报告必须和页面数据一致，宁可不给点。 */}
                <ExportOverviewButton disabled={dataLoading || dataError !== null} busy={exportingOverview} onExport={(primary) => { void exportOverview(primary); }} />
                <ColumnPicker visible={visibleColumns} onToggle={handleToggleColumn} onReset={resetColumns} />
              </div>
            ) : null}
          </div>

          {/* 「日报及问题」子菜单面板（图一：白色圆角面板 + 分组标题 + 子项）—— 左缘对齐父标签（展开时量一次），
              面板自己在鼠标进出时续命 / 延迟收起，避免指针过道断开；选完 = 收起面板 + 写回地址 ?view=daily&sub=。 */}
          {submenuOpen ? (
            <div
              data-daily-submenu-anchor="true"
              className="absolute top-full z-30 mt-2"
              style={{ left: submenuLeft }}
              onMouseEnter={cancelSubmenuClose}
              onMouseLeave={scheduleSubmenuClose}
            >
              <DailySubMenu
                active={dailySub}
                onSelect={(next) => {
                  closeSubmenu();
                  if (activeView !== "日报及问题") {
                    replaceProjectView(project.id, "daily");
                  }
                  replaceProjectSubView(project.id, next);
                }}
              />
            </div>
          ) : null}
        </div>

        {toolError === null ? null : (
          <Toast
            kind="error"
            text={toolError}
            onClose={() => {
              setToolError(null);
            }}
          />
        )}

        {dataError === null ? null : (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
            <span>{t("project.dataErrorPre")}{dataError}</span>
            <button
              type="button"
              onClick={reloadAll}
              className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs font-medium transition hover:bg-rose-100"
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {dataLoading && rawTasks.length === 0 && dataError === null ? (
          <p className="mt-4 text-sm text-zinc-400">{t("project.loadingTasks")}</p>
        ) : null}

        <div className="mt-6 space-y-4">
          {activeView === "项目总览" ? (
            <>
              {/* 汇总卡（M3-07 刀 1 后半）：最慢 / 最新阶段由服务端按任务聚合（GET /projects/{id}/summary） */}
              <ProjectSummary summary={summary} />
              <TaskBoard tasks={tasks} members={members} skeletonStages={BOARD_STAGES} onSetProgress={handleSetProgress} onSetStatus={handleSetStatus} onSetActualEnd={handleSetActualEnd} visibleColumns={visibleColumns} scrollRef={tableScrollRef} collapsed={collapsedStages} onToggleStage={toggleStage} onToggleAllStages={toggleAllStages} onAddNode={handleAddNode} onAddNodes={handleAddNodes} onCreateTempTask={(values) => handleQuickAdd({ ownerIds: [], status: "待开始" }, values)} viewStage="项目总览" managers={managers} managerIds={project.managerIds} onSubmitTaskEdit={handleSubmitTaskEdit} onRenameTask={handleRenameTask} onPatchTask={handlePatchTask} onChangeManagers={handleBoardManagerChange} onDeleteTask={requestDeleteTask} onUploadFiles={handleUploadTaskFiles} onDeleteFile={handleDeleteTaskFile} onRenameFile={handleRenameTaskFile} onFinalize={handleFinalizeTask} onUnfinalize={handleUnfinalizeTask} onChanged={reloadAll} actorName={me.user.displayName ?? ""} filesByTask={taskFiles} projectId={project.id} tierTint={tintRows} />
            </>
          ) : activeView === "甘特图" ? (
            // 甘特图（Push 142）：与项目总览同一份任务数据（服务端任务接口）；拖动改期 / 改进度走同一套写入口径
            <GanttChart tasks={tasks} members={members} managers={managers} tierTint={tintRows} onPatchTask={handlePatchTask} onSetProgress={handleSetProgress} />
          ) : activeView === "日报及问题" ? (
            // key = 项目 id：换项目时把日报 / 问题与填写草稿一起复位（原型内存态，见 ReportIssuePanel.tsx）
            // Push 290：背景档位「适中」透传给「问题追踪」做表格呈现（原醒目模式挂点，随功能下架改吃档位）；失败提示沿用同一条 toolError
            <ReportIssuePanel key={project.id} project={project} me={me} members={members} tierTint={tintRows} sub={dailySub} onChangeSub={(next) => { replaceProjectSubView(project.id, next); }} />
          ) : activeView === "干系人" ? (
            // 干系人（Push 221 · A27 前端接线）：表格形态与「项目总览」同一套（表头固定 + CSS grid 行 + 共用底部滑块）
            <StakeholderPanel projectId={project.id} canManage={canManageStakeholders} scrollRef={tableScrollRef} />
          ) : (
            <TaskKanban
              mode={activeView === "人员任务分配" ? "owner" : "status"}
              tasks={tasks}
              managers={managers}
              managerIds={project.managerIds}
              members={members}
              onAddTask={handleQuickAdd}
              onAddStageTask={handleKanbanAddNode}
              onSubmitTaskEdit={handleSubmitTaskEdit}
              onRenameTask={handleRenameTask}
              onPatchTask={handlePatchTask}
              onSetStatus={handleSetStatus}
              onSetActualEnd={handleSetActualEnd}
              onReorderTask={handleReorderTask}
              onSetProgress={handleSetProgress}
              onUploadFiles={handleUploadTaskFiles}
              onDeleteFile={handleDeleteTaskFile}
              onRenameFile={handleRenameTaskFile}
              onFinalize={handleFinalizeTask}
              onUnfinalize={handleUnfinalizeTask}
              onChanged={reloadAll}
              actorName={me.user.displayName ?? ""}
              projectId={project.id}
            />
          )}
        </div>

        {/* 底部滑块（Push 221 起）：项目总览与干系人两个表格共用同一枚 —— 两视图互斥，scrollRef / 溢出态复用；
            滚动容器 id 由 controlsId 按当前视图切换（task-board-scroll / stakeholder-board-scroll）。
            2026-10-10 修「浮动滑块盖住末行 / 遮挡行内按钮点击」（业务反馈）：吸附条不再铺白底分隔、整条
            pointer-events-none —— 吸附在视口底时不再遮字、点击穿透到行内按钮；可交互面只剩滑块本体
            （pointer-events-auto，见 TableScrollbar 组件注释）。 */}
        {activeView === "项目总览" || activeView === "干系人" ? (
        <div
          id="table-scrollbar-bar"
          className={
            "pointer-events-none sticky bottom-0 z-10 flex items-center " +
            (tableOverflow ? "mt-4 py-2.5" : "h-0 overflow-hidden")
          }
        >
          <TableScrollbar scrollRef={tableScrollRef} onOverflowChange={setTableOverflow} controlsId={activeView === "干系人" ? "stakeholder-board-scroll" : "task-board-scroll"} />
        </div>
        ) : null}
      </main>

      {/* 验收交付完成询问（2026-10-22 · 业务口径「当验收交付完成后 弹出一个弹出显示是否需要将项目设为已完成」）：
          参考 react-hot-toast 的底部 toast：白色圆角卡片、无深色遮罩，自底部弹性上浮 + 轻微放大；
          只有本次任务写入让验收阶段首次全部完成时打开，点击卡外 / 暂不 / Esc 先播退出再卸载。 */}
      {acceptanceDonePromptOpen ? (
        <div className="fixed inset-0 z-[80] flex items-end justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-6">
          <div
            className="absolute inset-0 bg-transparent"
            aria-hidden="true"
            onPointerDown={acceptanceDonePending ? undefined : closeAcceptanceDonePrompt}
          />
          <div
            ref={acceptanceDonePromptTrapRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-acceptance-done-title"
            aria-describedby="project-acceptance-done-body"
            aria-busy={acceptanceDonePending}
            data-focus-container=""
            tabIndex={-1}
            data-project-acceptance-done-prompt=""
            className={`ll-toast pointer-events-auto relative w-full max-w-[640px] rounded-[22px] border border-zinc-200/80 bg-white px-4 py-4 text-left shadow-[0_18px_50px_-16px_rgba(15,23,42,0.22),0_4px_12px_-4px_rgba(15,23,42,0.08)] outline-none sm:px-5 ${acceptanceDoneClosing ? "is-closing" : ""}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <div className="min-w-0 flex-1">
                <p id="project-acceptance-done-body" className="text-sm leading-6 text-zinc-600">
                  <span id="project-acceptance-done-title" className="font-semibold text-zinc-900">
                    {t("project.acceptanceDone.title")}
                  </span>
                  <span className="ml-1.5">{t("project.acceptanceDone.body")}</span>
                </p>
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                <button
                  type="button"
                  data-project-acceptance-done-cancel=""
                  disabled={acceptanceDonePending}
                  onClick={closeAcceptanceDonePrompt}
                  className="rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-1.5 text-sm font-medium text-zinc-600 transition hover:border-zinc-300 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("project.acceptanceDone.cancel")}
                </button>
                <button
                  type="button"
                  data-project-acceptance-done-confirm=""
                  disabled={acceptanceDonePending}
                  onClick={confirmAcceptanceDonePrompt}
                  className="rounded-xl bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white shadow-[0_2px_8px_rgba(15,23,42,0.18)] transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {acceptanceDonePending ? t("project.acceptanceDone.pending") : t("project.acceptanceDone.confirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 导出等待浮层（§6.16 ⑳ / ㉑）：真在等（翻译 / 生成超过 250ms）才显示小车动画 + 预计秒数；打印窗口唤起前收起。 */}
      {exportOverlayVisible ? <ExportProgressOverlay progress={exportTranslateProgress} /> : null}

      {/* 任务行内删除的第二下确认（Push 264 追订 · 业务口径「任务行内删除无二次确认」）：与「删除项目 / 模板 / 日报」同款
          顶部常驻确认 Toast —— 第一下只开口，第二下「删除」才真删。 */}
      {pendingDeleteTask === undefined ? null : (
        <ToastConfirm
          text={<>
            {t("project.deleteTaskPre")}<span className="font-semibold">{pendingDeleteTask.title}</span>{t("project.deleteTaskPost")}
          </>}
          ariaLabel={t("project.deleteTaskAria")}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          onCancel={() => { setPendingDeleteTaskId(null); }}
          onConfirm={confirmDeleteTask}
          containerRef={deleteTaskConfirmTrapRef}
          anchor={{ name: "data-task-delete-confirm", value: "" }}
          confirmAnchor={{ name: "data-task-delete", value: "" }}
        />
      )}
    </div>
  );
}
