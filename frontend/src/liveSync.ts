export const LIVE_RESOURCES = ["projects", "tasks", "reports", "issues", "files", "stakeholders", "templates", "dicts", "users", "audit", "permissions", "preferences"] as const;
export type LiveResource = (typeof LIVE_RESOURCES)[number];
export type LiveRefresh = () => Promise<() => void>;
const subscribers = new Set<{ resources: readonly LiveResource[]; queue: RefreshQueue }>();
const hintListeners = new Set<(resources: readonly LiveResource[]) => void>();
export function subscribeLiveHints(listener: (resources: readonly LiveResource[]) => void): () => void { hintListeners.add(listener); return () => { hintListeners.delete(listener); }; }
let writes = 0;
let writeRevision = 0;
let pointerDown = false;

/** Keep the version paired with an editing draft unchanged until the editor closes. */
export function liveSyncPaused(): boolean {
  return typeof document !== "undefined" && (
    document.visibilityState === "hidden" || pointerDown || writes > 0 ||
    document.querySelector('[role="dialog"]:not([data-live-sync-readonly="true"]), [aria-modal="true"]:not([data-live-sync-readonly="true"]), [data-inline-popover], [data-drag-ghost], [data-live-sync-pause="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):focus, textarea:focus, select:focus, [contenteditable="true"]:focus') !== null
  );
}

/** Read-only overlays can catch up without closing the overlay or replacing any input. */
export function liveReadPaused(): boolean {
  return typeof document !== "undefined" && (document.visibilityState === "hidden" || pointerDown || writes > 0 || document.querySelector('input:not([type="checkbox"]):not([type="radio"]):focus, textarea:focus, select:focus, [contenteditable="true"]:focus, [data-drag-ghost], [data-plan-drag-ghost]') !== null);
}

/** One request at a time, fixed throttle (continuous changes cannot keep postponing the trailing read). */
export class RefreshQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private running = false;
  private disposed = false;
  private lastStarted = 0;

  constructor(
    private readonly refresh: LiveRefresh,
    private readonly paused: () => boolean = liveSyncPaused,
    private readonly revision: () => number = () => writeRevision,
    private readonly commit: (apply: () => void) => void = (apply) => apply(),
    private readonly interval = 1000,
  ) {}

  request(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.running || this.timer !== null || !this.dirty) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(this.interval, this.lastStarted + this.interval - Date.now()));
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    if (this.paused()) { this.schedule(); return; }
    this.dirty = false;
    this.running = true;
    this.lastStarted = Date.now();
    const revision = this.revision();
    try {
      const apply = await this.refresh();
      if (!this.disposed) {
        if (this.paused() || revision !== this.revision()) this.dirty = true;
        else this.commit(apply);
      }
    } catch {
      // Preserve the current screen; the next event or periodic catch-up retries failed reads.
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

export function trackLocalWrite(): () => void {
  writes += 1;
  writeRevision += 1;
  return () => { writes -= 1; };
}

function invalidate(resources: readonly LiveResource[]): void {
  for (const listener of hintListeners) listener(resources);
  for (const subscriber of subscribers) {
    if (subscriber.resources.some((resource) => resources.includes(resource))) subscriber.queue.request();
  }
}

export const localWriteRevision = (): number => writeRevision;
export const requestLiveCatchUp = (): void => invalidate(LIVE_RESOURCES);

export function subscribeLiveRefresh(resources: readonly LiveResource[], refresh: LiveRefresh, commit: (apply: () => void) => void, paused: () => boolean = liveSyncPaused): () => void {
  const queue = new RefreshQueue(refresh, paused, () => writeRevision, commit);
  const subscriber = { resources, queue };
  subscribers.add(subscriber);
  // Also closes the initial-load / stream-open race.
  queue.request();
  return () => { queue.dispose(); subscribers.delete(subscriber); };
}

/**
 * 站内信事件处理者（Push 352 · 顶栏红点接线）：由调用方（App.tsx）从 ../inbox 注入 ——
 * 本模块不认识业务 store，避免 liveSync → inbox → api → liveSync 的循环依赖。
 * - onUnread = unread 事件（未读角标快照：新投递 / 标记 / 全部已读 / 稍后提醒触发的未读数变更）；
 * - onNotification = notification 事件（新投递 / 稍后提醒触发）：打开着的站内信弹窗据此静默补拉；
 * - onOpen = 连接打开（含自动重连；服务端「重连不补发」）—— 调用方按各自读面补拉对齐。
 */
export type LiveStreamHandlers = {
  onUnread?: (unreadCount: number) => void;
  onNotification?: () => void;
  onOpen?: () => void;
};

/** One stream per signed-in app; payloads never become business state directly. */
export function startLiveSync(handlers: LiveStreamHandlers = {}): () => void {
  const source = new EventSource("/api/v1/notifications/stream");
  const catchUp = () => invalidate(LIVE_RESOURCES);
  const onStreamOpen = () => { catchUp(); handlers.onOpen?.(); };
  const onUnread = (event: Event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    try {
      const payload: unknown = JSON.parse(event.data);
      if (typeof payload !== "object" || payload === null || !("unreadCount" in payload)) return;
      const count = (payload as { unreadCount: unknown }).unreadCount;
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) handlers.onUnread?.(count);
    } catch { /* Ignore invalid snapshots; the read API remains the source of truth. */ }
  };
  const onNotification = () => { handlers.onNotification?.(); };
  const onInvalidate = (event: Event) => {
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
    try {
      const payload: unknown = JSON.parse(event.data);
      if (typeof payload !== "object" || payload === null || !("resources" in payload) || !Array.isArray(payload.resources)) return;
      const resources = payload.resources.filter((value): value is LiveResource => typeof value === "string" && (LIVE_RESOURCES as readonly string[]).includes(value));
      invalidate(resources);
    } catch { /* Ignore invalid hints; authenticated read APIs remain the source of truth. */ }
  };
  const onPointerDown = () => { pointerDown = true; };
  const onPointerUp = () => { pointerDown = false; };
  const onVisible = () => { if (document.visibilityState === "visible") catchUp(); };
  source.addEventListener("invalidate", onInvalidate);
  source.addEventListener("unread", onUnread);
  source.addEventListener("notification", onNotification);
  source.addEventListener("open", onStreamOpen);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", catchUp);
  window.addEventListener("focus", catchUp);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("blur", onPointerUp);
  const timer = window.setInterval(catchUp, 30000);
  return () => {
    source.close();
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", catchUp);
    window.removeEventListener("focus", catchUp);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    window.removeEventListener("blur", onPointerUp);
    pointerDown = false;
  };
}

/** Keep existing row order during automatic updates; explicit sort/filter/navigation still uses server order. */
export function keepLiveOrder<T extends { id: string | number }>(previous: readonly T[], next: readonly T[]): T[] {
  const remaining = new Map(next.map((item) => [item.id, item]));
  const result: T[] = [];
  for (const item of previous) {
    const updated = remaining.get(item.id);
    if (updated !== undefined) { result.push(updated); remaining.delete(item.id); }
  }
  return [...result, ...remaining.values()];
}
