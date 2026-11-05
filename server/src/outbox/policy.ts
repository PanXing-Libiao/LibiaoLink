import { createHash } from "node:crypto";
import type { Env } from "../config/env.js";
import type { OutboxTopic } from "@libiaolink/contracts";
import { PREVIEW_JOB_TOPIC } from "../modules/file/index.js";
import { NOTIFY_GROUP_TOPIC, NOTIFY_MESSAGE_TOPIC } from "../modules/notify/index.js";

/**
 * 主题级重试策略（S7-1）：重试与死信的**语义**由契约 fixed（shared/src/modules/outbox.ts），
 * 数值按主题落 env —— 缺省走 OUTBOX_DEFAULT_*，preview.job 沿用 PREVIEW_CONVERT_*（与 M4-05c 同口径，
 * 不改既有 env 契约）。
 */
export interface OutboxTopicPolicy {
  /** 单轮领取条数（每主题独立批；防慢主题把批次占满、饿死其它主题）。 */
  batchLimit: number;
  /** 可重试失败的最大尝试次数（含首次）。 */
  maxAttempts: number;
  /** 指数退避基数（毫秒）：第 n 次失败后等待 base * 2^(n-1)，封顶 backoffMaxMs；实际重试再叠加确定性抖动。 */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** 预览转换退避封顶 30 分钟（与 M4-05c 原实现同口径：容器重启 / 配额耗尽不无限拉长）。 */
export const PREVIEW_BACKOFF_MAX_MS = 30 * 60_000;

/** 重试延时的确定性抖动幅度：在原始退避的 80%～100% 内错峰，不突破封顶。 */
export const RETRY_BACKOFF_JITTER_RATIO = 0.2;

export function defaultTopicPolicy(env: Env): OutboxTopicPolicy {
  return {
    batchLimit: env.OUTBOX_BATCH_LIMIT,
    maxAttempts: env.OUTBOX_DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs: env.OUTBOX_DEFAULT_BACKOFF_BASE_MS,
    backoffMaxMs: env.OUTBOX_DEFAULT_BACKOFF_MAX_MS,
  };
}

export function previewTopicPolicy(env: Env): OutboxTopicPolicy {
  return {
    batchLimit: env.OUTBOX_BATCH_LIMIT,
    maxAttempts: env.PREVIEW_CONVERT_MAX_ATTEMPTS,
    backoffBaseMs: env.PREVIEW_CONVERT_BACKOFF_MS,
    backoffMaxMs: PREVIEW_BACKOFF_MAX_MS,
  };
}

/** 已注册主题 → 策略；未登记主题由 dispatcher 回退缺省策略（正常不会发生：领取只按注册表主题）。 */
export function resolveOutboxPolicies(env: Env): ReadonlyMap<OutboxTopic, OutboxTopicPolicy> {
  return new Map<OutboxTopic, OutboxTopicPolicy>([
    [PREVIEW_JOB_TOPIC, previewTopicPolicy(env)],
    // notify.message（S7-4 站内信投递）：站内信 = 本地写库（无外部依赖抖动），沿用通用重试口径
    // （OUTBOX_DEFAULT_*：5 次 / 15s 起 / 30min 封顶）；不丢由 source_dedupe_key 唯一 + 死信告警兜底。
    [NOTIFY_MESSAGE_TOPIC, defaultTopicPolicy(env)],
    // notify.group（M5-03-2 群播报）：通用重试口径（OUTBOX_DEFAULT_*）—— retryable 才累计尝试；
    // rate_limited（限速 / 未就绪）走 deferred 延期重排、不消耗重试预算（dispatcher）。
    [NOTIFY_GROUP_TOPIC, defaultTopicPolicy(env)],
  ]);
}

/** 第 attempts 次失败（含本次，1 起）后的原始退避时长；供 retry 退避在应用抖动前复用。 */
export function backoffDelayMs(policy: OutboxTopicPolicy, attempts: number): number {
  return Math.min(policy.backoffBaseMs * 2 ** (attempts - 1), policy.backoffMaxMs);
}

/**
 * 第 attempts 次失败后的实际重试延时：以 dedupeKey + attempts 为稳定种子，在原始退避的
 * 80%～100% 内确定性错峰。同一消息 / 同一尝试跨 worker、跨重放得到同一结果；不同消息自然分散，
 * 避免下游恢复时整批重试同时到期。抖动只向下收敛，因此不会突破 backoffMaxMs。
 */
export function retryBackoffDelayMs(policy: OutboxTopicPolicy, attempts: number, dedupeKey: string): number {
  const cappedMs = backoffDelayMs(policy, attempts);
  const digest = createHash("sha256").update(JSON.stringify([dedupeKey, attempts])).digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  return Math.max(1, Math.round(cappedMs * (1 - RETRY_BACKOFF_JITTER_RATIO * fraction)));
}
