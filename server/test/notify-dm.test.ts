/**
 * 单聊 aibot 消费 + 绑定码 ingest 回归（M5-03-5-3 实现段 · **M5-03-5-6 绑定码链路**）：
 * markdown 组装与字节截断、绑定码正文归一（纯函数）、消费三分类（ok / rate_limited / retryable / permanent
 * → done / deferred / retry / dead + 投递留痕）、**绑定行寻址**（无绑定行 → dead + D4 绑定指引降级；有绑定行
 * → 正常发帧）、激活表读（846607 分流传入态）与发送成功旁证回填（D4）、收件人不可投递收敛、渠道路由防御、
 * 绑定码 ingest（单聊发码 → 同事务写绑定 + 标记码已用 → 会话内回执；群聊 / 事件回调不绑定；码过期 / 已用 /
 * 已绑定 / 未命中各回执面）、取码（TTL / 频率限制 / 撞码重试）与绑定态读面。
 * 仓储 / 长连接客户端 / 站内信 / 时钟 / 配置全替身，不连库、不发帧。
 */
import { describe, expect, it } from "vitest";
import type { NotifyMessagePayload } from "@libiaolink/contracts";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { OutboxClaimedRow } from "../src/db/outbox.store.js";
import type { AuditRecordInput } from "../src/modules/audit/index.js";
import type {
  DmActivationRow,
  DmBindingGuardRow,
  DmBindingCodeRow,
  DmBindingRow,
  WecomDmContact,
} from "../src/modules/notify/notify.dm.repository.js";
import {
  composeDmMarkdown,
  DM_BINDING_FAILURE_LIMIT,
  DM_BINDING_FAILURE_WINDOW_MS,
  DM_BINDING_CODE_MAX_PER_WINDOW,
  DM_BINDING_CODE_WINDOW_MS,
  DM_BINDING_CODE_TTL_MS,
  DM_BINDING_DEGRADE_PREFIX,
  DM_BINDING_REPLY_BOUND,
  DM_BINDING_REPLY_INVALID,
  DM_BINDING_REPLY_LOCKED,
  DM_BINDING_LOCK_STEPS_MS,
  DM_DEGRADE_PREFIX,
  DM_DISABLED_DEGRADE_PREFIX,
  DM_MARKDOWN_MAX_BYTES,
  DM_TRUNCATION_SUFFIX,
  DM_WELCOME_MESSAGE,
  extractBindingCode,
  NotifyDmService,
  truncateDmMarkdown,
} from "../src/modules/notify/notify.dm.service.js";
import type { AibotIncomingMessage, AibotSendResult, WecomAibotClient } from "../src/modules/notify/wecom.aibot.js";
import { applyMarkdownHardBreaks } from "../src/modules/notify/wecom.text.js";
import { FakeNotifyDeliveryArchive } from "./fakes/notify-delivery-archive.fake.js";

const AT = new Date("2026-10-14T06:00:00.000Z");
const BEFORE = new Date("2026-10-14T05:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "aibTestBot0001";
const OPEN_USERID = "wosuIHCwAAseSgWSu-LuNOhnzP0vbmUw";
const CODE = "123456";

/** 绑定行 / 激活行在替身里的键：机器人维度 + 企微号（与 (bot_id, wecom_userid) 唯一键同形）。 */
function key(botId: string, wecomUserid: string): string {
  return botId + "|" + wecomUserid;
}

function emptyGuard(): DmBindingGuardRow {
  return {
    bindingFailCount: 0,
    bindingFailWindowStartedAt: null,
    bindingLockLevel: 0,
    bindingLockedUntil: null,
    lastBindingAttemptAt: null,
    lastBindingMsgid: null,
  };
}

class FakeDmRepository {
  readonly archive = new FakeNotifyDeliveryArchive();
  contacts = new Map<string, WecomDmContact>();
  activations = new Map<string, DmActivationRow>();
  bindings = new Map<string, { botId: string; wecomUserid: string; userId: string; boundAt: Date; messagesEnabled: boolean }>();
  codes = new Map<string, DmBindingCodeRow>();
  guards = new Map<string, DmBindingGuardRow>();
  get deliveries() {
    return this.archive.attempts;
  }
  upsertCalls: { botId: string; wecomUserid: string; at: Date }[] = [];
  backfillCalls: { botId: string; wecomUserid: string; userId: string; at: Date }[] = [];
  bindCalls: { codeId: number; userId: string; botId: string; wecomUserid: string; at: Date }[] = [];
  codeCreateCalls: { botId: string; userId: string; code: string; expiresAt: Date; at: Date }[] = [];
  findCodeCalls: { code: string; botId: string }[] = [];
  guardUpdates: DmBindingGuardRow[] = [];
  touchCalls: { botId: string; wecomUserid: string; at: Date; lastBindingMsgid: string | null }[] = [];
  /** 频率限制读面替身（窗口内已生成码的创建时刻）。 */
  issuedAt: Date[] = [];
  /** 前 N 次取码按「撞码」返回 false（重试路径）。 */
  codeConflicts = 0;
  /** 绑定占用失败（并发 / 恰过期）。 */
  bindFails = false;
  backfillFails = false;
  /** 解绑调用留痕（含事务 client —— 断言「与清绑定同事务」）。 */
  clearCalls: { botId: string; userId: string; at: Date; client?: unknown }[] = [];
  /** 消息开关调用留痕。 */
  messageToggleCalls: { botId: string; userId: string; messagesEnabled: boolean; at: Date }[] = [];
  /** 覆盖清除行数（null = 按实际清掉的行数返回）。 */
  clearOverride: number | null = null;
  private nextCodeId = 1;

  async findContact(userId: string): Promise<WecomDmContact | null> {
    return this.contacts.get(userId) ?? null;
  }

  async findActivation(wecomUserid: string, botId: string): Promise<DmActivationRow | null> {
    return this.activations.get(key(botId, wecomUserid)) ?? null;
  }

  async findBindingByUserId(userId: string, botId: string): Promise<DmBindingRow | null> {
    for (const row of this.bindings.values()) {
      if (row.botId === botId && row.userId === userId) {
        return row;
      }
    }
    return null;
  }

  async findBindingByWecomUserid(wecomUserid: string, botId: string): Promise<DmBindingRow | null> {
    return this.bindings.get(key(botId, wecomUserid)) ?? null;
  }

  async upsertActivationFromCallback(input: { botId: string; wecomUserid: string; at: Date }): Promise<void> {
    this.upsertCalls.push(input);
    const existing = this.activations.get(key(input.botId, input.wecomUserid));
    this.activations.set(key(input.botId, input.wecomUserid), {
      wecomUserid: input.wecomUserid,
      userId: existing?.userId ?? null,
      firstActivatedAt: existing?.firstActivatedAt ?? input.at,
      lastMessageAt: input.at,
    });
    if (!this.guards.has(key(input.botId, input.wecomUserid))) {
      this.guards.set(key(input.botId, input.wecomUserid), emptyGuard());
    }
  }

  async lockBindingGuard(botId: string, wecomUserid: string): Promise<DmBindingGuardRow> {
    const guardKey = key(botId, wecomUserid);
    const guard = this.guards.get(guardKey) ?? emptyGuard();
    this.guards.set(guardKey, guard);
    return guard;
  }

  async updateBindingGuard(input: {
    botId: string;
    wecomUserid: string;
    at: Date;
    bindingFailCount: number;
    bindingFailWindowStartedAt: Date | null;
    bindingLockLevel: number;
    bindingLockedUntil: Date | null;
    lastBindingMsgid: string | null;
  }): Promise<void> {
    const guardKey = key(input.botId, input.wecomUserid);
    const previous = this.guards.get(guardKey) ?? emptyGuard();
    const next = {
      bindingFailCount: input.bindingFailCount,
      bindingFailWindowStartedAt: input.bindingFailWindowStartedAt,
      bindingLockLevel: input.bindingLockLevel,
      bindingLockedUntil: input.bindingLockedUntil,
      lastBindingAttemptAt: input.at,
      lastBindingMsgid: input.lastBindingMsgid ?? previous.lastBindingMsgid,
    };
    this.guards.set(guardKey, next);
    this.guardUpdates.push(next);
  }

  async touchBindingAttempt(input: {
    botId: string;
    wecomUserid: string;
    at: Date;
    lastBindingMsgid: string | null;
  }): Promise<void> {
    this.touchCalls.push(input);
    const guardKey = key(input.botId, input.wecomUserid);
    const previous = this.guards.get(guardKey) ?? emptyGuard();
    this.guards.set(guardKey, {
      ...previous,
      lastBindingAttemptAt: input.at,
      lastBindingMsgid: input.lastBindingMsgid ?? previous.lastBindingMsgid,
    });
  }

  async backfillActivationOnSend(input: {
    botId: string;
    wecomUserid: string;
    userId: string;
    at: Date;
  }): Promise<void> {
    if (this.backfillFails) {
      throw new Error("fake 回填写库失败");
    }
    this.backfillCalls.push(input);
    const existing = this.activations.get(key(input.botId, input.wecomUserid));
    this.activations.set(key(input.botId, input.wecomUserid), {
      wecomUserid: input.wecomUserid,
      userId: existing?.userId ?? input.userId,
      firstActivatedAt: existing?.firstActivatedAt ?? input.at,
      lastMessageAt: existing?.lastMessageAt ?? input.at,
    });
  }

  async bindingCodesSince(userId: string, botId: string, since: Date): Promise<Date[]> {
    void botId;
    return this.issuedAt.filter((item) => item.getTime() >= since.getTime());
  }

  inboundStats = { inboundCount: 0, lastInboundAt: null as Date | null, lastInboundUserid: null as string | null };
  observedBots: { botId: string; inboundCount: number; lastInboundAt: Date | null }[] = [];

  async botInboundStats(): Promise<{ inboundCount: number; lastInboundAt: Date | null; lastInboundUserid: string | null }> {
    return this.inboundStats;
  }

  async observedBotIds(limit: number): Promise<{ botId: string; inboundCount: number; lastInboundAt: Date | null }[]> {
    return this.observedBots.slice(0, limit);
  }

  async createBindingCode(input: {
    botId: string;
    userId: string;
    code: string;
    expiresAt: Date;
    at: Date;
  }): Promise<boolean> {
    this.codeCreateCalls.push(input);
    if (this.codeConflicts > 0) {
      this.codeConflicts -= 1;
      return false;
    }
    this.codes.set(key(input.botId, input.code), {
      id: this.nextCodeId,
      botId: input.botId,
      code: input.code,
      userId: input.userId,
      status: "pending",
      expiresAt: input.expiresAt,
    });
    this.nextCodeId += 1;
    return true;
  }

  async findBindingCode(code: string, botId: string): Promise<DmBindingCodeRow | null> {
    this.findCodeCalls.push({ code, botId });
    return this.codes.get(key(botId, code)) ?? this.codes.get(code) ?? null;
  }

  /** 读面回填替身（v1.8）：该用户当前仍未失效的 pending 码（同一用户至多一条 —— 取 id 最大者）。 */
  async findPendingBindingCode(
    userId: string,
    botId: string,
    at: Date,
  ): Promise<{ code: string; expiresAt: Date } | null> {
    let found: { code: string; expiresAt: Date; id: number } | null = null;
    for (const row of this.codes.values()) {
      if (
        row.botId !== botId ||
        row.userId !== userId ||
        row.status !== "pending" ||
        row.expiresAt.getTime() <= at.getTime()
      ) {
        continue;
      }
      if (found === null || row.id > found.id) {
        found = { code: row.code, expiresAt: row.expiresAt, id: row.id };
      }
    }
    return found === null ? null : { code: found.code, expiresAt: found.expiresAt };
  }

  async bindWithCode(input: {
    codeId: number;
    userId: string;
    botId: string;
    wecomUserid: string;
    at: Date;
  }): Promise<boolean> {
    this.bindCalls.push(input);
    if (this.bindFails) {
      return false;
    }
    for (const row of this.codes.values()) {
      if (row.id === input.codeId && row.botId === input.botId) {
        row.status = "used";
      }
    }
    this.bindings.set(key(input.botId, input.wecomUserid), {
      botId: input.botId,
      wecomUserid: input.wecomUserid,
      userId: input.userId,
      boundAt: input.at,
      messagesEnabled: true,
    });
    return true;
  }

  async updateBindingMessagesEnabledByUserId(input: {
    botId: string;
    userId: string;
    messagesEnabled: boolean;
    at: Date;
  }): Promise<number> {
    this.messageToggleCalls.push(input);
    let changed = 0;
    for (const row of this.bindings.values()) {
      if (row.botId === input.botId && row.userId === input.userId) {
        row.messagesEnabled = input.messagesEnabled;
        changed += 1;
      }
    }
    return changed;
  }

  /** 解绑（D6）：清当前机器人下该用户的绑定行；`clearOverride` 复现「并发已清 → 清 0 行」竞态。 */
  async clearBindingByUserId(
    input: { botId: string; userId: string; at: Date },
    client?: unknown,
  ): Promise<number> {
    this.clearCalls.push({ ...input, client });
    let cleared = 0;
    for (const [entryKey, row] of this.bindings) {
      if (row.botId === input.botId && row.userId === input.userId) {
        this.bindings.delete(entryKey);
        cleared += 1;
      }
    }
    return this.clearOverride ?? cleared;
  }
}

class FakeAibot {
  sends: { userid: string; content: string; dmActivated?: boolean | null }[] = [];
  groupSends: { chatid: string; content: string; groupActivated?: boolean | null }[] = [];
  replies: { reqId: string; userid: string; content: string }[] = [];
  welcomes: { reqId: string; content: string }[] = [];
  result: AibotSendResult = { ok: true, attempts: 1 };
  replyResult: AibotSendResult = { ok: true, attempts: 1 };
  welcomeResult: AibotSendResult = { ok: true, attempts: 1 };

  async sendUserMarkdown(params: {
    userid: string;
    content: string;
    dmActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.sends.push(params);
    return this.result;
  }

  async sendGroupMarkdown(params: {
    chatid: string;
    content: string;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.groupSends.push(params);
    return this.result;
  }

  async replyToCallback(params: { reqId: string; userid: string; content: string }): Promise<AibotSendResult> {
    this.replies.push(params);
    return this.replyResult;
  }

  async replyWelcome(params: { reqId: string; content: string }): Promise<AibotSendResult> {
    this.welcomes.push(params);
    return this.welcomeResult;
  }
}

/** 审计替身（D6）：留痕 (client, input) —— client 同一性即「与清绑定同事务」的证据。 */
class FakeAudit {
  records: { client: unknown; input: AuditRecordInput }[] = [];

  async record(client: unknown, input: AuditRecordInput): Promise<void> {
    this.records.push({ client, input });
  }
}

/** 事务替身（DatabaseService.db）：单层事务直接跑回调，并把同一个 tx 交给仓储与审计。 */
class FakeDatabase {
  db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ tx: "stub" }),
  };
}

/** C5-04 降级站内信替身（NotifyService.deliverInboxCopy 端口）。 */
class FakeNotifyInbox {
  copies: { message: NotifyMessagePayload; topic: string; dedupeKey: string }[] = [];
  fail = false;

  async deliverInboxCopy(
    message: NotifyMessagePayload,
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

function makeService(envOverrides: Record<string, unknown> = {}): {
  service: NotifyDmService;
  repo: FakeDmRepository;
  aibot: FakeAibot;
  inbox: FakeNotifyInbox;
  audit: FakeAudit;
  clock: ClockService;
  archive: FakeNotifyDeliveryArchive;
} {
  const repo = new FakeDmRepository();
  const aibot = new FakeAibot();
  const inbox = new FakeNotifyInbox();
  const clock = new ClockService();
  clock.setSource(() => AT);
  const config = {
    env: {
      NODE_ENV: "development",
      WECOM_BOT_ID: BOT_ID,
      WECOM_BOT_SECRET: "aib-secret-0123456789",
      WECOM_BOT_WS_URL: "wss://openws.work.weixin.qq.com",
      WECOM_BOT_DIAGNOSTICS: "auto",
      NOTIFY_DELIVERY_ENABLED: "true",
      ...envOverrides,
    },
  };
  const audit = new FakeAudit();
  const database = new FakeDatabase();
  const service = new NotifyDmService(
    repo as never,
    repo.archive as never,
    aibot as unknown as WecomAibotClient,
    inbox as never,
    clock,
    config as never,
    audit as never,
    database as never,
  );
  return { service, repo, aibot, inbox, audit, clock, archive: repo.archive };
}

function contact(overrides: Partial<WecomDmContact> = {}): WecomDmContact {
  return { id: USER_ID, status: "active", removedAt: null, ...overrides };
}

function activation(overrides: Partial<DmActivationRow> = {}): DmActivationRow {
  return { wecomUserid: OPEN_USERID, userId: null, firstActivatedAt: BEFORE, lastMessageAt: BEFORE, ...overrides };
}

function binding(overrides: Partial<DmBindingRow> = {}): DmBindingRow {
  return { wecomUserid: OPEN_USERID, userId: USER_ID, boundAt: BEFORE, messagesEnabled: true, ...overrides };
}

function codeRow(overrides: Partial<DmBindingCodeRow> = {}): DmBindingCodeRow {
  return {
    id: 7,
    botId: BOT_ID,
    code: CODE,
    userId: USER_ID,
    status: "pending",
    expiresAt: new Date(AT.getTime() + 60_000),
    ...overrides,
  };
}

/** 已绑定（可投递）的消费场景：联系人 + 绑定行齐备。 */
function makeBoundService(): ReturnType<typeof makeService> {
  const made = makeService();
  made.repo.contacts.set(USER_ID, contact());
  made.repo.bindings.set(key(BOT_ID, OPEN_USERID), {
    botId: BOT_ID,
    wecomUserid: OPEN_USERID,
    userId: USER_ID,
    boundAt: BEFORE,
    messagesEnabled: true,
  });
  return made;
}

function claimedRow(payload: Record<string, unknown>, overrides: Partial<OutboxClaimedRow> = {}): OutboxClaimedRow {
  return {
    id: 11,
    topic: "notify.message",
    payload,
    dedupeKey: "R02:t-1:v5:aibot",
    attempts: 0,
    availableAt: AT,
    lockedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipientId: USER_ID,
    type: "reminder",
    channel: "wecom_aibot",
    title: "任务节点完成",
    body: "节点：到货验收 负责人：张工",
    ...overrides,
  };
}

function permanent(errcode: number, errmsg: string): AibotSendResult {
  return { ok: false, kind: "permanent", errcode, errmsg, retryAt: null, attempts: 1, state: "subscribed" };
}

function incoming(overrides: Partial<AibotIncomingMessage> = {}): AibotIncomingMessage {
  return {
    cmd: "aibot_msg_callback",
    reqId: "ReqIdCallback0001",
    chatid: null,
    chattype: "single",
    fromUserId: OPEN_USERID,
    msgid: "m1",
    msgtype: "text",
    text: "你好",
    eventType: null,
    ...overrides,
  };
}

/** 单聊发码回调（正文形态见实测量 E4：用户可能带「绑定」前缀、也可能不带空格）。 */
function codeIncoming(text: string = "绑定" + CODE): AibotIncomingMessage {
  return incoming({ text });
}

// ---------- markdown 组装 / 截断（纯函数） ----------

describe("composeDmMarkdown / truncateDmMarkdown（纯函数）", () => {
  it("组装：加粗标题 + 空行 + 正文（同群口径）", () => {
    expect(composeDmMarkdown({ title: "T", body: "B" })).toBe("**T**\n\nB");
  });

  it("组装：空白标题防御（仅正文）", () => {
    expect(composeDmMarkdown({ title: "  ", body: "B" })).toBe("B");
  });

  it("硬换行：单个 LF 补行尾双空格，空行分隔保持原样且重复调用幂等", () => {
    expect(applyMarkdownHardBreaks("a\nb")).toBe("a  \nb");
    expect(applyMarkdownHardBreaks("a\n\nb")).toBe("a\n\nb");
    expect(applyMarkdownHardBreaks("a  \nb")).toBe("a  \nb");
    expect(composeDmMarkdown({ title: "T", body: "第一行\n第二行" })).toBe("**T**\n\n第一行  \n第二行");
  });

  it("截断：超长按 UTF-8 字节截断（≤ 20000 字节 + 省略标记 + 不劈多字节）", () => {
    const truncated = truncateDmMarkdown("汉".repeat(30_000));

    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.content, "utf8")).toBeLessThanOrEqual(DM_MARKDOWN_MAX_BYTES);
    expect(truncated.content.endsWith(DM_TRUNCATION_SUFFIX)).toBe(true);
    expect(truncated.content.includes("\uFFFD")).toBe(false);
  });

  it("截断：未超长原样返回", () => {
    expect(truncateDmMarkdown("短消息")).toEqual({ content: "短消息", truncated: false });
  });
});

// ---------- 绑定码正文归一（纯函数） ----------

describe("extractBindingCode（正文归一取码 · 口径 §5）", () => {
  it("纯码 / 「绑定」前缀 / 带空格：均取 6 位数字", () => {
    expect(extractBindingCode("123456")).toBe("123456");
    expect(extractBindingCode("绑定123456")).toBe("123456");
    expect(extractBindingCode("  绑定 123456  ")).toBe("123456");
  });

  it("群聊 @机器人名 前缀容错（正文归一后仍取码 —— 但群聊回调在 ingest 层被排除）", () => {
    expect(extractBindingCode("@LibiaoLinkRobot 绑定 123456")).toBe("123456");
  });

  it("无码 / 位数不足 / 位数超出 / 数字串中间：null（不误取）", () => {
    expect(extractBindingCode("你好")).toBeNull();
    expect(extractBindingCode("12345")).toBeNull();
    expect(extractBindingCode("1234567")).toBeNull();
    expect(extractBindingCode("")).toBeNull();
  });
});

// ---------- 消费三分类（绑定行寻址） ----------

describe("NotifyDmService.consume（三分类 + 留痕 + 降级 + 绑定行寻址）", () => {
  it("ok：done + sent 行（target = 绑定行 open_userid）+ 加粗标题发出 + 未命中激活表 → 旁证回填（D4）", async () => {
    const { service, repo, aibot, inbox, archive } = makeBoundService();

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toEqual({ outcome: "done" });
    expect(repo.deliveries[0]).toMatchObject({ state: "sent", target: OPEN_USERID, attempts: 1, sentAt: AT, error: null });
    expect(aibot.sends[0]).toMatchObject({ userid: OPEN_USERID, dmActivated: false });
    expect(aibot.sends[0]!.content).toBe("**任务节点完成**\n\n节点：到货验收 负责人：张工");
    expect(repo.backfillCalls).toEqual([{ botId: BOT_ID, wecomUserid: OPEN_USERID, userId: USER_ID, at: AT }]);
    expect(inbox.copies).toEqual([]);
    expect(archive.messages[0]).toMatchObject({
      sourceDedupeKey: "R02:t-1:v5:aibot",
      channel: "wecom_aibot",
      recipientId: USER_ID,
      ruleCode: "R02",
      lastState: "sent",
      attemptCount: 1,
      recipientLabel: "****" + OPEN_USERID.slice(-4),
      sentAt: AT,
    });
    expect(archive.attempts[0]).toMatchObject({ messageId: archive.messages[0]!.id, channel: "wecom_aibot" });
  });

  it("重复消费：归档已 sent → done，不再发起第二次单聊帧", async () => {
    const { service, archive, aibot } = makeBoundService();

    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });
    expect(await service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });

    expect(aibot.sends).toHaveLength(1);
    expect(archive.messages).toHaveLength(1);
    expect(archive.attempts).toHaveLength(1);
  });

  it("归档失败：不发帧，交 outbox retry", async () => {
    const { service, repo, aibot, archive } = makeBoundService();
    archive.failEnsure = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry", error: expect.stringContaining("归档失败") });
    expect(aibot.sends).toEqual([]);
    expect(repo.deliveries).toEqual([]);
  });

  it("ok：命中激活表 → dmActivated=true 传入、不重复回填", async () => {
    const { service, repo, aibot } = makeBoundService();
    repo.activations.set(key(BOT_ID, OPEN_USERID), activation({ userId: USER_ID }));

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toEqual({ outcome: "done" });
    expect(aibot.sends[0]!.dmActivated).toBe(true);
    expect(repo.backfillCalls).toEqual([]);
  });

  it("ok：激活行存在但 user_id 留空（D1 仅登记行）→ 命中分流 + 补回填 user_id", async () => {
    const { service, repo, aibot } = makeBoundService();
    repo.activations.set(key(BOT_ID, OPEN_USERID), activation({ userId: null }));

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome).toEqual({ outcome: "done" });
    expect(aibot.sends[0]!.dmActivated).toBe(true);
    expect(repo.backfillCalls).toEqual([{ botId: BOT_ID, wecomUserid: OPEN_USERID, userId: USER_ID, at: AT }]);
  });

  it("ok：旁证回填写库失败 → 不影响 done（旁证非关键路径）", async () => {
    const made = makeBoundService();
    made.repo.backfillFails = true;

    expect(await made.service.consume(claimedRow(payload()))).toEqual({ outcome: "done" });
  });

  it("未绑定企微（无绑定行）：不发帧 + dead 行（target=user:<id>）+ D4 绑定指引降级", async () => {
    const { service, repo, aibot, inbox } = makeService();
    repo.contacts.set(USER_ID, contact());

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(aibot.sends).toEqual([]);
    expect(repo.deliveries[0]).toMatchObject({
      state: "dead",
      target: "user:" + USER_ID,
      attempts: 0,
      error: "收件人未绑定企业微信（无可投递地址）",
    });
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.dedupeKey).toBe("R02:t-1:v5:aibot:c504");
    expect(String(inbox.copies[0]!.message.body)).toContain("节点：到货验收 负责人：张工");
    expect(String(inbox.copies[0]!.message.body)).toContain("当前用户未绑定企业微信，请前往设置补绑");
  });

  it("用户关闭企微单聊提醒：不发帧 + 投递行 dead + outbox done 收口", async () => {
    const made = makeBoundService();
    await made.service.setMessagesEnabled(USER_ID, false);

    const outcome = await made.service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("done");
    expect(made.aibot.sends).toEqual([]);
    expect(made.repo.deliveries[0]).toMatchObject({
      state: "dead",
      target: OPEN_USERID,
      attempts: 0,
      error: "收件人已关闭企业微信单聊提醒",
    });
    expect(DM_DISABLED_DEGRADE_PREFIX).toBe("【企微单聊提醒已关闭，已转站内信】\n\n");
    expect(made.inbox.copies).toHaveLength(1);
    expect(String(made.inbox.copies[0]!.message.body)).toContain(DM_DISABLED_DEGRADE_PREFIX.trim());
    expect(String(made.inbox.copies[0]!.message.body)).toContain("节点：到货验收 负责人：张工");
  });

  it("用户关闭企微单聊提醒 + 站内信写库失败：不发帧 + retry 收敛", async () => {
    const made = makeBoundService();
    await made.service.setMessagesEnabled(USER_ID, false);
    made.inbox.fail = true;

    const outcome = await made.service.consume(claimedRow(payload()));

    expect(outcome).toMatchObject({ outcome: "retry" });
    expect(made.aibot.sends).toEqual([]);
    expect(made.repo.deliveries[0]).toMatchObject({ state: "dead", attempts: 0 });
  });

  it("D4 话术终稿逐字锁定（前缀 = 标签行 + 终稿句）", () => {
    expect(DM_BINDING_DEGRADE_PREFIX).toBe("【企微未送达，已转站内信】\n当前用户未绑定企业微信，请前往设置补绑\n\n");
  });

  it("rate_limited：deferred + deferred 行（availableAt = retryAt；attempts 不消耗）", async () => {
    const retryAt = new Date(AT.getTime() + 30_000);
    const { service, repo, aibot } = makeBoundService();
    aibot.result = {
      ok: false,
      kind: "rate_limited",
      errcode: null,
      errmsg: "本地限速桶已满",
      retryAt,
      attempts: 0,
      state: "subscribed",
    };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("deferred");
    if (outcome.outcome === "deferred") {
      expect(outcome.availableAt.getTime()).toBe(retryAt.getTime());
    }
    expect(repo.deliveries[0]).toMatchObject({ state: "deferred", attempts: 0, sentAt: null });
  });

  it("846607 命中激活表（客户端按超频分类）→ dmActivated=true + deferred（与未激活分支成对）", async () => {
    const retryAt = new Date(AT.getTime() + 60_000);
    const { service, repo, aibot } = makeBoundService();
    repo.activations.set(key(BOT_ID, OPEN_USERID), activation({ userId: USER_ID }));
    aibot.result = {
      ok: false,
      kind: "rate_limited",
      errcode: 846607,
      errmsg: "aibot send msg frequency limit exceeded",
      retryAt,
      attempts: 1,
      state: "subscribed",
    };

    const outcome = await service.consume(claimedRow(payload()));

    expect(aibot.sends[0]!.dmActivated).toBe(true);
    expect(outcome.outcome).toBe("deferred");
  });

  it("retryable（断连 / 未订阅 / 超时）：retry + failed 行", async () => {
    const { service, repo, aibot } = makeBoundService();
    aibot.result = {
      ok: false,
      kind: "retryable",
      errcode: 846609,
      errmsg: "not subscribed",
      retryAt: null,
      attempts: 1,
      state: "subscribed",
    };

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("retry");
    expect(repo.deliveries[0]).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("permanent（853000 配置类）：dead + dead 行 + 通用前缀降级（:c504 / 标题关联保留）", async () => {
    const { service, repo, aibot, inbox } = makeBoundService();
    aibot.result = permanent(853000, "invalid bot");

    const outcome = await service.consume(
      claimedRow(payload({ refType: "task", refId: "33333333-3333-4333-8333-333333333333", templateCode: "R02_WECOM" })),
    );

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: OPEN_USERID, error: expect.stringContaining("853000") });
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.topic).toBe("notify.message");
    expect(inbox.copies[0]!.dedupeKey).toBe("R02:t-1:v5:aibot:c504");
    expect(inbox.copies[0]!.message).toMatchObject({
      recipientId: USER_ID,
      type: "reminder",
      title: "任务节点完成",
      refType: "task",
      refId: "33333333-3333-4333-8333-333333333333",
    });
    expect(inbox.copies[0]!.message.body.startsWith(DM_DEGRADE_PREFIX)).toBe(true);
    expect(inbox.copies[0]!.message.body).toContain("节点：到货验收 负责人：张工");
    expect(inbox.copies[0]!.message.body).not.toContain("未绑定企业微信");
  });

  it("permanent（846607 未命中激活表 · 兜底分支）：dead + 绑定指引话术（D4 终稿）", async () => {
    const { service, repo, aibot, inbox } = makeBoundService();
    aibot.result = permanent(846607, "aibot send msg frequency limit exceeded");

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(aibot.sends[0]!.dmActivated).toBe(false); // 未命中激活表 → false（计划 §3.5）
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", error: expect.stringContaining("846607") });
    expect(inbox.copies).toHaveLength(1);
    const body = String(inbox.copies[0]!.message.body);
    expect(body.startsWith(DM_BINDING_DEGRADE_PREFIX)).toBe(true);
    expect(body).toContain("当前用户未绑定企业微信，请前往设置补绑");
    expect(body).toContain("节点：到货验收 负责人：张工");
    expect(body).not.toContain("私发任意消息");
  });

  it("收件人不存在：dead + dead 行（target=user:<id>）、不发送、不降级", async () => {
    const { service, repo, aibot, inbox } = makeService();

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: "user:" + USER_ID, attempts: 0 });
    expect(aibot.sends).toEqual([]);
    expect(inbox.copies).toEqual([]);
  });

  it("收件人停用 / 已删除：dead + dead 行 + 降级（同 app 口径：用户存在即降级；target 取绑定行地址）", async () => {
    const disabled = makeBoundService();
    disabled.repo.contacts.set(USER_ID, contact({ status: "disabled" }));
    expect((await disabled.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(disabled.repo.deliveries[0]).toMatchObject({ state: "dead", target: OPEN_USERID, error: "收件人不可投递（已停用）" });
    expect(disabled.inbox.copies).toHaveLength(1);

    const removed = makeBoundService();
    removed.repo.contacts.set(USER_ID, contact({ removedAt: AT }));
    expect((await removed.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(removed.repo.deliveries[0]!.error).toContain("已删除");
    expect(removed.inbox.copies).toHaveLength(1);
  });

  it("收件人停用且未绑定：dead 行 target 回落 user:<id>（无地址可落）", async () => {
    const made = makeService();
    made.repo.contacts.set(USER_ID, contact({ status: "disabled" }));

    expect((await made.service.consume(claimedRow(payload()))).outcome).toBe("dead");
    expect(made.repo.deliveries[0]).toMatchObject({ target: "user:" + USER_ID, error: "收件人不可投递（已停用）" });
    expect(made.aibot.sends).toEqual([]);
  });

  it("降级站内信写库失败：retry 收敛（不静默丢消息）", async () => {
    const { service, repo, aibot, inbox } = makeBoundService();
    aibot.result = permanent(853000, "invalid bot");
    inbox.fail = true;

    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("retry");
    if (outcome.outcome === "retry") {
      expect(outcome.error).toContain("降级站内信失败");
    }
    expect(repo.deliveries).toHaveLength(1);
  });

  it("发送内容：合法上限内长正文（3000 字）逐字发出、≤ 20000 字节防御上限（截断行为另由纯函数锁）", async () => {
    const { service, repo, aibot } = makeBoundService();

    const body = "长".repeat(3_000);
    const outcome = await service.consume(claimedRow(payload({ body })));

    expect(outcome).toEqual({ outcome: "done" });
    expect(aibot.sends[0]!.content).toBe("**任务节点完成**\n\n" + body);
    expect(Buffer.byteLength(aibot.sends[0]!.content, "utf8")).toBeLessThanOrEqual(DM_MARKDOWN_MAX_BYTES);
    // 契约 body ≤ 4000 字 → 合法载荷不会触达 20000 字节截断；上限为契约放宽时的防御（截断逐字口径见纯函数用例）
    expect(aibot.sends[0]!.content.endsWith(DM_TRUNCATION_SUFFIX)).toBe(false);
    expect(repo.deliveries[0]!.state).toBe("sent");
  });

  it("渠道路由防御：非 wecom_aibot（wecom_app）→ dead、不读联系人、不发送", async () => {
    const { service, repo, aibot } = makeService();

    const outcome = await service.consume(claimedRow(payload({ channel: "wecom_app" })));

    expect(outcome.outcome).toBe("dead");
    if (outcome.outcome === "dead") {
      expect(outcome.error).toContain("渠道异常");
    }
    expect(repo.deliveries).toEqual([]);
    expect(aibot.sends).toEqual([]);
  });

  it("非法载荷：dead、不读联系人、不发送", async () => {
    const { service, repo, aibot } = makeService();

    const outcome = await service.consume(
      claimedRow({ recipientId: USER_ID, type: "unknown", title: "t", body: "b", channel: "wecom_aibot" }),
    );

    expect(outcome.outcome).toBe("dead");
    expect(repo.deliveries).toEqual([]);
    expect(aibot.sends).toEqual([]);
  });
});

// ---------- 绑定码 ingest ----------

describe("NotifyDmService.ingestCallback（单聊绑定码 · 口径 §5）", () => {
  it("非绑定码单聊消息：仅写激活登记（D1 · 不可作发送地址）、不回复", async () => {
    const { service, repo, aibot } = makeService();

    await service.ingestCallback(incoming({ text: "你好" }));

    expect(repo.upsertCalls).toEqual([{ botId: BOT_ID, wecomUserid: OPEN_USERID, at: AT }]);
    expect(repo.activations.get(key(BOT_ID, OPEN_USERID))).toEqual({
      wecomUserid: OPEN_USERID,
      userId: null,
      firstActivatedAt: AT,
      lastMessageAt: AT,
    });
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([]);
  });

  it("非文本消息（图片 / 语音）：不做码匹配、只登记激活", async () => {
    const { service, repo, aibot } = makeService();

    await service.ingestCallback(incoming({ msgtype: "image", text: null }));

    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([]);
  });

  it("命中绑定码：同事务写绑定（bot_id + open_userid + 库内用户）+ 回「绑定成功」", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());

    await service.ingestCallback(codeIncoming("绑定" + CODE));

    expect(repo.upsertCalls).toHaveLength(1); // 先登记激活（D1）
    expect(repo.bindCalls).toEqual([{ codeId: 7, userId: USER_ID, botId: BOT_ID, wecomUserid: OPEN_USERID, at: AT }]);
    expect(repo.bindings.get(key(BOT_ID, OPEN_USERID))).toMatchObject({
      userId: USER_ID,
      boundAt: AT,
      messagesEnabled: true,
    });
    expect(repo.codes.get(CODE)!.status).toBe("used");
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_BOUND }]);
  });

  it("群聊 @机器人名 前缀正文（群形态）也容错取码 —— 但群聊回调一律不绑定", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());

    await service.ingestCallback(incoming({ chattype: "group", chatid: "wrsuTest", text: "@LibiaoLinkRobot 绑定 " + CODE }));

    expect(repo.upsertCalls).toEqual([]);
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([]);
  });

  it("enter_chat 等事件回调 / fromUserId 缺失 / userid 非法：不登记、不绑定、不回复", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());

    await service.ingestCallback(incoming({ cmd: "aibot_event_callback", text: CODE }));
    await service.ingestCallback(incoming({ fromUserId: null, text: CODE }));
    await service.ingestCallback(incoming({ fromUserId: "bad userid!", text: CODE }));
    await service.ingestCallback(incoming({ fromUserId: "", text: CODE }));

    expect(repo.upsertCalls).toEqual([]);
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([]);
  });

  it("单聊 enter_chat：只回定稿欢迎语，不登记激活、不绑定", async () => {
    const { service, repo, aibot } = makeService();

    await service.replyWelcomeToEnterChat(
      incoming({ cmd: "aibot_event_callback", msgtype: "event", text: null, eventType: "enter_chat" }),
    );

    expect(aibot.welcomes).toEqual([{ reqId: "ReqIdCallback0001", content: DM_WELCOME_MESSAGE }]);
    expect(aibot.replies).toEqual([]);
    expect(repo.upsertCalls).toEqual([]);
    expect(repo.bindCalls).toEqual([]);
  });

  it("欢迎语过滤：群事件 / 非 enter_chat / 缺 req_id 或 userid / 消息回调均不回复", async () => {
    const { service, aibot } = makeService();

    await service.replyWelcomeToEnterChat(
      incoming({ cmd: "aibot_event_callback", chattype: "group", chatid: "chat-1", eventType: "enter_chat" }),
    );
    await service.replyWelcomeToEnterChat(
      incoming({ cmd: "aibot_event_callback", msgtype: "event", eventType: "card_action" }),
    );
    await service.replyWelcomeToEnterChat(
      incoming({ cmd: "aibot_event_callback", msgtype: "event", eventType: "enter_chat", reqId: null }),
    );
    await service.replyWelcomeToEnterChat(
      incoming({ cmd: "aibot_event_callback", msgtype: "event", eventType: "enter_chat", fromUserId: null }),
    );
    await service.replyWelcomeToEnterChat(incoming({ eventType: "enter_chat" }));

    expect(aibot.welcomes).toEqual([]);
  });

  it("欢迎语定稿：含可显示 emoji，4–120 字符", () => {
    expect(DM_WELCOME_MESSAGE).toBe(
      "你好，我是 LibiaoLink 项目助手 👋\n" +
        "📣 我会把与你相关的项目动态推送到企业微信；项目群还可接收日报汇总和任务喜报。\n" +
        "📌 本机器人主要承担消息提醒与绑定；查看项目详情、填写日报或处理文件，请登录 LibiaoLink。",
    );
    expect(DM_WELCOME_MESSAGE).toContain("👋");
    expect(DM_WELCOME_MESSAGE).toContain("📣");
    expect(DM_WELCOME_MESSAGE).toContain("📌");
    expect(DM_WELCOME_MESSAGE.length).toBeGreaterThanOrEqual(4);
    expect(DM_WELCOME_MESSAGE.length).toBeLessThanOrEqual(120);
  });

  it("欢迎语发送失败只吞掉异常，不登记激活、不绑定", async () => {
    const { service, repo, aibot } = makeService();
    aibot.welcomeResult = permanent(853000, "invalid bot");

    await expect(
      service.replyWelcomeToEnterChat(
        incoming({ cmd: "aibot_event_callback", msgtype: "event", text: null, eventType: "enter_chat" }),
      ),
    ).resolves.toBeUndefined();

    expect(aibot.welcomes).toHaveLength(1);
    expect(repo.upsertCalls).toEqual([]);
    expect(repo.bindCalls).toEqual([]);
  });

  it("正文含 6 位数字但未命中：统一失败话术 + 计 1 次失败（不泄露码存在性）", async () => {
    const { service, repo, aibot, audit } = makeService();

    await service.ingestCallback(codeIncoming("绑定654321"));

    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_INVALID }]);
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.input).toMatchObject({
      action: "deny",
      objectType: "wecom_dm_binding",
      result: "denied",
      entry: "system",
      actorId: null,
    });
    expect(JSON.stringify(audit.records[0]!.input)).not.toContain(OPEN_USERID);
    expect(JSON.stringify(audit.records[0]!.input)).not.toContain("654321");
  });

  it("码已过期：统一失败话术 + 计次 + 不写绑定", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow({ expiresAt: new Date(AT.getTime() - 1_000) }));

    await service.ingestCallback(codeIncoming());

    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_INVALID }]);
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
  });

  it("码已用（status=used）且不归当前企微号：统一失败话术 + 计次 + 不写绑定", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow({ status: "used" }));

    await service.ingestCallback(codeIncoming());

    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_INVALID }]);
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
  });

  it("跨用户换绑（v1.8 · 以码持有者为准）：绑定行改挂到码持有者 + 旧持有者回落未绑定 + 审计 1 条", async () => {
    const otherUser = "22222222-2222-4222-8222-222222222222";
    const { service, repo, aibot, audit } = makeBoundService();
    repo.codes.set(CODE, codeRow({ userId: otherUser }));

    await service.ingestCallback(codeIncoming());

    expect(repo.bindCalls).toHaveLength(1);
    expect(repo.bindCalls[0]).toMatchObject({ userId: otherUser, botId: BOT_ID, wecomUserid: OPEN_USERID });
    // 绑定行按 (bot_id, wecom_userid) 唯一键改挂：同一企微号不再挂在旧持有者名下。
    expect(repo.bindings.get(key(BOT_ID, OPEN_USERID))!.userId).toBe(otherUser);
    expect(await service.getBindingState(USER_ID)).toMatchObject({ bound: false, wecomUseridMasked: null, boundAt: null });
    expect(await service.getBindingState(otherUser)).toMatchObject({
      bound: true,
      wecomUseridMasked: "****" + OPEN_USERID.slice(-4),
    });
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_BOUND }]);
    // 换绑留痕（与绑定行改挂同一事务）：action=update / objectId = 旧持有者 / 摘要与 changes 不带完整密文。
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.input).toMatchObject({
      action: "update",
      objectType: "user",
      objectId: USER_ID,
      actorId: otherUser,
      changes: [{ field: "wecomDmBinding.owner", from: USER_ID, to: otherUser }],
      metadata: { botId: BOT_ID, wecomUseridMasked: "****" + OPEN_USERID.slice(-4) },
    });
    expect(JSON.stringify(audit.records[0]!.input).includes(OPEN_USERID)).toBe(false);
  });

  it("回调重复投递（码已用 + 绑定已归码持有者）：回「绑定成功」幂等、不重复绑定、不再写审计", async () => {
    const { service, repo, aibot, audit } = makeService();
    repo.codes.set(CODE, codeRow());

    await service.ingestCallback(codeIncoming());
    await service.ingestCallback(codeIncoming());

    expect(repo.bindCalls).toHaveLength(1); // 第二次不再触绑定
    expect(repo.bindings.get(key(BOT_ID, OPEN_USERID))!.boundAt).toEqual(AT);
    expect(aibot.replies.map((item) => item.content)).toEqual([DM_BINDING_REPLY_BOUND, DM_BINDING_REPLY_BOUND]);
    expect(audit.records).toHaveLength(0); // 本人重复投递非换绑
  });

  it("占用失败（并发消费 / 恰过期）：统一失败话术 + 计次 + 不写绑定", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());
    repo.bindFails = true;

    await service.ingestCallback(codeIncoming());

    expect(repo.bindCalls).toHaveLength(1);
    expect(repo.bindings.size).toBe(0);
    expect(aibot.replies).toEqual([{ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: DM_BINDING_REPLY_INVALID }]);
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
  });

  it("回调缺 req_id：跳过会话内回执（不抛错），绑定仍落库", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());

    await service.ingestCallback(incoming({ reqId: null, text: CODE }));

    expect(repo.bindings.size).toBe(1);
    expect(aibot.replies).toEqual([]);
  });

  it("会话内回执失败 / 抛错：不影响绑定结果（不回滚、不抛）", async () => {
    const { service, repo, aibot } = makeService();
    repo.codes.set(CODE, codeRow());
    aibot.replyResult = permanent(853000, "invalid bot");

    await service.ingestCallback(codeIncoming());
    expect(repo.bindings.size).toBe(1);

    const second = makeService();
    second.repo.codes.set(CODE, codeRow());
    second.aibot.replyToCallback = async () => {
      throw new Error("fake 回复异常");
    };
    await second.service.ingestCallback(codeIncoming());
    expect(second.repo.bindings.size).toBe(1);
  });

  it("5 次失败 → 锁定 1 分钟；锁定期间正确码也不查码表、不能绑定；审计与告警不含明文", async () => {
    const alertChatid = "wrAlertTest0001";
    const { service, repo, aibot, audit, clock } = makeService({ OUTBOX_ALERT_WECOM_CHATID: alertChatid });
    for (let index = 0; index < DM_BINDING_FAILURE_LIMIT; index += 1) {
      const at = new Date(AT.getTime() + index * 1_000);
      clock.setSource(() => at);
      await service.ingestCallback(incoming({ msgid: "bad-" + String(index), text: "654321" }));
    }

    const guard = repo.guards.get(key(BOT_ID, OPEN_USERID))!;
    expect(DM_BINDING_FAILURE_WINDOW_MS).toBe(600_000);
    expect(guard).toMatchObject({ bindingFailCount: 0, bindingLockLevel: 1 });
    expect(guard.bindingLockedUntil?.getTime()).toBe(AT.getTime() + 4_000 + DM_BINDING_LOCK_STEPS_MS[0]!);
    expect(aibot.replies.map((item) => item.content)).toEqual([
      DM_BINDING_REPLY_INVALID,
      DM_BINDING_REPLY_INVALID,
      DM_BINDING_REPLY_INVALID,
      DM_BINDING_REPLY_INVALID,
      DM_BINDING_REPLY_LOCKED,
    ]);
    expect(audit.records).toHaveLength(5);
    expect(audit.records.every((record) => record.input.objectType === "wecom_dm_binding")).toBe(true);

    repo.codes.set(key(BOT_ID, CODE), codeRow());
    const callsBeforeLockedAttempt = repo.findCodeCalls.length;
    const lockedAt = new Date(AT.getTime() + 5_000);
    clock.setSource(() => lockedAt);
    await service.ingestCallback(incoming({ msgid: "valid-while-locked", text: CODE }));

    expect(repo.findCodeCalls).toHaveLength(callsBeforeLockedAttempt);
    expect(repo.bindCalls).toEqual([]);
    expect(repo.bindings.size).toBe(0);
    expect(aibot.replies.at(-1)?.content).toBe(DM_BINDING_REPLY_LOCKED);
    expect(aibot.groupSends).toHaveLength(1);
    expect(aibot.groupSends[0]).toMatchObject({ chatid: alertChatid, groupActivated: true });
    expect(aibot.groupSends[0]!.content).toContain("****" + OPEN_USERID.slice(-4));
    expect(aibot.groupSends[0]!.content).not.toContain(OPEN_USERID);
    expect(aibot.groupSends[0]!.content).not.toContain(CODE);
  });

  it("锁定到期后再失败 5 次：升级到第 2 档 2 分钟；成功绑定清空失败与锁定状态", async () => {
    const { service, repo, clock } = makeService();
    for (let index = 0; index < DM_BINDING_FAILURE_LIMIT; index += 1) {
      const at = new Date(AT.getTime() + index * 1_000);
      clock.setSource(() => at);
      await service.ingestCallback(incoming({ msgid: "first-" + String(index), text: "654321" }));
    }
    for (let index = 0; index < DM_BINDING_FAILURE_LIMIT; index += 1) {
      const at = new Date(AT.getTime() + 70_000 + index * 1_000);
      clock.setSource(() => at);
      await service.ingestCallback(incoming({ msgid: "second-" + String(index), text: "654321" }));
    }
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({
      bindingFailCount: 0,
      bindingLockLevel: 2,
    });
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))!.bindingLockedUntil?.getTime()).toBe(
      AT.getTime() + 74_000 + DM_BINDING_LOCK_STEPS_MS[1]!,
    );

    const successAt = new Date(AT.getTime() + 300_000);
    repo.codes.set(
      key(BOT_ID, CODE),
      codeRow({ expiresAt: new Date(successAt.getTime() + 60_000) }),
    );
    clock.setSource(() => successAt);
    await service.ingestCallback(incoming({ msgid: "success-after-lock", text: CODE }));
    expect(repo.bindings.size).toBe(1);
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({
      bindingFailCount: 0,
      bindingFailWindowStartedAt: null,
      bindingLockLevel: 0,
      bindingLockedUntil: null,
      lastBindingMsgid: "success-after-lock",
    });
  });

  it("同一 msgid 重投：不重复计数、不重复写审计；普通文本不消耗失败配额", async () => {
    const { service, repo, aibot, audit } = makeService();
    await service.ingestCallback(incoming({ msgid: "normal-message", text: "你好" }));
    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toEqual(emptyGuard());

    await service.ingestCallback(incoming({ msgid: "same-msg", text: "654321" }));
    await service.ingestCallback(incoming({ msgid: "same-msg", text: "654321" }));

    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
    expect(audit.records).toHaveLength(1);
    expect(aibot.replies.map((item) => item.content)).toEqual([DM_BINDING_REPLY_INVALID, DM_BINDING_REPLY_INVALID]);
  });

  it("机器人隔离：机器人 A 的绑定码不能通过机器人 B 验证或绑定", async () => {
    const otherBot = "aibOtherBot0001";
    const { service, repo, aibot } = makeService({ WECOM_BOT_ID: otherBot });
    repo.codes.set(key(BOT_ID, CODE), codeRow());

    await service.ingestCallback(incoming({ msgid: "other-bot-code", text: CODE }));

    expect(repo.findCodeCalls.at(-1)).toEqual({ code: CODE, botId: otherBot });
    expect(repo.bindCalls).toEqual([]);
    expect(aibot.replies.at(-1)?.content).toBe(DM_BINDING_REPLY_INVALID);
    expect(repo.guards.get(key(otherBot, OPEN_USERID))).toMatchObject({ bindingFailCount: 1, bindingLockLevel: 0 });
  });

  it("24 小时无验证尝试：下一次失败前锁定级别归零", async () => {
    const { service, repo } = makeService();
    repo.upsertActivationFromCallback({ botId: BOT_ID, wecomUserid: OPEN_USERID, at: AT });
    repo.guards.set(key(BOT_ID, OPEN_USERID), {
      ...emptyGuard(),
      bindingFailCount: 4,
      bindingFailWindowStartedAt: new Date(AT.getTime() - DM_BINDING_FAILURE_WINDOW_MS - 1),
      bindingLockLevel: 6,
      lastBindingAttemptAt: new Date(AT.getTime() - 24 * 60 * 60_000 - 1),
    });

    await service.ingestCallback(incoming({ msgid: "idle-reset", text: "654321" }));

    expect(repo.guards.get(key(BOT_ID, OPEN_USERID))).toMatchObject({
      bindingFailCount: 1,
      bindingLockLevel: 0,
      bindingLockedUntil: null,
    });
  });
});

// ---------- 取码与绑定态 ----------

describe("NotifyDmService.requestBindingCode / getBindingState（D3 / D5 口径）", () => {
  it("取码：6 位数字 + expiresAt = now + 3 分钟", async () => {
    const { service, repo } = makeService();

    const result = await service.requestBindingCode(USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toMatch(/^[0-9]{6}$/);
      expect(result.expiresAt.getTime()).toBe(AT.getTime() + DM_BINDING_CODE_TTL_MS);
      expect(result.expiresInSeconds).toBe(DM_BINDING_CODE_TTL_MS / 1000);
    }
    expect(DM_BINDING_CODE_TTL_MS).toBe(180_000); // 2026-10-20 安全修订：TTL 3 分钟
    expect(repo.codeCreateCalls).toHaveLength(1);
    expect(repo.codeCreateCalls[0]).toMatchObject({
      botId: BOT_ID,
      userId: USER_ID,
      expiresAt: new Date(AT.getTime() + DM_BINDING_CODE_TTL_MS),
      at: AT,
    });
  });

  it("频率限制（v1.9）：窗口内已取满 5 次 → rate_limited + retryAt = 最近一码 + 窗口长度（≤ 3 分钟）", async () => {
    const { service, repo } = makeService();
    const newest = new Date(AT.getTime() - 50_000);
    repo.issuedAt = [
      new Date(AT.getTime() - 170_000),
      new Date(AT.getTime() - 140_000),
      new Date(AT.getTime() - 110_000),
      new Date(AT.getTime() - 80_000),
      newest,
    ];

    const result = await service.requestBindingCode(USER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rate_limited");
      // v1.9 回归：分散取码（5 次跨 2 分钟）后，罚时不再是「最早一码 + 3 分钟」只剩 10 秒，
      // 而是「最近一码 + 3 分钟」= 还有 2 分 10 秒。
      expect(result.retryAt.getTime()).toBe(newest.getTime() + DM_BINDING_CODE_WINDOW_MS);
      expect(result.retryAt.getTime() - AT.getTime()).toBe(130_000);
      expect(result.retryAt.getTime() - AT.getTime()).toBeLessThanOrEqual(DM_BINDING_CODE_WINDOW_MS);
    }
    expect(repo.codeCreateCalls).toEqual([]);
    expect(DM_BINDING_CODE_MAX_PER_WINDOW).toBe(5);
    expect(DM_BINDING_CODE_WINDOW_MS).toBe(180_000);
  });

  it("撞码重试：前两次被唯一键挡下 → 第三次成功", async () => {
    const { service, repo } = makeService();
    repo.codeConflicts = 2;

    const result = await service.requestBindingCode(USER_ID);

    expect(result.ok).toBe(true);
    expect(repo.codeCreateCalls).toHaveLength(3);
  });

  it("连续撞码到顶：抛错（由调用方按 5xx 收口，不静默返回无效码）", async () => {
    const { service, repo } = makeService();
    repo.codeConflicts = 99;

    await expect(service.requestBindingCode(USER_ID)).rejects.toThrow("绑定码生成失败");
  });

  it("绑定态读面：已绑定回掩码末 4 位 + 时刻（ISO）；未绑定 / 换机器人回落 null", async () => {
    const bound = makeBoundService();
    expect(await bound.service.getBindingState(USER_ID)).toEqual({
      bound: true,
      wecomUseridMasked: "****" + OPEN_USERID.slice(-4),
      boundAt: BEFORE.toISOString(),
      messagesEnabled: true,
      bindingCode: null,
      retryAt: null,
    });

    const unbound = makeService();
    unbound.repo.contacts.set(USER_ID, contact());
    expect(await unbound.service.getBindingState(USER_ID)).toEqual({
      bound: false,
      wecomUseridMasked: null,
      boundAt: null,
      messagesEnabled: true,
      bindingCode: null,
      retryAt: null,
    });

    // 换机器人：旧绑定按 (bot_id, ...) 维度不再命中 → 读面回到未绑定（无需清库即生效）。
    const otherBot = makeBoundService();
    otherBot.repo.bindings.clear();
    otherBot.repo.bindings.set(key("aibOtherBot0001", OPEN_USERID), {
      botId: "aibOtherBot0001",
      wecomUserid: OPEN_USERID,
      userId: USER_ID,
      boundAt: BEFORE,
      messagesEnabled: true,
    });
    expect((await otherBot.service.getBindingState(USER_ID)).bound).toBe(false);
  });

  it("消息开关：绑定默认开启，可关闭并持久化；未绑定时幂等", async () => {
    const { service, repo } = makeBoundService();
    expect((await service.getBindingState(USER_ID)).messagesEnabled).toBe(true);

    const off = await service.setMessagesEnabled(USER_ID, false);
    expect(off.messagesEnabled).toBe(false);
    expect(repo.messageToggleCalls).toEqual([{ botId: BOT_ID, userId: USER_ID, messagesEnabled: false, at: AT }]);
    expect((await service.getBindingState(USER_ID)).messagesEnabled).toBe(false);

    const unbound = makeService();
    const state = await unbound.service.setMessagesEnabled(USER_ID, false);
    expect(state).toMatchObject({ bound: false, messagesEnabled: true });
    expect(unbound.repo.messageToggleCalls).toHaveLength(1);
  });

  it("读面回填（v1.8）：回当前未用绑定码与取码限流可重试时刻 —— 刷新 / 重进页面不丢码面与罚时", async () => {
    const { service, repo } = makeService();
    const expiresAt = new Date(AT.getTime() + 240_000);
    repo.codes.set(CODE, codeRow({ expiresAt }));
    repo.issuedAt = [
      new Date(AT.getTime() - 170_000),
      new Date(AT.getTime() - 140_000),
      new Date(AT.getTime() - 110_000),
      new Date(AT.getTime() - 80_000),
      new Date(AT.getTime() - 50_000),
    ];

    const state = await service.getBindingState(USER_ID);

    expect(state.bound).toBe(false);
    expect(state.bindingCode).toEqual({ code: CODE, expiresAt: expiresAt.toISOString(), expiresInSeconds: 240 });
    // 罚时回填与取码侧同一判定（v1.9）：窗口内最近一码 + 窗口长度。
    expect(state.retryAt).toBe(new Date(AT.getTime() - 50_000 + 180_000).toISOString());

    // 未到顶 → retryAt = null；码已过期 / 已用 → bindingCode = null（读面只回「此刻仍可用」的码）。
    const noLimit = makeService();
    noLimit.repo.codes.set(CODE, codeRow());
    expect((await noLimit.service.getBindingState(USER_ID)).retryAt).toBeNull();

    const stale = makeService();
    stale.repo.codes.set(CODE, codeRow({ expiresAt: new Date(AT.getTime() - 1) }));
    expect((await stale.service.getBindingState(USER_ID)).bindingCode).toBeNull();

    const used = makeService();
    used.repo.codes.set(CODE, codeRow({ status: "used" }));
    expect((await used.service.getBindingState(USER_ID)).bindingCode).toBeNull();
  });
});

// ---------- 解绑（D6） ----------

describe("NotifyDmService.unbind（D6：清绑定 + 同事务审计 / 幂等）", () => {
  it("解绑：清绑定行 + 同事务写审计 1 条（user / delete / 只带掩码）", async () => {
    const { service, repo, audit } = makeBoundService();

    const state = await service.unbind(USER_ID, USER_ID);

    expect(state).toEqual({
      bound: false,
      wecomUseridMasked: null,
      boundAt: null,
      messagesEnabled: true,
      bindingCode: null,
      retryAt: null,
    });
    expect(repo.clearCalls).toHaveLength(1);
    expect(repo.clearCalls[0]).toMatchObject({ botId: BOT_ID, userId: USER_ID, at: AT });
    expect(repo.bindings.size).toBe(0);
    expect(audit.records).toHaveLength(1);
    const record = audit.records[0]!;
    expect(record.input).toMatchObject({
      actorId: USER_ID,
      action: "delete",
      objectType: "user",
      objectId: USER_ID,
      summary: "解绑企业微信单聊（open_userid ****" + OPEN_USERID.slice(-4) + "）",
      changes: [{ field: "wecomDmBinding", from: "****" + OPEN_USERID.slice(-4), to: null }],
      metadata: { bound: false, botId: BOT_ID },
    });
    // 同一事务证据：审计 client === 清绑定 client；明文 open_userid 不进审计。
    expect(record.client).toBe(repo.clearCalls[0]!.client);
    expect(JSON.stringify(record.input)).not.toContain(OPEN_USERID);
  });

  it("幂等：本就未绑定 → 不触库、不写审计，仍回 bound:false", async () => {
    const { service, repo, audit } = makeService();

    expect(await service.unbind(USER_ID, USER_ID)).toEqual({
      bound: false,
      wecomUseridMasked: null,
      boundAt: null,
      messagesEnabled: true,
      bindingCode: null,
      retryAt: null,
    });
    expect(repo.clearCalls).toEqual([]);
    expect(audit.records).toEqual([]);
  });

  it("幂等：重复解绑 → 第二次不再触库、不再写审计", async () => {
    const { service, repo, audit } = makeBoundService();

    await service.unbind(USER_ID, USER_ID);
    await service.unbind(USER_ID, USER_ID);

    expect(repo.clearCalls).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
  });

  it("竞态（清 0 行 = 他处已清）：不写审计、仍回 bound:false", async () => {
    const { service, repo, audit } = makeBoundService();
    repo.clearOverride = 0;

    expect((await service.unbind(USER_ID, USER_ID)).bound).toBe(false);
    expect(repo.clearCalls).toHaveLength(1);
    expect(audit.records).toEqual([]);
  });

  it("解绑后失去投递地址：消费不发帧 → dead + 绑定指引降级（D4）", async () => {
    const { service, repo, aibot, inbox } = makeBoundService();

    await service.unbind(USER_ID, USER_ID);
    const outcome = await service.consume(claimedRow(payload()));

    expect(outcome.outcome).toBe("dead");
    expect(aibot.sends).toEqual([]);
    expect(repo.deliveries[0]).toMatchObject({ state: "dead", target: "user:" + USER_ID });
    expect(inbox.copies).toHaveLength(1);
    expect(inbox.copies[0]!.message.body.startsWith(DM_BINDING_DEGRADE_PREFIX)).toBe(true);
  });
});

// ---------- 机器人诊断（Push 255 · 仅非生产） ----------

describe("NotifyDmService.getBotDiagnostics（机器人诊断 · v1.9）", () => {
  it("开发环境：回显 bot_id / secret + 掩码 + 最近回调统计 + 观察到的其他 bot_id", async () => {
    const { service, repo } = makeService();
    repo.inboundStats = { inboundCount: 3, lastInboundAt: AT, lastInboundUserid: OPEN_USERID };
    repo.observedBots = [
      { botId: BOT_ID, inboundCount: 3, lastInboundAt: AT },
      { botId: "aibOtherBot0001", inboundCount: 1, lastInboundAt: BEFORE },
    ];

    const diag = await service.getBotDiagnostics();

    expect(diag.enabled).toBe(true);
    expect(diag.botId).toBe(BOT_ID);
    expect(diag.botSecret).toBe("aib-secret-0123456789");
    expect(diag.botSecretMasked).toBe("aib-****6789");
    expect(diag.wsUrl).toBe("wss://openws.work.weixin.qq.com");
    expect(diag.deliveryEnabled).toBe(true);
    expect(diag.lastInboundAt).toBe(AT.toISOString());
    expect(diag.inboundCount).toBe(3);
    expect(diag.lastInboundUseridMasked).toBe("****" + OPEN_USERID.slice(-4));
    expect(diag.observedBotIds).toEqual([
      { botId: BOT_ID, inboundCount: 3, lastInboundAt: AT.toISOString() },
      { botId: "aibOtherBot0001", inboundCount: 1, lastInboundAt: BEFORE.toISOString() },
    ]);
    expect(diag.serverTime).toBe(AT.toISOString());
  });

  it("生产默认关闭：enabled:false + 敏感字段 null + 统计归零（WECOM_BOT_DIAGNOSTICS=true 可强制开启）", async () => {
    const { service, repo } = makeService({ NODE_ENV: "production" });
    repo.inboundStats = { inboundCount: 3, lastInboundAt: AT, lastInboundUserid: OPEN_USERID };

    expect(await service.getBotDiagnostics()).toEqual({
      enabled: false,
      botId: null,
      botSecret: null,
      botSecretMasked: null,
      wsUrl: null,
      deliveryEnabled: true,
      lastInboundAt: null,
      inboundCount: 0,
      lastInboundUseridMasked: null,
      observedBotIds: [],
      serverTime: AT.toISOString(),
    });

    const forced = makeService({ NODE_ENV: "production", WECOM_BOT_DIAGNOSTICS: "true" });
    expect((await forced.service.getBotDiagnostics()).enabled).toBe(true);
  });
});
