import { describe, expect, it } from "vitest";
import { ClockService } from "../src/common/clock/clock.service.js";
import type { AppConfig } from "../src/config/config.module.js";
import type { AibotIncomingMessage, AibotSendResult } from "../src/modules/notify/index.js";
import type { ProjectAccessContext } from "../src/modules/permission/index.js";
import type { ProjectLookupResult } from "../src/modules/project/index.js";
import type { ReportDigestIssue, ReportDigestReport, ReportDigestSnapshot } from "../src/modules/report-issue/index.js";
import { ReportQueryService } from "../src/modules/report-query/report-query.service.js";
import {
  REPORT_QUERY_DM_UNBOUND,
  REPORT_QUERY_GROUP_NOT_BOUND,
  REPORT_QUERY_GROUP_PROJECT_ONLY,
  REPORT_QUERY_ISSUE_UNAVAILABLE,
  REPORT_QUERY_PROJECT_UNAVAILABLE,
} from "../src/modules/report-query/report-query.text.js";

const BOT_ID = "bot-test";
const ACTOR_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT = { id: PROJECT_ID, code: "PRJ-001", name: "临港数据中心" };
const CHATID = "chatid_12345";

function report(id: string): ReportDigestReport {
  return {
    id,
    authorId: ACTOR_ID,
    authorName: "张三",
    submittedAt: "2026-11-10T01:12:00.000Z",
    state: "submitted",
    stageKeys: [],
    stageNames: [],
    doneWork: "完成联调",
    plan: null,
    photos: [],
  };
}

function issue(id: string): ReportDigestIssue {
  return {
    id,
    title: "现场问题",
    categories: ["quality"],
    state: "open",
    ownerDepartment: null,
    ownerId: null,
    ownerName: null,
    solution: null,
    raisedAt: "2026-11-10",
    sourceReportId: null,
    sourceReport: null,
    photos: [],
  };
}

function defaultSnapshot(): ReportDigestSnapshot {
  return {
    project: PROJECT,
    date: "2026-11-10",
    reports: [report("report-1")],
    draftCount: 0,
    issues: [issue("issue-1")],
  };
}

class FakePermissions {
  constructor(private readonly events: string[]) {}

  reportAllowed = true;
  issueAllowed = true;
  access: ProjectAccessContext | null = {
    projectId: PROJECT_ID,
    member: true,
    projectManager: false,
    groupAccessLevel: null,
    accessLevel: "view",
  };

  async resolveProjectAccess(_actorId: string, projectId: string): Promise<ProjectAccessContext | null> {
    this.events.push("resolveProjectAccess");
    return this.access === null ? null : { ...this.access, projectId };
  }

  async can(_actorId: string, key: string): Promise<boolean> {
    this.events.push("can:" + key);
    if (key === "report.view") return this.reportAllowed;
    if (key === "issue.view") return this.issueAllowed;
    return true;
  }
}

class FakeProjectQuery {
  constructor(private readonly events: string[]) {}

  lookupResult: ProjectLookupResult = { status: "unique", project: PROJECT };
  matchResult = true;
  lookupCalls: Array<{ actorId: string; reference: string }> = [];
  matchCalls: Array<{ projectId: string; reference: string }> = [];

  async lookup(actorId: string, reference: string): Promise<ProjectLookupResult> {
    this.events.push("lookup");
    this.lookupCalls.push({ actorId, reference });
    return this.lookupResult;
  }

  async matchesBoundProject(projectId: string, reference: string): Promise<boolean> {
    this.events.push("matchesBoundProject");
    this.matchCalls.push({ projectId, reference });
    return this.matchResult;
  }
}

class FakeProjectGroups {
  constructor(private readonly events: string[]) {}

  projectId: string | null = PROJECT_ID;
  calls = 0;

  async projectIdByChatid(chatid: string): Promise<string | null> {
    this.events.push("projectIdByChatid");
    this.calls += 1;
    expect(chatid).toBe(CHATID);
    return this.projectId;
  }
}

class FakeDigest {
  constructor(private readonly events: string[]) {}

  snapshot = defaultSnapshot();
  calls: Array<{ projectId: string; date: string }> = [];

  async getSnapshot(projectId: string, date: string): Promise<ReportDigestSnapshot> {
    this.events.push("getSnapshot");
    this.calls.push({ projectId, date });
    return { ...this.snapshot, project: { ...this.snapshot.project, id: projectId }, date };
  }
}

class FakeDmNotify {
  constructor(private readonly events: string[]) {}

  actor: string | null = ACTOR_ID;
  activateResult = true;
  activateCalls = 0;
  resolveCalls = 0;

  async activateFromReportQuery(_incoming: AibotIncomingMessage): Promise<boolean> {
    this.events.push("activateDm");
    this.activateCalls += 1;
    return this.activateResult;
  }

  async resolveReportQueryActor(_wecomUserid: string): Promise<string | null> {
    this.events.push("resolveActor");
    this.resolveCalls += 1;
    return this.actor;
  }
}

class FakeGroupNotify {
  constructor(private readonly events: string[]) {}

  activateCalls = 0;

  async activateFromReportQuery(_incoming: AibotIncomingMessage): Promise<void> {
    this.events.push("activateGroup");
    this.activateCalls += 1;
  }
}

class FakeAibot {
  passive: AibotSendResult = { ok: true, attempts: 1 };
  active: AibotSendResult = { ok: true, attempts: 1 };
  passiveCalls: Array<{ reqId: string; userid: string; content: string; chatid?: string | null }> = [];
  activeCalls: Array<{ kind: "dm" | "group"; content: string }> = [];

  async replyToCallback(params: {
    reqId: string;
    userid: string;
    content: string;
    chatid?: string | null;
  }): Promise<AibotSendResult> {
    this.passiveCalls.push(params);
    return this.passive;
  }

  async sendUserMarkdown(params: { userid: string; content: string; dmActivated?: boolean | null }): Promise<AibotSendResult> {
    this.activeCalls.push({ kind: "dm", content: params.content });
    return this.active;
  }

  async sendGroupMarkdown(params: { chatid: string; content: string; groupActivated?: boolean | null }): Promise<AibotSendResult> {
    this.activeCalls.push({ kind: "group", content: params.content });
    return this.active;
  }
}

function failed(attempts: number): AibotSendResult {
  return {
    ok: false,
    kind: "retryable",
    errcode: null,
    errmsg: "not ready",
    retryAt: null,
    attempts,
    state: "subscribed",
  };
}

function dmMessage(overrides: Partial<AibotIncomingMessage> = {}): AibotIncomingMessage {
  return {
    cmd: "aibot_msg_callback",
    reqId: "req-1",
    chatid: null,
    chattype: "single",
    fromUserId: "wecom-user-1",
    msgid: "msg-1",
    msgtype: "text",
    text: "查询 项目 PRJ-001 2026-11-10 日报和问题",
    eventType: null,
    ...overrides,
  };
}

function groupMessage(overrides: Partial<AibotIncomingMessage> = {}): AibotIncomingMessage {
  return {
    cmd: "aibot_msg_callback",
    reqId: "req-g-1",
    chatid: CHATID,
    chattype: "group",
    fromUserId: "wecom-user-1",
    msgid: "msg-g-1",
    msgtype: "text",
    text: "查询 项目 PRJ-001 2026-11-10 日报和问题",
    eventType: null,
    ...overrides,
  };
}

function makeHarness(options: { dmFlag?: string; groupFlag?: string } = {}) {
  const events: string[] = [];
  const clock = new ClockService();
  let now = Date.parse("2026-11-11T01:00:00.000Z");
  clock.setSource(() => new Date(now));
  const config = {
    env: {
      WECOM_REPORT_QUERY_DM_ENABLED: options.dmFlag ?? "true",
      WECOM_REPORT_QUERY_GROUP_ENABLED: options.groupFlag ?? "true",
      WECOM_BOT_ID: BOT_ID,
      PUBLIC_APP_BASE_URL: "https://pm.libiaorobot.com",
    },
  } as unknown as AppConfig;
  const permissions = new FakePermissions(events);
  const projects = new FakeProjectQuery(events);
  const projectGroups = new FakeProjectGroups(events);
  const digest = new FakeDigest(events);
  const dm = new FakeDmNotify(events);
  const groupNotify = new FakeGroupNotify(events);
  const aibot = new FakeAibot();
  const service = new ReportQueryService(
    config,
    clock,
    permissions as never,
    projects as never,
    projectGroups as never,
    digest as never,
    dm as never,
    groupNotify as never,
    aibot as never,
  );
  return {
    service,
    events,
    permissions,
    projects,
    projectGroups,
    digest,
    dm,
    groupNotify,
    aibot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ReportQueryService（S3 查询路由 / 权限 / 幂等限流）", () => {
  it("开关按精确字符串比较；false / 非 true 时完全回退原行为", async () => {
    const falseHarness = makeHarness({ dmFlag: "false", groupFlag: "TRUE" });
    expect(falseHarness.service.accepts(dmMessage())).toBe(false);
    expect(falseHarness.service.accepts(groupMessage())).toBe(false);
    await falseHarness.service.handle(dmMessage());
    expect(falseHarness.dm.activateCalls).toBe(0);
    expect(falseHarness.aibot.passiveCalls).toHaveLength(0);
  });

  it("单聊查询先登记激活，再解析项目 / 权限并回复文字", async () => {
    const harness = makeHarness();
    await harness.service.handle(dmMessage());

    expect(harness.dm.activateCalls).toBe(1);
    expect(harness.dm.resolveCalls).toBe(1);
    expect(harness.groupNotify.activateCalls).toBe(0);
    expect(harness.digest.calls).toEqual([{ projectId: PROJECT_ID, date: "2026-11-10" }]);
    expect(harness.aibot.passiveCalls).toHaveLength(1);
    expect(harness.aibot.activeCalls).toHaveLength(0);
    expect(harness.aibot.passiveCalls[0]?.content).toContain("已提交日报 1 篇，草稿 0 篇；问题 1 条");
    expect(harness.aibot.passiveCalls[0]?.content).toContain("report=report-1");
    expect(harness.aibot.passiveCalls[0]?.content).toContain("sub=issues&date=2026-11-10");
  });

  it("6 位数字项目编号按查询处理，不进入绑定码链路", async () => {
    const harness = makeHarness();
    harness.projects.lookupResult = {
      status: "unique",
      project: { id: OTHER_PROJECT_ID, code: "123456", name: "数字编号项目" },
    };
    harness.digest.snapshot = {
      ...harness.digest.snapshot,
      project: { id: OTHER_PROJECT_ID, code: "123456", name: "数字编号项目" },
    };
    await harness.service.handle(
      dmMessage({ text: "查询 项目 123456 2026-11-10 日报", msgid: "msg-six-digit" }),
    );

    expect(harness.projects.lookupCalls[0]?.reference).toBe("123456");
    expect(harness.dm.activateCalls).toBe(1);
    expect(harness.aibot.passiveCalls[0]?.content).toContain("数字编号项目（123456）");
  });

  it("群聊先仅激活会话，省略项目时使用群绑定项目", async () => {
    const harness = makeHarness();
    await harness.service.handle(
      groupMessage({ text: "@LibiaoLink 查询 昨天日报和问题", msgid: "msg-g-omit" }),
    );

    expect(harness.groupNotify.activateCalls).toBe(1);
    expect(harness.events.indexOf("activateGroup")).toBeLessThan(harness.events.indexOf("projectIdByChatid"));
    expect(harness.projects.matchCalls).toHaveLength(0);
    expect(harness.digest.calls).toEqual([{ projectId: PROJECT_ID, date: "2026-11-10" }]);
    expect(harness.aibot.passiveCalls[0]?.chatid).toBe(CHATID);
    expect(harness.aibot.passiveCalls[0]?.content).toContain("项目：临港数据中心（PRJ-001）");
  });

  it("群聊显式项目必须是群绑定项目", async () => {
    const harness = makeHarness();
    harness.projects.matchResult = false;
    await harness.service.handle(groupMessage({ text: "查询 项目 PRJ-999 昨天日报", msgid: "msg-g-other" }));

    expect(harness.aibot.passiveCalls[0]?.content).toBe(REPORT_QUERY_GROUP_PROJECT_ONLY);
    expect(harness.digest.calls).toHaveLength(0);
  });

  it("群未绑定与发送人未绑定均不输出数据", async () => {
    const unboundGroup = makeHarness();
    unboundGroup.projectGroups.projectId = null;
    await unboundGroup.service.handle(groupMessage({ msgid: "msg-g-unbound" }));
    expect(unboundGroup.aibot.passiveCalls[0]?.content).toBe(REPORT_QUERY_GROUP_NOT_BOUND);
    expect(unboundGroup.digest.calls).toHaveLength(0);

    const unboundUser = makeHarness();
    unboundUser.dm.actor = null;
    await unboundUser.service.handle(dmMessage({ msgid: "msg-dm-unbound" }));
    expect(unboundUser.aibot.passiveCalls[0]?.content).toBe(REPORT_QUERY_DM_UNBOUND);
    expect(unboundUser.projects.lookupCalls).toHaveLength(0);
    expect(unboundUser.digest.calls).toHaveLength(0);
  });

  it("项目重名只提示编号，不读取快照", async () => {
    const harness = makeHarness();
    harness.projects.lookupResult = {
      status: "ambiguous",
      candidates: [
        PROJECT,
        { id: OTHER_PROJECT_ID, code: "PRJ-008", name: "临港数据中心" },
      ],
    };
    await harness.service.handle(dmMessage());

    const content = harness.aibot.passiveCalls[0]?.content ?? "";
    expect(content).toContain("匹配到 2 个可见项目，请使用编号查询");
    expect(content).toContain("PRJ-008");
    expect(harness.digest.calls).toHaveLength(0);
    expect(content).not.toContain("report=");
  });

  it("项目不可见与无 report.view 使用统一错误口径", async () => {
    for (const setup of [
      (harness: ReturnType<typeof makeHarness>) => {
        harness.projects.lookupResult = { status: "not_found" };
      },
      (harness: ReturnType<typeof makeHarness>) => {
        harness.permissions.reportAllowed = false;
      },
      (harness: ReturnType<typeof makeHarness>) => {
        harness.permissions.access = null;
      },
    ]) {
      const harness = makeHarness();
      setup(harness);
      await harness.service.handle(dmMessage({ msgid: "msg-" + String(Math.random()) }));
      expect(harness.aibot.passiveCalls[0]?.content).toBe(REPORT_QUERY_PROJECT_UNAVAILABLE);
      expect(harness.digest.calls).toHaveLength(0);
    }
  });

  it("无 issue.view：日报正常返回且问题数量 / 链接隐藏；问题专项查询拒绝", async () => {
    const harness = makeHarness();
    harness.permissions.issueAllowed = false;
    await harness.service.handle(dmMessage({ msgid: "msg-no-issue" }));
    const content = harness.aibot.passiveCalls[0]?.content ?? "";
    expect(content).toContain("已提交日报 1 篇，草稿 0 篇");
    expect(content).not.toContain("问题");
    expect(content).not.toContain("sub=issues");

    const issueOnly = makeHarness();
    issueOnly.permissions.issueAllowed = false;
    await issueOnly.service.handle(
      dmMessage({ msgid: "msg-issue-only", text: "查询 项目 PRJ-001 2026-11-10 问题" }),
    );
    expect(issueOnly.aibot.passiveCalls[0]?.content).toBe(REPORT_QUERY_ISSUE_UNAVAILABLE);
    expect(issueOnly.digest.calls).toHaveLength(0);
  });

  it("未来日期与语法错误只回帮助，不查快照", async () => {
    for (const text of ["查询 项目 PRJ-001 2026-11-12 日报", "查询 昨天日报", "查询 项目 PRJ-001 昨天日报 额外"]) {
      const harness = makeHarness();
      await harness.service.handle(dmMessage({ text, msgid: "msg-" + text }));
      expect(harness.aibot.passiveCalls[0]?.content).toContain("请按以下格式发送查询");
      expect(harness.digest.calls).toHaveLength(0);
    }
  });

  it("缺省日期使用 Asia/Shanghai 今天", async () => {
    const harness = makeHarness();
    await harness.service.handle(dmMessage({ text: "查询 项目 PRJ-001 日报", msgid: "msg-today" }));
    expect(harness.digest.calls).toEqual([{ projectId: PROJECT_ID, date: "2026-11-11" }]);
  });

  it("同一 bot_id + msgid 在 10 分钟内只回复一次", async () => {
    const harness = makeHarness();
    await harness.service.handle(dmMessage({ msgid: "same-msg" }));
    harness.advance(6_000);
    await harness.service.handle(dmMessage({ msgid: "same-msg" }));

    expect(harness.aibot.passiveCalls).toHaveLength(1);
    expect(harness.digest.calls).toHaveLength(1);
  });

  it("同一发送人 5 秒内最多处理一次，窗口结束后恢复", async () => {
    const harness = makeHarness();
    await harness.service.handle(dmMessage({ msgid: "rate-1" }));
    harness.advance(4_000);
    await harness.service.handle(dmMessage({ msgid: "rate-2" }));
    expect(harness.aibot.passiveCalls).toHaveLength(1);

    harness.advance(1_000);
    await harness.service.handle(dmMessage({ msgid: "rate-3" }));
    expect(harness.aibot.passiveCalls).toHaveLength(2);
  });

  it("被动回复本地未就绪时降级主动 markdown；已发帧失败不重发", async () => {
    const fallback = makeHarness();
    fallback.aibot.passive = failed(0);
    await fallback.service.handle(dmMessage({ msgid: "fallback" }));
    expect(fallback.aibot.activeCalls).toHaveLength(1);
    expect(fallback.aibot.activeCalls[0]?.kind).toBe("dm");

    const noResend = makeHarness();
    noResend.aibot.passive = failed(1);
    await noResend.service.handle(dmMessage({ msgid: "no-resend" }));
    expect(noResend.aibot.activeCalls).toHaveLength(0);
  });
});
