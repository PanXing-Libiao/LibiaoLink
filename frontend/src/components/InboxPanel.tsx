import { useCallback, useEffect, useState } from "react";
import { loadWecomDmBinding } from "../bindingApi";
import { relativeTimeText, useLocale, useT, type TextKey } from "../i18n";
import { applyInboxUnread, getInboxBadge, useInboxBadge } from "../inbox";
import { loadInboxPage, markAllInboxRead, markInboxRead, type InboxNotification, type InboxNotificationType } from "../inboxApi";
import { PROJECT_BASE_HASH, SETTINGS_BASE_HASH } from "../useHashRoute";
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
 * 用来消息通知」）：最近 8 条 + 全部已读；打开即拉取（随行回读未读角标）。
 * SSE notification 事件只推进 ../inbox 的版本号，弹窗开着时据此静默补拉（不清空现值、不整页骨架 ——
 * 与全局静默同步口径一致）；点条 = 置读（乐观 + 失败回滚出 Toast），关联对象 refType = project 可直达
 * 项目详情，其余类型先置读。
 */
export function InboxPanel({ onError, onNavigate }: { onError: (text: string) => void; onNavigate: () => void }) {
  const t = useT();
  const locale = useLocale();
  const inboxBadge = useInboxBadge();
  const [items, setItems] = useState<InboxNotification[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  /** 未绑定企微（D6 未绑定提示 · Push 250）：未绑定 = 企微单聊推送落站内信降级 —— 弹窗底部提示 + 「前往设置补绑」。 */
  const [wecomUnbound, setWecomUnbound] = useState(false);

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
    }
  };

  const handleActivate = (item: InboxNotification): void => {
    if (item.refType === "project" && item.refId !== null) {
      onNavigate();
      window.location.hash = PROJECT_BASE_HASH + encodeURIComponent(item.refId);
    }
    if (item.status === "unread") {
      void markRead(item);
    }
  };

  const handleMarkAllRead = async (): Promise<void> => {
    if (items === null || !items.some((item) => item.status === "unread")) {
      return;
    }
    const previous = items;
    const previousUnread = getInboxBadge().unreadCount;
    setItems(items.map((row) => row.status === "unread" ? { ...row, status: "read" } : row));
    applyInboxUnread(0);
    try {
      const result = await markAllInboxRead();
      applyInboxUnread(result.unreadCount);
    } catch {
      setItems(previous);
      applyInboxUnread(previousUnread);
      onError(t("header.inbox.saveFailed"));
    }
  };

  const hasUnreadRow = items !== null && items.some((item) => item.status === "unread");

  return (
    <div data-inbox-content="true">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-900">{t("header.inbox.title")}</span>
        {inboxBadge.unreadCount > 0 ? (
          <span className="rounded-full bg-red-50 px-1.5 py-px text-[11px] font-medium tabular-nums text-red-600">{inboxBadge.unreadCount}</span>
        ) : null}
        <button
          type="button"
          data-inbox-mark-all="true"
          disabled={!hasUnreadRow}
          onClick={() => {
            void handleMarkAllRead();
          }}
          className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default disabled:text-zinc-300 disabled:hover:bg-transparent"
        >
          {t("header.inbox.markAllRead")}
        </button>
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
            <button
              key={item.id}
              type="button"
              data-inbox-item={String(item.id)}
              data-inbox-status={item.status}
              onClick={() => {
                handleActivate(item);
              }}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-zinc-50"
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
