/**
 * 项目群不可投递告警门禁（2026-10-28）：
 * - 统一可投递 = 群绑定存在且机器人已激活；未绑定 / 未激活 = 不可投递，但原因与处置分开；
 * - 同一项目同一原因只即时告警一次，原因变化时再告警；
 * - 恢复只进入 outbox 日报，不即时推送；
 * - 正文只展示项目名与处置，不泄露项目 UUID / chatid / outbox 行号。
 */
import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import {
  composeProjectGroupUnavailableAlert,
  projectGroupBindingDeliverability,
  projectGroupDeliverability,
  ProjectGroupDeliveryAlertService,
} from "../src/modules/notify/project-group-delivery-alert.service.js";
import type {
  AibotSendResult,
  WecomAibotClient,
} from "../src/modules/notify/wecom.aibot.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_NAME = "新能源汽车总装输送线项目";
const ALERT_CHATID = "AlertChatIdAbcDef-99";
const AT = new Date("2026-10-28T00:00:00.000Z");

const ENV = {
  OUTBOX_ALERT_WECOM_CHATID: ALERT_CHATID,
  WECOM_BOT_ID: "bot-id",
  WECOM_BOT_SECRET: "bot-secret",
} as unknown as Env;

class FakeAibot {
  readonly sends: { chatid: string; content: string; groupActivated?: boolean | null }[] = [];
  result: AibotSendResult = { ok: true, attempts: 1 };

  async sendGroupMarkdown(params: {
    chatid: string;
    content: string;
    groupActivated?: boolean | null;
  }): Promise<AibotSendResult> {
    this.sends.push(params);
    return this.result;
  }
}

function makeService(): {
  service: ProjectGroupDeliveryAlertService;
  aibot: FakeAibot;
  clock: ClockService;
} {
  const aibot = new FakeAibot();
  const clock = new ClockService();
  clock.setSource(() => AT);
  const service = new ProjectGroupDeliveryAlertService(
    aibot as unknown as WecomAibotClient,
    new AppConfig(ENV),
    clock,
  );
  return { service, aibot, clock };
}

async function flushSend(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("项目群可投递统一判定", () => {
  it("绑定存在且已激活才可投递；未绑定 / 已绑定未激活分别归因", () => {
    expect(projectGroupDeliverability(null)).toEqual({ deliverable: false, reason: "unbound" });
    expect(projectGroupDeliverability({ bound: false, activated: true })).toEqual({
      deliverable: false,
      reason: "unbound",
    });
    expect(projectGroupDeliverability({ bound: true, activated: false })).toEqual({
      deliverable: false,
      reason: "not_activated",
    });
    expect(projectGroupDeliverability({ bound: true, activated: true })).toEqual({ deliverable: true });
    expect(projectGroupBindingDeliverability({ bound: true, activated: true })).toEqual({ deliverable: true });
  });
});

describe("项目群不可投递告警文案", () => {
  it("未绑定：展示项目名、原因与绑定处置，不暴露 UUID / chatid / outbox", () => {
    const text = composeProjectGroupUnavailableAlert(PROJECT_NAME, "unbound");

    expect(text).toBe(
      "【LibiaoLink 告警】\n" +
        "项目群不可投递：" +
        PROJECT_NAME +
        "\n原因：项目群未绑定" +
        "\n影响：项目日报、任务提醒无法发送到项目群" +
        "\n处置：请在项目设置中完成项目群绑定",
    );
    expect(text).not.toContain(PROJECT_ID);
    expect(text).not.toContain(ALERT_CHATID);
    expect(text).not.toContain("outbox");
  });

  it("已绑定未激活：展示激活原因与 @ 机器人处置", () => {
    expect(composeProjectGroupUnavailableAlert(PROJECT_NAME, "not_activated")).toBe(
      "【LibiaoLink 告警】\n" +
        "项目群不可投递：" +
        PROJECT_NAME +
        "\n原因：已绑定，但机器人尚未激活" +
        "\n影响：项目日报、任务提醒无法发送到项目群" +
        "\n处置：请在项目群内 @LibiaoLink 发送一条消息完成激活",
    );
  });

  it("项目名空白时使用占位名", () => {
    expect(composeProjectGroupUnavailableAlert("   ", "unbound")).toContain("项目群不可投递：项目名称未登记");
  });
});

describe("ProjectGroupDeliveryAlertService", () => {
  it("同一项目同一原因只即时告警一次；原因变化时再告警", async () => {
    const { service, aibot } = makeService();

    service.reportUnavailable(PROJECT_ID, PROJECT_NAME, "unbound");
    service.reportUnavailable(PROJECT_ID, PROJECT_NAME, "unbound");
    await flushSend();
    expect(aibot.sends).toHaveLength(1);

    service.reportUnavailable(PROJECT_ID, PROJECT_NAME, "not_activated");
    await flushSend();
    expect(aibot.sends).toHaveLength(2);
    expect(aibot.sends[1]!.content).toContain("原因：已绑定，但机器人尚未激活");
  });

  it("恢复不即时发送，只进入日报；恢复记录读取一次后清空", async () => {
    const { service, aibot } = makeService();

    service.reportUnavailable(PROJECT_ID, PROJECT_NAME, "unbound");
    await flushSend();
    service.reportAvailable(PROJECT_ID);
    await flushSend();

    expect(aibot.sends).toHaveLength(1);
    expect(service.drainRecoveries()).toEqual([
      {
        code: "notify.project_group.recovered",
        message: "项目群恢复可投递：" + PROJECT_NAME + "（原因为项目群未绑定）",
        at: AT.toISOString(),
      },
    ]);
    expect(service.drainRecoveries()).toEqual([]);
  });

  it("未处于告警态时不产生恢复记录", () => {
    const { service } = makeService();
    service.reportAvailable(PROJECT_ID);
    expect(service.drainRecoveries()).toEqual([]);
  });

  it("告警发送失败不向业务抛出，原 dead / 降级处理不被阻断", async () => {
    const { service, aibot } = makeService();
    aibot.result = {
      ok: false,
      kind: "retryable",
      errcode: null,
      errmsg: "长连接未就绪",
      retryAt: null,
      attempts: 0,
      state: "connecting",
    };

    expect(() => service.reportUnavailable(PROJECT_ID, PROJECT_NAME, "unbound")).not.toThrow();
    await flushSend();
    expect(aibot.sends).toHaveLength(1);
  });
});
