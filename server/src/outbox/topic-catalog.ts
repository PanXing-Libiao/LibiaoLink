import type { OutboxTopic } from "@libiaolink/contracts";
import { OUTBOX_TOPICS } from "@libiaolink/contracts";
import type { OutboxTopicHandler } from "./handler.js";

/**
 * Outbox 主题角色清单（S7·outbox 运维收口）：每个契约主题必须显式声明为
 * `consumer`（有业务消费者）或 `drain_only`（当前无业务订阅，仅确认并收敛历史事件）。
 *
 * `drain_only` 不是删除：worker 会正常领取并置 `done`，只是不产生通知、不补发历史业务动作。
 * 新增主题时先改 shared 契约，再在此登记；`outbox-topic-catalog.test.ts` 负责全量 / 不重叠门禁。
 */
export const OUTBOX_TOPIC_ROLES = {
  "task.created": "drain_only",
  "task.updated": "consumer",
  "task.progress_changed": "consumer",
  "task.completed": "consumer",
  "task.finalized": "drain_only",
  "task.unfinalized": "drain_only",
  "task.deleted": "drain_only",
  "task.locked_fields_adjusted": "drain_only",
  "task.draft_doc_reminded": "drain_only",
  "task.gate_rejected": "drain_only",
  "node.added": "drain_only",
  "node.completed": "consumer",
  "node.deleted": "drain_only",
  "node.gate_rejected": "drain_only",
  "stage.advanced": "consumer",
  "stage.gate_rejected": "drain_only",
  "stage.rolled_back": "drain_only",
  "project.created": "drain_only",
  "file.version.created": "drain_only",
  "file.finalized": "drain_only",
  "preview.job": "consumer",
  "change.applied": "consumer",
  "report.submitted": "consumer",
  "report.deleted": "drain_only",
  "issue.created": "drain_only",
  "issue.updated": "consumer",
  "issue.deleted": "drain_only",
  "notify.message": "consumer",
  "notify.group": "consumer",
} as const satisfies Record<OutboxTopic, "consumer" | "drain_only">;

export type OutboxTopicRole = (typeof OUTBOX_TOPIC_ROLES)[OutboxTopic];

export const OUTBOX_CONSUMER_TOPICS: readonly OutboxTopic[] = OUTBOX_TOPICS.filter(
  (topic) => OUTBOX_TOPIC_ROLES[topic] === "consumer",
);

export const OUTBOX_DRAIN_ONLY_TOPICS: readonly OutboxTopic[] = OUTBOX_TOPICS.filter(
  (topic) => OUTBOX_TOPIC_ROLES[topic] === "drain_only",
);

/** drain-only 消费结果：确认事件已被接住，不改业务状态、不产生二次通知。 */
const DRAIN_ONLY_HANDLER: OutboxTopicHandler = {
  handle: async () => ({ outcome: "done" }),
};

export function createDrainOnlyHandler(): OutboxTopicHandler {
  return DRAIN_ONLY_HANDLER;
}

/** 业务消费者登记：角色必须是 `consumer`，且不得与 drain-only 重复登记。 */
export function registerConsumerTopic(
  registry: Map<OutboxTopic, OutboxTopicHandler>,
  topic: OutboxTopic,
  handler: OutboxTopicHandler,
): void {
  if (OUTBOX_TOPIC_ROLES[topic] !== "consumer") {
    throw new Error("Outbox 主题角色冲突：" + topic + " 未登记为 consumer");
  }
  if (registry.has(topic)) {
    throw new Error("Outbox 消费者重复登记：" + topic);
  }
  registry.set(topic, handler);
}

/** 无条件登记全部 drain-only 主题；与业务消费者重叠时 fail fast，避免静默覆盖。 */
export function registerDrainOnlyTopics(registry: Map<OutboxTopic, OutboxTopicHandler>): void {
  for (const topic of OUTBOX_DRAIN_ONLY_TOPICS) {
    if (registry.has(topic)) {
      throw new Error("Outbox 主题角色冲突：" + topic + " 既有业务消费者，不能按 drain-only 登记");
    }
    registry.set(topic, createDrainOnlyHandler());
  }
}
