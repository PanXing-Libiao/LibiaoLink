import { useLiveRefresh } from "../useLiveRefresh";
import { keepLiveOrder } from "../liveSync";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { addedNodeKey } from "../data/tasks";
import type { TemplatePresetNode } from "../data/templatePresets";
import { fetchStageNodes, fetchStageTemplates, type TemplateItem } from "../templateApi";
import { ScrollArea } from "./ScrollArea";
import { usePopover } from "./usePopover";
import { useFocusTrapFor } from "./useFocusTrap";
import { stageText, useLocale, useLocalizedTranslator, useT } from "../i18n";
import { prefetchZhToEn } from "../translateApi";

/**
 * 插入位置（Push 111，业务口径「人员要指定位置放入」）：新加的任务放进该阶段里的哪一格 ——
 * `last` = 该阶段最后（默认）；`before` / `after` = 以某张同阶段任务为锚，插到它前面 / 后面。
 */
export type StagePlacement = { kind: "last" } | { kind: "before"; taskId: string } | { kind: "after"; taskId: string };

/**
 * 插入位置浮层（Push 113，业务口径「我要点击这个添加后选择位置」；Push 114 起「默认顺序添加」取消勾选后才弹）：点某一条「＋ 添加」时贴这条浮出 ——
 * 前两档固定（该阶段最后（默认）/ 该阶段最前），下面按**当前阶段的任务顺序**列出该阶段任务
 * （固定高度、隐式滚动条、可滑动；悬停高亮并浮出「插到它后面」），点一条 = 把这次要加的任务插到它后面。
 */
function PlacementPopover({ anchor, tasks, heading, onPick, onClose }: {
  /** 贴哪一行浮出（点的那一行 / 整套添加按钮）。 */
  anchor: HTMLElement;
  tasks: readonly { id: string; title: string }[];
  /** 浮层标题：这条节点的名字 /「整套添加 N 条」。 */
  heading: string;
  onPick: (next: StagePlacement) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { open, setOpen, position, triggerRef, popoverRef } = usePopover(320, 340);
  useEffect(() => {
    triggerRef.current = anchor as HTMLButtonElement;
    setOpen(true);
  }, [anchor, setOpen, triggerRef]);
  /**
   * 挂载时 `open` 还是 false（下一行 effect 里才置 true）：**真的开过之后**再变 false 才算「关掉」——
   * 否则挂载那一下就会回调 `onClose`，浮层还没显示就被父级清掉了（Push 113 踩过）。
   */
  const openedRef = useRef(false);
  useEffect(() => {
    if (open) {
      openedRef.current = true;
      return;
    }
    if (openedRef.current) {
      onClose();
    }
  }, [open, onClose]);
  /** 键盘焦点陷阱（Push 264 追订）：浮层开着时焦点进浮层、Tab 在浮层内循环、关闭还原到触发按钮。 */
  useFocusTrapFor(popoverRef, open && position !== null);
  const pick = (next: StagePlacement) => {
    onPick(next);
    setOpen(false);
  };
  const fixed: readonly { kind: StagePlacement["kind"]; label: string }[] = [
    { kind: "last", label: t("sac.place.last") },
    { kind: "before", label: t("sac.place.first") },
  ];
  if (!open || position === null) {
    return null;
  }
  return createPortal(
    <div
      ref={popoverRef}
      data-select-popover="true"
      role="dialog"
      aria-label={t("sac.place.aria", { heading })}
      style={{ top: position.top, left: position.left, width: position.width }}
      className="fixed z-50 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.18)]"
    >
      <div className="border-b border-zinc-100 px-2.5 py-2">
        <p className="truncate text-xs font-medium text-zinc-800" title={heading}>{heading}</p>
        <p className="mt-0.5 text-[10px] text-zinc-400">{t("sac.place.hint")}</p>
      </div>

      <div className="p-1">
        {fixed.map((item) => (
          <button
            key={item.kind}
            type="button"
            disabled={item.kind === "before" && tasks.length === 0}
            onClick={() => { pick(item.kind === "before" ? { kind: "before", taskId: tasks[0].id } : { kind: "last" }); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:bg-transparent"
          >
            {item.label}
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <p className="border-t border-zinc-100 px-2.5 py-2 text-[11px] text-zinc-400">{t("sac.place.empty")}</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-2.5 py-1.5">
            <span className="text-[10px] text-zinc-400">{t("sac.place.order")}</span>
            <span className="text-[10px] text-zinc-400">{t("sac.place.afterHint")}</span>
          </div>
          <ScrollArea ariaLabel={t("sac.place.order")} viewportClassName="h-[176px]" className="px-1 pb-1">
            {tasks.map((task, index) => (
              <button
                key={task.id}
                type="button"
                title={t("sac.place.afterTitle")}
                onClick={() => { pick({ kind: "after", taskId: task.id }); }}
                className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-700 transition hover:bg-zinc-100"
              >
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-zinc-400">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="shrink-0 text-[10px] text-zinc-400 opacity-0 transition group-hover:opacity-100">{t("sac.place.after")}</span>
              </button>
            ))}
          </ScrollArea>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * 「默认顺序添加」复选框（Push 114，业务口径「影响正常情况下添加任务了 所以默认是顺序添加 要改的话手动改」）：
 * 勾上（默认）= 点「＋ 添加」直接按顺序加到该阶段末尾；取消勾选 = 点「＋ 添加」后先选插入位置。
 * 视觉照业务给的样例（方框 + 勾线的 SVG：勾上时方框在右上角开一个缺口、勾线画出来；未勾选 = 一个完整的圆角方框，没有多余的点）
 * —— 复用 Tailwind，不引 styled-components。**Push 117**（业务反馈「你做的效果不对啊」）：① 把样例里写死的两个 `stroke-dashoffset` 补上，缺了它们
 * 未勾选会多出一个小圆点、勾上时缺口也不会落在右上角；② 去掉键盘焦点圈（原来 `peer-focus-visible:ring-2 ring-[#feca04]/70`）
 * —— 样例里没有它，而且它盖在 16px 的勾选框上就是一圈很扎眼的黄框（业务截图里的黄框就是它）；键盘用户仍可用 Tab 聚焦、空格切换。
 */
function SequentialToggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  const t = useT();
  return (
    <label
      title={checked ? t("sac.seq.titleOn") : t("sac.seq.titleOff")}
      className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-700"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => { onChange(event.target.checked); }}
        className="peer sr-only"
      />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={"h-4 w-4 shrink-0 transition-colors " + (checked ? "text-zinc-900" : "text-zinc-400")}
      >
        {/*
          两边都要带 `stroke-dashoffset`（Push 117 修的就是这个，样例里也是写死的）：方框的虚线图案整体前移 73 个单位
          （方框周长约 75.4），勾上时 `80 18` 里那 18 个单位的缺口才会正好落在**右上角** —— 也就是勾线尾巴穿出去的位置；
          少了它缺口会被推到路径末尾（等于不画），方框看起来就是闭合的。
          勾线同理：未勾选时 `0 30` 会在路径起点留一个圆点（0 长虚线 + 圆头），`dashoffset 1` 把这个点推到路径起点之前，等于不画。
        */}
        <rect
          x="1.5"
          y="1.5"
          width="21"
          height="21"
          rx="5"
          ry="5"
          strokeWidth="3"
          className={"transition-[stroke-dasharray] duration-100 [stroke-dashoffset:73] " + (checked ? "[stroke-dasharray:80_18]" : "[stroke-dasharray:88_0]")}
        />
        <polyline
          points="7 10 12 16 22 2"
          strokeWidth="4"
          className={"transition-[stroke-dasharray] duration-150 [stroke-dashoffset:1] " + (checked ? "[stroke-dasharray:30_30]" : "[stroke-dasharray:0_30]")}
        />
      </svg>
      <span>{t("sac.seq.label")}</span>
    </label>
  );
}


type StageAddCardProps = {
  stage: string;
  /**
   * 项目里「已添加的节点」判重键（`data/tasks.ts` 的 addedNodeKey = 阶段名 + 换行 + 任务描述）：
   * Push 181 起节点池来自节点库（UUID），判重按「同阶段同名」折算 —— 键与节点标题在卡片内比对。
   */
  addedNodeKeys: ReadonlySet<string>;
  /**
   * 项目里已有任务的**来源节点 id** 集合（契约 sourceNodeId · M3-07 刀 3）：命中 = 这条节点加过（精确判重）。
   * 与 addedNodeKeys（同阶段同名的兜底）一起用 —— 旧行 / 手工同名任务只命中后者。
   */
  addedNodeIds: ReadonlySet<string>;
  /** 点一条节点直接加进项目（没有「插入位置」时走这条 —— 项目总览里点阶段标签加节点）。 */
  onAddNode?: (stage: string, node: TemplatePresetNode) => void;
  /** 加一批 + 指定插入位置（看板那条路径）；templateId = 这批来自哪块模板（有它时上层走模板实例化接口，整套同事务）。 */
  onAddNodes?: (stage: string, nodes: readonly TemplatePresetNode[], placement: StagePlacement, templateId?: string) => void;
  /**
   * Push 207 撤（业务口径 2026-09-28「临时任务不应该存在于阶段里面新建」）：本卡片原常驻的「临时任务
   * （没有模板 · 自己填名称）」入口（Push 197）整体下架 —— 阶段面板只出节点 / 模板两类来源；
   * 临时任务的常驻入口仍留在项目总览底部「临时任务」分组头与看板列底「添加」菜单（都不属于阶段面板）。
   */
  /**
   * 插入位置（Push 113，业务口径「我要点击这个添加后选择位置」）：给了就「**点 ＋ 添加 → 先弹位置浮层 → 选完才加进项目**」。
   * 浮层里前两档固定（该阶段最后（默认）/ 该阶段最前），下面按当前阶段的任务顺序列一遍（点一条 = 插到它后面）；
   * 不传 = 点一条直接加（项目总览那条路径，默认排该阶段最后）。
   */
  placement?: {
    /** 该阶段现有任务（顺序 = 项目总览里这些任务的先后）；空 = 只有「该阶段最后」可点。 */
    tasks: readonly { id: string; title: string }[];
  };
  onClose: () => void;
  /** 卡片落点（由 TaskBoard 量表格算出来：表头正下方、贴表格右边缘）；不传时回落到右上角悬浮。 */
  style?: CSSProperties;
};

/**
 * 任务表里点阶段标签（「售前规划」…「验收」）打开的右侧中等卡片：
 * 顶部是标签导航 —— 第一个「任务节点」（这个阶段的节点池，点一条就加进项目），
 * 其余每个标签 = 这个阶段的一块模板（按预设顺序预览、可鼠标滚动，也能逐条 / 整套加）。
 * 关卡片 = 右上 × / `Esc` / **点卡片外的空白处** / **再点同一个阶段标签**；换阶段标签或换项目时也会自动关掉（由 TaskBoard 控制）。
 */
export function StageAddCard({ stage, addedNodeKeys, addedNodeIds, onAddNode, onAddNodes, placement, onClose, style }: StageAddCardProps) {
  const t = useT();
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  /** Push 207：原「常驻临时任务入口」的展开态（tempOpen）随入口一并下架。 */

  /** 点了「＋ 添加」/「整套添加」之后、还没选位置的那一次（Push 113）：`nodes` = 这次要加的一条 / 一批，`anchor` = 贴哪一行浮出。 */
  const [armed, setArmed] = useState<{ nodes: readonly TemplatePresetNode[]; anchor: HTMLElement; templateId?: string } | null>(null);
  /**
   * 「默认顺序添加」（Push 114，业务口径「影响正常情况下添加任务了 所以默认是顺序添加 要改的话手动改」）：默认勾选 ——
   * 勾上 = 点「＋ 添加」直接按顺序加到该阶段末尾（不动顺序表）；取消勾选 = 点「＋ 添加」才弹位置浮层手动选。每次开卡片都回到默认。
   */
  const [sequential, setSequential] = useState(true);
  /**
   * 「任务节点」标签的节点池（Push 181）：节点库接口（GET /api/v1/task-nodes?stage=…）。
   */
  const [nodes, setNodes] = useState<TemplatePresetNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [nodesRetry, setNodesRetry] = useState(0);
  /**
   * 「模板」标签的模板清单（Push 182）：模板接口（GET /api/v1/task-templates?stage=…）——
   * 写死的预设已由种子 #9 灌进库，这里与任务模板页看的是同一份数据。
   */
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templatesRetry, setTemplatesRetry] = useState(0);
  const [activeTab, setActiveTab] = useState("nodes");
  const cardRef = useRef<HTMLElement | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：面板开着时焦点进面板、Tab 在面板内循环、关闭还原到阶段标签。 */
  useFocusTrapFor(cardRef);

  // 换阶段（点了别的阶段标签）时回到第一个标签（Push 207：原「收起临时任务表单」随入口下架）
  useEffect(() => {
    setActiveTab("nodes");
  }, [stage]);

  useLiveRefresh(["templates"], async () => {
    const [nextNodes, nextTemplates] = await Promise.all([fetchStageNodes(stage), fetchStageTemplates(stage)]);
    return () => {
      setNodes((previous) => keepLiveOrder(previous, nextNodes));
      setTemplates((previous) => keepLiveOrder(previous, nextTemplates));
      // An armed selection stays a snapshot; the write API still validates its nodes/template.
      if (armed !== null && armed.nodes.some((node) => !nextNodes.some((next) => next.id === node.id))) setNodesError(t("sac.err.nodeDeleted"));
    };
  }, stage, !nodesLoading && !templatesLoading, { readOnly: true });

  // 节点库取数（换阶段 / 重试重取）：失败只在卡片里提示（卡片本来就是临时浮层，不占全局提示条）
  useEffect(() => {
    let alive = true;
    setNodesLoading(true);
    setNodesError(null);
    void (async () => {
      try {
        const items = await fetchStageNodes(stage);
        if (alive) {
          setNodes(items);
        }
      } catch (error) {
        if (alive) {
          setNodesError(error instanceof Error ? error.message : t("sac.err.nodesLoad"));
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
  }, [stage, nodesRetry]);

  // 模板取数（换阶段 / 重试重取）：与节点库同样只在卡片里提示失败
  useEffect(() => {
    let alive = true;
    setTemplatesLoading(true);
    setTemplatesError(null);
    void (async () => {
      try {
        const items = await fetchStageTemplates(stage);
        if (alive) {
          prefetchZhToEn(items.map((item) => item.name));
          setTemplates(items);
        }
      } catch (error) {
        if (alive) {
          setTemplatesError(error instanceof Error ? error.message : t("sac.err.templatesLoad"));
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
  }, [stage, templatesRetry]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // 「插入位置」浮层开着时（Push 112）：Esc 先关浮层，再按一次才关卡片
      if (document.querySelector("[data-select-popover]") !== null) {
        return;
      }
      onClose();
    };
    // 点卡片外的空白处也关掉（任务行 / 表头 / 汇总卡 / 页面其它地方都算）；
    // 阶段标签（data-stage-pill）除外 —— 点同一个标签由标签自己的点击逻辑开关（再点即关）
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target !== null && target.closest("[data-stage-pill]") !== null) {
        return;
      }
      // 「插入位置」下拉是挂到 body 的浮层（Push 111）：点它不算点卡片外面，卡片不关
      if (target !== null && target.closest("[data-select-popover]") !== null) {
        return;
      }
      if (cardRef.current !== null && !cardRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  const currentTemplate = templates.find((item) => item.id === activeTab);
  const isNodesTab = currentTemplate === undefined;
  const items = currentTemplate?.nodes ?? nodes;
  /** 这条节点加过没有（M3-07 刀 3）：先看来源 id（精确），再回落「同阶段同名」（本刀之前的旧行 / 手工同名任务）。 */
  const isAdded = (node: TemplatePresetNode): boolean =>
    addedNodeIds.has(node.id) || addedNodeKeys.has(addedNodeKey(stage, node.title));
  const pendingCount = items.filter((node) => !isAdded(node)).length;
  /** 取数中的占位 / 失败提示（按当前标签取节点库或模板的加载状态）。 */
  const listNotice = isNodesTab
    ? nodesLoading
      ? t("sac.load.nodes")
      : nodesError === null
        ? null
        : t("sac.err.nodesLoadPrefix", { message: nodesError })
    : templatesLoading
      ? t("sac.load.templates")
      : templatesError === null
        ? null
        : t("sac.err.templatesLoadPrefix", { message: templatesError });
  /** 失败时「重试」按钮该重取哪一边。 */
  const retryCurrent = (): void => {
    if (isNodesTab) {
      setNodesRetry((count) => count + 1);
      return;
    }
    setTemplatesRetry((count) => count + 1);
  };
  /** 当前标签取数失败了吗（决定出不出重试按钮）。 */
  const listFailed = isNodesTab ? nodesError !== null : templatesError !== null;
  const addedCount = items.length - pendingCount;

  /** 位置选好了（Push 113）：交给上层按这个位置插进项目；没给批量入口时逐条加。templateId = 当前标签是哪块模板（缺省 = 节点池）。 */
  const commitAdd = (picked: readonly TemplatePresetNode[], next: StagePlacement, templateId?: string) => {
    if (picked.some((node) => !nodes.some((current) => current.id === node.id)) || (templateId !== undefined && !templates.some((item) => item.id === templateId))) {
      setNodesError(t("sac.err.changed"));
      return;
    }
    if (onAddNodes !== undefined) {
      onAddNodes(stage, picked, next, templateId);
      return;
    }
    for (const node of picked) {
      onAddNode?.(stage, node);
    }
  };

  /**
   * 点「＋ 添加」/「整套添加」（Push 113 / 114）：勾着「默认顺序添加」时**直接按顺序加**（`last` = 不动顺序表，
   * 按「阶段为主键」的展示顺序落在这个阶段段的末尾）；取消勾选才按老口径弹位置浮层，选完才加进项目。
   */
  const startAdd = (picked: readonly TemplatePresetNode[], anchor: HTMLElement) => {
    if (picked.length === 0) {
      return;
    }
    if (sequential || placement === undefined) {
      commitAdd(picked, { kind: "last" }, currentTemplate?.id);
      return;
    }
    setArmed({ nodes: picked, anchor, templateId: currentTemplate?.id });
  };

  return (
    <aside
      ref={cardRef}
      role="dialog"
      aria-label={t("sac.aria", { stage: stageText(locale, stage) })}
      style={style ?? { top: 112, right: 24 }}
      className="absolute z-40 flex max-h-[72vh] w-[400px] max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-white/80 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.98),rgba(255,255,255,0.94))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_12px_40px_rgba(15,23,42,0.22)] backdrop-blur-2xl backdrop-saturate-150"
    >
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-800">{stageText(locale, stage)}</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {t("sac.summary", { nodes: nodes.length, templates: templates.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sac.closeAria")}
          title={t("sac.closeAria")}
          className="shrink-0 rounded p-0.5 text-zinc-400 transition hover:bg-white/70 hover:text-zinc-700"
        >
          <svg viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5">
            <path d="M4 4l7 7M11 4l-7 7" />
          </svg>
        </button>
      </div>

      {/* 标签导航：任务节点 + 这个阶段的模板（模板多时横向滚动） */}
      <div className="mt-3 flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200/80">
        <button
          type="button"
          onClick={() => setActiveTab("nodes")}
          aria-current={isNodesTab ? "true" : undefined}
          className={
            "whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs font-medium transition " +
            (isNodesTab ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800")
          }
        >
          {t("sac.tab.nodes")}
          <span className="ml-1 text-[10px] text-zinc-400">{nodes.length}</span>
        </button>
        {templates.map((template) => {
          const active = template.id === activeTab;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => setActiveTab(template.id)}
              aria-current={active ? "true" : undefined}
              className={
                "whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs font-medium transition " +
                (active ? "border-zinc-900 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800")
              }
            >
              {localize(template.name)}
              <span className="ml-1 text-[10px] text-zinc-400">{template.nodes.length}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        <span className="text-[11px] text-zinc-500">
          {isNodesTab ? "" : t("sac.previewPrefix")}{t("sac.added", { n: addedCount })}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {isNodesTab ? null : (
            <button
              type="button"
              disabled={pendingCount === 0}
              onClick={(event) => { startAdd(items.filter((node) => !isAdded(node)), event.currentTarget); }}
              title={t("sac.batch.title")}
              className="shrink-0 rounded-md bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-white/60 disabled:text-zinc-400"
            >
              {t("sac.batch", { n: pendingCount })}
            </button>
          )}
          <SequentialToggle checked={sequential} onChange={setSequential} />
        </div>
      </div>

      {/* Push 207 撤：本卡片原「常驻临时任务入口」整块在此，按业务口径「临时任务不应该存在于阶段里面新建」下架。 */}

      {listNotice !== null ? (
        <p className="mt-2 flex min-h-0 flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-200 px-3 text-center text-xs text-zinc-500">
          {listNotice}
          {!listFailed ? null : (
            <button
              type="button"
              onClick={retryCurrent}
              className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 transition hover:bg-zinc-100"
            >
              {t("common.retry")}
            </button>
          )}
        </p>
      ) : (
      <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {items.map((node, index) => {
          const added = isAdded(node);
          return (
            <li key={node.id}>
              <button
                type="button"
                disabled={added}
                onClick={(event) => { startAdd([node], event.currentTarget); }}
                title={added ? t("sac.addedTitle") : t("sac.addTitle", { stage: stageText(locale, stage) })}
                className={
                  "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition " +
                  (added
                    ? "cursor-default border-white/60 bg-white/40"
                    : "border-white/70 bg-white/70 hover:border-zinc-300 hover:bg-white")
                }
              >
                {isNodesTab ? null : (
                  <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-zinc-400">{index + 1}</span>
                )}
                <span className="min-w-0 flex-1">
                  <span className={"block truncate text-xs " + (added ? "text-zinc-400" : "font-medium text-zinc-700")}>{node.title}</span>
                  <span className="block truncate text-[10px] text-zinc-400">{node.titleEn}</span>
                </span>
                <span className={"shrink-0 text-[11px] " + (added ? "text-zinc-400" : "font-medium text-emerald-700")}>
                  {added ? t("sac.addedTag") : t("sac.add")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      )}

      {armed === null ? null : (
        <PlacementPopover
          anchor={armed.anchor}
          tasks={placement?.tasks ?? []}
          heading={armed.nodes.length === 1 ? armed.nodes[0].title : t("sac.batchHeading", { n: armed.nodes.length })}
          onPick={(next) => { commitAdd(armed.nodes, next, armed.templateId); }}
          onClose={() => { setArmed(null); }}
        />
      )}
      <p className="mt-2 shrink-0 text-[10px] leading-4 text-zinc-400">{t("sac.footnote")}</p>
    </aside>
  );
}
