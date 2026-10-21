/**
 * 企微限速桶回归（M5-03-1 · S8-1；M5-03-2 扩多窗口；M5-03-5-3 扩 single kind）：窗口计数 / 拒绝与 retryAt
 * （取被拒窗口最大值）/ 跨窗口重置 / 桶隔离 / 同 kind 多窗口同起点不互污 / 0=未启用 / 桶键摘要（chatid / userid）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  chatBucketId,
  InMemoryRateWindowStore,
  userBucketId,
  WECOM_BOT_WINDOW_PER_HOUR_MS,
  WECOM_BOT_WINDOW_PER_MINUTE_MS,
  WecomRateLimiter,
  type RateWindowStore,
  type WecomRateWindowSpec,
} from "../src/modules/notify/wecom.rate.js";

const MINUTE_MS = 60_000;

function makeLimiter(windows: WecomRateWindowSpec[], store: RateWindowStore = new InMemoryRateWindowStore()) {
  return { limiter: new WecomRateLimiter({ store, windows }), store };
}

describe("企微限速桶（M5-03-1 · S8-1；M5-03-2 多窗口）", () => {
  it("单窗口：放行至上限；第 limit+1 次拒绝并给出下一窗口 retryAt", async () => {
    const { limiter } = makeLimiter([{ kind: "group", windowMs: MINUTE_MS, limit: 2 }]);
    const now = 1_000; // 窗口 [0, 60000)

    const first = await limiter.tryConsume("group", "abc", now);
    const second = await limiter.tryConsume("group", "abc", now);
    const third = await limiter.tryConsume("group", "abc", now);

    expect(first).toMatchObject({ ok: true, kind: "group", bucket: "group:abc" });
    expect(first.windows).toEqual([{ windowMs: MINUTE_MS, windowStartMs: 0, limit: 2, count: 1 }]);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.retryAt.getTime()).toBe(MINUTE_MS);
      expect(third.windows).toEqual([{ windowMs: MINUTE_MS, windowStartMs: 0, limit: 2, count: 3 }]);
    }
  });

  it("多窗口（分钟 + 小时）：任一被拒即拒；retryAt = 各被拒窗口下一窗口起点的最大值", async () => {
    const { limiter } = makeLimiter([
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 2 },
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 5 },
    ]);
    const t0 = 1_000;
    expect((await limiter.tryConsume("group", "c1", t0)).ok).toBe(true); // 分钟 1/2 · 小时 1/5
    expect((await limiter.tryConsume("group", "c1", t0)).ok).toBe(true); // 分钟 2/2 · 小时 2/5

    // 分钟窗口 3/2 被拒；小时窗口 3/5 未拒 —— retryAt = 分钟窗口下一窗口起点
    const minuteRefused = await limiter.tryConsume("group", "c1", t0);
    expect(minuteRefused.ok).toBe(false);
    if (!minuteRefused.ok) {
      expect(minuteRefused.retryAt.getTime()).toBe(MINUTE_MS);
    }

    // 下一分钟：分钟窗口重置（可发），小时窗口累计到超限被拒 —— retryAt = 小时窗口下一窗口起点
    const t1 = MINUTE_MS + 1_000;
    expect((await limiter.tryConsume("group", "c1", t1)).ok).toBe(true); // 分钟 1/2 · 小时 4/5
    expect((await limiter.tryConsume("group", "c1", t1)).ok).toBe(true); // 分钟 2/2 · 小时 5/5
    const bothRefused = await limiter.tryConsume("group", "c1", t1); // 分钟 3/2 · 小时 6/5
    expect(bothRefused.ok).toBe(false);
    if (!bothRefused.ok) {
      expect(bothRefused.retryAt.getTime()).toBe(WECOM_BOT_WINDOW_PER_HOUR_MS);
    }
  });

  it("同 kind 多窗口同起点不互污（计数键含窗口长度）", async () => {
    const { limiter } = makeLimiter([
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, limit: 1 },
      { kind: "group", windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, limit: 5 },
    ]);
    const t0 = 0; // 分钟 / 小时窗口起点重合（都是 0）
    expect((await limiter.tryConsume("group", "c2", t0)).ok).toBe(true); // 分钟 1/1 · 小时 1/5
    const second = await limiter.tryConsume("group", "c2", t0);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // 若两窗口共用计数键，小时窗口会读到 3；独立键 = 2
      expect(second.windows).toEqual([
        { windowMs: WECOM_BOT_WINDOW_PER_MINUTE_MS, windowStartMs: 0, limit: 1, count: 2 },
        { windowMs: WECOM_BOT_WINDOW_PER_HOUR_MS, windowStartMs: 0, limit: 5, count: 2 },
      ]);
    }
  });

  it("跨窗口重置：下一窗口重新计数", async () => {
    const { limiter } = makeLimiter([{ kind: "group", windowMs: MINUTE_MS, limit: 1 }]);
    expect((await limiter.tryConsume("group", "abc", 1_000)).ok).toBe(true);
    expect((await limiter.tryConsume("group", "abc", 2_000)).ok).toBe(false);
    expect((await limiter.tryConsume("group", "abc", MINUTE_MS)).ok).toBe(true);
    expect((await limiter.tryConsume("group", "abc", MINUTE_MS + 1_000)).ok).toBe(false);
  });

  it("桶隔离：不同摘要 / app 与 group 互不影响", async () => {
    const { limiter } = makeLimiter([
      { kind: "app", windowMs: MINUTE_MS, limit: 1 },
      { kind: "group", windowMs: MINUTE_MS, limit: 1 },
    ]);
    expect((await limiter.tryConsume("group", "a", 0)).ok).toBe(true);
    expect((await limiter.tryConsume("group", "a", 0)).ok).toBe(false);
    expect((await limiter.tryConsume("group", "b", 0)).ok).toBe(true);
    expect((await limiter.tryConsume("app", "global", 0)).ok).toBe(true);
    expect((await limiter.tryConsume("app", "global", 0)).ok).toBe(false);
  });

  it("0 = 未启用：不触达计数存储、直接放行", async () => {
    const store: RateWindowStore = { consume: vi.fn(async () => 999) };
    const { limiter } = makeLimiter([{ kind: "app", windowMs: MINUTE_MS, limit: 0 }], store);
    const decision = await limiter.tryConsume("app", "global", 1_000);
    expect(decision.ok).toBe(true);
    expect(decision.windows).toEqual([{ windowMs: MINUTE_MS, windowStartMs: 0, limit: 0, count: 0 }]);
    expect(store.consume).not.toHaveBeenCalled();
  });

  it("single kind：与群 / 应用桶按 kind 隔离、按摘要独立计数（单聊限速桶）", async () => {
    const { limiter } = makeLimiter([
      { kind: "group", windowMs: MINUTE_MS, limit: 1 },
      { kind: "single", windowMs: MINUTE_MS, limit: 1 },
    ]);
    expect((await limiter.tryConsume("single", "u1", 0)).ok).toBe(true);
    expect((await limiter.tryConsume("single", "u1", 0)).ok).toBe(false); // 同桶第 2 次拒绝
    expect((await limiter.tryConsume("single", "u2", 0)).ok).toBe(true); // 不同 userid 摘要隔离
    expect((await limiter.tryConsume("group", "u1", 0)).ok).toBe(true); // 群 / 单聊同摘要不互污（kind 前缀隔离）
  });

  it("userBucketId：与 chatBucketId 同摘要口径（12 位十六进制，不含 userid 明文）", () => {
    const userid = "zhangsan.wang";
    expect(userBucketId(userid)).toBe(userBucketId(userid));
    expect(userBucketId(userid)).toBe(chatBucketId(userid));
    expect(userBucketId(userid)).toMatch(/^[0-9a-f]{12}$/);
    expect(userBucketId(userid)).not.toContain("zhangsan");
  });

  it("chatBucketId：确定性 12 位十六进制摘要，不含 chatid 明文", () => {
    const chatid = "wrsuIHCwAAC0pZQPjA2ePuS5hhuwaKSg";
    const first = chatBucketId(chatid);
    expect(first).toBe(chatBucketId(chatid));
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(first).not.toContain("wrsu");
    expect(first).not.toContain(chatid);
  });
});
