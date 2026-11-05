import { describe, expect, it } from "vitest";
import type { Env } from "../src/config/env.js";
import {
  backoffDelayMs,
  defaultTopicPolicy,
  PREVIEW_BACKOFF_MAX_MS,
  previewTopicPolicy,
  RETRY_BACKOFF_JITTER_RATIO,
  resolveOutboxPolicies,
  retryBackoffDelayMs,
} from "../src/outbox/policy.js";

/** S7-1 主题策略门禁：缺省策略读 OUTBOX_DEFAULT_*、preview.job 沿用 PREVIEW_CONVERT_*、指数退避封顶与确定性抖动。 */

const ENV = {
  OUTBOX_BATCH_LIMIT: 2,
  OUTBOX_DEFAULT_MAX_ATTEMPTS: 5,
  OUTBOX_DEFAULT_BACKOFF_BASE_MS: 15000,
  OUTBOX_DEFAULT_BACKOFF_MAX_MS: 1800000,
  PREVIEW_CONVERT_MAX_ATTEMPTS: 3,
  PREVIEW_CONVERT_BACKOFF_MS: 15000,
} as unknown as Env;

describe("outbox 主题策略（S7-1）", () => {
  it("缺省策略读 OUTBOX_DEFAULT_*（batchLimit 复用 OUTBOX_BATCH_LIMIT）", () => {
    expect(defaultTopicPolicy(ENV)).toEqual({
      batchLimit: 2,
      maxAttempts: 5,
      backoffBaseMs: 15000,
      backoffMaxMs: 1800000,
    });
  });

  it("preview.job 沿用 PREVIEW_CONVERT_*（attempts / backoff 与 M4-05c 同口径），退避封顶 30 分钟", () => {
    const policy = previewTopicPolicy({ ...ENV, PREVIEW_CONVERT_BACKOFF_MS: 600000 } as Env);

    expect(policy.maxAttempts).toBe(3);
    expect(backoffDelayMs(policy, 1)).toBe(600000);
    expect(backoffDelayMs(policy, 2)).toBe(1200000);
    // 第 3 次 = 600000 * 2^2 = 2400000 > 封顶 1800000
    expect(backoffDelayMs(policy, 3)).toBe(PREVIEW_BACKOFF_MAX_MS);
    expect(PREVIEW_BACKOFF_MAX_MS).toBe(30 * 60_000);
  });

  it("resolveOutboxPolicies：注册主题清单 = preview.job + notify.message + notify.group（S7-4 / M5-03-2；未登记主题由 dispatcher 回退缺省）", () => {
    const policies = resolveOutboxPolicies(ENV);

    expect([...policies.keys()]).toEqual(["preview.job", "notify.message", "notify.group"]);
    expect(policies.get("preview.job")).toEqual(previewTopicPolicy(ENV));
    // notify.message（站内信投递 · S7-4）：本地写库、无外部依赖抖动 —— 沿用通用重试口径（OUTBOX_DEFAULT_*）。
    expect(policies.get("notify.message")).toEqual(defaultTopicPolicy(ENV));
    // notify.group（群播报 · M5-03-2 接线段）：retryable 才累计尝试；rate_limited 走 deferred 不消耗重试预算。
    expect(policies.get("notify.group")).toEqual(defaultTopicPolicy(ENV));
  });

  it("退避单调递增且封顶：attempts 很大也不超过 backoffMaxMs", () => {
    const policy = defaultTopicPolicy(ENV);

    expect(backoffDelayMs(policy, 1)).toBe(15000);
    expect(backoffDelayMs(policy, 4)).toBe(120000);
    expect(backoffDelayMs(policy, 8)).toBe(1800000);
    expect(backoffDelayMs(policy, 30)).toBe(1800000);
  });

  it("retry 退避按 dedupeKey + attempts 确定性抖动：同键稳定、不同键错峰、不突破封顶", () => {
    const policy = defaultTopicPolicy(ENV);
    const first = retryBackoffDelayMs(policy, 1, "task.updated:key:1");

    expect(RETRY_BACKOFF_JITTER_RATIO).toBe(0.2);
    expect(retryBackoffDelayMs(policy, 1, "task.updated:key:1")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(12000);
    expect(first).toBeLessThanOrEqual(15000);

    const delays = new Set(
      Array.from({ length: 128 }, (_, index) => retryBackoffDelayMs(policy, 1, "task.updated:key:" + index)),
    );
    expect(delays.size).toBeGreaterThan(64);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(12000);
      expect(delay).toBeLessThanOrEqual(15000);
    }

    expect(retryBackoffDelayMs(policy, 30, "task.updated:key:1")).toBeGreaterThanOrEqual(1440000);
    expect(retryBackoffDelayMs(policy, 30, "task.updated:key:1")).toBeLessThanOrEqual(1800000);
  });
});
