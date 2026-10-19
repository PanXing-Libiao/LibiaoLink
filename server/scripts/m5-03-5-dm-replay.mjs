#!/usr/bin/env node
/**
 * M5-03-5-3 · 单聊 aibot（实现段）· 本地回放（无网络 / 无 PG）：
 *   ① 帧形锁帧（P4 复核落地）：假 socket 驱动 server/dist 的 `wecom.aibot.js` —— `sendUserMarkdown` 帧 =
 *      { chatid: userid, chat_type: 1, msgtype: markdown, markdown: { content } }（官方 SDK 语义核对
 *      sendMessage：单聊填 userid + 探针 T5-1b 真机 errcode=0）；群帧 chat_type=2 不动（对拍）。
 *   ② 846607 双语义分流：dmActivated=false（未命中激活表）→ permanent；true / 缺省 → rate_limited（超频）；
 *      群侧 groupActivated 分流对拍。
 *   ③ 限速 kind `single`：本地双窗口拒绝（不发帧 / attempts=0 / retryAt = 被拒窗口下一窗口起点）；群 / 单聊桶隔离。
 *   ④ 消费链（假仓储 / 假站内信驱动 dist `notify.dm.service.js`）：ok → done + sent 行 + 旁证回填（D4）/
 *      rate_limited → deferred（不消耗重试）/ retryable → retry / permanent 853000 → dead + 通用前缀降级 /
 *      permanent 846607（未命中）→ dead + 激活指引前缀降级（P3 · 终稿）/ 收件人不存在 → dead 不降级 /
 *      停用 → dead + 降级 / 降级写库失败 → retry。
 *   ⑤ 激活 ingest：single 消息回调 upsert（原文 userid + 反查回填 + 幂等刷新 last_message_at）/
 *      enter_chat 不激活 / 未匹配用户留空登记 / 非法 userid 忽略。
 *   ⑥ 绑定码链路（M5-03-5-6 · 迁移 0055 · 口径 v1.8）：会话内回执帧形锁帧（`aibot_respond_msg` + 回调
 *      req_id 透传 + `msgtype: stream` 单帧收敛）／绑定行寻址（未绑定 → 不发帧 + dead + D4 降级）／
 *      ingest 全分支（单聊发码命中 → 同事务写绑定 + 标记码已用 + 回「绑定成功」；码过期 / 已用 → 「码已失效」；
 *      跨用户换绑（v1.8：该企微号改挂到码持有者 + 同事务审计）；同一码重复投递 → 幂等「绑定成功」；
 *      未命中 / 群聊 / 事件回调 → 不回复；非码消息 → 仅登记激活 D1）／
 *      取码（TTL 5 分钟 / 5 次每 3 分钟 / 撞码重试）／读面回填（v1.8：未用码 + 罚时 —— 刷新不丢状态）。
 *
 * 前置：已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && node scripts/m5-03-5-dm-replay.mjs [--out <报告.md>] [--json <证据.json>]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const report = [];
const evidence = { checks: [] };
let pass = 0;
let fail = 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    if (item === "--json") out.json = argv[++i];
  }
  return out;
}

function check(name, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  report.push((ok ? "PASS " : "FAIL ") + name + (detail === undefined ? "" : " —— " + detail));
  evidence.checks.push({ name, ok, detail: detail ?? null });
}

function assertEqual(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? undefined : "实际 " + JSON.stringify(actual) + " / 期望 " + JSON.stringify(expected));
}

function assertTrue(name, ok, detail) {
  check(name, ok === true, ok === true ? undefined : detail);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 假 socket（AibotSocket 替身）：sent 记录已发帧 + 驱动面（open / deliver / ackLast）。 */
function makeFakeSocket() {
  const socket = {
    sent: [],
    closed: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      socket.sent.push(data);
    },
    close(code, reason) {
      if (socket.closed) return;
      socket.closed = true;
      socket.onclose?.(code ?? 1000, reason ?? "closed by replay");
    },
    open() {
      socket.onopen?.();
    },
    deliver(frame) {
      socket.onmessage?.(JSON.stringify(frame));
    },
    lastFrame() {
      return JSON.parse(socket.sent[socket.sent.length - 1]);
    },
    /** 以回执应答最近一帧（订阅 / 推送同形：errcode 在帧顶层）。 */
    ackLast(errcode = 0, errmsg = "ok") {
      const headers = socket.lastFrame().headers ?? {};
      socket.deliver({ headers: { req_id: headers.req_id }, errcode, errmsg });
    },
  };
  return socket;
}

const AT = new Date("2026-10-14T06:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USERID = "zhangsan";
/** 单聊寻址口径（M5-03-5-6）：绑定行 = 回调 from.userid 原文（密文 open_userid）+ 机器人维度 bot_id。 */
const BOT_ID_STUB = "bot-stub";
const OPEN_USERID = "wosuIHCwAAseSgWSu-LuNOhnzP0vbmUw";
const CODE = "123456";
const FIXED_NOW = 1_700_000_000_000;
const minuteWindowStart = Math.floor(FIXED_NOW / 60_000) * 60_000;

async function main() {
  const distFile = (name) => pathToFileURL(join(HERE, "..", "dist", "modules", "notify", name)).href;
  const { createWecomAibotClientFromEnv } = await import(distFile("wecom.aibot.js"));
  const { InMemoryRateWindowStore } = await import(distFile("wecom.rate.js"));
  const dm = await import(distFile("notify.dm.service.js"));
  const { ClockService } = await import(pathToFileURL(join(HERE, "..", "dist", "common", "clock", "clock.service.js")).href);

  check(
    "D0 dist 单聊实现面可用（NotifyDmService / composeDmMarkdown / extractBindingCode / 绑定指引降级前缀导出）",
    typeof dm.NotifyDmService === "function" &&
      typeof dm.composeDmMarkdown === "function" &&
      typeof dm.extractBindingCode === "function" &&
      typeof dm.DM_BINDING_DEGRADE_PREFIX === "string" &&
      typeof dm.DM_BINDING_REPLY_BOUND === "string",
  );

  // ---- 发送面（真实客户端 + 假 socket） ----
  const baseEnv = {
    WECOM_BOT_WS_URL: "wss://stub.test/aibot",
    WECOM_BOT_ID: "bot-stub",
    WECOM_BOT_SECRET: "secret-stub",
    WECOM_BOT_PING_INTERVAL_MS: 3_600_000, // 默认静默（个别场景覆盖）
    WECOM_BOT_ACK_TIMEOUT_MS: 1000,
    WECOM_BOT_RECONNECT_MIN_MS: 60_000,
    WECOM_BOT_RECONNECT_MAX_MS: 60_000,
    WECOM_BOT_RATE_LIMIT_PER_MINUTE: 30,
    WECOM_BOT_RATE_LIMIT_PER_HOUR: 1000,
  };
  const makeRuntime = (envPatch = {}) => {
    const sockets = [];
    const socketFactory = () => {
      const socket = makeFakeSocket();
      sockets.push(socket);
      return socket;
    };
    const { aibot } = createWecomAibotClientFromEnv(
      { ...baseEnv, ...envPatch },
      { socketFactory, store: new InMemoryRateWindowStore(), now: () => FIXED_NOW },
    );
    return { aibot, sockets };
  };
  const connect = async (aibot, sockets) => {
    aibot.start();
    const socket = sockets[sockets.length - 1];
    socket.open();
    socket.ackLast(0);
    await sleep(0);
    return socket;
  };

  // S1 单聊帧形锁帧（P4）
  {
    const { aibot, sockets } = makeRuntime();
    const socket = await connect(aibot, sockets);
    const pending = aibot.sendUserMarkdown({ userid: USERID, content: "**单聊锁帧**\n\n正文", dmActivated: false });
    await sleep(0);
    const frame = socket.lastFrame();
    const body = frame.body ?? {};
    check(
      "S1 单聊帧形锁帧：cmd=aibot_send_msg + req_id 前缀 + body 全等（chatid=userid / chat_type=1 / markdown.content）",
      frame.cmd === "aibot_send_msg" &&
        typeof frame.headers?.req_id === "string" &&
        frame.headers.req_id.startsWith("aibot_send_msg_") &&
        body.chatid === USERID &&
        body.chat_type === 1 &&
        body.msgtype === "markdown" &&
        body.markdown?.content === "**单聊锁帧**\n\n正文" &&
        Object.keys(body).length === 4,
      JSON.stringify(frame),
    );
    socket.ackLast(0);
    const sent = await pending;
    check("S1 单聊发送：errcode=0 → ok / attempts=1", sent.ok === true && sent.attempts === 1, JSON.stringify(sent));
    await aibot.stop();
  }

  // S2 群帧对拍（chat_type=2 不变 —— 本刀未动群发送面）
  {
    const { aibot, sockets } = makeRuntime();
    const socket = await connect(aibot, sockets);
    const pending = aibot.sendGroupMarkdown({ chatid: "ChatIdAbcDef-99", content: "群帧对拍", groupActivated: true });
    await sleep(0);
    const body = socket.lastFrame().body ?? {};
    check(
      "S2 群帧对拍：chatid=chatid + chat_type=2 不变（单聊扩面未回改群面）",
      body.chatid === "ChatIdAbcDef-99" && body.chat_type === 2 && body.msgtype === "markdown" && body.markdown?.content === "群帧对拍",
      JSON.stringify(body),
    );
    socket.ackLast(0);
    const sent = await pending;
    check("S2 群发送：errcode=0 → ok", sent.ok === true, JSON.stringify(sent));
    await aibot.stop();
  }

  // S3 846607 双语义分流（单聊 + 群对拍）
  {
    const { aibot, sockets } = makeRuntime();
    const socket = await connect(aibot, sockets);

    const unactivated = aibot.sendUserMarkdown({ userid: USERID, content: "x", dmActivated: false });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    const r1 = await unactivated;
    check(
      "S3 单聊未命中激活表 + 846607 → permanent（未激活收口）",
      r1.ok === false && r1.kind === "permanent" && r1.errcode === 846607,
      JSON.stringify(r1),
    );

    const throttled = aibot.sendUserMarkdown({ userid: USERID, content: "x", dmActivated: true });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    const r2 = await throttled;
    check(
      "S3 单聊命中激活表 + 846607 → rate_limited（超频延期重排）",
      r2.ok === false && r2.kind === "rate_limited" && r2.errcode === 846607,
      JSON.stringify(r2),
    );

    const groupUnactivated = aibot.sendGroupMarkdown({ chatid: "ChatIdAbcDef-99", content: "x", groupActivated: false });
    await sleep(0);
    socket.ackLast(846607, "aibot send msg frequency limit exceeded");
    const r3 = await groupUnactivated;
    check(
      "S3 群侧 groupActivated=false 对拍 → permanent（群 / 单聊分流并存、参数不串用）",
      r3.ok === false && r3.kind === "permanent",
      JSON.stringify(r3),
    );
    await aibot.stop();
  }

  // S4 未就绪发送
  {
    const { aibot, sockets } = makeRuntime();
    const result = await aibot.sendUserMarkdown({ userid: USERID, content: "x", dmActivated: true });
    check(
      "S4 未就绪发送（未 start）→ retryable / attempts=0 / 不发帧",
      result.ok === false && result.kind === "retryable" && result.attempts === 0 && sockets.length === 0,
      JSON.stringify(result),
    );
  }

  // S5 单聊限速（single 桶）+ 群 / 单聊桶隔离
  {
    const { aibot, sockets } = makeRuntime({ WECOM_BOT_RATE_LIMIT_PER_MINUTE: 1, WECOM_BOT_RATE_LIMIT_PER_HOUR: 1000 });
    const socket = await connect(aibot, sockets);

    const first = aibot.sendUserMarkdown({ userid: USERID, content: "1", dmActivated: true });
    await sleep(0);
    socket.ackLast(0);
    const firstResult = await first;
    check("S5 限速：单聊首条放行（ok）", firstResult.ok === true, JSON.stringify(firstResult));
    const framesAfterFirst = socket.sent.length;

    const blocked = await aibot.sendUserMarkdown({ userid: USERID, content: "2", dmActivated: true });
    check(
      "S5 限速：第二条本地拦截（rate_limited / attempts=0 / retryAt = 下一分钟窗口起点）",
      blocked.ok === false && blocked.kind === "rate_limited" && blocked.attempts === 0 && blocked.retryAt.getTime() === minuteWindowStart + 60_000,
      JSON.stringify(blocked),
    );
    check("S5 限速：拦截不发帧（帧数不变）", socket.sent.length === framesAfterFirst);

    const groupOk = aibot.sendGroupMarkdown({ chatid: USERID, content: "g" });
    await sleep(0);
    socket.ackLast(0);
    const groupResult = await groupOk;
    check(
      "S5 桶隔离：单聊桶耗尽不影响群桶（同摘要 kind 隔离 —— single: 前缀）",
      groupResult.ok === true,
      JSON.stringify(groupResult),
    );
    await aibot.stop();
  }

  // ---- 消费链（假仓储 / 假站内信 · 生产 = OutboxModule 按 channel=wecom_aibot 路由 —— 接线随 M5-03-5-4） ----
  const clock = new ClockService();
  clock.setSource(() => AT);

  const contact = (overrides = {}) => ({ id: USER_ID, username: USERID, status: "active", removedAt: null, ...overrides });
  const payload = (overrides = {}) => ({
    recipientId: USER_ID,
    type: "reminder",
    channel: "wecom_aibot",
    title: "任务节点完成",
    body: "节点：到货验收 负责人：张工",
    ...overrides,
  });
  const claimedRow = (payloadValue, overrides = {}) => ({
    id: 11,
    topic: "notify.message",
    payload: payloadValue,
    dedupeKey: "R02:t-1:v5:aibot",
    attempts: 0,
    availableAt: AT,
    lockedAt: AT,
    createdAt: AT,
    ...overrides,
  });
  /** 单聊回调帧归一入参（长连接 dispatchCallback 的产物形态：req_id / msgtype / text 齐备）。 */
  const dmIncoming = (overrides = {}) => ({
    cmd: "aibot_msg_callback",
    reqId: "ReqIdCallback0001",
    chatid: null,
    chattype: "single",
    fromUserId: OPEN_USERID,
    msgid: "m1",
    msgtype: "text",
    text: "你好",
    ...overrides,
  });

  const makeService = (clientResult) => {
    const repo = {
      contacts: new Map([[USER_ID, contact()]]),
      activations: new Map(),
      bindings: new Map(),
      codes: new Map(),
      deliveries: [],
      upsertCalls: [],
      backfillCalls: [],
      bindCalls: [],
      bindClients: [],
      clearCalls: [],
      clearOverride: null,
      codeCreateCalls: [],
      issuedAt: [],
      codeConflicts: 0,
      bindFails: false,
      async findContact(userId) {
        return this.contacts.get(userId) ?? null;
      },
      async findActivation(wecomUserid, botId) {
        return this.activations.get(botId + "|" + wecomUserid) ?? null;
      },
      async findBindingByUserId(userId, botId) {
        for (const row of this.bindings.values()) {
          if (row.botId === botId && row.userId === userId) return row;
        }
        return null;
      },
      async findBindingByWecomUserid(wecomUserid, botId) {
        return this.bindings.get(botId + "|" + wecomUserid) ?? null;
      },
      async upsertActivationFromCallback(input) {
        this.upsertCalls.push(input);
        const existing = this.activations.get(input.botId + "|" + input.wecomUserid);
        this.activations.set(input.botId + "|" + input.wecomUserid, {
          wecomUserid: input.wecomUserid,
          userId: existing?.userId ?? null,
          firstActivatedAt: existing?.firstActivatedAt ?? input.at,
          lastMessageAt: input.at,
        });
      },
      async backfillActivationOnSend(input) {
        this.backfillCalls.push(input);
      },
      async bindingCodesSince(userId, since) {
        return this.issuedAt.filter((item) => item.getTime() >= since.getTime());
      },
      async createBindingCode(input) {
        this.codeCreateCalls.push(input);
        if (this.codeConflicts > 0) {
          this.codeConflicts -= 1;
          return false;
        }
        this.codes.set(input.code, {
          id: this.codes.size + 1,
          code: input.code,
          userId: input.userId,
          status: "pending",
          expiresAt: input.expiresAt,
        });
        return true;
      },
      async findBindingCode(code) {
        return this.codes.get(code) ?? null;
      },
      /** 读面回填替身（v1.8）：该用户当前仍未失效的 pending 码（至多一条）。 */
      async findPendingBindingCode(userId, at) {
        let found = null;
        for (const row of this.codes.values()) {
          if (row.userId !== userId || row.status !== "pending" || row.expiresAt.getTime() <= at.getTime()) continue;
          if (found === null || row.id > found.id) found = { code: row.code, expiresAt: row.expiresAt, id: row.id };
        }
        return found === null ? null : { code: found.code, expiresAt: found.expiresAt };
      },
      async bindWithCode(input, client) {
        this.bindCalls.push(input);
        this.bindClients.push(client);
        if (this.bindFails) return false;
        for (const row of this.codes.values()) {
          if (row.id === input.codeId) row.status = "used";
        }
        this.bindings.set(input.botId + "|" + input.wecomUserid, {
          botId: input.botId,
          wecomUserid: input.wecomUserid,
          userId: input.userId,
          boundAt: input.at,
        });
        return true;
      },
      async insertDelivery(input) {
        this.deliveries.push(input);
      },
    };
    /** 解绑仓储面（D6）：清绑定行 + 回清除行数；`clearOverride` 用于复现「并发已清 → 清 0 行」竞态。 */
    repo.clearBindingByUserId = async function clearBindingByUserId(input, client) {
      this.clearCalls.push({ ...input, client });
      let cleared = 0;
      for (const [key, row] of this.bindings) {
        if (row.botId === input.botId && row.userId === input.userId) {
          this.bindings.delete(key);
          cleared += 1;
        }
      }
      return this.clearOverride ?? cleared;
    };
    const aibot = {
      sends: [],
      replies: [],
      async sendUserMarkdown(params) {
        this.sends.push(params);
        return clientResult;
      },
      async replyToCallback(params) {
        this.replies.push(params);
        return { ok: true, attempts: 1 };
      },
    };
    const inbox = {
      copies: [],
      failNext: false,
      async deliverInboxCopy(message, topic, dedupeKey) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("站内信落库失败（回放）");
        }
        this.copies.push({ message, topic, dedupeKey });
        return { duplicate: false };
      },
    };
    /** 审计替身（D6）：记录 (client, input) —— 以 client 同一性断言「与清绑定同事务」。 */
    const audit = {
      records: [],
      async record(client, input) {
        this.records.push({ client, input });
      },
    };
    /** 事务替身：单层事务直接跑回调并把 tx 传给仓储 / 审计（同一对象 = 同一事务证据）。 */
    const database = { db: { transaction: async (fn) => fn({ tx: "stub" }) } };
    const config = { env: { WECOM_BOT_ID: BOT_ID_STUB } };
    return {
      service: new dm.NotifyDmService(repo, aibot, inbox, clock, config, audit, database),
      repo,
      aibot,
      inbox,
      audit,
    };
  };

  /** 已绑定（可投递）场景：联系人 + 绑定行齐备（M5-03-5-6 起发送地址 = 绑定行 open_userid）。 */
  const boundService = (clientResult) => {
    const made = makeService(clientResult);
    made.repo.bindings.set(BOT_ID_STUB + "|" + OPEN_USERID, {
      botId: BOT_ID_STUB,
      wecomUserid: OPEN_USERID,
      userId: USER_ID,
      boundAt: AT,
    });
    return made;
  };

  // S6 ok → done + sent 行 + 旁证回填（D4）
  {
    const { service, repo, aibot, inbox } = boundService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("S6 消费 ok：done", outcome.outcome, "done");
    assertEqual(
      "S6 消费 ok：sent 行（target = 绑定行 open_userid / attempts=1 / sentAt 非空 / error null）",
      repo.deliveries[0].state + ":" + repo.deliveries[0].target + ":" + String(repo.deliveries[0].attempts) + ":" + String(repo.deliveries[0].sentAt !== null) + ":" + String(repo.deliveries[0].error),
      "sent:" + OPEN_USERID + ":1:true:null",
    );
    assertEqual("S6 消费 ok：发帧目标 = 绑定行地址（不再读 users.username）", aibot.sends[0].userid, OPEN_USERID);
    assertEqual("S6 消费 ok：内容逐字 = 加粗标题 + 空行 + 正文", aibot.sends[0].content, "**任务节点完成**\n\n节点：到货验收 负责人：张工");
    assertEqual("S6 消费 ok：未命中激活表 → dmActivated=false 传入（D4 不拦截、仍尝试发送）", String(aibot.sends[0].dmActivated), "false");
    assertTrue(
      "S6 消费 ok：旁证回填（D4）—— bot_id / wecom_userid / user_id / 时刻",
      repo.backfillCalls.length === 1 &&
        repo.backfillCalls[0].botId === BOT_ID_STUB &&
        repo.backfillCalls[0].wecomUserid === OPEN_USERID &&
        repo.backfillCalls[0].userId === USER_ID &&
        repo.backfillCalls[0].at.getTime() === AT.getTime(),
    );
    assertEqual("S6 消费 ok：不产生降级副本", String(inbox.copies.length), "0");
  }

  // S7 命中激活表 → dmActivated=true、不重复回填
  {
    const { service, repo, aibot } = boundService({ ok: true, attempts: 1 });
    repo.activations.set(BOT_ID_STUB + "|" + OPEN_USERID, {
      wecomUserid: OPEN_USERID,
      userId: USER_ID,
      firstActivatedAt: AT,
      lastMessageAt: AT,
    });
    await service.consume(claimedRow(payload()));
    assertTrue(
      "S7 命中激活表 → dmActivated=true 传入且不重复回填",
      aibot.sends[0].dmActivated === true && repo.backfillCalls.length === 0,
    );
  }

  // S8 rate_limited → deferred
  {
    const retryAt = new Date(AT.getTime() + 30_000);
    const { service, repo } = boundService({ ok: false, kind: "rate_limited", errcode: null, errmsg: "本地限速桶已满", retryAt, attempts: 0, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual(
      "S8 rate_limited：deferred + availableAt = retryAt（attempts 不消耗）",
      outcome.outcome + ":" + String(outcome.availableAt.getTime() === retryAt.getTime()),
      "deferred:true",
    );
    assertEqual(
      "S8 rate_limited：deferred 行（attempts=0 / sentAt null）",
      repo.deliveries[0].state + ":" + String(repo.deliveries[0].attempts) + ":" + String(repo.deliveries[0].sentAt),
      "deferred:0:null",
    );
  }

  // S9 retryable → retry
  {
    const { service, repo } = boundService({ ok: false, kind: "retryable", errcode: 846609, errmsg: "not subscribed", retryAt: null, attempts: 1, state: "backoff" });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("S9 retryable（未订阅 / 断连）：retry + failed 行", outcome.outcome + ":" + repo.deliveries[0].state, "retry:failed");
  }

  // S10 permanent 853000 → dead + 通用前缀降级
  {
    const { service, repo, inbox } = boundService({ ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload({ refType: "task", refId: "33333333-3333-4333-8333-333333333333" })));
    assertTrue(
      "S10 permanent（853000）：dead + dead 行（含 errcode）",
      outcome.outcome === "dead" && outcome.error.includes("853000") && repo.deliveries[0].state === "dead",
    );
    assertTrue(
      "S10 permanent 降级（C5-04）：同收件人站内信副本（:c504 / 通用前缀 / 标题与关联对象保留 / 不带激活指引）",
      inbox.copies.length === 1 &&
        inbox.copies[0].dedupeKey === "R02:t-1:v5:aibot:c504" &&
        inbox.copies[0].topic === "notify.message" &&
        inbox.copies[0].message.recipientId === USER_ID &&
        inbox.copies[0].message.title === "任务节点完成" &&
        inbox.copies[0].message.refId === "33333333-3333-4333-8333-333333333333" &&
        String(inbox.copies[0].message.body).startsWith(dm.DM_DEGRADE_PREFIX) &&
        !String(inbox.copies[0].message.body).includes("私发任意消息"),
    );
  }

  // S11 permanent 846607 未命中 → dead + 绑定指引前缀（D4 终稿 · 兜底分支）
  {
    const { service, inbox, aibot } = boundService({ ok: false, kind: "permanent", errcode: 846607, errmsg: "aibot send msg frequency limit exceeded", retryAt: null, attempts: 1, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "S11 846607 未命中激活表：dmActivated=false 传入 + dead 收口",
      aibot.sends[0].dmActivated === false && outcome.outcome === "dead",
    );
    assertTrue(
      "S11 降级前缀附绑定指引话术终稿（D4 · 2026-10-16 · 含终稿句与原文保留）",
      inbox.copies.length === 1 &&
        String(inbox.copies[0].message.body).startsWith(dm.DM_BINDING_DEGRADE_PREFIX) &&
        String(inbox.copies[0].message.body).includes("当前用户未绑定企业微信，请前往设置补绑") &&
        !String(inbox.copies[0].message.body).includes("私发任意消息") &&
        String(inbox.copies[0].message.body).includes("节点：到货验收 负责人：张工"),
    );
  }

  // S12 收件人不存在 → dead，不降级
  {
    const { service, repo, aibot, inbox } = makeService({ ok: true, attempts: 1 });
    repo.contacts.clear();
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "S12 收件人不存在：dead + dead 行（target=user:<id>）、不发送、不降级",
      outcome.outcome === "dead" && repo.deliveries[0].target === "user:" + USER_ID && aibot.sends.length === 0 && inbox.copies.length === 0,
    );
  }

  // S13 收件人停用 → dead + 降级
  {
    const { service, repo, inbox } = makeService({ ok: true, attempts: 1 });
    repo.contacts.set(USER_ID, contact({ status: "disabled" }));
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "S13 收件人停用：dead + dead 行 + 降级（用户存在即降级 · 同 app 口径）",
      outcome.outcome === "dead" && repo.deliveries[0].state === "dead" && inbox.copies.length === 1,
    );
  }

  // S14 降级写库失败 → retry
  {
    const { service, inbox } = boundService({ ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" });
    inbox.failNext = true;
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "S14 降级站内信写库失败：retry 收敛（有界重试不静默丢）",
      outcome.outcome === "retry" && String(outcome.error).includes("降级站内信失败"),
    );
  }

  // S15 激活登记 ingest（D1：非绑定码单聊消息仍登记 —— 但不可作发送地址）
  {
    const { service, repo, aibot } = makeService({ ok: true, attempts: 1 });
    const incoming = dmIncoming({ text: "你好" });
    await service.ingestCallback(incoming);
    await service.ingestCallback(incoming); // 幂等复放（刷新 last_message_at）
    assertTrue(
      "S15 单聊消息回调 ingest：登记 upsert 幂等（原文 userid + bot_id / user_id 留空 / last_message_at 刷新）",
      repo.upsertCalls.length === 2 &&
        repo.upsertCalls[0].botId === BOT_ID_STUB &&
        repo.upsertCalls[0].wecomUserid === OPEN_USERID &&
        Object.keys(repo.upsertCalls[0]).length === 3 &&
        repo.activations.get(BOT_ID_STUB + "|" + OPEN_USERID).lastMessageAt.getTime() === AT.getTime() &&
        repo.activations.get(BOT_ID_STUB + "|" + OPEN_USERID).userId === null,
    );
    assertEqual("S15 非绑定码消息不绑定、不回复（防探测）", String(repo.bindCalls.length) + ":" + String(aibot.replies.length), "0:0");
    await service.ingestCallback(dmIncoming({ cmd: "aibot_event_callback", text: CODE })); // enter_chat 不处理
    await service.ingestCallback(dmIncoming({ chattype: "group", chatid: "wrsuTest", text: CODE }));
    await service.ingestCallback(dmIncoming({ fromUserId: null, text: CODE }));
    await service.ingestCallback(dmIncoming({ fromUserId: "bad userid!", text: CODE }));
    assertEqual(
      "S15 事件回调 / 群聊回调 / userid 缺失或非法：不登记、不绑定",
      String(repo.upsertCalls.length) + ":" + String(repo.bindCalls.length),
      "2:0",
    );
  }

  // S16 会话内回执帧形锁帧（aibot_respond_msg + 回调 req_id 透传 + 单帧收敛流式回复）
  {
    const { aibot, sockets } = makeRuntime();
    const socket = await connect(aibot, sockets);
    const pending = aibot.replyToCallback({ reqId: "ReqIdCallback0001", userid: OPEN_USERID, content: "绑定成功" });
    await sleep(0);
    const frame = socket.lastFrame();
    const body = frame.body ?? {};
    check(
      "S16 回执帧形锁帧：cmd=aibot_respond_msg + headers.req_id = 回调 req_id + body = { msgtype: stream, stream: { id, finish: true, content } }",
      frame.cmd === "aibot_respond_msg" &&
        frame.headers?.req_id === "ReqIdCallback0001" &&
        body.msgtype === "stream" &&
        body.stream?.finish === true &&
        body.stream?.content === "绑定成功" &&
        typeof body.stream?.id === "string" &&
        body.stream.id.startsWith("stream_") &&
        Object.keys(body).length === 2 &&
        Object.keys(body.stream).length === 3,
      JSON.stringify(frame),
    );
    socket.ackLast(0);
    const replied = await pending;
    check("S16 回执：errcode=0 → ok / attempts=1", replied.ok === true && replied.attempts === 1, JSON.stringify(replied));
    await aibot.stop();
  }

  // S17 未绑定企微（无绑定行）→ 不发帧 + dead + D4 绑定指引降级
  {
    const { service, repo, aibot, inbox } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual(
      "S17 未绑定：不发帧 + dead 行（target=user:<id> / attempts=0）",
      outcome.outcome + ":" + String(aibot.sends.length) + ":" + repo.deliveries[0].state + ":" + repo.deliveries[0].target,
      "dead:0:dead:user:" + USER_ID,
    );
    assertTrue(
      "S17 未绑定降级（C5-04 · D4 终稿）：站内信副本含终稿句、不带旧 B6 话术",
      inbox.copies.length === 1 &&
        inbox.copies[0].dedupeKey === "R02:t-1:v5:aibot:c504" &&
        String(inbox.copies[0].message.body).startsWith(dm.DM_BINDING_DEGRADE_PREFIX) &&
        String(inbox.copies[0].message.body).includes("当前用户未绑定企业微信，请前往设置补绑") &&
        !String(inbox.copies[0].message.body).includes("私发任意消息"),
    );
  }

  // S18 绑定码 ingest 全分支（命中 / 跨用户换绑 / 重复投递 / 过期 / 未命中）
  {
    const { service, repo, aibot, audit } = makeService({ ok: true, attempts: 1 });
    repo.codes.set(CODE, { id: 7, code: CODE, userId: USER_ID, status: "pending", expiresAt: new Date(AT.getTime() + 300_000) });
    await service.ingestCallback(dmIncoming({ text: "绑定" + CODE }));
    assertTrue(
      "S18 命中：同事务写绑定（bot_id + open_userid + 库内用户）+ 标记码已用",
      repo.bindCalls.length === 1 &&
        repo.bindCalls[0].codeId === 7 &&
        repo.bindCalls[0].botId === BOT_ID_STUB &&
        repo.bindCalls[0].wecomUserid === OPEN_USERID &&
        repo.bindCalls[0].userId === USER_ID &&
        repo.bindings.get(BOT_ID_STUB + "|" + OPEN_USERID).userId === USER_ID &&
        repo.codes.get(CODE).status === "used",
    );
    assertEqual(
      "S18 命中回执：会话内回「绑定成功」（透传回调 req_id）",
      aibot.replies[0].reqId + ":" + aibot.replies[0].content,
      "ReqIdCallback0001:" + dm.DM_BINDING_REPLY_BOUND,
    );
    await service.ingestCallback(dmIncoming({ text: CODE }));
    assertEqual(
      "S18 同一码重复投递（码已用 + 绑定仍归码持有者）：回「绑定成功」幂等、不重复绑定、零审计",
      aibot.replies[1].content + ":" + String(repo.bindCalls.length) + ":" + String(audit.records.length),
      dm.DM_BINDING_REPLY_BOUND + ":1:0",
    );

    // 跨用户换绑（v1.8 口径核心）：该企微号已挂在别的库内用户上 → 以码持有者为准，不再短路「已绑定」。
    const OTHER_USER = "22222222-2222-4222-8222-222222222222";
    const rebind = makeService({ ok: true, attempts: 1 });
    rebind.repo.bindings.set(BOT_ID_STUB + "|" + OPEN_USERID, {
      botId: BOT_ID_STUB,
      wecomUserid: OPEN_USERID,
      userId: USER_ID,
      boundAt: AT,
    });
    rebind.repo.codes.set(CODE, { id: 9, code: CODE, userId: OTHER_USER, status: "pending", expiresAt: new Date(AT.getTime() + 300_000) });
    await rebind.service.ingestCallback(dmIncoming({ text: "绑定" + CODE }));
    assertTrue(
      "S18 跨用户换绑（v1.8）：该企微号改挂到码持有者（旧持有者回落未绑定）+ 回「绑定成功」",
      rebind.repo.bindings.get(BOT_ID_STUB + "|" + OPEN_USERID).userId === OTHER_USER &&
        (await rebind.service.getBindingState(USER_ID)).bound === false &&
        (await rebind.service.getBindingState(OTHER_USER)).bound === true &&
        rebind.aibot.replies[0].content === dm.DM_BINDING_REPLY_BOUND,
    );
    assertTrue(
      "S18 换绑审计（v1.8）：audit_logs 1 条（user / update / 旧持有者 → 码持有者 / 只带掩码）+ 与绑定改挂同一事务",
      rebind.audit.records.length === 1 &&
        rebind.audit.records[0].input.action === "update" &&
        rebind.audit.records[0].input.objectType === "user" &&
        rebind.audit.records[0].input.objectId === USER_ID &&
        rebind.audit.records[0].input.actorId === OTHER_USER &&
        rebind.audit.records[0].input.summary.includes("****" + OPEN_USERID.slice(-4)) &&
        !JSON.stringify(rebind.audit.records[0].input).includes(OPEN_USERID) &&
        rebind.audit.records[0].client === rebind.repo.bindClients[0],
    );

    const stale = makeService({ ok: true, attempts: 1 });
    stale.repo.codes.set(CODE, { id: 8, code: CODE, userId: USER_ID, status: "pending", expiresAt: new Date(AT.getTime() - 1_000) });
    await stale.service.ingestCallback(dmIncoming({ text: CODE }));
    assertEqual(
      "S18 码过期：回「码已失效」+ 不写绑定",
      stale.aibot.replies[0].content + ":" + String(stale.repo.bindCalls.length),
      dm.DM_BINDING_REPLY_INVALID + ":0",
    );

    const miss = makeService({ ok: true, attempts: 1 });
    await miss.service.ingestCallback(dmIncoming({ text: "绑定654321" }));
    assertEqual(
      "S18 未命中任何码：登记激活但不回复（防探测）",
      String(miss.repo.upsertCalls.length) + ":" + String(miss.aibot.replies.length) + ":" + String(miss.repo.bindCalls.length),
      "1:0:0",
    );
  }

  // S19 取码（TTL / 频率限制 / 撞码重试）
  {
    const { service, repo } = makeService({ ok: true, attempts: 1 });
    const issued = await service.requestBindingCode(USER_ID);
    assertTrue(
      "S19 取码：6 位数字 + TTL 5 分钟 + 委托仓储同一事务（作废旧 pending + 插新码）",
      issued.ok === true &&
        /^[0-9]{6}$/.test(issued.code) &&
        issued.expiresAt.getTime() === AT.getTime() + 300_000 &&
        repo.codeCreateCalls.length === 1 &&
        repo.codeCreateCalls[0].userId === USER_ID,
    );
    const throttled = makeService({ ok: true, attempts: 1 });
    const first = new Date(AT.getTime() - 170_000);
    throttled.repo.issuedAt = [
      first,
      new Date(AT.getTime() - 140_000),
      new Date(AT.getTime() - 110_000),
      new Date(AT.getTime() - 80_000),
      new Date(AT.getTime() - 50_000),
    ];
    const limited = await throttled.service.requestBindingCode(USER_ID);
    assertTrue(
      "S19 频率限制：3 分钟窗口内第 6 次取码 → rate_limited + retryAt = 最早一次 + 窗口长度（最长 ≤ 3 分钟）",
      limited.ok === false &&
        limited.reason === "rate_limited" &&
        limited.retryAt.getTime() === first.getTime() + 180_000 &&
        limited.retryAt.getTime() - AT.getTime() <= 180_000 &&
        throttled.repo.codeCreateCalls.length === 0,
    );
    const clash = makeService({ ok: true, attempts: 1 });
    clash.repo.codeConflicts = 2;
    const retried = await clash.service.requestBindingCode(USER_ID);
    assertTrue(
      "S19 撞码重试：唯一键挡下两次 → 第三次成功（共 3 次写入尝试）",
      retried.ok === true && clash.repo.codeCreateCalls.length === 3,
    );
  }

  // S20 绑定态读面 + 解绑（契约刀：D5 读面 / D6 解绑 + 同事务审计 / 幂等）
  {
    const bound = boundService({ ok: true, attempts: 1 });
    const state = await bound.service.getBindingState(USER_ID);
    assertEqual(
      "S20 绑定态读面（D5）：已绑定 → bound:true + open_userid 掩码末 4 位 + boundAt",
      String(state.bound) + ":" + String(state.wecomUseridMasked) + ":" + String(state.boundAt),
      "true:****" + OPEN_USERID.slice(-4) + ":" + AT.toISOString(),
    );

    const after = await bound.service.unbind(USER_ID, USER_ID);
    assertEqual(
      "S20 解绑（D6）：收回落 bound:false（掩码 / 时刻一律 null —— 不回泄漏已解绑地址）",
      String(after.bound) + ":" + String(after.wecomUseridMasked) + ":" + String(after.boundAt),
      "false:null:null",
    );
    assertEqual(
      "S20 解绑：清绑定行 1 行 → 寻址面回落未绑定（findBindingByUserId 不再命中）",
      String(bound.repo.clearCalls.length) + ":" + String(bound.repo.bindings.size) + ":" + String((await bound.service.getBindingState(USER_ID)).bound),
      "1:0:false",
    );
    assertTrue(
      "S20 解绑审计（D6）：audit_logs 1 条（objectType=user / action=delete / actor=本人 / 摘要与 changes 只带掩码）",
      bound.audit.records.length === 1 &&
        bound.audit.records[0].input.objectType === "user" &&
        bound.audit.records[0].input.action === "delete" &&
        bound.audit.records[0].input.objectId === USER_ID &&
        bound.audit.records[0].input.actorId === USER_ID &&
        bound.audit.records[0].input.summary.includes("****" + OPEN_USERID.slice(-4)) &&
        bound.audit.records[0].input.changes[0].field === "wecomDmBinding" &&
        bound.audit.records[0].input.changes[0].from === "****" + OPEN_USERID.slice(-4) &&
        bound.audit.records[0].input.changes[0].to === null &&
        bound.audit.records[0].input.metadata.bound === false &&
        bound.audit.records[0].input.metadata.botId === BOT_ID_STUB,
    );
    assertEqual(
      "S20 解绑审计与清绑定同事务（同一 client 对象传入仓储与审计）",
      String(bound.audit.records[0].client === bound.repo.clearCalls[0].client),
      "true",
    );

    const again = await bound.service.unbind(USER_ID, USER_ID);
    assertEqual(
      "S20 解绑幂等：再解绑 → bound:false 且零副作用（本次不清库、审计仍 1 条）",
      String(again.bound) + ":" + String(bound.repo.clearCalls.length) + ":" + String(bound.audit.records.length),
      "false:1:1",
    );

    const plain = makeService({ ok: true, attempts: 1 });
    const none = await plain.service.unbind(USER_ID, USER_ID);
    assertEqual(
      "S20 未绑定解绑：bound:false 且不触库 / 不写审计（幂等幂）",
      String(none.bound) + ":" + String(plain.repo.clearCalls.length) + ":" + String(plain.audit.records.length),
      "false:0:0",
    );

    const race = boundService({ ok: true, attempts: 1 });
    race.repo.clearOverride = 0;
    const raced = await race.service.unbind(USER_ID, USER_ID);
    assertEqual(
      "S20 解绑竞态（清 0 行 = 他处已清）：不写审计、仍回 bound:false",
      String(raced.bound) + ":" + String(race.repo.clearCalls.length) + ":" + String(race.audit.records.length),
      "false:1:0",
    );
  }

  // S21 读面回填（v1.8 · Push 254）：GET 同形回「当前未用绑定码」与「取码限流可重试时刻」—— 刷新不丢码面 / 罚时
  {
    const { service, repo } = makeService({ ok: true, attempts: 1 });
    repo.codes.set(CODE, { id: 7, code: CODE, userId: USER_ID, status: "pending", expiresAt: new Date(AT.getTime() + 240_000) });
    repo.issuedAt = [
      new Date(AT.getTime() - 170_000),
      new Date(AT.getTime() - 140_000),
      new Date(AT.getTime() - 110_000),
      new Date(AT.getTime() - 80_000),
      new Date(AT.getTime() - 50_000),
    ];
    const state = await service.getBindingState(USER_ID);
    assertTrue(
      "S21 读面回填（v1.8）：未用码（码 + 失效时刻 + 剩余秒）+ 罚时可重试时刻（与取码侧同一判定）",
      state.bound === false &&
        state.bindingCode !== null &&
        state.bindingCode.code === CODE &&
        state.bindingCode.expiresAt === new Date(AT.getTime() + 240_000).toISOString() &&
        state.bindingCode.expiresInSeconds === 240 &&
        state.retryAt === new Date(AT.getTime() - 170_000 + 180_000).toISOString(),
    );
    const stale = makeService({ ok: true, attempts: 1 });
    stale.repo.codes.set(CODE, { id: 7, code: CODE, userId: USER_ID, status: "pending", expiresAt: new Date(AT.getTime() - 1) });
    const staleState = await stale.service.getBindingState(USER_ID);
    assertTrue(
      "S21 读面回填：码已过期 / 未到限流 → bindingCode 与 retryAt 一律 null（只回「此刻仍可用」的状态）",
      staleState.bindingCode === null && staleState.retryAt === null,
    );
  }

  const summary = "m5-03-5 单聊 aibot（实现段 + M5-03-5-6 绑定码链路 + 契约刀绑定端点）回放：PASS " + pass + " / FAIL " + fail;
  console.log(summary);
  for (const line of report) console.log("  " + line);
  if (args.out) {
    writeFileSync(args.out, "# " + summary + "\n\n" + report.map((line) => "- " + line).join("\n") + "\n", "utf8");
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ pass, fail, checks: evidence.checks }, null, 2) + "\n", "utf8");
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
