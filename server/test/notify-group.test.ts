/**
 * 群播报消费回归（M5-03-2 接线段 · outbox 主题 notify.group）：载荷解析 / markdown 组装与字节截断、
 * 消费三分类（ok / rate_limited / retryable / permanent → done / deferred / retry / dead + 投递留痕）、
 * 无绑定与停用收敛、回调 ingest（会话激活置位）。仓储 / 长连接 / 时钟全替身，不连库、不发帧。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import type {
  WecomGroupCandidateRow,
  WecomGroupRow,
} from "../src/modules/notify/notify.group.repository.js";
import { areAllProjectTasksOnTime } from "../src/modules/notify/notify.group.repository.js";
import {
  composeGroupMarkdown,
  GROUP_DEGRADE_PREFIX,
  GROUP_MARKDOWN_MAX_BYTES,
  GROUP_NAME_COMMAND_HINT,
  GROUP_TRUNCATION_SUFFIX,
  maskChatid,
  NotifyGroupService,
  parseGroupMessage,
  parseGroupNameCommand,
  truncateGroupMarkdown,
} from "../src/modules/notify/notify.group.service.js";
import type { AibotIncomingMessage, AibotSendResult, WecomAibotClient } from "../src/modules/notify/wecom.aibot.js";
import { FakeNotifyDeliveryArchive } from "./fakes/notify-delivery-archive.fake.js";

const AT = new Date("2026-10-12T06:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_2 = "22222222-2222-4222-8222-222222222222";
const CHATID = "AbcDefGhiJkLmNoPqrStUv-12";

function groupRow(overrides: Partial<WecomGroupRow> & { projectId: string; chatid: string }): WecomGroupRow {
  return {
    id: 1,
    name: null,
    enabled: true,
    activatedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class FakeGroupRepository {
  readonly archive = new FakeNotifyDeliveryArchive();
  groups: WecomGroupRow[] = [];

  get deliveries() {
    return this.archive.attempts;
  }
  activateCalls: { chatid: string; at: Date }[] = [];
  candidates: WecomGroupCandidateRow[] = [];
  observeCalls: { chatid: string; name: string | null; at: Date }[] = [];
  managers = new Map<string, string>();
  allTasksOnTime = false;
  setNameCalls: { chatid: string; name: string; at: Date }[] = [];

  async findGroupByProject(projectId: string): Promise<WecomGroupRow | null> {
    return this.groups.find((row) => row.projectId === projectId) ?? null;
  }

  async findGroupByChatid(chatid: string): Promise<WecomGroupRow | null> {
    return this.groups.find((row) => row.chatid === chatid) ?? null;
  }

  async activateByChatid(chatid: string, at: Date): Promise<WecomGroupRow | null> {
    this.activateCalls.push({ chatid, at });
    const row = this.groups.find((item) => item.chatid === chatid && item.activatedAt === null);
    if (row === undefined) {
      return null;
    }
    row.activatedAt = at;
    return row;
  }

  async observeCandidate(input: { chatid: string; name: string | null }, at: Date): Promise<WecomGroupCandidateRow> {
    this.observeCalls.push({ ...input, at });
    const existing = this.candidates.find((row) => row.chatid === input.chatid);
    if (existing !== undefined) {
      existing.name = input.name ?? existing.name;
      existing.lastSeenAt = at;
      return existing;
    }
    const row: WecomGroupCandidateRow = {
      id: this.candidates.length + 1,
      chatid: input.chatid,
      name: input.name,
      firstSeenAt: at,
      lastSeenAt: at,
    };
    this.candidates.push(row);
    return row;
  }

  async setGroupName(chatid: string, name: string, at: Date): Promise<WecomGroupRow | null> {
    this.setNameCalls.push({ chatid, name, at });
    const row = this.groups.find((item) => item.chatid === chatid);
    if (row === undefined) {
      return null;
    }
    row.name = name;
    row.updatedAt = at;
    return row;
  }

  async findProjectManagerId(projectId: string): Promise<string | null> {
    return this.managers.get(projectId) ?? null;
  }

  async areProjectTasksAllOnTime(): Promise<boolean> {
    return this.allTasksOnTime;
  }

}

class FakeAibot {
  sends: { chatid: string; content: string; groupActivated?: boolean | null }[] = [];
  imageSends: {
    chatid: string;
    content: Buffer;
    fileName: string;
    mime?: string | null;
    groupActivated?: boolean | null;
  }[] = [];
  replies: { reqId: string; userid: string; content: string; chatid?: string | null }[] = [];
  result: AibotSendResult = { ok: true, attempts: 1 };
  imageResult: AibotSendResult = { ok: true, attempts: 1 };

  async replyToCallback(params: {
    reqId: string;
    userid: string;
    content: string;
    chatid?: string | null;
  }): Promise<AibotSendResult> {
    this.replies.push(params);
    return this.result;
  }

  async sendGroupMarkdown(params: {
    chatid: string;
    content: string;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.sends.push(params);
    return this.result;
  }

  async sendGroupImage(params: {
    chatid: string;
    content: Buffer;
    fileName: string;
    mime?: string | null;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.imageSends.push(params);
    return this.imageResult;
  }
}

/** C5-04 降级站内信替身（NotifyService.deliverInboxCopy 端口）。 */
class FakeNotifyInbox {
  copies: { message: Record<string, unknown>; topic: string; dedupeKey: string }[] = [];
  fail = false;

  async deliverInboxCopy(
    message: Record<string, unknown>,
    topic: string,
    dedupeKey: string,
  ): Promise<{ duplicate: boolean }> {
    if (this.fail) {
      throw new Error("fake 站内信写库失败");
    }
    this.copies.push({ message, topic, dedupeKey });
    return { duplicate: false };
  }
}

function makeService(r06ImagePath = "", r06OnTimeImagePath = ""): {
  service: NotifyGroupService;
  repo: FakeGroupRepository;
  aibot: FakeAibot;
  inbox: FakeNotifyInbox;
  archive: FakeNotifyDeliveryArchive;
} {
  const repo = new FakeGroupRepository();
  const aibot = new FakeAibot();
  const inbox = new FakeNotifyInbox();
  const clock = new ClockService();
  clock.setSource(() => AT);
  const service = new NotifyGroupService(
    repo as never,
    repo.archive as never,
    aibot as unknown as WecomAibotClient,
    inbox as never,
    clock,
    { env: { WECOM_R06_IMAGE_PATH: r06ImagePath, WECOM_R06_ON_TIME_IMAGE_PATH: r06OnTimeImagePath } } as never,
  );
  return { service, repo, aibot, inbox, archive: repo.archive };
}

function claimedRow(payload: Record<string, unknown>, overrides: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow {
  return {
    id: 7,
    topic: "notify.group",
    payload,
    dedupeKey: "R03:t-1:2026-09-24",
    attempts: 0,
    availableAt: AT,
    lockedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectId: PROJECT_ID, title: "任务节点完成", body: "**节点**：到货验收\n负责人：张工", ...overrides };
}

function incoming(overrides: Partial<AibotIncomingMessage> = {}): AibotIncomingMessage {
  return {
    cmd: "aibot_msg_callback",
    reqId: null,
    chatid: CHATID,
    chattype: "group",
    fromUserId: "user1",
    msgid: "m1",
    msgtype: "event",
    text: null,
    eventType: null,
    ...overrides,
  };
}

// ---------- 载荷解析 / markdown 组装 / 截断 ----------

describe("parseGroupMessage / composeGroupMarkdown / truncateGroupMarkdown（纯函数）", () => {
  it("解析：合法载荷 trim 归一；title 可空；refType / refId 允许省略", () => {
    const parsed = parseGroupMessage(payload({ title: "  标题  ", body: "  正文  ", refType: "task", refId: PROJECT_2 }));
    expect(parsed).toEqual({
      projectId: PROJECT_ID,
      title: "标题",
      body: "正文",
      refType: "task",
      refId: PROJECT_2,
      templateCode: null,
    });
    expect(parseGroupMessage(payload({ title: null }))?.title).toBeNull();
  });

  it("解析：非法载荷 → null（缺 projectId / body / refType-refId 不成对 / 超长）", () => {
    expect(parseGroupMessage({})).toBeNull();
    expect(parseGroupMessage({ projectId: PROJECT_ID })).toBeNull();
    expect(parseGroupMessage(payload({ refType: "task", refId: null }))).toBeNull();
    expect(parseGroupMessage(payload({ refId: "not-a-uuid" }))).toBeNull();
    expect(parseGroupMessage(payload({ body: "x".repeat(4001) }))).toBeNull();
    expect(parseGroupMessage(payload({ title: "   " }))).toBeNull();
    // title 键按契约必填（可 null；产出端显式携带）：缺键 = 载荷非法
    expect(parseGroupMessage({ projectId: PROJECT_ID, body: "正文" })).toBeNull();
  });

  it("组装：无标题只发正文；有标题加粗 + 空行分隔", () => {
    expect(composeGroupMarkdown({ title: null, body: "正文" })).toBe("正文");
    expect(composeGroupMarkdown({ title: "标题", body: "正文" })).toBe("**标题**\n\n正文");
  });

  it("截断：未超长原样；超长按字节截断 + 尾部省略标记，不劈开多字节字符", () => {
    const short = "短消息";
    expect(truncateGroupMarkdown(short)).toEqual({ content: short, truncated: false });

    const long = "汉".repeat(10_000);
    const result = truncateGroupMarkdown(long);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(GROUP_MARKDOWN_MAX_BYTES);
    expect(result.content.endsWith(GROUP_TRUNCATION_SUFFIX)).toBe(true);
    expect(result.content.includes("\uFFFD")).toBe(false);
    // 截断点前后为完整「汉」字（3 字节/字）：前缀长度必为 3 的倍数
    const prefix = result.content.slice(0, result.content.length - GROUP_TRUNCATION_SUFFIX.length);
    expect(Buffer.byteLength(prefix, "utf8") % 3).toBe(0);
  });

  it("掩码 = **** + 末 4 位", () => {
    expect(maskChatid(CHATID)).toBe("****v-12");
  });
});

// ---------- 群名命令 ----------

describe("parseGroupNameCommand（群内群名命令）", () => {
  it("支持冒号 / 空格 / 设置前缀 / 前置提及", () => {
    expect(parseGroupNameCommand("群名：美国仓储项目群")).toEqual({ kind: "set", name: "美国仓储项目群" });
    expect(parseGroupNameCommand("群名 美国仓储项目群")).toEqual({ kind: "set", name: "美国仓储项目群" });
    expect(parseGroupNameCommand("设置群名：美国仓储项目群")).toEqual({ kind: "set", name: "美国仓储项目群" });
    expect(parseGroupNameCommand("@机器人 群名：美国仓储项目群")).toEqual({ kind: "set", name: "美国仓储项目群" });
    expect(parseGroupNameCommand("<@user1> 群名称 美国仓储项目群")).toEqual({ kind: "set", name: "美国仓储项目群" });
  });

  it("非命令不误判：群名叫什么 / 普通聊天 / 空名", () => {
    expect(parseGroupNameCommand("群名叫什么")).toBeNull();
    expect(parseGroupNameCommand("大家好")).toBeNull();
    expect(parseGroupNameCommand("群名")).toEqual({ kind: "invalid", reason: "missing" });
    expect(parseGroupNameCommand("群名：")).toEqual({ kind: "invalid", reason: "missing" });
  });

  it("超过 64 字符：invalid too_long", () => {
    expect(parseGroupNameCommand("群名：" + "汉".repeat(65))).toEqual({ kind: "invalid", reason: "too_long" });
  });
});

// ---------- 消费三分类 ----------

describe("NotifyGroupService.consume（outbox notify.group → 投递 → 三分类）", () => {
  it("ok：发送受理 → done + sent 行（sentAt 非空 / error 为空 / attempts=1）", async () => {
    const { service, repo, aibot, archive } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));

    const outcome = await service.consume(claimedRow(payload({ title: null })));

    expect(outcome).toEqual({ outcome: "done" });
    expect(aibot.sends[0]).toMatchObject({ chatid: CHATID, content: payload()["body"], groupActivated: true });
    expect(repo.deliveries).toEqual([
      expect.objectContaining({ outboxId: 7, target: CHATID, state: "sent", attempts: 1, error: null, sentAt: AT }),
    ]);
    expect(archive.messages[0]).toMatchObject({
      sourceDedupeKey: "R03:t-1:2026-09-24",
      topic: "notify.group",
      channel: "wecom_group",
      recipientId: null,
      recipientLabel: "project:" + PROJECT_ID + " · " + maskChatid(CHATID),
      ruleCode: "R03",
      lastState: "sent",
      attemptCount: 1,
      sentAt: AT,
    });
    expect(archive.attempts[0]).toMatchObject({ messageId: archive.messages[0]!.id, channel: "wecom_group" });
  });

  it("重复消费：归档已 sent → done，不再发起第二次群消息", async () => {
    const { service, repo, aibot, archive } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));

    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });
    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });

    expect(aibot.sends).toHaveLength(1);
    expect(archive.messages).toHaveLength(1);
    expect(archive.attempts).toHaveLength(1);
  });

  it("归档失败：不发群消息，交 outbox retry", async () => {
    const { service, repo, aibot, archive } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));
    archive.failEnsure = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry", error: expect.stringContaining("归档失败") });
    expect(aibot.sends).toEqual([]);
    expect(repo.deliveries).toEqual([]);
  });

  it("rate_limited：deferred 延期重排（availableAt = retryAt；attempts 不消耗）+ deferred 行", async () => {
    const { service, repo, aibot } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    const retryAt = new Date(AT.getTime() + 30_000);
    aibot.result = {
      ok: false,
      kind: "rate_limited",
      errcode: null,
      errmsg: "本地限速桶已满（31/30）",
      retryAt,
      attempts: 0,
      state: "subscribed",
    };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "deferred", availableAt: retryAt });
    expect(repo.deliveries[0]).toMatchObject({ state: "deferred", attempts: 0, sentAt: null });
    expect(repo.deliveries[0]!.error).toContain("群播报未送达：本地限速桶已满（31/30）");
  });

  it("rate_limited 无 retryAt（846607 超频）→ 兜底 now+60s", async () => {
    const { service, repo, aibot } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    aibot.result = { ok: false, kind: "rate_limited", errcode: 846607, errmsg: "frequency limit", retryAt: null, attempts: 1, state: "subscribed" };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "deferred" });
    if (outcome.outcome === "deferred") {
      expect(outcome.availableAt.getTime()).toBe(AT.getTime() + 60_000);
    }
  });

  it("retryable：failed 行 + retry（连接未就绪 / 回执超时）", async () => {
    const { service, repo, aibot } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    aibot.result = { ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪（state=connecting）", retryAt: null, attempts: 0, state: "connecting" };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry" });
    expect(repo.deliveries[0]).toMatchObject({ state: "failed", attempts: 0, sentAt: null });
  });

  it("permanent（846607 未激活）：dead 行 + dead + B4 降级项目经理站内信（播报类型 + 幂等键后缀）", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    repo.managers.set(PROJECT_ID, PROJECT_2);
    aibot.result = { ok: false, kind: "permanent", errcode: 846607, errmsg: "send msg not allowed", retryAt: null, attempts: 1, state: "subscribed" };

    const outcome = await service.consume(claimedRow(payload({ templateCode: "A02_GROUP" })));

    expect(outcome).toMatchObject({ outcome: "dead" });
    if (outcome.outcome === "dead") {
      expect(outcome.error).toContain("846607");
    }
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", attempts: 1, sentAt: null });
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.topic).toBe("notify.group");
    expect(inbox.copies[0]!.dedupeKey).toBe("R03:t-1:2026-09-24:c504");
    expect(inbox.copies[0]!.message).toMatchObject({ recipientId: PROJECT_2, type: "broadcast" });
    expect(String(inbox.copies[0]!.message.body).startsWith(GROUP_DEGRADE_PREFIX)).toBe(true);
  });

  it("无绑定：dead + 不写投递行（target NOT NULL 无值可落 · 差异登记②）+ B4 降级项目经理站内信", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.managers.set(PROJECT_ID, PROJECT_2);

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect(repo.deliveries).toEqual([]);
    expect(aibot.sends).toEqual([]);
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.message).toMatchObject({ recipientId: PROJECT_2, type: "reminder" });
  });

  it("绑定停用：dead 行（target=chatid）+ dead，不发送 + B4 降级", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, enabled: false }));
    repo.managers.set(PROJECT_ID, PROJECT_2);

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: CHATID, attempts: 0 });
    expect(aibot.sends).toEqual([]);
    expect(inbox.copies).toHaveLength(1);
  });

  it("降级：PM 解析不到（项目软删 / 不存在）→ 跳过站内信，仍 dead", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    aibot.result = { ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect(inbox.copies).toEqual([]);
  });

  it("降级站内信写库失败：retry 收敛（不静默丢消息）", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
    repo.managers.set(PROJECT_ID, PROJECT_2);
    aibot.result = { ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" };
    inbox.fail = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry" });
    if (outcome.outcome === "retry") {
      expect(outcome.error).toContain("降级站内信失败");
    }
  });

  it("非法载荷：dead（不读绑定、不发送）", async () => {
    const { service, repo, aibot } = makeService();

    const outcome = await service.consume(claimedRow({ projectId: "not-a-uuid", body: "b" }));

    expect(outcome).toMatchObject({ outcome: "dead" });
    expect(repo.deliveries).toEqual([]);
    expect(aibot.sends).toEqual([]);
  });


  it("markdown 组装：有标题 → 加粗 + 空行（发送内容逐字）", async () => {
    const { service, repo, aibot } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));

    await service.consume(claimedRow(payload()));

    expect(aibot.sends[0]!.content).toBe("**任务节点完成**\n\n**节点**：到货验收\n负责人：张工");
  });

  it("R06 按时交付判定：无任务 / 未完成 / 延期 / 缺完成日均不放行", () => {
    const at = new Date("2026-10-20T02:00:00.000Z");
    const row = (overrides: Partial<{ status: string; plannedEnd: string | null; actualEnd: string | null; onTime: boolean | null }> = {}) => ({
      status: "done",
      plannedEnd: "2026-10-19",
      actualEnd: "2026-10-19",
      onTime: null,
      ...overrides,
    });

    expect(areAllProjectTasksOnTime([], at)).toBe(false);
    expect(areAllProjectTasksOnTime([row(), row({ actualEnd: "2026-10-18" })], at)).toBe(true);
    expect(areAllProjectTasksOnTime([row(), row({ actualEnd: "2026-10-20" })], at)).toBe(false);
    expect(areAllProjectTasksOnTime([row({ status: "active" })], at)).toBe(false);
    expect(areAllProjectTasksOnTime([row({ actualEnd: null, plannedEnd: "2026-10-19", onTime: true })], at)).toBe(false);
    expect(areAllProjectTasksOnTime([row({ actualEnd: null, plannedEnd: null, onTime: true })], at)).toBe(true);
  });

  it("R06_GROUP：文字送达后追加配置的喜报海报，投递记录累计两条消息", async () => {
    const dir = mkdtempSync(join(tmpdir(), "libiaolink-r06-"));
    const file = join(dir, "喜报.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    try {
      const { service, repo, aibot } = makeService(file);
      repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));

      const outcome = await service.consume(
        claimedRow(payload({ templateCode: "R06_GROUP", title: "叮咚~喜报来啦！", body: "项目圆满完成" })),
      );

      expect(outcome).toEqual({ outcome: "done" });
      expect(aibot.sends).toHaveLength(1);
      expect(aibot.imageSends).toHaveLength(1);
      expect(aibot.imageSends[0]).toMatchObject({
        chatid: CHATID,
        fileName: "喜报.png",
        mime: "image/png",
        groupActivated: true,
      });
      expect(repo.deliveries[0]).toMatchObject({ state: "sent", attempts: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R06_GROUP：全部任务按时交付时优先使用按时交付喜报图", async () => {
    const dir = mkdtempSync(join(tmpdir(), "libiaolink-r06-"));
    const fallbackFile = join(dir, "验收.gif");
    const onTimeFile = join(dir, "按时.gif");
    const gifHeader = Buffer.from("GIF89a", "ascii");
    writeFileSync(fallbackFile, gifHeader);
    writeFileSync(onTimeFile, gifHeader);
    try {
      const { service, repo, aibot } = makeService(fallbackFile, onTimeFile);
      repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));
      repo.allTasksOnTime = true;

      const outcome = await service.consume(
        claimedRow(payload({ templateCode: "R06_GROUP", title: "叮咚~喜报来啦！", body: "项目圆满完成" })),
      );

      expect(outcome).toEqual({ outcome: "done" });
      expect(aibot.imageSends).toHaveLength(1);
      expect(aibot.imageSends[0]).toMatchObject({ fileName: "按时.gif", mime: "image/gif" });
      expect(repo.deliveries[0]).toMatchObject({ state: "sent", attempts: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R06_GROUP 图片失败不回滚已送达文字：仍 done + sent，图片仅留日志", async () => {
    const dir = mkdtempSync(join(tmpdir(), "libiaolink-r06-"));
    const file = join(dir, "喜报.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    try {
      const { service, repo, aibot } = makeService(file);
      repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));
      aibot.imageResult = {
        ok: false,
        kind: "retryable",
        errcode: null,
        errmsg: "素材上传初始化回执超时",
        retryAt: null,
        attempts: 0,
        state: "subscribed",
      };

      const outcome = await service.consume(claimedRow(payload({ templateCode: "R06_GROUP" })));

      expect(outcome).toEqual({ outcome: "done" });
      expect(aibot.sends).toHaveLength(1);
      expect(aibot.imageSends).toHaveLength(1);
      expect(repo.deliveries[0]).toMatchObject({ state: "sent", attempts: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 回调 ingest ----------

describe("NotifyGroupService.activateFromCallback（群回调 ingest）", () => {
  it("未激活绑定：置位（activated_at = 回调时刻），不写候选", async () => {
    const { service, repo } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));

    await service.activateFromCallback(incoming());

    expect(repo.activateCalls).toHaveLength(1);
    expect(repo.groups[0]!.activatedAt).toEqual(AT);
    expect(repo.observeCalls).toEqual([]);
  });

  it("已激活绑定：幂等跳过", async () => {
    const { service, repo } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, activatedAt: AT }));

    await service.activateFromCallback(incoming());

    expect(repo.activateCalls).toHaveLength(0);
    expect(repo.observeCalls).toEqual([]);
  });

  it("未绑定群：写入候选（群名 trim），不激活", async () => {
    const { service, repo } = makeService();

    await service.activateFromCallback(incoming({ chatName: "  项目交付群  " }));

    expect(repo.activateCalls).toHaveLength(0);
    expect(repo.observeCalls).toEqual([{ chatid: CHATID, name: "项目交付群", at: AT }]);
    expect(repo.candidates).toEqual([
      { id: 1, chatid: CHATID, name: "项目交付群", firstSeenAt: AT, lastSeenAt: AT },
    ]);
  });

  it("同群重复回调：候选幂等 upsert（同 id、刷新 lastSeenAt、保留首次时间）", async () => {
    const { service, repo } = makeService();

    await service.activateFromCallback(incoming({ chatName: "项目群" }));
    const firstSeenAt = repo.candidates[0]!.firstSeenAt;
    await service.activateFromCallback(incoming({ chatName: "" }));

    expect(repo.candidates).toHaveLength(1);
    expect(repo.candidates[0]).toMatchObject({ id: 1, name: "项目群", firstSeenAt, lastSeenAt: AT });
  });

  it("非群消息回调（事件 / 单聊 / 无 chatid / 非法 chatid）：全部忽略", async () => {
    const { service, repo } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));

    await service.activateFromCallback(incoming({ cmd: "aibot_event_callback" }));
    await service.activateFromCallback(incoming({ chattype: "single" }));
    await service.activateFromCallback(incoming({ chatid: null }));
    await service.activateFromCallback(incoming({ chatid: "bad id" }));

    expect(repo.activateCalls).toHaveLength(0);
    expect(repo.observeCalls).toEqual([]);
  });

  it("未绑定群 + 群名命令：候选名落库并回执", async () => {
    const { service, repo, aibot } = makeService();

    await service.activateFromCallback(incoming({ msgtype: "text", text: "群名：美国仓储项目群", reqId: "req-1" }));

    expect(repo.observeCalls).toEqual([{ chatid: CHATID, name: "美国仓储项目群", at: AT }]);
    expect(repo.candidates[0]).toMatchObject({ name: "美国仓储项目群" });
    expect(repo.activateCalls).toEqual([]);
    expect(aibot.replies).toHaveLength(1);
    expect(aibot.replies[0]).toMatchObject({ reqId: "req-1", chatid: CHATID });
    expect(aibot.replies[0]!.content).toContain("群名已记录：美国仓储项目群");
  });

  it("已绑定群 + 群名命令：更新绑定名并回执", async () => {
    const { service, repo, aibot } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID, name: "旧名", activatedAt: AT }));

    await service.activateFromCallback(incoming({ msgtype: "text", text: "设置群名 新名称", reqId: "req-2" }));

    expect(repo.setNameCalls).toEqual([{ chatid: CHATID, name: "新名称", at: AT }]);
    expect(repo.groups[0]!.name).toBe("新名称");
    expect(repo.activateCalls).toEqual([]);
    expect(aibot.replies[0]!.content).toBe("群名已更新：新名称");
  });

  it("已绑定未激活 + 群名命令：激活并更新名称", async () => {
    const { service, repo } = makeService();
    repo.groups.push(groupRow({ projectId: PROJECT_ID, chatid: CHATID }));

    await service.activateFromCallback(incoming({ msgtype: "text", text: "群名：新名称" }));

    expect(repo.activateCalls).toHaveLength(1);
    expect(repo.groups[0]!.activatedAt).toEqual(AT);
    expect(repo.groups[0]!.name).toBe("新名称");
  });

  it("群名超长：候选不写名，回执提示 64 字符", async () => {
    const { service, repo, aibot } = makeService();

    await service.activateFromCallback(incoming({ msgtype: "text", text: "群名：" + "汉".repeat(65), reqId: "req-3" }));

    expect(repo.observeCalls[0]!.name).toBeNull();
    expect(aibot.replies[0]!.content).toContain("最多 64 个字符");
  });

  it("群名命令缺名称：候选不写名，回执用法", async () => {
    const { service, repo, aibot } = makeService();

    await service.activateFromCallback(incoming({ msgtype: "text", text: "群名", reqId: "req-4" }));

    expect(repo.observeCalls[0]!.name).toBeNull();
    expect(aibot.replies[0]!.content).toBe(GROUP_NAME_COMMAND_HINT);
  });

  it("普通群聊：只登记候选，不回执", async () => {
    const { service, repo, aibot } = makeService();

    await service.activateFromCallback(incoming({ msgtype: "text", text: "大家好", reqId: "req-5" }));

    expect(repo.observeCalls[0]!.name).toBeNull();
    expect(aibot.replies).toEqual([]);
  });

  it("无 reqId：名称仍落库但不回执", async () => {
    const { service, repo, aibot } = makeService();

    await service.activateFromCallback(incoming({ msgtype: "text", text: "群名：美国仓储项目群" }));

    expect(repo.observeCalls[0]!.name).toBe("美国仓储项目群");
    expect(aibot.replies).toEqual([]);
  });
});
