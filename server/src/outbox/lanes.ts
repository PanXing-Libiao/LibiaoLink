import type { OutboxTopic } from "@libiaolink/contracts";
import { PREVIEW_JOB_TOPIC } from "../modules/file/index.js";
import { NOTIFY_GROUP_TOPIC, NOTIFY_MESSAGE_TOPIC } from "../modules/notify/index.js";

/** Outbox 逻辑消费通道：通道内串行，通道间可并行。 */
export const OUTBOX_LANE_NAMES = ["notify", "preview", "general"] as const;

export type OutboxLaneName = (typeof OUTBOX_LANE_NAMES)[number];

export interface OutboxLane {
  readonly name: OutboxLaneName;
  readonly topics: readonly OutboxTopic[];
}

const NOTIFY_TOPICS = new Set<OutboxTopic>([NOTIFY_MESSAGE_TOPIC, NOTIFY_GROUP_TOPIC]);

/**
 * 将已注册主题划分为互斥的消费通道：
 * - notify：通知投递，不被预览或通用业务事件阻塞；
 * - preview：预览转换，通道内仍严格串行；
 * - general：其余全部已注册主题，保证新主题默认有人消费。
 *
 * 只划分传入的已注册主题；被开关关闭而未注册的主题不会出现在任何通道。
 */
export function buildOutboxLanes(registeredTopics: readonly OutboxTopic[]): readonly OutboxLane[] {
  const topics = [...new Set(registeredTopics)].sort();
  const notify = topics.filter((topic) => NOTIFY_TOPICS.has(topic));
  const preview = topics.filter((topic) => topic === PREVIEW_JOB_TOPIC);
  const general = topics.filter((topic) => topic !== PREVIEW_JOB_TOPIC && !NOTIFY_TOPICS.has(topic));
  const lanes: readonly OutboxLane[] = [
    { name: "notify", topics: notify },
    { name: "preview", topics: preview },
    { name: "general", topics: general },
  ];
  assertOutboxLanePartition(topics, lanes);
  return lanes;
}

/** 启动期 fail fast：重复进入多个通道会破坏「同一主题通道内串行」的保证。 */
export function assertOutboxLanePartition(
  registeredTopics: readonly OutboxTopic[],
  lanes: readonly OutboxLane[],
): void {
  const expected = new Set(registeredTopics);
  const assigned = new Set<OutboxTopic>();
  for (const lane of lanes) {
    for (const topic of lane.topics) {
      if (assigned.has(topic)) {
        throw new Error("Outbox 通道主题重复：" + topic);
      }
      if (!expected.has(topic)) {
        throw new Error("Outbox 通道包含未注册主题：" + topic);
      }
      assigned.add(topic);
    }
  }
  const missing = [...expected].filter((topic) => !assigned.has(topic));
  if (missing.length > 0) {
    throw new Error("Outbox 通道遗漏主题：" + missing.sort().join(", "));
  }
}
