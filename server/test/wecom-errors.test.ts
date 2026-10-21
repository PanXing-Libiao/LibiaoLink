/**
 * 企微错误分类回归（M5-03-1 · S8-1；M5-03-2 群通道码表切换为智能机器人；M5-03-5-3 扩单聊 aibot）：
 * errcode 表（app / group / aibot）、846607 双语义分流、HTTP 状态兜底、网络错误描述掩码。
 * 口径：docs/M5-03-实施方案(企微通道).md §五（5.3A Spike 实测码表）；错误码集合为初始集（M5-03-4 锁定的回归基线；93001 移出群已锁 · T3-6 2026-10-13）。
 */
import { describe, expect, it } from "vitest";
import {
  classifyWecomErrcode,
  classifyWecomHttpStatus,
  describeNetworkError,
  describeWecomFailure,
  summarizeWecomErrmsg,
} from "../src/modules/notify/wecom.errors.js";

describe("企微错误分类（M5-03-1 · S8-1）", () => {
  it("app：凭据 / 配置 / 接收人 / 内容类 → permanent", () => {
    for (const code of [40001, 40013, 40056, 41002, 41004, 60011, 45002]) {
      expect(classifyWecomErrcode("wecom_app", code)).toBe("permanent");
    }
  });

  it("app：token 失效族（41001 缺失 / 40014 非法 / 42001 过期）→ token_invalid", () => {
    for (const code of [40014, 41001, 42001]) {
      expect(classifyWecomErrcode("wecom_app", code)).toBe("token_invalid");
    }
  });

  it("app：45009 → rate_limited；-1 系统繁忙 → retryable", () => {
    expect(classifyWecomErrcode("wecom_app", 45009)).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_app", -1)).toBe("retryable");
  });

  it("group（智能机器人）：853000 / 846601 / 93001 → permanent；846609 → retryable", () => {
    expect(classifyWecomErrcode("wecom_group", 853000)).toBe("permanent"); // bot_id / secret 无效
    expect(classifyWecomErrcode("wecom_group", 846601)).toBe("permanent"); // 未开长连接模式
    expect(classifyWecomErrcode("wecom_group", 93001)).toBe("permanent"); // 机器人被移出群（T3-6 实测）
    expect(classifyWecomErrcode("wecom_group", 846609)).toBe("retryable"); // 未订阅
  });

  it("group：846607 双语义按会话激活态分流（false = 未激活 → permanent；其余 → rate_limited）", () => {
    expect(classifyWecomErrcode("wecom_group", 846607, { groupActivated: false })).toBe("permanent");
    expect(classifyWecomErrcode("wecom_group", 846607, { groupActivated: true })).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_group", 846607, { groupActivated: null })).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_group", 846607)).toBe("rate_limited");
  });

  it("aibot（单聊）：846607 双语义按激活表命中态分流（false = 未命中 → permanent；true / 缺省 → rate_limited）", () => {
    expect(classifyWecomErrcode("wecom_aibot", 846607, { dmActivated: false })).toBe("permanent");
    expect(classifyWecomErrcode("wecom_aibot", 846607, { dmActivated: true })).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_aibot", 846607, { dmActivated: null })).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_aibot", 846607)).toBe("rate_limited");
    // 群 / 单聊参数不串用：群侧传 dmActivated 不影响群分流（vice versa）
    expect(classifyWecomErrcode("wecom_group", 846607, { dmActivated: false })).toBe("rate_limited");
    expect(classifyWecomErrcode("wecom_aibot", 846607, { groupActivated: false })).toBe("rate_limited");
  });

  it("aibot（单聊）：主体码表同群（853000 / 846601 → permanent；846609 → retryable）；群专属 93001 未收录兜底 retryable", () => {
    expect(classifyWecomErrcode("wecom_aibot", 853000)).toBe("permanent");
    expect(classifyWecomErrcode("wecom_aibot", 846601)).toBe("permanent");
    expect(classifyWecomErrcode("wecom_aibot", 846609)).toBe("retryable");
    expect(classifyWecomErrcode("wecom_aibot", 93001)).toBe("retryable"); // 移出群 = 群专属（P6 单聊口径待真机补测）
    expect(classifyWecomErrcode("wecom_aibot", 987654)).toBe("retryable");
  });

  it("group：token 失效族不适用（按未收录兜底 retryable）", () => {
    expect(classifyWecomErrcode("wecom_group", 42001)).toBe("retryable");
  });

  it("未收录 errcode 一律 retryable 兜底（有界重试，不误杀；93000 等 webhook 历史码随面退役、无专门分支）", () => {
    expect(classifyWecomErrcode("wecom_app", 123456)).toBe("retryable");
    expect(classifyWecomErrcode("wecom_group", 987654)).toBe("retryable");
    expect(classifyWecomErrcode("wecom_group", 93000)).toBe("retryable");
  });

  it("HTTP 状态兜底：429 → rate_limited；408 / 5xx → retryable；其余 4xx → permanent", () => {
    expect(classifyWecomHttpStatus(429)).toBe("rate_limited");
    expect(classifyWecomHttpStatus(408)).toBe("retryable");
    expect(classifyWecomHttpStatus(500)).toBe("retryable");
    expect(classifyWecomHttpStatus(502)).toBe("retryable");
    expect(classifyWecomHttpStatus(401)).toBe("permanent");
    expect(classifyWecomHttpStatus(404)).toBe("permanent");
  });

  it("describeNetworkError：key / secret / access_token 一律掩码，不回显明文", () => {
    const error = new TypeError(
      "fetch failed: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456&secret=s3cr3t&access_token=tok-9",
    );
    const text = describeNetworkError(error);
    expect(text).toContain("TypeError");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("tok-9");
    expect(text).toContain("key=***");
  });

  it("describeNetworkError：非 Error 输入给占位描述", () => {
    expect(describeNetworkError("boom")).toBe("unknown error");
  });
});

describe("失败描述收敛（告警 / 留痕文案核心语义 · 2026-10-13）", () => {
  it("summarizeWecomErrmsg：去企微 hint / from ip / more info 机器尾巴", () => {
    expect(
      summarizeWecomErrmsg(
        "not allow send msg in room, hint: [1791862401423410269083567], from ip: 183.129.199.210, more info at https://open.work.weixin.qq.com/devtool/query?e=93001",
      ),
    ).toBe("not allow send msg in room");
    expect(summarizeWecomErrmsg("系统繁忙, hint: [abc], from ip: 10.0.0.1")).toBe("系统繁忙");
  });

  it("去内部连接态标记；已知码 → 白话标签；未收录码 / 无码 → errmsg 概要", () => {
    expect(summarizeWecomErrmsg("长连接未就绪（state=backoff）")).toBe("长连接未就绪");
    expect(describeWecomFailure(93001, "not allow send msg in room, hint: [x], from ip: y")).toBe(
      "（errcode=93001：机器人已被移出群）",
    );
    expect(describeWecomFailure(99999, "unknown failure, hint: [x]")).toBe("（errcode=99999：unknown failure）");
    expect(describeWecomFailure(null, "长连接未就绪（state=backoff）")).toBe("：长连接未就绪");
    expect(describeWecomFailure(null, null)).toBe("");
  });
});
