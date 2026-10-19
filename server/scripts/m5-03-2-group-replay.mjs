#!/usr/bin/env node
/**
 * M5-03-2 接线段 · 本地回放（无网络 / 无 PG）：
 *   驱动 server/dist 的群通道链路（NotifyGroupService + WecomAibotClient 端子 + OutboxDispatcher），覆盖：
 *   ① 载荷解析 / markdown 组装 / 字节截断 / 掩码（纯函数）；
 *   ② 消费三分类 —— ok → done + sent 行 / rate_limited → deferred（attempts 不消耗）/ retryable → retry +
 *      failed 行 / permanent（846607 未激活）→ dead + dead 行 + C5-04 降级（项目经理站内信 · :c504）；
 *      未绑定 / 停用同走降级；非法载荷的确定性收敛；
 *   ③ 回调 ingest（群会话激活置位 / 幂等 / 非群聊忽略）；
 *   ④ dispatcher deferred 收敛（attempts 原值回写 = 不消耗重试预算）。
 *
 * 前置：已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && node scripts/m5-03-2-group-replay.mjs [--out <报告.md>] [--json <证据.json>]
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
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CHATID = "AbcDefGhiJkLmNoPqrStUv-12";

function groupRow(overrides = {}) {
  return {
    id: 1,
    projectId: PROJECT_ID,
    chatid: CHATID,
    name: null,
    enabled: true,
    activatedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function claimedRow(payload, overrides = {}) {
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

function payload(overrides = {}) {
  return { projectId: PROJECT_ID, title: "任务节点完成", body: "**节点**：到货验收", ...overrides };
}

async function main() {
  const distFile = (name) => pathToFileURL(join(HERE, "..", "dist", "modules", "notify", name)).href;
  const group = await import(distFile("notify.group.service.js"));
  const { ClockService } = await import(pathToFileURL(join(HERE, "..", "dist", "common", "clock", "clock.service.js")).href);
  const { OutboxDispatcher } = await import(pathToFileURL(join(HERE, "..", "dist", "outbox", "dispatcher.js")).href);

  check("G1 dist 群播报消费服务可用（NotifyGroupService 导出）", typeof group.NotifyGroupService === "function");

  const clock = new ClockService();
  clock.setSource(() => AT);

  // ---- 纯函数：组装 / 截断 / 掩码 ----
  assertEqual("G2 markdown 组装：无标题只发正文", group.composeGroupMarkdown({ title: null, body: "正文" }), "正文");
  assertEqual("G3 markdown 组装：有标题加粗 + 空行", group.composeGroupMarkdown({ title: "T", body: "B" }), "**T**\n\nB");
  const truncated = group.truncateGroupMarkdown("汉".repeat(10_000));
  assertTrue(
    "G4 截断：超长按字节截断（≤ 20000 字节 + 省略标记 + 不劈多字节）",
    truncated.truncated &&
      Buffer.byteLength(truncated.content, "utf8") <= group.GROUP_MARKDOWN_MAX_BYTES &&
      truncated.content.endsWith(group.GROUP_TRUNCATION_SUFFIX) &&
      !truncated.content.includes("\uFFFD") &&
      truncated.content.length < 10_000,
  );
  assertEqual("G5 截断：未超长原样", group.truncateGroupMarkdown("短消息").content, "短消息");
  assertEqual("G6 掩码：只回末 4 位", group.maskChatid(CHATID), "****v-12");
  assertEqual("G7 载荷解析：title null 归一", group.parseGroupMessage(payload({ title: null })).title, null);
  assertEqual("G8 载荷解析：非法（缺 title 键）→ null", group.parseGroupMessage({ projectId: PROJECT_ID, body: "B" }), null);

  // ---- 消费三分类（假仓储 / 假长连接端子） ----
  const makeService = (aibotResult) => {
    const repo = {
      groups: [groupRow()],
      deliveries: [],
      activateCalls: [],
      managers: new Map([[PROJECT_ID, "u-manager"]]),
      async findGroupByProject(projectId) {
        return this.groups.find((row) => row.projectId === projectId) ?? null;
      },
      async findGroupByChatid(chatid) {
        return this.groups.find((row) => row.chatid === chatid) ?? null;
      },
      async activateByChatid(chatid, at) {
        this.activateCalls.push(chatid);
        const row = this.groups.find((item) => item.chatid === chatid && item.activatedAt === null);
        if (row === undefined) return null;
        row.activatedAt = at;
        return row;
      },
      async findProjectManagerId(projectId) {
        return this.managers.get(projectId) ?? null;
      },
      async insertDelivery(input) {
        this.deliveries.push(input);
      },
    };
    const aibot = {
      sends: [],
      async sendGroupMarkdown(params) {
        this.sends.push(params);
        return aibotResult;
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
    return { service: new group.NotifyGroupService(repo, aibot, inbox, clock), repo, aibot, inbox };
  };

  {
    const { service, repo, aibot } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow(payload({ title: null })));
    assertEqual("G9 消费 ok：done", outcome.outcome, "done");
    assertEqual("G10 消费 ok：sent 行（error null / sentAt 非空）", repo.deliveries[0].state + ":" + String(repo.deliveries[0].error) + ":" + String(repo.deliveries[0].sentAt !== null), "sent:null:true");
    assertEqual("G11 消费 ok：无标题内容逐字 = 正文", aibot.sends[0].content, payload({ title: null }).body);
  }

  {
    const retryAt = new Date(AT.getTime() + 30_000);
    const { service, repo } = makeService({ ok: false, kind: "rate_limited", errcode: null, errmsg: "本地限速桶已满", retryAt, attempts: 0, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("G12 rate_limited：deferred + availableAt = retryAt（attempts 不消耗）", outcome.outcome + ":" + String(outcome.availableAt.getTime() === retryAt.getTime()), "deferred:true");
    assertEqual("G13 rate_limited：deferred 行（attempts=0 / sentAt null）", repo.deliveries[0].state + ":" + String(repo.deliveries[0].attempts) + ":" + String(repo.deliveries[0].sentAt), "deferred:0:null");
  }

  {
    const { service, repo } = makeService({ ok: false, kind: "retryable", errcode: null, errmsg: "长连接未就绪（state=connecting）", retryAt: null, attempts: 0, state: "connecting" });
    const outcome = await service.consume(claimedRow(payload()));
    assertEqual("G14 retryable：retry + failed 行", outcome.outcome + ":" + repo.deliveries[0].state, "retry:failed");
  }

  {
    const { service, repo, inbox } = makeService({ ok: false, kind: "permanent", errcode: 846607, errmsg: "send msg not allowed", retryAt: null, attempts: 1, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload({ templateCode: "R03_GROUP" })));
    assertTrue("G15 permanent（846607 未激活）：dead + dead 行（含 errcode 描述）", outcome.outcome === "dead" && outcome.error.includes("846607") && repo.deliveries[0].state === "dead");
    assertTrue(
      "G15b permanent 降级（B4）：项目经理站内信（:c504 键 + 前缀 + R03 非播报 → reminder）",
      inbox.copies.length === 1 &&
        inbox.copies[0].dedupeKey === "R03:t-1:2026-09-24:c504" &&
        inbox.copies[0].topic === "notify.group" &&
        inbox.copies[0].message.recipientId === "u-manager" &&
        inbox.copies[0].message.type === "reminder" &&
        String(inbox.copies[0].message.body).startsWith(group.GROUP_DEGRADE_PREFIX),
    );
  }

  {
    const { service, inbox } = makeService({ ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" });
    const outcome = await service.consume(claimedRow(payload({ templateCode: "A02_GROUP" })));
    assertTrue("G15c 播报类模板（A02）：降级 type=broadcast", outcome.outcome === "dead" && inbox.copies.length === 1 && inbox.copies[0].message.type === "broadcast");
  }

  {
    const { service, repo, aibot, inbox } = makeService({ ok: true, attempts: 1 });
    repo.groups = [];
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("G16 未绑定：dead 且不写投递行、不发送（差异登记②）", outcome.outcome === "dead" && repo.deliveries.length === 0 && aibot.sends.length === 0);
    assertTrue("G16b 未绑定同样走 B4 降级：项目经理站内信（:c504）", inbox.copies.length === 1 && inbox.copies[0].dedupeKey === "R03:t-1:2026-09-24:c504");
  }

  {
    const { service, repo } = makeService({ ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" });
    repo.managers = new Map();
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("G16c PM 解析不到（项目软删）：跳过站内信，仍 dead", outcome.outcome === "dead");
  }

  {
    const { service, inbox } = makeService({ ok: false, kind: "permanent", errcode: 853000, errmsg: "invalid bot", retryAt: null, attempts: 1, state: "subscribed" });
    inbox.failNext = true;
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("G16d 降级站内信写库失败：retry 收敛（有界重试不静默丢）", outcome.outcome === "retry" && String(outcome.error).includes("降级站内信失败"));
  }

  {
    const { service, repo, aibot, inbox } = makeService({ ok: true, attempts: 1 });
    repo.groups = [groupRow({ enabled: false })];
    const outcome = await service.consume(claimedRow(payload()));
    assertTrue("G17 绑定停用：dead + dead 行（target=chatid）、不发送", outcome.outcome === "dead" && repo.deliveries[0].state === "dead" && repo.deliveries[0].target === CHATID && aibot.sends.length === 0);
    assertTrue("G17b 绑定停用同样走 B4 降级", inbox.copies.length === 1);
  }

  {
    const { service, repo } = makeService({ ok: true, attempts: 1 });
    const outcome = await service.consume(claimedRow({ projectId: "not-a-uuid", body: "B" }));
    assertTrue("G18 非法载荷：dead（不读绑定 / 不留痕）", outcome.outcome === "dead" && repo.deliveries.length === 0);
  }

  // ---- 回调 ingest ----
  {
    const { service, repo } = makeService({ ok: true, attempts: 1 });
    await service.activateFromCallback({ cmd: "aibot_msg_callback", reqId: null, chatid: CHATID, chattype: "group", fromUserId: "u1", msgid: "m1" });
    assertEqual("G19 回调 ingest：未激活 → 置位", String(repo.groups[0].activatedAt !== null), "true");
    await service.activateFromCallback({ cmd: "aibot_msg_callback", reqId: null, chatid: CHATID, chattype: "group", fromUserId: "u1", msgid: "m2" });
    assertEqual("G20 回调 ingest：已激活 → 幂等（activate 仅首次触达）", String(repo.activateCalls.length), "1");
    await service.activateFromCallback({ cmd: "aibot_msg_callback", reqId: null, chatid: CHATID, chattype: "single", fromUserId: "u1", msgid: "m3" });
    assertEqual("G21 回调 ingest：非群聊 → 忽略", String(repo.activateCalls.length), "1");
  }

  // ---- dispatcher：deferred 收敛（attempts 原值回写） ----
  {
    const rows = [claimedRow(payload(), { attempts: 4 })];
    const store = {
      claims: [],
      done: [],
      retried: [],
      dead: [],
      async claim(input) {
        this.claims.push(input);
        return rows.splice(0, input.limit);
      },
      async markDone(id) {
        this.done.push(id);
      },
      async markRetry(id, input) {
        this.retried.push({ id, input });
      },
      async markDead(id, input) {
        this.dead.push({ id, input });
      },
    };
    const retryAt = new Date(AT.getTime() + 45_000);
    const registry = new Map([
      ["notify.group", { handle: async () => ({ outcome: "deferred", availableAt: retryAt, error: "本地限速桶已满" }) }],
    ]);
    const alerts = { emitted: [], digests: [], emit(alert) { this.emitted.push(alert); }, emitDigest(report) { this.digests.push(report); } };
    const { AppConfig } = await import(pathToFileURL(join(HERE, "..", "dist", "config", "config.module.js")).href);
    const config = new AppConfig({ WORKER_ID: "replay", OUTBOX_BATCH_LIMIT: 5, OUTBOX_STALE_MS: 600000, OUTBOX_DEFAULT_MAX_ATTEMPTS: 3, OUTBOX_DEFAULT_BACKOFF_BASE_MS: 1000, OUTBOX_DEFAULT_BACKOFF_MAX_MS: 10000 });
    const dispatcher = new OutboxDispatcher(store, registry, new Map(), alerts, config, clock);
    const stats = await dispatcher.drainOnce();
    assertTrue(
      "G22 dispatcher deferred：attempts 原值回写（4 不累计）+ availableAt 原样 + 无死信告警",
      stats.deferred === 1 && stats.retried === 0 && stats.dead === 0 && store.retried[0].input.attempts === 4 && store.retried[0].input.availableAt.getTime() === retryAt.getTime() && alerts.emitted.length === 0,
    );
  }

  const summary = "m5-03-2 接线段回放：PASS " + pass + " / FAIL " + fail;
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
