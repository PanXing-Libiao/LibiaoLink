/**
 * 企微发送限速桶（M5-03-1 · S8-1：「限速桶（DB 计数）」；M5-03-2 扩多窗口）。
 *
 * 语义（进契约口径 · 实施方案 §五 处置三分类）：
 *   固定窗口 × 多窗口 —— 窗口起点按 epoch 对齐到 windowMs 的整数倍；任一窗口内第 limit+1 次尝试 →
 *   该窗口拒绝；**全部窗口放行才放行**，`retryAt` = 各被拒窗口「下一窗口起点」的最大值 ——
 *   调用方据此**延期重排（不消耗 outbox 重试次数）**。0 = 未启用（该窗口不计数、不参与判定）。
 *
 * 计数存储 = `RateWindowStore` 端口：本刀交付内存实现（单测 / stub 回放）；**落库实现（DB 计数）随
 * `notify_deliveries` / 群绑定迁移接入（M5-03-2 / M5-03-3）** —— SQL 形态 = 单语句
 * `INSERT ... ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`
 * （先增量后判定，天然处理跨进程并发；桶键 = 渠道桶 id + 窗口长度，避免分钟 / 小时窗口同起点互污 ——
 * 约定见迁移 0046 头注）。
 *
 * 发送面与窗口组（数值落 env）：
 *   - `app`（自建应用 · M5-03-3 接线）：单窗口 `WECOM_RATE_WINDOW_MS` / `WECOM_RATE_LIMIT_APP`（待 A5 实测回填）；
 *   - `group`（智能机器人 · M5-03-2）：双窗口 = 30 条/分钟 + 1000 条/小时（Spike 实测口径，按会话；
 *     回复 + 主动推送合计）。webhook 面已退役（P5 定案 2026-10-12）—— `webhookBucketId` 同批移除。
 *   - `single`（智能机器人单聊 · M5-03-5-3）：双窗口复用 `WECOM_BOT_RATE_LIMIT_PER_MINUTE / HOUR`（按 userid；
 *     单聊实测后决定是否拆独立 env —— P5 待定）；桶键 = userid 摘要，与群桶按 kind 隔离。
 */
import { createHash } from "node:crypto";

/** 计数端口：计数并返回该窗口内的新值（含本次）；落库 / 内存实现可替换。 */
export interface RateWindowStore {
  consume(bucket: string, windowStartMs: number): Promise<number>;
}

/** 内存计数（默认）：单进程范围 —— 单测 / stub 回放 / 单 worker 过渡期可用；多进程一致性由落库实现承担。 */
export class InMemoryRateWindowStore implements RateWindowStore {
  private readonly counters = new Map<string, number>();

  async consume(bucket: string, windowStartMs: number): Promise<number> {
    const key = bucket + "@" + String(windowStartMs);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
}

export type WecomRateKind = "app" | "group" | "single";

/** 单个窗口的判定结果（count 含本次；count > limit = 该窗口已拒绝）。 */
export interface WecomRateWindowState {
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口起点（epoch 毫秒；对齐到 windowMs 整数倍）。 */
  windowStartMs: number;
  /** 窗口内上限（0 = 未启用）。 */
  limit: number;
  /** 窗口内计数（含本次）；未启用窗口恒 0。 */
  count: number;
}

export type WecomRateDecision =
  | { ok: true; kind: WecomRateKind; bucket: string; windows: WecomRateWindowState[] }
  | { ok: false; kind: WecomRateKind; bucket: string; retryAt: Date; windows: WecomRateWindowState[] };

/** 窗口组定义（同一 kind 可多窗口：例 = 分钟 + 小时）。 */
export interface WecomRateWindowSpec {
  kind: WecomRateKind;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口内上限（0 = 未启用）。 */
  limit: number;
}

export interface WecomRateLimiterOptions {
  store: RateWindowStore;
  /** 窗口组（装配方按发送面配置：app 单窗口 / group 与 single 各双窗口）。 */
  windows: readonly WecomRateWindowSpec[];
  now?: () => number;
}

export class WecomRateLimiter {
  constructor(private readonly options: WecomRateLimiterOptions) {}

  /**
   * 发送前取额度：ok = 放行（各启用窗口已计数）；拒绝 = 不发帧 / 不发 HTTP，
   * 调用方按 retryAt 延期重排（不消耗重试次数）。未启用（limit 0）窗口不触达计数存储。
   */
  async tryConsume(kind: WecomRateKind, bucketId: string, nowMs?: number): Promise<WecomRateDecision> {
    const current = nowMs ?? (this.options.now ?? Date.now)();
    const bucket = kind + ":" + bucketId;
    const states: WecomRateWindowState[] = [];
    for (const spec of this.options.windows) {
      if (spec.kind !== kind) {
        continue;
      }
      const windowStartMs = Math.floor(current / spec.windowMs) * spec.windowMs;
      if (spec.limit <= 0) {
        states.push({ windowMs: spec.windowMs, windowStartMs, limit: spec.limit, count: 0 });
        continue;
      }
      // 桶键含窗口长度（同 kind 多窗口共存时同起点不互污；见迁移 0046 头注约定）
      const count = await this.options.store.consume(bucket + ":w" + String(spec.windowMs), windowStartMs);
      states.push({ windowMs: spec.windowMs, windowStartMs, limit: spec.limit, count });
    }
    const refused = states.filter((state) => state.count > state.limit);
    if (refused.length === 0) {
      return { ok: true, kind, bucket, windows: states };
    }
    const retryAtMs = Math.max(...refused.map((state) => state.windowStartMs + state.windowMs));
    return { ok: false, kind, bucket, retryAt: new Date(retryAtMs), windows: states };
  }
}

/** 自建应用全局桶 id（token 面共享一个桶）。 */
export const WECOM_APP_BUCKET_ID = "global";

/** 智能机器人窗口长度（毫秒）—— Spike 实测口径：30 条/分钟 + 1000 条/小时（按会话；回复 + 主动推送合计）。 */
export const WECOM_BOT_WINDOW_PER_MINUTE_MS = 60_000;
export const WECOM_BOT_WINDOW_PER_HOUR_MS = 3_600_000;

/** 智能机器人桶 id = 目标摘要（chatid / userid 共用实现；sha256 前 12 位十六进制）。 */
function digestTargetId(target: string): string {
  return createHash("sha256").update(target).digest("hex").slice(0, 12);
}

/** 群通道桶 id = chatid 摘要 —— 计数键 / 日志均不出现 chatid 明文。 */
export function chatBucketId(chatid: string): string {
  return digestTargetId(chatid);
}

/** 单聊通道桶 id = userid 摘要（镜像群桶键口径）—— 计数键 / 日志均不出现 userid 明文。 */
export function userBucketId(userid: string): string {
  return digestTargetId(userid);
}
