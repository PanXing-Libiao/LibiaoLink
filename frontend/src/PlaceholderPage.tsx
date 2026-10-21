import { Fragment, useEffect, useRef, useState } from "react";
import { subscribeLiveHints, keepLiveOrder } from "./liveSync";
import { useLiveRefresh } from "./useLiveRefresh";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AppHeader } from "./components/AppHeader";
import { RowDeleteButton } from "./components/RowDeleteButton";
import { Toast } from "./components/Toast";
import { useFocusTrap } from "./components/useFocusTrap";
import { TaskNodeCard } from "./components/TaskNodeCard";
import { PROJECT_STAGES } from "./data/projects";
import { ApiError } from "./api";
import {
  createStageNode,
  createTaskTemplate,
  deleteTaskNode,
  deleteTaskTemplate,
  fetchStageNodes,
  fetchStageTemplates,
  nodeWriteMessage,
  templateWriteMessage,
  updateStageNode,
  updateTaskTemplate,
  type TaskNodeItem,
  type TemplateItem,
} from "./templateApi";
import { replaceTemplateSection, templateSectionFromParam, templateSectionHref, templateSectionSlug, type PlaceholderPage as PlaceholderPageKey } from "./useHashRoute";
import { stageText, useLocale, useLocalizedTranslator, useT } from "./i18n";
import { prefetchZhToEn } from "./translateApi";
import type { MeResponse } from "./types";

/** 任务模板的阶段板块：与项目详情同口径（「项目总览」是汇总视图，不作为板块）。 */
const TEMPLATE_SECTIONS: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");

/** 左列节点池的兜底空数组（取不到该板块那份时用，避免每次渲染都新建一个）。 */
const EMPTY_NODE_LIST: readonly TaskNodeItem[] = [];

type TemplateNode = TaskNodeItem;

/**
 * 右侧一块模板面板 = 一份模板草稿（Push 182 起 = 模板接口的本地副本）：
 * 服务端下发的 `name` / `nodes` / `version` 是基线，「保存」= PATCH 全量回传（改名 + 节点顺序 + version）。
 */
type TemplateDraft = {
  id: string;
  /** 模板名（可直接改；保存时 trim 后落库） */
  name: string;
  /** 这份模板里已选的节点，顺序即模板里的顺序 */
  nodes: TemplateNode[];
  /** 上次「保存 / 加载」时的样子（服务端当前值；用来判断有没有未保存的改动） */
  saved: string;
  /** 乐观锁版本（服务端下发；保存 / 删除原样回传，过期 = 409 VERSION_CONFLICT） */
  version: number;
  /** 服务端基线（最近一次「保存 / 加载」时名字 / 节点 / version 的完整副本）：「放弃改动」一键回退的目标。 */
  baseline: TemplateBaseline;
  /**
   * 逐面板刷新时按服务端回包算出的冲突标注（Push 264 追订）：
   * 「updated」= 这份已在别处被改过（本地 version 落后，直接保存会 409）；「deleted」= 已在别处被删除（保存 / 删除会 404）。
   * 缺省 = 没有冲突；本地改动一直保留到「保存」成功或「放弃改动」。
   */
  conflict?: "updated" | "deleted";
};

/** 服务端基线（「放弃改动」的回退目标）：名字 + 节点（含顺序）+ 当时的乐观锁版本。 */
type TemplateBaseline = { name: string; nodes: TemplateNode[]; version: number };

/** 模板的「样子」快照：名字 + 节点顺序，序列化后直接比字符串。 */
const snapshotOf = (template: Pick<TemplateDraft, "name" | "nodes">): string =>
  JSON.stringify({ name: template.name, nodes: template.nodes.map((node) => node.id) });

/** 这份草稿有没有未保存的改动（名字 / 节点顺序与基线不一致）。 */
const isDirty = (template: TemplateDraft): boolean => template.saved !== snapshotOf(template);

/** 服务端模板 → 面板草稿（saved 记服务端当前的样子，之后任何本地改动都会让按钮变回「保存」）。 */
function toTemplateDraft(template: TemplateItem): TemplateDraft {
  const name = template.name;
  const nodes = template.nodes.slice();
  return {
    id: template.id,
    name,
    nodes,
    saved: snapshotOf({ name, nodes }),
    version: template.version,
    baseline: { name, nodes: nodes.slice(), version: template.version },
  };
}

/**
 * 服务端回包 × 本地草稿的逐面板合并（Push 264 追订）：原来本板块只要有一份脏草稿，整块列表就拒绝被服务端数据替换 ——
 * 别人对同板块其它模板的新建 / 改名 / 删除一概看不到（直到草稿保存或整页重载）。改成只保护脏的那一份：
 * - 没有未保存改动、或本地改动恰好与服务端一致的面板：服务端数据说了算（替换 / 新增 / 消失照常）；
 * - 有未保存改动的面板：名字 / 节点顺序 / 旧 version 原样保留（刚拖好的顺序不会被冲掉，保存时服务端已前进由 409 裁决），
 *   只按服务端回包标注冲突（version 前进了 = updated）；
 * - 服务端已删除、本地还脏的：留在列表里（不静默吃掉用户编辑）标 deleted，出路 = 面板上的「放弃改动」。
 */
function mergeStageTemplates(
  previous: Record<string, TemplateDraft[]>,
  stage: string,
  items: TemplateItem[],
): Record<string, TemplateDraft[]> {
  const local = previous[stage] ?? EMPTY_TEMPLATE_LIST;
  const localById = new Map(local.map((draft) => [draft.id, draft]));
  const merged: TemplateDraft[] = items.map((item) => {
    const draft = localById.get(item.id);
    if (draft === undefined || !isDirty(draft) || snapshotOf(draft) === snapshotOf(item)) {
      return toTemplateDraft(item);
    }
    return { ...draft, conflict: item.version === draft.version ? undefined : "updated" };
  });
  for (const draft of local) {
    if (isDirty(draft) && !items.some((item) => item.id === draft.id)) {
      merged.push({ ...draft, conflict: "deleted" });
    }
  }
  return { ...previous, [stage]: merged };
}

/** 「未保存」状态行的一句话（冲突 / 已从库中删除各一套口径；完整说明在悬停 title 里）。 */
function unsavedHintText(template: TemplateDraft, t: ReturnType<typeof useT>): string {
  if (template.conflict === "updated") {
    return t("tpl.unsaved.conflict");
  }
  if (template.conflict === "deleted") {
    return t("tpl.unsaved.deleted");
  }
  return t("tpl.unsaved.dirty");
}

/** 「未保存」状态行的悬停说明（点「保存」/「放弃改动」的引导）。 */
function unsavedHintTitle(template: TemplateDraft, t: ReturnType<typeof useT>): string {
  if (template.conflict === "updated") {
    return t("tpl.unsaved.conflictTitle");
  }
  if (template.conflict === "deleted") {
    return t("tpl.unsaved.deletedTitle");
  }
  return t("tpl.unsaved.dirtyTitle");
}

/** 空阶段兜底用的空数组（避免每次渲染都新建一个）。 */
const EMPTY_TEMPLATE_LIST: TemplateDraft[] = [];

/** 按住卡片后位移超过这个数才算「拖动」（没过阈值就是点一下，什么都不改）。 */
const DRAG_THRESHOLD = 4;

/** 正在拖的节点（Push 116）：左侧节点池拖过来 = 复制一份；模板面板里的卡片 = 在同面板内调顺序。 */
type DragInfo = { nodeId: string; source: "left" | "right"; fromTemplateId: string | null; width: number };

/** 按下卡片、还没过拖动阈值时的暂存（Push 116）。 */
type PendingDrag = {
  info: Omit<DragInfo, "width">;
  pointerId: number;
  /** 按下时的坐标：用来判「过没过阈值」。 */
  x: number;
  y: number;
  /** 卡片 DOM：真拖起来之后把指针捕获在它身上（鼠标滑出窗口再放开也收得到 pointerup）。 */
  node: HTMLElement;
  dragging: boolean;
};

/** 落点（Push 116）：`templateId` = 哪块模板面板、`index` = 插到面板里第几张卡片前面（0 = 最前、卡片数 = 末尾）。 */
type DropSpot = { templateId: string; index: number };

type PlaceholderPageProps = {
  me: MeResponse;
  page: PlaceholderPageKey;
  /** 任务模板页当前板块（来自 URL 的 `?section=`；缺省 / 不认识的值回落到第一个板块） */
  section: string | null;
  /**
   * 是否持有 blueprint.manage（节点库与任务模板的维护 = 系统管理员，ADR-019 / ADR-020）：
   * 决定左列「＋ 添加节点」/ 节点卡片的编辑删除、右侧「＋ 新建模板」/「保存」/ 删除模板 / 拖拽改模板渲不渲染、可不可用；
   * 服务端逐请求仍是最终裁决（无权 = 403 FORBIDDEN）。
   */
  canManageBlueprint: boolean;
};

/** 占位页：顶层页的按钮先各自落地，页面内容后续迭代；任务模板先出阶段板块标签栏 + 左侧任务节点卡片区。 */
/**
 * 拖动（Push 116，业务口径「这里拖动卡片也要可以滑动鼠标」）：改成**指针拖动** —— 原生 HTML5 拖拽在拖动期间会把 `wheel` 吞掉,
 * 「拖着的同时用滚轮翻列表」就不成立。现在的口径：按住卡片、位移超过 `DRAG_THRESHOLD` 才算拖动，拖起来之后**滚轮直接可用**（指针在页面上 = 滚页面），
 * 拖动中另有一块跟着鼠标走的**半透明拖动卡片**（`data-drag-ghost`，`pointer-events-none`，不挡 `elementFromPoint` 的落点判定），
 * 插入线（`InsertLine`）按「落在哪块面板的第几格」实时跟着走；没过阈值 = 点一下，什么都不改；Esc / 指针取消 = 原地取消。
 * 左侧节点池拖过来 = 复制一份（同面板按节点 id 去重），模板面板里的卡片 = 在同面板内调顺序。
 */

/**
 * 右侧调顺序时的插入位置指示线：绝对定位、且不接收鼠标事件。
 * 一旦让它占位，线一出现就把后面的卡片顶开，鼠标底下的元素跟着换、落点又变，拖动时就会来回频闪。
 */
function InsertLine({ className }: { className: string }) {
  return (
    <div
      className={
        "pointer-events-none absolute left-0 right-0 h-[3px] rounded-full bg-[#feca04] shadow-[0_0_0_3px_rgba(254,202,4,0.18)] " +
        className
      }
    />
  );
}

export default function PlaceholderPage({ me, page, section, canManageBlueprint }: PlaceholderPageProps) {
  const t = useT();
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  /** 当前板块：URL 是唯一来源（点标签栏 = 换地址；`?section=` 取 ASCII slug，兼容旧链接的中文板块名），缺省 / 不认识的值回落到第一个板块。 */
  const activeSection = templateSectionFromParam(section) ?? TEMPLATE_SECTIONS[0] ?? "";

  // 地址里的板块参数不是规范 slug（旧中文值 / 不认识的取值 / 手改）：落回对应板块，并把地址一并纠正成规范 slug，避免「地址与显示不一致」
  useEffect(() => {
    if (page === "templates" && section !== null && section.trim() !== templateSectionSlug(activeSection)) {
      replaceTemplateSection(activeSection);
    }
  }, [page, section, activeSection]);
  /**
   * 右侧的模板面板（Push 182 起 = 模板接口）：**按阶段分开存**，每个阶段一套；
   * 服务端下发即基线，本地改名 / 拖拽 = 未保存改动（「保存」才回写）。
   */
  const [templatesByStage, setTemplatesByStage] = useState<Record<string, TemplateDraft[]>>({});
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  /** 模板取数版本号：首次进入 / 失败重试 / 节点库改动 / 冲突重取后 +1（重取按面板合并：只有脏草稿会保留）。 */
  const [templatesVersion, setTemplatesVersion] = useState(0);
  /** 模板名展示态（Push 301 追订）：未聚焦 = 英文界面出机翻译文；聚焦 = 回原文供编辑（保存回写原文，译文不落库）。 */
  const [nameFocusedId, setNameFocusedId] = useState<string | null>(null);
  /** 当前阶段的模板面板。 */
  const templates = templatesByStage[activeSection] ?? EMPTY_TEMPLATE_LIST;
  /**
   * 正在拖的节点（Push 116）：`source` 区分「左侧节点池 → 复制一份」与「模板面板里 → 同面板调顺序」，
   * `fromTemplateId` 是后者的来源面板、`width` 给跟着鼠标走的那块拖动卡片对齐宽度。
   */
  const [drag, setDrag] = useState<DragInfo | null>(null);
  /** 落点：哪块面板 + 插到第几张卡片前面（0..N）；null = 鼠标不在任何面板上。 */
  const [dropTarget, setDropTarget] = useState<DropSpot | null>(null);
  /** 按下卡片、还没过拖动阈值时的暂存（Push 116）。 */
  const pendingRef = useRef<PendingDrag | null>(null);
  /** 拖动中鼠标的最后位置：鼠标可以不动、只用滚轮，落点得按这个位置重算。 */
  const pointerRef = useRef({ x: 0, y: 0 });
  /** 抓取偏移（按下时鼠标在卡片内的位置 + 卡片宽度）：拖动卡片按这个对齐鼠标。 */
  const grabRef = useRef({ dx: 0, dy: 0, width: 0 });
  /** 跟着鼠标走的拖动卡片（Push 116）：直接用 DOM 改 `transform`，不走 state（每帧都要动）。 */
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /** 最新的落点计算 / 落地实现（每帧回调里读，免得闭包吃到旧值）。 */
  const dropTargetAtRef = useRef<(x: number, y: number) => DropSpot | null>(() => null);
  const commitDropRef = useRef<(info: DragInfo, spot: DropSpot | null) => void>(() => undefined);
  /**
   * 左列「任务节点」= 节点库接口（Push 181：`GET /api/v1/task-nodes?stage=`）。
   * 按板块缓存：切走再切回来不必重取，只有写入（新增 / 删除）后才按版本号重取。
   */
  const [nodesByStage, setNodesByStage] = useState<Record<string, readonly TaskNodeItem[]>>({});
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState<string | null>(null);
  /** 取数版本号：新增 / 删除成功后 +1 重取，保证左列与节点库一致。 */
  const [nodesVersion, setNodesVersion] = useState(0);
  const activeNodes = nodesByStage[activeSection] ?? EMPTY_NODE_LIST;

  useEffect(() => subscribeLiveHints((resources) => {
    if (!resources.includes("templates")) return;
    setNodesByStage((previous) => Object.fromEntries(Object.entries(previous).filter(([stage]) => stage === activeSection)));
    setTemplatesByStage((previous) => Object.fromEntries(Object.entries(previous).map(([stage, drafts]) => [stage, stage === activeSection ? drafts : drafts.filter(isDirty)])));
  }), [activeSection]);

  useLiveRefresh(["templates"], async () => {
    const [nodes, templates] = await Promise.all([fetchStageNodes(activeSection), fetchStageTemplates(activeSection)]);
    return () => {
      setNodesByStage((previous) => ({ ...previous, [activeSection]: keepLiveOrder(previous[activeSection] ?? [], nodes) }));
      setNodesError(null);
      setTemplatesError(null);
      setTemplatesByStage((previous) => {
        const merged = mergeStageTemplates(previous, activeSection, templates);
        return { ...merged, [activeSection]: keepLiveOrder(previous[activeSection] ?? [], merged[activeSection] ?? []) };
      });
    };
  }, activeSection + ":" + String(nodesVersion) + ":" + String(templatesVersion), page === "templates" && !nodesLoading && !templatesLoading);
  /** 左列「任务节点」的搜索词：按中 / 英文名过滤当前板块的节点卡片。 */
  const [nodeQuery, setNodeQuery] = useState("");

  // 切板块时清空搜索词：否则上一个板块的关键词会把新板块的节点全滤掉，看起来像没数据
  useEffect(() => {
    setNodeQuery("");
  }, [activeSection]);

  // 节点库取数（换板块 / 写入后重取）：失败在左列里提示 + 可重试，不静默吞
  useEffect(() => {
    if (page !== "templates") {
      return;
    }
    let alive = true;
    setNodesLoading(true);
    setNodesError(null);
    void (async () => {
      try {
        const items = await fetchStageNodes(activeSection);
        if (alive) {
          setNodesByStage((previous) => ({ ...previous, [activeSection]: items }));
        }
      } catch (error) {
        if (alive) {
          setNodesError(error instanceof Error ? error.message : t("tpl.err.nodesLoad"));
        }
      } finally {
        if (alive) {
          setNodesLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, activeSection, nodesVersion]);
  // 模板取数（换板块 / 重取）：服务端是模板内容的真相 —— 逐面板合并（见 mergeStageTemplates）：
  // 只有**这一份**有未保存改动时才保留本地草稿（避免把刚拖好的顺序冲掉），其余面板照常刷新（别人的新建 / 改名 / 删除都能看到）。
  useEffect(() => {
    if (page !== "templates") {
      return;
    }
    let alive = true;
    setTemplatesLoading(true);
    setTemplatesError(null);
    void (async () => {
      try {
        const items = await fetchStageTemplates(activeSection);
        if (alive) {
          prefetchZhToEn(items.map((item) => item.name));
          setTemplatesByStage((previous) => mergeStageTemplates(previous, activeSection, items));
        }
      } catch (error) {
        if (alive) {
          setTemplatesError(error instanceof Error ? error.message : t("tpl.err.templatesLoad"));
        }
      } finally {
        if (alive) {
          setTemplatesLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [page, activeSection, templatesVersion]);

  const normalizedQuery = nodeQuery.trim().toLowerCase();
  const visibleNodes =
    normalizedQuery === ""
      ? activeNodes
      : activeNodes.filter((node) =>
          (node.title + "\n" + node.titleEn).toLowerCase().includes(normalizedQuery),
        );

  /**
   * 拖拽只传 id，落点时按 id 找回节点内容（相当于复制一份到右侧模板）：
   * 左侧卡片来自节点库（当前板块那一份），右侧卡片来自各模板面板 —— 两处都查一遍。
   */
  const nodeById = (id: string): TemplateNode | null => {
    const fromLibrary = activeNodes.find((node) => node.id === id);
    if (fromLibrary !== undefined) {
      return fromLibrary;
    }
    for (const list of Object.values(templatesByStage)) {
      for (const template of list) {
        const found = template.nodes.find((node) => node.id === id);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return null;
  };

  /** 拖动中的那个节点（Push 116）：用来画跟着鼠标走的拖动卡片。 */
  const dragNode = drag === null ? null : nodeById(drag.nodeId);

  /** 这块面板里是不是已经有正在拖的那个节点（只有从左侧拖过来才可能重复）。 */
  const isDuplicateIn = (template: TemplateDraft): boolean =>
    drag !== null && drag.source === "left" && template.nodes.some((node) => node.id === drag.nodeId);

  /** 只改「当前阶段」的模板面板，其它阶段原样不动。 */
  const updateTemplates = (updater: (list: TemplateDraft[]) => TemplateDraft[]): void => {
    setTemplatesByStage((previous) => ({
      ...previous,
      [activeSection]: updater(previous[activeSection] ?? EMPTY_TEMPLATE_LIST),
    }));
  };

  /** 清掉拖动状态（删面板 / 拖动取消时用）。 */
  const resetDrag = (): void => {
    pendingRef.current = null;
    document.body.style.userSelect = "";
    setDrag(null);
    setDropTarget(null);
  };

  /**
   * 新建模板 = `POST /api/v1/task-templates`（默认名「未命名模板」、空节点，回来再拖节点进去）：
   * 成功 = 新面板插到最前（原来的往右挪）并把焦点 / 全选落到它的名字上；失败 = 底部提示条。
   */
  const startNewTemplate = (): void => {
    if (newTemplateBusy) {
      return;
    }
    setNewTemplateBusy(true);
    setTemplateNotice(null);
    void (async () => {
      try {
        const created = await createTaskTemplate(activeSection, t("tpl.unnamed"), []);
        const draft = toTemplateDraft(created);
        updateTemplates((previous) => [draft, ...previous]);
        // 焦点 / 全选等这块面板渲染出来再落（下面那个 useEffect 里做 —— 不用 setTimeout 抢时机）
        setFocusTemplateId(draft.id);
      } catch (error) {
        setTemplateNotice(t("tpl.err.create", { message: templateErrorMessage(error, t("tpl.err.retryLater")) }));
      } finally {
        setNewTemplateBusy(false);
      }
    })();
  };

  const renameTemplate = (templateId: string, name: string): void => {
    updateTemplates((previous) => previous.map((item) => (item.id === templateId ? { ...item, name } : item)));
  };

  /**
   * 保存这份模板 = `PATCH /api/v1/task-templates/{id}`：**改名 + 节点顺序全量回传**（含增删 / 重排）+ `version` 乐观锁。
   * 成功 = 用服务端回包替换这块面板（version 前进、名字按库里的 trim 结果、节点名取节点库当前值）；
   * 失败 = 顶部 Toast（本地改动不丢）；version 过期（409）/ 模板已被删除（404）额外重取该板块 ——
   * 重取按面板合并：只有脏草稿保留，这块会标上「有冲突 / 库中已删除」，出路 = 面板上的「放弃改动」。
   */
  const saveTemplate = (templateId: string): void => {
    const draft = templates.find((item) => item.id === templateId);
    if (draft === undefined || savingTemplateId !== null) {
      return;
    }
    const name = draft.name.trim() === "" ? t("tpl.unnamed") : draft.name.trim();
    setSavingTemplateId(templateId);
    setTemplateNotice(null);
    void (async () => {
      try {
        const saved = await updateTaskTemplate(draft.id, {
          name,
          nodeIds: draft.nodes.map((node) => node.id),
          version: draft.version,
        });
        const next = toTemplateDraft(saved);
        updateTemplates((previous) => previous.map((item) => (item.id === templateId ? next : item)));
      } catch (error) {
        const conflict = error instanceof ApiError && (error.code === "VERSION_CONFLICT" || error.code === "NOT_FOUND");
        setTemplateNotice(
          t("tpl.err.save", { name: draft.name, message: templateErrorMessage(error, t("tpl.err.retryLater")) }) +
            (conflict ? t("tpl.err.saveKept") : ""),
        );
        if (conflict) {
          setTemplatesVersion((version) => version + 1);
        }
      } finally {
        setSavingTemplateId(null);
      }
    })();
  };

  /** 删除这份模板（红胶囊第一下）：第二下在底部确认条上 —— `DELETE` 带 version，软删，面板随即消失。 */
  const removeTemplate = (templateId: string): void => {
    resetDrag();
    const draft = templates.find((item) => item.id === templateId);
    if (draft !== undefined) {
      setPendingDeleteTemplate(draft);
    }
  };

  /** 确认删除（底部确认条的第二下）：软删成功 = 面板消失；失败 = 顶部 Toast（模板已在别处被删除时重取该板块，脏草稿标「库中已删除」）。 */
  const confirmDeleteTemplate = (): void => {
    const draft = pendingDeleteTemplate;
    if (draft === null) {
      return;
    }
    setPendingDeleteTemplate(null);
    void (async () => {
      try {
        await deleteTaskTemplate(draft.id, draft.version);
        updateTemplates((previous) => previous.filter((item) => item.id !== draft.id));
      } catch (error) {
        const gone = error instanceof ApiError && error.code === "NOT_FOUND";
        const conflict = error instanceof ApiError && error.code === "VERSION_CONFLICT";
        setTemplateNotice(
          t("tpl.err.delete", { name: draft.name, message: templateErrorMessage(error, t("tpl.err.retryLater")) }) +
            (gone ? t("tpl.err.deleteGone") : ""),
        );
        if (gone || conflict) {
          setTemplatesVersion((version) => version + 1);
        }
      }
    })();
  };

  /**
   * 「放弃改动」（Push 264 追订）：这块面板一键回到服务端基线（最近一次「保存 / 加载」的名字 / 节点顺序 / version）。
   * 这份模板已在别处被删除时（「库中已删除」）= 回退后重取会把它从列表带走，等于「把这份草稿从页面移除」。
   * 随后重取当前板块，把 version 与服务端对齐（别人对其它模板的改动也会一起刷新）。
   */
  const discardTemplateChanges = (templateId: string): void => {
    updateTemplates((previous) =>
      previous.map((item) => {
        if (item.id !== templateId) {
          return item;
        }
        const restored: TemplateDraft = {
          ...item,
          name: item.baseline.name,
          nodes: item.baseline.nodes.slice(),
          saved: snapshotOf(item.baseline),
          version: item.baseline.version,
          conflict: undefined,
        };
        return restored;
      }),
    );
    setTemplatesVersion((version) => version + 1);
  };

  /**
   * 节点表单状态（面板内联，不弹窗）：新增与编辑**共用一套表单**（Push 181 后半 —— 业务口径「任务节点编辑也要」）。
   * `mode === "edit"` 时带着被编辑的那一行（含乐观锁 version），保存走 PATCH；`"create"` 走 POST。
   */
  const [nodeForm, setNodeForm] = useState<{ mode: "create" } | { mode: "edit"; node: TaskNodeItem } | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formTitleEn, setFormTitleEn] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  /** 待确认删除的节点（同款红胶囊的第一下：第二下在底部确认条上）+ 写入失败的提示文案。 */
  const [pendingDeleteNode, setPendingDeleteNode] = useState<TaskNodeItem | null>(null);
  const [nodeNotice, setNodeNotice] = useState<string | null>(null);
  /** 模板写入的本地状态：正在新建 / 正在保存哪一块、待确认删除的模板、失败提示。 */
  const [newTemplateBusy, setNewTemplateBusy] = useState(false);
  /** 新建模板后，等这块面板渲染出来再把焦点 / 全选落到它的名字输入框上。 */
  const [focusTemplateId, setFocusTemplateId] = useState<string | null>(null);
  const [savingTemplateId, setSavingTemplateId] = useState<string | null>(null);
  const [pendingDeleteTemplate, setPendingDeleteTemplate] = useState<TemplateDraft | null>(null);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内、Tab 在条内循环、关闭还原到行内删除按钮。 */
  const deleteNodeConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDeleteNode !== null);
  const deleteTemplateConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDeleteTemplate !== null);

  /** 新建模板后的聚焦：状态一置上就等这次渲染提交完，把名字输入框聚焦 + 全选（落完即清）。 */
  useEffect(() => {
    if (focusTemplateId === null) {
      return;
    }
    const input = document.getElementById("template-name-" + focusTemplateId);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
    setFocusTemplateId(null);
  }, [focusTemplateId]);

  /**
   * 打开节点表单后把光标落在中文名输入框（Push 219）：编辑表单是**就地插在被编辑卡片下方**的，
   * 聚焦既能直接开改、也保证它随卡片进入视野（长列表里点靠后的卡片，不用再滚回列头找表单）。
   */
  useEffect(() => {
    if (nodeForm === null) {
      return;
    }
    const input = document.getElementById("node-form-title");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, [nodeForm]);

  /** 写节点库失败的统一文案（ApiError 带业务码；其它异常给兜底话术，不把原始堆栈抛给用户）。 */
  const nodeErrorMessage = (error: unknown, fallback: string): string =>
    error instanceof ApiError ? nodeWriteMessage(error) : fallback;

  /** 写模板失败的统一文案（与节点库同一套：业务码转人话，其它异常给兜底话术）。 */
  const templateErrorMessage = (error: unknown, fallback: string): string =>
    error instanceof ApiError ? templateWriteMessage(error) : fallback;

  /** 打开「新增节点」表单（清空旧输入；已开着就收起）。 */
  const openCreateForm = (): void => {
    setFormError(null);
    if (nodeForm?.mode === "create") {
      setNodeForm(null);
      return;
    }
    setFormTitle("");
    setFormTitleEn("");
    setNodeForm({ mode: "create" });
  };

  /** 打开「编辑节点」表单（预填当前中 / 英文名；再点一次同一个节点 = 收起）。 */
  const openEditForm = (node: TaskNodeItem): void => {
    resetDrag();
    setFormError(null);
    if (nodeForm?.mode === "edit" && nodeForm.node.id === node.id) {
      setNodeForm(null);
      return;
    }
    setFormTitle(node.title);
    setFormTitleEn(node.titleEn);
    setNodeForm({ mode: "edit", node });
  };

  /** 收起表单（取消按钮 / 保存成功后）。 */
  const closeNodeForm = (): void => {
    setNodeForm(null);
    setFormError(null);
  };

  /**
   * 提交节点表单：新增 = POST；编辑 = PATCH（乐观锁 version 原样回传，过期由服务端 409 裁决）。
   * 成功 = 收起表单 + 重取当前板块（卡片上的名字随即更新）；失败 = 表单内就地提示。
   */
  const submitNodeForm = (): void => {
    const form = nodeForm;
    const title = formTitle.trim();
    if (form === null || title === "" || formBusy) {
      return;
    }
    setFormBusy(true);
    setFormError(null);
    void (async () => {
      try {
        if (form.mode === "create") {
          await createStageNode(activeSection, title, formTitleEn.trim());
        } else {
          await updateStageNode(form.node.id, { title, titleEn: formTitleEn.trim(), version: form.node.version });
        }
        setNodeForm(null);
        setFormTitle("");
        setFormTitleEn("");
        setNodesVersion((version) => version + 1);
        // 节点名变了：模板面板里的节点摘要跟着刷新（本地没有未保存改动时才会被覆盖）
        setTemplatesVersion((version) => version + 1);
      } catch (error) {
        setFormError(nodeErrorMessage(error, form.mode === "create" ? t("tpl.err.nodeCreate") : t("tpl.err.nodeSave")));
      } finally {
        setFormBusy(false);
      }
    })();
  };

  /**
   * 节点表单（新增 / 编辑共用一套控件，Push 219）：新增 = 挂在列头「＋ 添加节点」按钮下方；
   * 编辑 = **就地插在被编辑的那张卡片下面** —— 业务口径「任务模板里面点编辑，应该就近就可以修改，不是像当前一样在最上方才行」：
   * 长列表里点靠后的卡片，表单就在这张卡片底下出现，不用再滚回列头找（打开后焦点直接落在中文名输入框）。
   */
  const renderNodeForm = (form: { mode: "create" | "edit" }): ReactNode => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitNodeForm();
      }}
      className={
        (form.mode === "create" ? "mb-3 " : "") + "rounded-xl border border-white/80 bg-white/70 p-3"
      }
    >
      <p className="mb-2 text-xs font-medium text-zinc-700">
        {form.mode === "create" ? t("tpl.node.create") : t("tpl.node.edit")} · {stageText(locale, activeSection)}
      </p>
      <input
        type="text"
        value={formTitle}
        onChange={(event) => { setFormTitle(event.target.value); }}
        placeholder={t("tpl.node.namePlaceholder")}
        id="node-form-title"
        aria-label={t("tpl.node.nameAria")}
        maxLength={200}
        className="mb-2 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-zinc-300"
      />
      <input
        type="text"
        value={formTitleEn}
        onChange={(event) => { setFormTitleEn(event.target.value); }}
        placeholder={t("tpl.node.nameEnPlaceholder")}
        aria-label={t("tpl.node.nameEnAria")}
        maxLength={200}
        className="mb-2 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 outline-none transition placeholder:text-zinc-400 focus:border-zinc-300"
      />
      {formError === null ? null : <p className="mb-2 text-xs text-rose-600">{formError}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={closeNodeForm}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-50"
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={formBusy || formTitle.trim() === ""}
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-white/60 disabled:text-zinc-400"
        >
          {formBusy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </form>
  );

  /** 删除节点（DELETE /api/v1/task-nodes/{id}）：成功 = 重取该板块（卡片消失就是反馈）；失败出提示条。 */
  const confirmDeleteNode = (): void => {
    const node = pendingDeleteNode;
    if (node === null) {
      return;
    }
    setPendingDeleteNode(null);
    void (async () => {
      try {
        await deleteTaskNode(node.id);
        setNodesVersion((version) => version + 1);
        setTemplatesVersion((version) => version + 1);
        // 服务端随外键级联把该节点从各模板移除；本地草稿同步摘掉，避免保存时撞「节点不存在」
        setTemplatesByStage((previous) => {
          const next: Record<string, TemplateDraft[]> = {};
          for (const [stage, list] of Object.entries(previous)) {
            next[stage] = list.map((draft) => ({
              ...draft,
              nodes: draft.nodes.filter((item) => item.id !== node.id),
            }));
          }
          return next;
        });
      } catch (error) {
        setNodeNotice(t("tpl.err.delete", { name: node.title, message: nodeErrorMessage(error, t("tpl.err.retryLater")) }));
      }
    })();
  };

  /**
   * 鼠标底下是「哪块面板的第几格」（Push 116）：`data-template-panel` 认面板、卡片中线认格 ——
   * 落在某张卡片中线以上 = 插到它前面，都在上面 = 插到面板末尾；空面板 = 第 0 格。
   * 用 `elementFromPoint` 而不是看事件目标是谁：拖动卡片与插入线都不接收鼠标事件，结果不受它们影响。
   */
  const dropTargetAt = (x: number, y: number): DropSpot | null => {
    const under = document.elementFromPoint(x, y);
    const panel = under === null ? null : under.closest("[data-template-panel]");
    if (panel === null) {
      return null;
    }
    const templateId = panel.getAttribute("data-template-panel") ?? "";
    if (!templates.some((template) => template.id === templateId)) {
      return null;
    }
    const cards = Array.from(panel.querySelectorAll("article"));
    for (let index = 0; index < cards.length; index++) {
      const rect = cards[index].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        return { templateId, index };
      }
    }
    return { templateId, index: cards.length };
  };

  /**
   * 放开落点（Push 116）：左侧拖过来 = **复制一份**进面板（同一块面板里按节点 id 去重，重复拖入不生效）；
   * 面板里的卡片 = **在同面板内调顺序**（原位置后面的下标要减 1）；拖到别的面板上不处理（与原生拖拽那版口径一致）。
   */
  const commitDrop = (info: DragInfo, spot: DropSpot | null): void => {
    if (spot === null) {
      return;
    }
    const insertAt = spot.index;
    if (info.source === "right") {
      if (info.fromTemplateId !== spot.templateId) {
        return;
      }
      updateTemplates((previous) =>
        previous.map((template) => {
          if (template.id !== spot.templateId) {
            return template;
          }
          const from = template.nodes.findIndex((node) => node.id === info.nodeId);
          const moved = from === -1 ? undefined : template.nodes[from];
          if (moved === undefined) {
            return template;
          }
          const next = template.nodes.slice();
          next.splice(from, 1);
          let target = insertAt;
          if (from < target) {
            target -= 1;
          }
          next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
          return { ...template, nodes: next };
        }),
      );
      return;
    }
    const node = nodeById(info.nodeId);
    if (node === null) {
      return;
    }
    updateTemplates((previous) =>
      previous.map((template) => {
        if (template.id !== spot.templateId || template.nodes.some((item) => item.id === node.id)) {
          return template;
        }
        const next = template.nodes.slice();
        next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, node);
        return { ...template, nodes: next };
      }),
    );
  };

  // 指针 / 每帧回调里读最新实现，免得闭包吃到上一轮的函数
  useEffect(() => {
    dropTargetAtRef.current = dropTargetAt;
    commitDropRef.current = commitDrop;
  });

  /**
   * 指针拖动（Push 116，业务口径「这里拖动卡片也要可以滑动鼠标」）：① 按下卡片、位移超过 `DRAG_THRESHOLD` 才算真拖动；
   * ② 拖动中**滚轮照常可用**（整段拖动没有原生拖拽参与，浏览器不会吞滚轮 —— 指针在页面上就是滚页面）；
   * ③ 放开时落在哪块面板的第几格就交给 `commitDrop`；④ Esc / 指针取消 = 原地取消；没过阈值 = 点一下，什么都不改。
   */
  useEffect(() => {
    /** 收尾（放开 / Esc / 指针取消）：清掉暂存与落点，恢复页面文字选择。 */
    const endDrag = () => {
      pendingRef.current = null;
      document.body.style.userSelect = "";
      setDrag(null);
      setDropTarget(null);
    };
    const handleMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const pending = pendingRef.current;
      if (pending === null || pending.dragging) {
        return;
      }
      if (Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y) < DRAG_THRESHOLD) {
        return;
      }
      pending.dragging = true;
      try {
        // 指针捕获在卡片上：鼠标滑出窗口再放开也收得到 pointerup
        pending.node.setPointerCapture(pending.pointerId);
      } catch {
        // 指针已经不在了（例如刚抬起）：忽略，落点照样按下面的逻辑算
      }
      const rect = pending.node.getBoundingClientRect();
      grabRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, width: rect.width };
      document.body.style.userSelect = "none";
      setDrag({ ...pending.info, width: rect.width });
      setDropTarget(dropTargetAtRef.current(event.clientX, event.clientY));
    };
    const handleUp = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending === null) {
        return;
      }
      const wasDragging = pending.dragging;
      pendingRef.current = null;
      document.body.style.userSelect = "";
      setDrag(null);
      setDropTarget(null);
      if (!wasDragging) {
        return;
      }
      commitDropRef.current({ ...pending.info, width: grabRef.current.width }, dropTargetAtRef.current(event.clientX, event.clientY));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingRef.current !== null) {
        endDrag();
      }
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  /**
   * 拖动中按帧重算落点（Push 116）：鼠标可以不动、页面在滚（滚轮），拖动卡片与插入线得跟着走，
   * 不能停在按下时算出来的那一格。
   */
  useEffect(() => {
    if (drag === null) {
      return;
    }
    let raf = window.requestAnimationFrame(function tick() {
      const ghost = ghostRef.current;
      if (ghost !== null) {
        const grab = grabRef.current;
        ghost.style.transform = "translate(" + String(pointerRef.current.x - grab.dx) + "px," + String(pointerRef.current.y - grab.dy) + "px)";
      }
      const next = dropTargetAtRef.current(pointerRef.current.x, pointerRef.current.y);
      setDropTarget((previous) =>
        previous !== null && next !== null && previous.templateId === next.templateId && previous.index === next.index ? previous : next,
      );
      raf = window.requestAnimationFrame(tick);
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [drag]);

  /** 按下卡片（Push 116）：先只记「可能拖动」，真拖动由上面的指针循环按位移阈值判定。 */
  const beginDrag = (
    info: { nodeId: string; source: "left" | "right"; fromTemplateId: string | null },
    event: ReactPointerEvent<HTMLElement>,
  ): void => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as Element | null;
    // 卡片上的按钮（模板里的「移除」叉号）不参与拖动
    if (target !== null && target.closest("button") !== null) {
      return;
    }
    pendingRef.current = {
      info,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      node: event.currentTarget,
      dragging: false,
    };
    pointerRef.current = { x: event.clientX, y: event.clientY };
  };
  if (page === "templates") {
    return (
      <div className="min-h-screen">
        <AppHeader me={me} />
        <main className="w-full px-6 pb-10 pt-3">
          {/* 板块标签栏吸顶（Push 235 业务口径「任务模版和我的任务都要做吸顶效果」）：与项目详情主标签栏同一套口径 ——
              滚动时停在应用顶栏（h-16 = 64px）正下方，站灰底 + 毛玻璃兜住滚动内容；
              -mx-6 / -mt-3 + 同值内衬抵消：横幅铺满行宽、标签位置与原来一致。自身高 59px（pt-3 12 + 标签 46 + 底边 1）——
              左列「任务节点」的吸顶位随之顺延（top = 64 + 59 − 1 = 122px，多叠 1px 防缝）。 */}
          <div data-template-tabs="true" className="sticky top-16 z-20 -mx-6 -mt-3 flex items-center gap-3 border-b border-zinc-200 bg-[#f5f6f8]/95 px-6 pt-3 backdrop-blur">
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {TEMPLATE_SECTIONS.map((stage) => {
                const active = stage === activeSection;
                return (
                  <button
                    key={stage}
                    type="button"
                    onClick={() => replaceTemplateSection(stage)}
                    title={templateSectionHref(stage)}
                    aria-current={active ? "page" : undefined}
                    className={
                      "whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition " +
                      (active
                        ? "border-zinc-900 text-zinc-900"
                        : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800")
                    }
                  >
                    {stageText(locale, stage)}
                  </button>
                );
              })}
            </div>
            {/*
              新建模板的入口在板块标签栏这一行：点一下 = POST 一份空模板（默认名「未命名模板」），
              新面板插到「任务节点」右侧、原来的模板往右挪。写 = blueprint.manage，无权不渲染（服务端仍是最终裁决）。
            */}
            {canManageBlueprint ? (
              <button
                type="button"
                onClick={startNewTemplate}
                disabled={newTemplateBusy}
                title={t("tpl.new.title")}
                className="shrink-0 rounded-lg border border-white/80 bg-white/70 px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-[0_2px_10px_rgba(15,23,42,0.08)] transition hover:bg-white hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {newTemplateBusy ? t("tpl.new.busy") : t("tpl.new")}
              </button>
            ) : null}
          </div>

          <div className="relative mt-6">
            {/* 毛玻璃底衬：玻璃要有可透的背景才看得出效果，这里垫一层很淡的色雾（纯装饰、不接收鼠标事件）。 */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-x-clip">
              <div className="sticky top-0 h-[70vh]">
                <div className="absolute left-[2%] top-[4%] h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(254,202,4,0.75),rgba(254,202,4,0)_70%)] blur-3xl" />
                <div className="absolute left-[16%] top-[46%] h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(244,114,182,0.45),rgba(244,114,182,0)_70%)] blur-3xl" />
                <div className="absolute left-[30%] top-[20%] h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(48,207,208,0.60),rgba(48,207,208,0)_70%)] blur-3xl" />
                <div className="absolute right-[2%] top-[38%] h-96 w-96 rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.50),rgba(99,102,241,0)_70%)] blur-3xl" />
              </div>
            </div>

            {/* 左列「任务节点」固定不动（宽屏滚动时钉住；Push 235 起叠在吸顶的板块标签栏下面：top = 122px = 顶栏 64 + 标签栏 59 − 1px 防缝），右侧模板面板一行放不下就换到下一行 */}
            <div className="relative z-10 flex flex-col gap-8 lg:flex-row lg:items-start">
              <section className="flex w-full flex-col rounded-2xl border border-white/80 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.62),rgba(255,255,255,0.32))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_8px_32px_rgba(15,23,42,0.14)] backdrop-blur-2xl backdrop-saturate-150 lg:sticky lg:top-[122px] lg:w-[370px] lg:shrink-0 lg:self-start">
                {/* 列头行（Push 181）：左边板块标题、右边计数 + 「＋ 添加节点」——业务口径「在图二任务节点的位置加一个添加节点的按钮」。
                    2026-10-13 英文界面追订（「add 键漂移」= 整行超宽把按钮顶出玻璃面板右缘）：整行允许换行 ——
                    英文状态文案（Hardware Implementation · 24 nodes）比中文长，一行放不下时「计数 + 按钮」整组换到第二行右对齐，
                    按钮锚在面板里不再飘出去；中文文案短，仍是一行、布局不变。 */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                  <span className="shrink-0 font-semibold text-zinc-800">{t("tpl.nodes.title")}</span>
                  <span className="ml-auto flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-xs text-zinc-500">
                      {stageText(locale, activeSection)} ·{" "}
                      {visibleNodes.length === activeNodes.length
                        ? t("tpl.nodes.count", { n: activeNodes.length })
                        : t("tpl.nodes.countFiltered", { shown: visibleNodes.length, total: activeNodes.length })}
                    </span>
                    {canManageBlueprint ? (
                      <button
                        type="button"
                        onClick={openCreateForm}
                        aria-expanded={nodeForm?.mode === "create"}
                        title={t("tpl.nodes.addTitle", { stage: stageText(locale, activeSection) })}
                        className="shrink-0 rounded-md border border-white/70 bg-white/60 px-2 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-white hover:text-zinc-900"
                      >
                        {t("tpl.nodes.add")}
                      </button>
                    ) : null}
                  </span>
                </div>
                {nodeForm !== null && nodeForm.mode === "create" ? renderNodeForm(nodeForm) : null}
                {/* 搜索框：按中 / 英文名过滤左列的节点卡片（切板块时自动清空） */}
                <div className="relative mb-3">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    type="text"
                    value={nodeQuery}
                    onChange={(event) => setNodeQuery(event.target.value)}
                    placeholder={t("tpl.nodes.searchPlaceholder")}
                    aria-label={t("tpl.nodes.searchAria")}
                    className="w-full rounded-lg border border-white/70 bg-white/55 py-1.5 pl-8 pr-8 text-sm text-zinc-700 outline-none transition placeholder:text-zinc-400 hover:bg-white/70 focus:border-zinc-300 focus:bg-white/80"
                  />
                  {nodeQuery !== "" && (
                    <button
                      type="button"
                      onClick={() => setNodeQuery("")}
                      aria-label={t("tpl.nodes.clear")}
                      title={t("tpl.nodes.clear")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 transition hover:bg-white/70 hover:text-zinc-700"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 15 15"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        className="h-3.5 w-3.5"
                      >
                        <path d="M4 4l7 7M11 4l-7 7" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="space-y-3">
                  {nodesLoading && activeNodes.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-white/80 bg-white/35 px-4 py-8 text-center text-xs text-zinc-500">{t("tpl.nodes.loading")}</p>
                  ) : null}
                  {nodesError === null ? null : (
                    <p className="rounded-xl border border-dashed border-rose-200 bg-rose-50/70 px-4 py-6 text-center text-xs text-rose-700">
                      {t("tpl.nodes.loadFailed", { message: nodesError })}
                      <button
                        type="button"
                        onClick={() => { setNodesVersion((version) => version + 1); }}
                        className="ml-2 rounded border border-rose-200 bg-white px-2 py-0.5 text-[11px] text-rose-700 transition hover:bg-rose-50"
                      >
                        {t("common.retry")}
                      </button>
                    </p>
                  )}
                  {visibleNodes.map((item) => (
                    <Fragment key={item.id}>
                      <TaskNodeCard
                        title={item.title}
                        subtitle={item.titleEn}
                        grab={canManageBlueprint}
                        onPointerDown={
                          canManageBlueprint
                            ? (event) => {
                                beginDrag({ nodeId: item.id, source: "left", fromTemplateId: null }, event);
                              }
                            : undefined
                        }
                        onEdit={
                          canManageBlueprint
                            ? () => {
                                openEditForm(item);
                              }
                            : undefined
                        }
                        onDelete={
                          canManageBlueprint
                            ? () => {
                                resetDrag();
                                setPendingDeleteNode(item);
                              }
                            : undefined
                        }
                      />
                      {nodeForm !== null && nodeForm.mode === "edit" && nodeForm.node.id === item.id
                        ? renderNodeForm(nodeForm)
                        : null}
                    </Fragment>
                  ))}
                  {visibleNodes.length === 0 && !nodesLoading && nodesError === null && (
                    <p className="rounded-xl border border-dashed border-white/80 bg-white/35 px-4 py-8 text-center text-xs text-zinc-500">
                      {t("tpl.nodes.empty")}
                    </p>
                  )}
                </div>
              </section>

              {/* 同一行的面板拉成等高，换行后各自成行 */}
              <div className="flex w-full min-w-0 flex-1 flex-wrap gap-8">
                {templates.map((template) => {
                  const hovered = dropTarget !== null && dropTarget.templateId === template.id;
                  const duplicate = hovered && isDuplicateIn(template);
                  const nodeCount = template.nodes.length;
                  const savedOk = !isDirty(template);
                  return (
                    <section
                      key={template.id}
                      data-template-panel={template.id}
                      aria-label={t("tpl.panel.aria", { name: localize(template.name) })}
                      className={
                        "group/panel flex w-full flex-col rounded-2xl border bg-[linear-gradient(to_bottom,rgba(255,255,255,0.62),rgba(255,255,255,0.32))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_8px_32px_rgba(15,23,42,0.14)] backdrop-blur-2xl backdrop-saturate-150 transition lg:w-[370px] lg:shrink-0 " +
                        (hovered
                          ? duplicate
                            ? "border-amber-400/70 ring-2 ring-amber-300/40"
                            : "border-zinc-900/30 ring-2 ring-zinc-900/10"
                          : "border-white/80")
                      }
                    >
                      <div className="mb-3">
                        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                          <input
                            id={"template-name-" + template.id}
                            type="text"
                            value={nameFocusedId === template.id ? template.name : localize(template.name)}
                            onFocus={() => { setNameFocusedId(template.id); }}
                            onBlur={() => { setNameFocusedId(null); }}
                            onChange={(event) => renameTemplate(template.id, event.target.value)}
                            disabled={!canManageBlueprint}
                            aria-label={t("tpl.name.placeholder")}
                            placeholder={t("tpl.name.placeholder")}
                            title={canManageBlueprint ? t("tpl.name.title") : t("tpl.name.readonlyTitle")}
                            className={
                              "-mx-1 flex-1 truncate rounded px-1 font-semibold text-zinc-800 outline-none transition hover:bg-white/40 focus:bg-white/70 disabled:cursor-not-allowed " +
                              // 2026-10-13 业务口径（英文界面「模板名称省略」）：英文模板名比中文长，名字和「计数 / 保存 / 删除」抢一行 ——
                              // 用最小宽 12rem 当换行阈值：整行放不下时这一组整组换到下一行右对齐，名字（Hardware Implementation）不再被截成 Hardware Implementa…。
                              (locale === "en" ? "min-w-[12rem]" : "min-w-0")
                            }
                          />
                          {/* 「计数 / 保存 / 删除」收成一组：放得下就一行右对齐；英文面板放不下时整组换到第二行（名字优先占满第一行）。 */}
                          <span className="ml-auto flex min-w-0 items-center gap-2">
                            <span aria-label={t("tpl.nodes.selectedAria")} className="shrink-0 text-xs text-zinc-500">
                              {t("tpl.nodes.n", { n: nodeCount })}
                            </span>
                            {canManageBlueprint ? (
                              <button
                                type="button"
                                data-template-save={template.id}
                                onClick={() => saveTemplate(template.id)}
                                disabled={savedOk || savingTemplateId !== null}
                                title={t("tpl.save.title")}
                                className={
                                  "shrink-0 rounded-md px-2 py-0.5 text-xs font-medium transition disabled:cursor-not-allowed " +
                                  (savedOk
                                    ? "border border-white/70 bg-white/50 text-zinc-400"
                                    : "bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-400")
                                }
                              >
                                {savingTemplateId === template.id ? t("common.saving") : savedOk ? t("tpl.save.saved") : t("common.save")}
                              </button>
                            ) : (
                              <span
                                aria-label={t("tpl.save.saved")}
                                title={t("tpl.name.readonlyTitle")}
                                className="shrink-0 rounded-md border border-white/70 bg-white/50 px-2 py-0.5 text-xs font-medium text-zinc-400"
                              >
                                {t("tpl.readonly")}
                              </span>
                            )}
                            {canManageBlueprint ? (
                              <RowDeleteButton
                                onDelete={() => removeTemplate(template.id)}
                                label={t("row.delete.template", { name: localize(template.name) })}
                                scope="panel"
                              />
                            ) : null}
                          </span>
                        </div>
                        {/* 提示行固定高度：出现 / 消失都不顶动下方列表（否则拖拽时会跟着抖）；
                            不拖拽时这一行留给「未保存 / 冲突」状态 + 「放弃改动」出路（Push 264 追订） */}
                        <div className="flex h-4 items-center gap-1.5 text-xs">
                          {duplicate ? (
                            <span className="font-medium text-amber-600">{t("tpl.dup")}</span>
                          ) : canManageBlueprint && !savedOk ? (
                            <>
                              <span
                                data-template-unsaved="true"
                                data-template-conflict={template.conflict ?? "none"}
                                title={unsavedHintTitle(template, t)}
                                className={
                                  "flex min-w-0 items-center gap-1.5 font-medium " +
                                  (template.conflict === undefined ? "text-amber-600" : "text-rose-600")
                                }
                              >
                                <span
                                  aria-hidden="true"
                                  className={
                                    "h-1.5 w-1.5 shrink-0 rounded-full " +
                                    (template.conflict === undefined ? "bg-amber-500" : "bg-rose-500")
                                  }
                                />
                                <span className="truncate">{unsavedHintText(template, t)}</span>
                              </span>
                              <span aria-hidden="true" className={template.conflict === undefined ? "text-amber-600/50" : "text-rose-600/50"}>·</span>
                              <button
                                type="button"
                                data-template-discard={template.id}
                                disabled={savingTemplateId === template.id}
                                onClick={() => { discardTemplateChanges(template.id); }}
                                title={
                                  template.conflict === "deleted"
                                    ? t("tpl.discard.titleDeleted")
                                    : t("tpl.discard.title")
                                }
                                className={
                                  "shrink-0 underline decoration-dotted underline-offset-2 transition hover:decoration-solid disabled:cursor-not-allowed disabled:opacity-50 " +
                                  (template.conflict === undefined ? "text-amber-700 hover:text-amber-900" : "text-rose-700 hover:text-rose-900")
                                }
                              >
                                {t("tpl.discard")}
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div
                        className={
                          "flex flex-1 flex-col rounded-xl border transition " +
                          (hovered
                            ? duplicate
                              ? "border-amber-300/70 bg-white/45"
                              : "border-zinc-400 bg-white/70"
                            : "border-white/60 bg-white/25")
                        }
                      >
                        {nodeCount === 0 ? (
                          <p className="flex min-h-[160px] flex-1 items-center justify-center px-4 text-center text-xs text-zinc-400">
                            {t("tpl.dropHere")}
                          </p>
                        ) : (
                          <div className="space-y-3 p-3">
                            {template.nodes.map((item, index) => (
                              <div key={item.id} className="relative">
                                {dropTarget?.templateId === template.id && dropTarget.index === index ? (
                                  <InsertLine className="-top-[7px]" />
                                ) : null}
                                {index === nodeCount - 1 &&
                                dropTarget?.templateId === template.id &&
                                dropTarget.index === nodeCount ? (
                                  <InsertLine className="-bottom-[7px]" />
                                ) : null}
                                <TaskNodeCard
                                  title={item.title}
                                  subtitle={item.titleEn}
                                  grab={canManageBlueprint}
                                  highlighted={duplicate && item.id === drag?.nodeId}
                                  dimmed={drag?.source === "right" && item.id === drag.nodeId}
                                  onPointerDown={
                                    canManageBlueprint
                                      ? (event) => {
                                          beginDrag({ nodeId: item.id, source: "right", fromTemplateId: template.id }, event);
                                        }
                                      : undefined
                                  }
                                  deleteLabel={t("row.delete.template", { name: item.title })}
                                  onDelete={
                                    canManageBlueprint
                                      ? () =>
                                          updateTemplates((previous) =>
                                            previous.map((entry) =>
                                              entry.id === template.id
                                                ? { ...entry, nodes: entry.nodes.filter((node) => node.id !== item.id) }
                                                : entry,
                                            ),
                                          )
                                      : undefined
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              {templatesLoading && templates.length === 0 ? (
                <p className="flex min-h-[160px] w-full items-center justify-center rounded-2xl border border-dashed border-white/80 bg-white/35 px-6 text-center text-xs text-zinc-500">
                  {t("tpl.templates.loading")}
                </p>
              ) : null}
              {templatesError === null ? null : (
                <p className="flex min-h-[160px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-rose-200 bg-rose-50/70 px-6 text-center text-xs text-rose-700">
                  {t("tpl.templates.loadFailed", { message: templatesError })}
                  <button
                    type="button"
                    onClick={() => { setTemplatesVersion((version) => version + 1); }}
                    className="rounded border border-rose-200 bg-white px-2 py-0.5 text-[11px] text-rose-700 transition hover:bg-rose-50"
                  >
                    {t("common.retry")}
                  </button>
                </p>
              )}
              {templates.length === 0 && !templatesLoading && templatesError === null ? (
                <p className="flex min-h-[160px] w-full items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-white/40 px-6 text-center text-xs text-zinc-500">
                  {t("tpl.templates.empty")}
                </p>
              ) : null}
              </div>
            </div>
          </div>
          {/* 节点库 / 模板删除的第二下确认条（Fixed 底栏，与首页「删除项目」确认条同款 —— 非阻断）；失败提示改上方浮动 Toast（Push 261 追订） */}
          {pendingDeleteNode === null && pendingDeleteTemplate === null ? null : (
            <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
              {pendingDeleteNode === null ? null : (
                <div
                  ref={deleteNodeConfirmTrapRef}
                  role="dialog"
                  aria-label={t("tpl.deleteNode.aria")}
                  className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
                >
                  <span>
                    {t("tpl.deleteNode.lead")}<span className="font-semibold">{pendingDeleteNode.title}</span>{t("tpl.deleteNode.tail", { stage: stageText(locale, activeSection) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setPendingDeleteNode(null); }}
                    className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={confirmDeleteNode}
                    className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
                  >
                    {t("common.delete")}
                  </button>
                </div>
              )}
              {pendingDeleteTemplate === null ? null : (
                <div
                  ref={deleteTemplateConfirmTrapRef}
                  role="dialog"
                  aria-label={t("tpl.deleteTemplate.aria")}
                  className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
                >
                  <span>
                    {t("tpl.deleteTemplate.lead")}<span className="font-semibold">{pendingDeleteTemplate.name}</span>{t("tpl.deleteTemplate.tail", { stage: stageText(locale, activeSection) })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setPendingDeleteTemplate(null); }}
                    className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={confirmDeleteTemplate}
                    className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
                  >
                    {t("common.delete")}
                  </button>
                </div>
              )}
            </div>
          )}
          {nodeNotice === null ? null : (
            <Toast
              kind="error"
              text={nodeNotice}
              onClose={() => { setNodeNotice(null); }}
            />
          )}
          {templateNotice === null ? null : (
            <Toast
              kind="error"
              text={templateNotice}
              onClose={() => { setTemplateNotice(null); }}
            />
          )}
        </main>
        {dragNode === null || drag === null ? null : (
          <div
            ref={ghostRef}
            data-drag-ghost="true"
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-50"
            style={{ width: drag.width }}
          >
            <TaskNodeCard title={dragNode.title} subtitle={dragNode.titleEn} ghost />
          </div>
        )}
      </div>
    );
  }
}
