import { describe, expect, it } from "vitest";
import { OUTBOX_TOPICS, type OutboxTopic } from "@libiaolink/contracts";
import { assertOutboxLanePartition, buildOutboxLanes } from "../src/outbox/lanes.js";

/** Outbox 通道划分门禁：主题必须恰好进入一个通道，通知 / 预览与通用通道互不牵连。 */
describe("Outbox 消费通道划分", () => {
  it("三个通道的并集 = 已注册主题，且互不重叠", () => {
    const lanes = buildOutboxLanes(OUTBOX_TOPICS);
    const notify = lanes.find((lane) => lane.name === "notify");
    const preview = lanes.find((lane) => lane.name === "preview");
    const general = lanes.find((lane) => lane.name === "general");
    const assigned = lanes.flatMap((lane) => lane.topics);

    expect([...lanes.map((lane) => lane.name)].sort()).toEqual(["general", "notify", "preview"]);
    expect([...notify!.topics].sort()).toEqual(["notify.group", "notify.message"]);
    expect(preview!.topics).toEqual(["preview.job"]);
    expect(new Set(assigned).size).toBe(OUTBOX_TOPICS.length);
    expect([...assigned].sort()).toEqual([...OUTBOX_TOPICS].sort());
    expect(general!.topics).not.toContain("notify.message");
    expect(general!.topics).not.toContain("notify.group");
    expect(general!.topics).not.toContain("preview.job");
  });

  it("关闭预览 / 通知后只划分已注册主题：对应通道为空，不影响通用通道", () => {
    const registered = OUTBOX_TOPICS.filter(
      (topic) => topic !== "preview.job" && topic !== "notify.message" && topic !== "notify.group",
    );
    const lanes = buildOutboxLanes(registered);

    expect(lanes.find((lane) => lane.name === "notify")!.topics).toEqual([]);
    expect(lanes.find((lane) => lane.name === "preview")!.topics).toEqual([]);
    expect(lanes.find((lane) => lane.name === "general")!.topics).toHaveLength(registered.length);
  });

  it("输入去重并排序；未知主题不会凭空进入通道", () => {
    const topic: OutboxTopic = "task.updated";
    const lanes = buildOutboxLanes([topic, topic]);

    expect(lanes.flatMap((lane) => lane.topics)).toEqual([topic]);
  });

  it("启动断言：重复归属或遗漏主题均 fail fast", () => {
    const topic: OutboxTopic = "task.updated";

    expect(() =>
      assertOutboxLanePartition([topic], [
        { name: "notify", topics: [topic] },
        { name: "general", topics: [topic] },
      ]),
    ).toThrow("Outbox 通道主题重复：" + topic);

    expect(() =>
      assertOutboxLanePartition([topic], [
        { name: "notify", topics: [] },
        { name: "general", topics: [] },
      ]),
    ).toThrow("Outbox 通道遗漏主题：" + topic);
  });
});
