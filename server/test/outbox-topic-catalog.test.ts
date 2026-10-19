import { describe, expect, it } from "vitest";
import { OUTBOX_TOPICS, RULE_EVENT_TOPICS, type OutboxTopic } from "@libiaolink/contracts";
import {
  createDrainOnlyHandler,
  OUTBOX_CONSUMER_TOPICS,
  OUTBOX_DRAIN_ONLY_TOPICS,
  OUTBOX_TOPIC_ROLES,
  registerConsumerTopic,
  registerDrainOnlyTopics,
} from "../src/outbox/topic-catalog.js";

/** 主题角色完整性门禁：新增契约主题而不登记角色时，CI 必须失败。 */
describe("Outbox 主题角色清单（完整性门禁）", () => {
  it("29 个契约主题全部显式登记，consumer / drain-only 各归其位", () => {
    expect(OUTBOX_TOPICS).toHaveLength(29);
    expect(Object.keys(OUTBOX_TOPIC_ROLES).sort()).toEqual([...OUTBOX_TOPICS].sort());
    expect(OUTBOX_CONSUMER_TOPICS).toHaveLength(11);
    expect(OUTBOX_DRAIN_ONLY_TOPICS).toHaveLength(18);
  });

  it("consumer 与 drain-only 不重叠且无遗漏（集合并集 = OUTBOX_TOPICS）", () => {
    const consumer = new Set<OutboxTopic>(OUTBOX_CONSUMER_TOPICS);
    const drainOnly = new Set<OutboxTopic>(OUTBOX_DRAIN_ONLY_TOPICS);
    const overlap = [...consumer].filter((topic) => drainOnly.has(topic));
    const union = new Set<OutboxTopic>([...consumer, ...drainOnly]);

    expect(overlap).toEqual([]);
    expect([...union].sort()).toEqual([...OUTBOX_TOPICS].sort());
  });

  it("规则事件主题必须继续有业务消费者；五类历史积压主题归 drain-only", () => {
    for (const topic of RULE_EVENT_TOPICS) {
      expect(OUTBOX_TOPIC_ROLES[topic]).toBe("consumer");
    }
    for (const topic of ["task.created", "file.version.created", "project.created", "issue.created", "task.deleted"] as const) {
      expect(OUTBOX_TOPIC_ROLES[topic]).toBe("drain_only");
    }
  });

  it("drain-only handler 只确认完成，不产生业务结果", async () => {
    const handler = createDrainOnlyHandler();

    await expect(
      handler.handle({
        id: 1,
        topic: "task.created",
        payload: { taskId: "t-1" },
        dedupeKey: "task.created:t-1:v1",
        attempts: 0,
        availableAt: new Date("2026-10-19T00:00:00Z"),
        lockedAt: new Date("2026-10-19T00:00:00Z"),
        createdAt: new Date("2026-10-19T00:00:00Z"),
      }),
    ).resolves.toEqual({ outcome: "done" });
  });

  it("业务消费者登记：drain-only 主题 / 重复登记均 fail fast", () => {
    const registry = new Map<OutboxTopic, ReturnType<typeof createDrainOnlyHandler>>();

    expect(() => registerConsumerTopic(registry, "task.created", createDrainOnlyHandler())).toThrow(
      "Outbox 主题角色冲突：task.created 未登记为 consumer",
    );

    registerConsumerTopic(registry, "task.updated", createDrainOnlyHandler());
    expect(() => registerConsumerTopic(registry, "task.updated", createDrainOnlyHandler())).toThrow(
      "Outbox 消费者重复登记：task.updated",
    );
  });

  it("drain-only 全量登记：不得覆盖已有业务消费者", () => {
    const registry = new Map([["task.created" as OutboxTopic, createDrainOnlyHandler()]]);

    expect(() => registerDrainOnlyTopics(registry)).toThrow(
      "Outbox 主题角色冲突：task.created 既有业务消费者，不能按 drain-only 登记",
    );
  });
});
