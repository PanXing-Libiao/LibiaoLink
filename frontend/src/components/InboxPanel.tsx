import { useCallback, useEffect, useState } from "react";
import { loadWecomDmBinding } from "../bindingApi";
import { relativeTimeText, useLocale, useT, type TextKey } from "../i18n";
import { applyInboxUnread, getInboxBadge, useInboxBadge } from "../inbox";
import {
  deleteAllInboxNotifications,
  deleteInboxNotification,
  loadInboxPage,
  markAllInboxRead,
  markInboxRead,
  type InboxNotification,
  type InboxNotificationType,
} from "../inboxApi";
import { projectFocusHref, projectViewHref, SETTINGS_BASE_HASH } from "../useHashRoute";
import { Loader } from "./Loader";

/** 弹窗条数：快速一瞥「最近 8 条」；完整消息中心（分类筛选 / 已处理 / 稍后提醒）留给 M5-07 整页。 */
const INBOX_PANEL_LIMIT = 8;

/** 类型签（C5-02 分类）：提醒 / 审批 / 播报 / 系统 —— 文案走 i18n（中英），颜色 = 全站淡彩签同款。 */
const TYPE_LABEL_KEYS: Record<InboxNotificationType, TextKey> = {
  reminder: "inbox.type.reminder",
  approval: "inbox.type.approval",
  broadcast: "inbox.type.broadcast",
  system: "inbox.type.system",
};

const TYPE_CHIP_CLASS: Record<InboxNotificationType, string> = {
  reminder: "border-amber-200 bg-amber-50 text-amber-700",
  approval: "border-violet-200 bg-violet-50 text-violet-700",
  broadcast: "border-sky-200 bg-sky-50 text-sky-700",
  system: "border-zinc-200 bg-zinc-100 text-zinc-600",
};

/**
 * 顶栏「站内信」弹窗内容（Push 352 · 业务口径 2026-10-16「在这个左侧增加站内信按钮 点击后出现局部弹窗
 * 用来消息通知」）：最近 8 条 + 全部已读 + 全部删除；打开即拉取（随行回读未读角标）。
 * SSE notification 事件只推进 ../inbox 的版本号，弹窗开着时据此静默补拉（不清空现值、不整页骨架 ——
 * 与全局静默同步口径一致）；点条 = 置读（乐观 + 失败回滚出 Toast），并按读面 projectId + refType
 * 直达关联内容（项目 / 任务抽屉 / 日报行 / 问题抽屉 / 项目文件视图）。2026-10-23 增单条删除 / 一键删除：先二次确认，成功按服务端 unreadCount
 * 校准红点并补拉；删除只隐藏本人收件箱（C5-03 全量留档保留）。
 */
/** 站内信点击落点：任务开抽屉、日报定位行、问题开抽屉；文件打开项目详情「项目文件」，其它对象落到项目总览。 */
function inboxTargetHref(item: InboxNotification): string | null {
  const projectId = item.projectId ?? (item.refType === "project" ? item.refId : null);
  if (projectId === null) {
    return null;
  }
  if (item.refType === "task" && item.refId !== null) {
    return projectFocusHref(projectId, { kind: "task", id: item.refId });
  }
  if ((item.refType === "report" || item.refType === "daily_report") && item.refId !== null) {
    return projectFocusHref(projectId, { kind: "report", id: item.refId });
  }
  if (item.refType === "issue" && item.refId !== null) {
    return projectFocusHref(projectId, { kind: "issue", id: item.refId });
  }
  if (item.refType === "file") {
    return projectViewHref(projectId, "files");
  }
  return projectViewHref(projectId, "overview");
}

export function InboxPanel({ onError, onNavigate }: { onError: (text: string) => void; onNavigate: () => void }) {
  const t = useT();
  const locale = useLocale();
  const inboxBadge = useInboxBadge();
  const [items, setItems] = useState<InboxNotification[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  /** 未绑定企微（D6 未绑定提示 · Push 250）：未绑定 = 企微单聊推送落站内信降级 —— 弹窗底部提示 + 「前往设置补绑」。 */
  const [wecomUnbound, setWecomUnbound] = useState(false);
  /** 一键删除二次确认：第一次点只进入确认态，第二次才落库（与全站删除先例一致）。 */
  const [clearArmed, setClearArmed] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingId, setMarkingId] = useState<number | null>(null);
  const inboxBusy = deletingId !== null || clearingAll || markingAll || markingId !== null;

  const reload = useCallback(async (): Promise<void> => {
    try {
      const page = await loadInboxPage(INBOX_PANEL_LIMIT);
      setItems(page.items);
      setTotal(page.total);
      setFailed(false);
      applyInboxUnread(page.unreadCount);
    } catch {
      // 401 由 apiRequest 统一跳登录；其余失败 = 首载出重试按钮、已有列表保持现值（静默）
      setFailed(true);
    }
  }, []);

  // 打开（挂载）= 拉一次；SSE notification 事件推进 revision = 开着时静默补拉
  useEffect(() => {
    void reload();
  }, [reload, inboxBadge.revision]);

  // 清空二次确认 4 秒未落第二下自动收起（避免误触后续点击）。
  useEffect(() => {
    if (!clearArmed) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setClearArmed(false);
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [clearArmed]);

  // 企微绑定态：弹窗每次打开（挂载）读一次 —— 未绑定 = 底部出「前往设置补绑」提示（D6）；失败静默（不挡消息列表）
  useEffect(() => {
    let cancelled = false;
    void loadWecomDmBinding()
      .then((state) => {
        if (!cancelled) {
          setWecomUnbound(!state.bound);
        }
      })
      .catch(() => {
        // 读态失败：不出提示（消息列表照常）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const markRead = async (item: InboxNotification): Promise<void> => {
    if (inboxBusy) {
      return;
    }
    setClearArmed(false);
    setMarkingId(item.id);
    const previous = items;
    const previousUnread = getInboxBadge().unreadCount;
    setItems((current) => current === null ? current : current.map((row) => row.id === item.id ? { ...row, status: "read" } : row));
    applyInboxUnread(previousUnread - 1);
    try {
      await markInboxRead(item.id);
    } catch {
      setItems(previous);
      applyInboxUnread(previousUnread);
      onError(t("header.inbox.saveFailed"));
    } finally {
      setMarkingId(null);
    }
  };

  /** 单条删除：软删隐藏；成功后本地移除并按服务端 unreadCount 校准红点，再补拉最近 8 条 / 总数。 */
  const handleDelete = async (item: InboxNotification): Promise<void> => {
    if (inboxBusy) {
      return;
    }
    setClearArmed(false);
    setDeletingId(item.id);
    try {
      const result = await deleteInboxNotification(item.id);
      setItems((current) => current === null ? current : current.filter((row) => row.id !== item.id));
      setTotal((current) => Math.max(0, current - 1));
      applyInboxUnread(result.unreadCount);
      await reload();
    } catch {
      onError(t("header.inbox.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  };

  /** 一键删除全部：第一次点进入确认态；第二下落库。成功先清本地面，再补拉以接住并发到达的新消息。 */
  const handleDeleteAll = async (): Promise<void> => {
    if (items === null || total === 0 || inboxBusy) {
      return;
    }
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setClearingAll(true);
    try {
      const result = await deleteAllInboxNotifications();
      applyInboxUnread(result.unreadCount);
      setItems([]);
      setTotal(0);
      setClearArmed(false);
      await reload();
    } catch {
      onError(t("header.inbox.deleteFailed"));
    } finally {
      setClearingAll(false);
    }
  };

  const handleActivate = (item: InboxNotification): void => {
    const target = inboxTargetHref(item);
    if (target !== null) {
      onNavigate();
      window.location.hash = target.slice(1);
    }
    if (item.status === "unread") {
      void markRead(item);
    }
  };

  const handleMarkAllRead = async (): Promise<void> => {
    if (items === null || !items.some((item) => item.status === "unread") || inboxBusy) {
      return;
    }
    const previous = items;
    const previousUnread = getInboxBadge().unreadCount;
    setMarkingAll(true);
    setItems(items.map((row) => row.status === "unread" ? { ...row, status: "read" } : row));
    applyInboxUnread(0);
    try {
      const result = await markAllInboxRead();
      applyInboxUnread(result.unreadCount);
    } catch {
      setItems(previous);
      applyInboxUnread(previousUnread);
      onError(t("header.inbox.saveFailed"));
    } finally {
      setMarkingAll(false);
    }
  };

  const hasUnreadRow = items !== null && items.some((item) => item.status === "unread");
  const hasItems = items !== null && total > 0;

  return (
    <div data-inbox-content="true">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-900">{t("header.inbox.title")}</span>
        {inboxBadge.unreadCount > 0 ? (
          <span className="rounded-full bg-red-50 px-1.5 py-px text-[11px] font-medium tabular-nums text-red-600">{inboxBadge.unreadCount}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            data-inbox-mark-all="true"
            disabled={!hasUnreadRow || inboxBusy}
            onClick={() => {
              void handleMarkAllRead();
            }}
            className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default disabled:text-zinc-300 disabled:hover:bg-transparent"
          >
            {t("header.inbox.markAllRead")}
          </button>
          <button
            type="button"
            data-inbox-delete-all="true"
            disabled={!hasItems || inboxBusy}
            onClick={() => {
              void handleDeleteAll();
            }}
            className={"rounded-lg px-2 py-1 text-xs font-medium transition disabled:cursor-default disabled:text-zinc-300 disabled:hover:bg-transparent " + (clearArmed ? "bg-red-50 text-red-600 hover:bg-red-100" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900")}
          >
            {clearingAll ? t("header.inbox.deleting") : clearArmed ? t("header.inbox.deleteAllConfirm") : t("header.inbox.deleteAll")}
          </button>
        </div>
      </div>
      {items === null && !failed ? (
        <div className="flex items-center justify-center px-3 py-8">
          <Loader />
        </div>
      ) : null}
      {items === null && failed ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-xs text-zinc-500">
          <span>{t("header.inbox.loadFailed")}</span>
          <button
            type="button"
            data-inbox-retry="true"
            onClick={() => {
              void reload();
            }}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            {t("header.inbox.retry")}
          </button>
        </div>
      ) : null}
      {items !== null && items.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-zinc-400">{t("header.inbox.empty")}</div>
      ) : null}
      {items !== null && items.length > 0 ? (
        <div data-inbox-list="true" className="max-h-[60vh] overflow-y-auto py-1">
          {items.map((item) => (
            <div key={item.id} className="group flex items-start gap-1 rounded-lg px-1 transition hover:bg-zinc-50">
              <button
                type="button"
                data-inbox-item={String(item.id)}
                data-inbox-status={item.status}
                disabled={inboxBusy}
                onClick={() => {
                  handleActivate(item);
                }}
                className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-400/60 disabled:cursor-default"
              >
                <span aria-hidden="true" className={"mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full " + (item.status === "unread" ? "bg-red-500" : "bg-transparent")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={"shrink-0 rounded border px-1 py-px text-[10px] font-medium leading-4 " + TYPE_CHIP_CLASS[item.type]}>{t(TYPE_LABEL_KEYS[item.type])}</span>
                    <span className="truncate text-sm font-medium text-zinc-800">{item.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{relativeTimeText(locale, item.deliveredAt)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-zinc-500">{item.body}</span>
                  {item.mergedCount > 1 ? (
                    <span className="mt-0.5 block text-[11px] text-zinc-400">{t("header.inbox.merged", { n: item.mergedCount })}</span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                data-inbox-delete-item={String(item.id)}
                title={t("header.inbox.deleteOne")}
                aria-label={t("header.inbox.deleteOne")}
                disabled={inboxBusy}
                onClick={() => {
                  void handleDelete(item);
                }}
                className="mr-1 mt-1.5 shrink-0 rounded-md p-1 text-zinc-300 opacity-70 transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-default disabled:opacity-30 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-3.5 w-3.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {items !== null && total > items.length ? (
        <div className="border-t border-zinc-100 px-3 py-1.5 text-center text-[11px] text-zinc-400">{t("header.inbox.more", { shown: items.length, total })}</div>
      ) : null}
      {wecomUnbound ? (
        <div
          data-inbox-wecom-unbound="true"
          className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-zinc-50/60 px-3 py-2 text-[11px] text-zinc-500"
        >
          <span>{t("inbox.unbound.hint")}</span>
          <button
            type="button"
            data-inbox-wecom-settings="true"
            onClick={() => {
              onNavigate();
              window.location.hash = SETTINGS_BASE_HASH.slice(1);
            }}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-100"
          >
            {t("inbox.unbound.action")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
