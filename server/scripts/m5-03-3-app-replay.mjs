#!/usr/bin/env node
/**
 * M5-03-3 · 应用消息 + 告警出口 · 本地回放（无网络 / 无 PG）：
 *   驱动 server/dist 的 wecom_app 链路（NotifyAppService + WecomAlertSink），覆盖：
 *   ① 文本组装 / 字节截断 / 掩码（纯函数）；
 *   ② 消费三分类 —— ok → done + sent 行 / rate_limited → deferred（attempts 不消耗）/ retryable → retry +
 *      failed 行 / permanent（60011 / token 失效重取后仍失败）→ dead + dead 行 + C5-04 降级（站内信副本 :c504）；
 *   ③ 收件人不可投递收敛 —— 不存在 → dead + 不降级；停用 / 离职 / userid 缺失 → dead + 降级；
 *   ④ 渠道路由防御（非 wecom_app → dead；生产装配在 OutboxModule 按 channel 分流）；
 *   ⑤ 告警出口（WecomAlertSink）—— 推管理员告警群 / 同族 15 分钟抑制（死信即时 / 探针同族）/ 失败回退结构化日志。
 *
 * 前置：已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && node scripts/m5-03-3-app-replay.mjs [--out <报告.md>] [--json <证据.json>]
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

const AT = new Date("2026-10-12T06:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USERID = "zhangsan";
const REF_ID = "33333333-3333-4333-8333-333333333333";
const ALERT_CHATID = "AlertChatIdAbcDef-99";

function claimedRow(payload, overrides = {}) {
  return {
    id: 9,
    topic: "notify.message",
    payload,
    dedupeKey: "R02:t-1:v5:app",
    attempts: 0,
    availableAt: AT,
    lockedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return { recipientId: USER_ID, type: "reminder", channel: "wecom_app", title: "任务节点完成", body: "节点：到货验收 负责人：张工", ...overrides };
}

function contact(overrides = {}) {
  return { id: USER_ID, username: USERID, status: "active", removedAt: null, ...overrides };
}

function permanent(errcode, errmsg) {
  return { ok: false, kind: "permanent", errcode, errmsg, httpStatus: null, retryAt: null, retriedToken: false, attempts: 1 };
}

async function main() {
  const app = await import(pathToFileURL(join(HERE, "..", "dist", "modules", "notify", "notify.app.service.js")).href);
  const alert = await import(pathToFileURL(join(HERE, "..", "dist", "outbox", "wecom-alert.sink.js")).href);
  const { ClockService } = await import(pathToFileURL(join(HERE, "..", "dist", "common", "clock", "clock.service.js")).href);
  const { createReplayNotifyDeliveryArchive } = await import(pathToFileURL(join(HERE, "support", "notify-delivery-archive-fake.mjs")).href);

  check("A1 dist 应用消息消费服务可用（NotifyAppService 导出）", typeof app.NotifyAppService === "function");

  const clock = new ClockService();
  clock.setSource(() => AT);

  // ---- 纯函数：组装 / 截断 / 掩码 ----
  assertEqual("A2 组装：标题 + 空行 + 正文（text 无 markdown）", app.composeAppText({ title: "T", body: "B" }), "T\n\nB");
  const truncated = app.truncateAppText("汉".repeat(3_000));
  assertTrue(
    "A3 截断：超长按字节截断（≤ 2000 字节 + 省略标记 + 不劈多字节）",
    truncated.truncated &&
      Buffer.byteLength(truncated.content, "utf8") <= app.APP_TEXT_MAX_BYTES &&
      truncated.content.endsWith(app.APP_TRUNCATION_SUFFIX) &&
      !truncated.content.includes("\uFFFD") &&
      truncated.content.length < 3_000,
  );
  assertEqual("A4 截断：未超长原样", app.truncateAppText("短消息").content, "短消息");
  assertEqual("A5 掩码：只回末 4 位", app.maskUserid(USERID), "****gsan");

  // ---- 消费（假仓储 / 假 HTTP 客户端 / 假站内信 · 生产 = OutboxModule 按 channel=wecom_app 路由） ----
  const makeService = (clientResult) => {
    const repo = {
      contacts: new Map([[USER_ID, contact()]]),
      findCalls: [],
      deliveries: [],
      async findContact(userId) {
        this.findCalls.push(userId);
        return this.contacts.get(userId) ?? null;
      },
      async insertDelivery(input) {
        this.deliveries.push(input);
      },
    };
    const client = {
      sends: [],
      async sendAppText(params) {
        this.sends.push(params);
        return clientResult;
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
    const archive = createReplayNotifyDeliveryArchive(repo);
    return { service: new app.NotifyAppService(repo, archive, client, inbox, clock), repo, archive, client, inbox };
  };

  {
    const { service, repo, client, inbox } = makeService({ ok: true, retriedToken: false, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("A6 消费 ok：done", outcome.outcome, "done");
    assertEqual(
      "A7 消费 ok：sent 行（target=userid / attempts=1 / sentAt 非空 / error null）",
      repo.deliveries[0].state + ":" + repo.deliveries[0].target + ":" + String(repo.deliveries[0].attempts) + ":" + String(repo.deliveries[0].sentAt !== null) + ":" + String(repo.deliveries[0].error),
      "sent:" + USERID + ":1:true:null",
    );
    assertEqual("A8 消费 ok：发送内容逐字 = 标题 + 空行 + 正文", client.sends[0].content, "任务节点完成\n\n节点：到货验收 负责人：张工");
    assertEqual("A9 消费 ok：touser = [userid]", JSON.stringify(client.sends[0].toUser), JSON.stringify([USERID]));
    assertEqual("A10 消费 ok：不产生降级副本", String(inbox.copies.length), "0");
  }

  {
    const retryAt = new Date(AT.getTime() + 30_000);
    const { service, repo } = makeService({ ok: false, kind: "rate_limited", errcode: 45009, errmsg: "api freq out of limit", httpStatus: null, retryAt, retriedToken: false, attempts: 0 });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("A11 rate_limited：deferred + availableAt = retryAt（attempts 不消耗）", outcome.outcome + ":" + String(outcome.availableAt.getTime() === retryAt.getTime()), "deferred:true");
    assertEqual("A12 rate_limited：deferred 行（attempts=0 / sentAt null）", repo.deliveries[0].state + ":" + String(repo.deliveries[0].attempts) + ":" + String(repo.deliveries[0].sentAt), "deferred:0:null");
  }

  {
    const { service, repo } = makeService({ ok: false, kind: "retryable", errcode: -1, errmsg: "系统繁忙", httpStatus: null, retryAt: null, retriedToken: false, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("A13 retryable：retry + failed 行", outcome.outcome + ":" + repo.deliveries[0].state, "retry:failed");
  }

  {
    const { service, repo, inbox } = makeService(permanent(60011, "invalid userid"));
    const outcome = await service.consume(claimedRow(payload({ refType: "task", refId: REF_ID, templateCode: "R02_WECOM" })));
    assertTrue("A14 permanent（60011）：dead + dead 行（含 errcode）", outcome.outcome === "dead" && outcome.error.includes("60011") && repo.deliveries[0].state === "dead");
    assertTrue(
      "A15 permanent 降级（C5-04）：同收件人站内信副本（:c504 / 前缀 / 标题与关联对象保留）",
      inbox.copies.length === 1 &&
        inbox.copies[0].dedupeKey === "R02:t-1:v5:app:c504" &&
        inbox.copies[0].topic === "notify.message" &&
        inbox.copies[0].message.recipientId === USER_ID &&
        inbox.copies[0].message.type === "reminder" &&
        inbox.copies[0].message.title === "任务节点完成" &&
        inbox.copies[0].message.refType === "task" &&
        inbox.copies[0].message.refId === REF_ID &&
        String(inbox.copies[0].message.body).startsWith(app.APP_DEGRADE_PREFIX),
    );
  }

  {
    const { service, inbox } = makeService({ ok: false, kind: "token_invalid", errcode: 40014, errmsg: "invalid access_token", httpStatus: null, retryAt: null, retriedToken: true, attempts: 2 });
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("A16 token 失效重取后仍失败：按配置类收口 dead + 降级", outcome.outcome === "dead" && inbox.copies.length === 1);
  }

  {
    const { service, repo, client, inbox } = makeService({ ok: true, attempts: 1 });
    repo.contacts = new Map();
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "A17 收件人不存在：dead + dead 行（target=user:<id>）、不发送、不降级",
      outcome.outcome === "dead" && repo.deliveries[0].state === "dead" && repo.deliveries[0].target === "user:" + USER_ID && repo.deliveries[0].attempts === 0 && client.sends.length === 0 && inbox.copies.length === 0,
    );
  }

  {
    const { service, repo, inbox } = makeService(permanent(853000, "invalid bot"));
    repo.contacts.set(USER_ID, contact({ status: "disabled" }));
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "A18 收件人停用：dead + dead 行（target=userid）+ 降级",
      outcome.outcome === "dead" && repo.deliveries[0].state === "dead" && repo.deliveries[0].target === USERID && repo.deliveries[0].error === "收件人不可投递（已停用）" && inbox.copies.length === 1,
    );
  }

  {
    const { service, repo, inbox } = makeService(permanent(853000, "invalid bot"));
    repo.contacts.set(USER_ID, contact({ removedAt: AT }));
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("A19 收件人离职（目录源删除）：dead + 降级", outcome.outcome === "dead" && String(repo.deliveries[0].error).includes("已删除") && inbox.copies.length === 1);
  }

  {
    const { service, repo, client, inbox } = makeService(permanent(853000, "invalid bot"));
    repo.contacts.set(USER_ID, contact({ username: "  " }));
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "A20 userid 缺失：dead + dead 行（target=user:<id>）、不发送、降级",
      outcome.outcome === "dead" && repo.deliveries[0].target === "user:" + USER_ID && repo.deliveries[0].error === "收件人不可投递（userid 缺失）" && client.sends.length === 0 && inbox.copies.length === 1,
    );
  }

  {
    const { service, repo, client } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload({ body: "长".repeat(3_000) })));
    assertTrue(
      "A21 截断发送：超长正文按 2000 字节截断发出（≤ 上限 + 省略标记）+ sent 行",
      outcome.outcome === "done" && Buffer.byteLength(client.sends[0].content, "utf8") <= app.APP_TEXT_MAX_BYTES && client.sends[0].content.endsWith(app.APP_TRUNCATION_SUFFIX) && repo.deliveries[0].state === "sent",
    );
  }

  {
    const { service, repo, client } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload({ channel: "inbox" })));
    assertTrue(
      "A22 渠道路由防御：非 wecom_app（inbox）→ dead、不读联系人、不发送",
      outcome.outcome === "dead" && outcome.error.includes("渠道异常") && repo.findCalls.length === 0 && repo.deliveries.length === 0 && client.sends.length === 0,
    );
  }

  {
    const { service, repo, client } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow({ recipientId: USER_ID, type: "unknown", title: "t", body: "b", channel: "wecom_app" }));
    assertTrue(
      "A23 非法载荷：dead、不读联系人、不发送",
      outcome.outcome === "dead" && repo.findCalls.length === 0 && repo.deliveries.length === 0 && client.sends.length === 0,
    );
  }

  {
    const { service, repo, inbox } = makeService(permanent(853000, "invalid bot"));
    inbox.failNext = true;
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue(
      "A24 降级站内信写库失败：retry 收敛（有界重试不静默丢）",
      outcome.outcome === "retry" && String(outcome.error).includes("降级站内信失败") && repo.deliveries[0].state === "dead",
    );
  }

  // ---- 告警出口（WecomAlertSink · 单一管理员告警群 + 可执行即时告警 + 日报） ----
  const actionable = {
    code: "outbox.queue_stalled",
    level: "error",
    message: "outbox 队列停滞",
    impact: "通知可能延迟",
    action: "检查 worker 与消费者",
  };
  assertEqual(
    "W1 即时告警文本：含 code / message / 影响 / 处置（detail 不回显 JSON）",
    alert.composeAlertText(actionable),
    "【LibiaoLink 告警】outbox.queue_stalled\noutbox 队列停滞\n影响：通知可能延迟\n处置：检查 worker 与消费者",
  );

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const makeAlertSink = (clientResult, nowFn) => {
    const aibot = {
      sends: [],
      async sendGroupMarkdown(params) {
        if (clientResult instanceof Error) throw clientResult;
        this.sends.push(params);
        return clientResult;
      },
    };
    const fallback = {
      emitted: [],
      digests: [],
      emit(value) { this.emitted.push(value); },
      emitDigest(value) { this.digests.push(value); },
    };
    const sink = new alert.WecomAlertSink(aibot, ALERT_CHATID, fallback, nowFn ?? (() => 1_000_000));
    return { sink, aibot, fallback };
  };

  {
    const { sink, aibot, fallback } = makeAlertSink({ ok: true, attempts: 1 });
    sink.emit(actionable);
    await flush();
    assertTrue(
      "W2 可执行告警：经智能机器人推唯一管理员告警群（chatid + 影响 + 处置）",
      aibot.sends.length === 1 && aibot.sends[0].chatid === ALERT_CHATID && String(aibot.sends[0].content).includes("处置：检查 worker 与消费者") && fallback.emitted.length === 0,
    );
  }

  {
    const { sink, aibot, fallback } = makeAlertSink({ ok: true, attempts: 1 });
    sink.emit({ code: "outbox.dead_letter", level: "error", message: "近期死信 2 条" });
    await flush();
    assertTrue(
      "W2b 无处置动作的告警：不推群，只回退结构化日志",
      aibot.sends.length === 0 && fallback.emitted.length === 1 && fallback.emitted[0].code === "outbox.dead_letter",
    );
  }

  {
    let nowMs = 1_000_000;
    const { sink, aibot, fallback } = makeAlertSink({ ok: true, attempts: 1 }, () => nowMs);
    sink.emit(actionable);
    await flush();
    nowMs += alert.ALERT_SUPPRESS_MS - 1;
    sink.emit(actionable);
    sink.emit({ ...actionable, code: "outbox.unconsumed_topic", message: "未消费主题" });
    await flush();
    const suppressedOk = aibot.sends.length === 2;
    nowMs += 1;
    sink.emit(actionable);
    await flush();
    assertTrue(
      "W3 告警抑制：同 code 15 分钟内只推首条（不同 code 不受影响）、窗口过期恢复",
      suppressedOk && aibot.sends.length === 3 && fallback.emitted.length === 0,
    );
  }

  {
    const { sink, aibot, fallback } = makeAlertSink({ ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪", retryAt: null, attempts: 0, state: "connecting" });
    const value = { ...actionable, code: "outbox.unconsumed_topic", message: "未消费主题" };
    sink.emit(value);
    await flush();
    assertTrue(
      "W4 告警发送失败（ok=false）：回退结构化日志出口",
      aibot.sends.length === 1 && fallback.emitted.length === 1 && fallback.emitted[0].code === value.code,
    );
  }

  {
    const { sink, fallback } = makeAlertSink(new Error("socket 已断开"));
    sink.emit(actionable);
    await flush();
    assertTrue("W5 告警发送异常（抛错）：回退结构化日志出口（告警链不断）", fallback.emitted.length === 1);
  }

  {
    const { sink, aibot, fallback } = makeAlertSink({ ok: true, attempts: 1 });
    sink.emitDigest({
      generatedAt: "2026-10-19T05:00:00.000Z",
      reportAt: "2026-10-19T00:00:00.000Z",
      windowFrom: "2026-10-18T16:00:00.000Z",
      windowTo: "2026-10-19T16:00:00.000Z",
      delivery: { total: 1, delivered: 1, retrying: 0, failed: 0, lateDelivered: 0, maxLatencyMs: null },
      automaticFallbacks: [{ label: "预览确定性拒绝", detail: "preview.job", count: 1 }],
      repeatedIssues: [],
      recoveries: {
        total: 2,
        byCode: [
          { code: "outbox.queue_stalled.recovered", count: 1 },
          { code: "outbox.unconsumed_topic.recovered", count: 1 },
        ],
      },
    });
    await flush();
    assertTrue(
      "W6 管理员日报：固定 08:00 区间、交付结果、自动降级与恢复计数同群展示",
      aibot.sends.length === 1 &&
        aibot.sends[0].chatid === ALERT_CHATID &&
        String(aibot.sends[0].content).includes("【LibiaoLink 管理员日报】") &&
        String(aibot.sends[0].content).includes("统计范围：2026-10-18 00:00–24:00（北京时间）") &&
        String(aibot.sends[0].content).includes("送达 1 · 待重试 0 · 最终失败 0") &&
        String(aibot.sends[0].content).includes("自动降级 1 次") &&
        String(aibot.sends[0].content).includes("已恢复 2 项：队列停滞恢复 1 次 · 未消费主题恢复 1 次") &&
        fallback.digests.length === 0,
    );
  }

  const summary = "m5-03-3 应用消息 + 告警出口回放：PASS " + pass + " / FAIL " + fail;
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
