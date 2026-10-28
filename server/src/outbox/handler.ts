import type { OutboxClaimedRow } from "../db/outbox.store.js";

/** 死信即时告警的专用文案覆盖；未提供时由 dispatcher 使用通用死信文案。 */
export interface OutboxDeadAlertOverride {
  message: string;
  impact: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

/**
 * 单条消费的结果（S7-1；deferred 随 M5-03-2 接线段扩）：dispatcher 据此收敛 outbox 状态 ——
 *   done     = 处理完成（含「业务上无需处理，消费掉」）；
 *   retry    = 可重试失败，按主题策略退避回 pending（attempts 累计）；
 *   deferred = 延期重排（外部限速 / 未就绪窗口）：回 pending 至 availableAt、**attempts 不累计**
 *              ——「等窗口」不是「消费失败」，不占重试预算（S8-1 处置三分类：rate_limited）；
 *   dead     = 确定性失败或重试到顶，落 dead；默认发死信即时告警。
 * handler 只做业务处理与分类，**不直接回写 outbox 状态**（回写统一在 dispatcher）。
 */
export type OutboxHandleOutcome =
  | { outcome: "done" }
  | { outcome: "retry"; error: string }
  | { outcome: "deferred"; availableAt: Date; error: string }
  | {
      outcome: "dead";
      error: string;
      /**
       * 死信告警去向：缺省 immediate（企微即时告警）；digest = 只写结构化日志并计入日报。
       * 仅用于「重试也不会变好、管理员也无处置动作」的确定性拒绝，避免告警群反复收到噪音。
       */
      deadAlert?: "immediate" | "digest";
      /** 即时死信告警的专用文案；`deadAlert=digest` 时不生效。 */
      alert?: OutboxDeadAlertOverride;
    };

/** 主题消费者（worker 注册表的一项）。 */
export interface OutboxTopicHandler {
  handle(row: OutboxClaimedRow): Promise<OutboxHandleOutcome>;
  /** 终态 dead 的留痕钩子（可选）：如把产物置 failed（D2-05 降级）。抛错只记日志，不阻塞 dead 落库。 */
  onDead?(row: OutboxClaimedRow, error: string): Promise<void>;
}
