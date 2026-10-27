import { describe, expect, it } from "vitest";
import {
  ProjectSummaryFactsSchema,
  type DailyReport,
  type Issue,
} from "@libiaolink/contracts";
import {
  buildProjectSummaryFacts,
  buildTemplateNarrative,
  invalidNarrativeClaims,
  invalidNarrativeNumbers,
  issueResolutionOf,
  type ProjectSummarySource,
} from "../src/modules/project-summary/project-summary.rules.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const STAGE_START = "2026-08-01";

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  const base: DailyReport = {
    id: REPORT_ID,
    projectId: PROJECT_ID,
    authorId: USER_ID,
    authorName: "现场负责人",
    date: "2026-10-26",
    state: "submitted",
    headcount: 2,
    doneWork: "完成现场确认",
    plan: "继续安装",
    foundIssue: null,
    issueCategories: [],
    suggestion: null,
    stageKeys: [],
    stageNames: [],
    photos: [],
    issuePhotos: [],
    submittedAt: "2026-10-26T08:00:00.000Z",
    createdAt: "2026-10-26T07:00:00.000Z",
    updatedAt: "2026-10-26T08:00:00.000Z",
    version: 1,
  };
  return { ...base, ...overrides };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: ISSUE_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sourceReportId: null,
    title: "现场问题",
    categories: ["项目部"],
    state: "open",
    reporterId: USER_ID,
    reporterName: "现场负责人",
    ownerDepartment: null,
    ownerId: null,
    ownerName: null,
    raisedAt: "2026-10-20",
    solution: null,
    photos: [],
    closedBy: null,
    closedAt: null,
    createdAt: "2026-10-20T02:00:00.000Z",
    updatedAt: "2026-10-20T02:00:00.000Z",
    version: 1,
  };
  return { ...base, ...overrides };
}

function source(overrides: Partial<ProjectSummarySource> = {}): ProjectSummarySource {
  const base: ProjectSummarySource = {
    project: {
      id: PROJECT_ID,
      code: "LBGW-20260801-001",
      name: "测试项目",
      customer: "测试客户",
      region: "华东",
      projectType: "标准项目",
      stageKey: "install",
      status: "active",
      managerNames: ["项目经理甲"],
      description: "项目总结规则测试",
      createdAt: "2026-08-01T02:00:00.000Z",
      archivedAt: null,
    },
    stages: [
      {
        stageKey: "install",
        name: "实施阶段",
        seq: 1,
        status: "active",
        nodes: { total: 2, done: 1 },
        tasks: { total: 1, done: 1 },
        plannedStart: STAGE_START,
        plannedEnd: "2026-12-31",
        actualStart: STAGE_START,
        actualEnd: null,
        advancedAt: "2026-08-02T02:00:00.000Z",
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        title: "完成任务",
        ownerIds: [USER_ID],
        ownerNames: ["现场负责人"],
        status: "done",
        displayStatus: "done",
        progress: 1,
        plannedEnd: "2026-10-20",
        actualEnd: "2026-10-19",
        deliverableTypes: [],
        updatedAt: "2026-10-19T02:00:00.000Z",
        createdAt: "2026-08-01T02:00:00.000Z",
      },
    ],
    reports: [report()],
    issues: [],
    files: [],
    changes: [],
    now: new Date("2026-10-27T04:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("项目总结 · 固定规则事实包", () => {
  it("问题结论由脚本判定：完成且有解决方案与关闭记录才算已解决", () => {
    const open = issue();
    const inProgress = issue({
      id: "55555555-5555-4555-8555-555555555556",
      title: "处理中问题",
      state: "in_progress",
      ownerName: "现场负责人",
      ownerDepartment: "项目部",
    });
    const resolved = issue({
      id: "55555555-5555-4555-8555-555555555557",
      title: "已解决问题",
      state: "done",
      solution: "更换部件并复核",
      closedAt: "2026-10-22T03:00:00.000Z",
      closedBy: USER_ID,
    });
    const missingEvidence = issue({
      id: "55555555-5555-4555-8555-555555555558",
      title: "关闭证据缺失问题",
      state: "done",
    });
    const facts = buildProjectSummaryFacts(source({ issues: [open, inProgress, resolved, missingEvidence] }));

    const parsedFacts = ProjectSummaryFactsSchema.safeParse(facts);
    if (!parsedFacts.success) {
      throw new Error(JSON.stringify(parsedFacts.error.issues, null, 2));
    }
    expect(parsedFacts.success).toBe(true);
    expect(issueResolutionOf(open)).toBe("unresolved");
    expect(issueResolutionOf(inProgress)).toBe("unresolved");
    expect(issueResolutionOf(resolved)).toBe("resolved");
    expect(issueResolutionOf(missingEvidence)).toBe("needs_evidence");
    expect(facts.counts.issuesResolved).toBe(1);
    expect(facts.counts.issuesUnresolved).toBe(2);
    expect(facts.counts.issuesInProgress).toBe(1);
    expect(facts.counts.issuesClosedWithoutEvidence).toBe(1);
    expect(facts.issues.find((item) => item.id === open.id)?.followUpOwner).toBe("项目经理甲");
    expect(facts.issues.find((item) => item.id === inProgress.id)?.followUpOwner).toBe("现场负责人");

    const gapKinds = new Set(facts.gaps.map((gap) => gap.kind));
    expect(gapKinds.has("unresolved_issue")).toBe(true);
    expect(gapKinds.has("issue_evidence")).toBe(true);
    expect(facts.handover.some((group) => group.owner === "现场负责人")).toBe(true);
  });

  it("逾期、未分配与成果缺件分别进入待整改，并按接手人归组", () => {
    const facts = buildProjectSummaryFacts(source({
      tasks: [
        {
          id: TASK_ID,
          title: "逾期且未分配任务",
          ownerIds: [],
          ownerNames: [],
          status: "active",
          displayStatus: "overdue",
          progress: 0.4,
          plannedEnd: "2026-10-20",
          actualEnd: null,
          deliverableTypes: ["布局图"],
          updatedAt: "2026-10-21T02:00:00.000Z",
          createdAt: "2026-08-01T02:00:00.000Z",
        },
      ],
      files: [],
      reports: [],
    }));

    expect(facts.counts.tasksOverdue).toBe(1);
    expect(facts.counts.tasksUnassigned).toBe(1);
    expect(facts.counts.deliverablesRequired).toBe(1);
    expect(facts.counts.deliverablesMissing).toBe(1);
    expect(facts.gaps.filter((gap) => gap.kind === "overdue_task")).toHaveLength(1);
    expect(facts.gaps.filter((gap) => gap.kind === "unassigned_task")).toHaveLength(1);
    expect(facts.gaps.filter((gap) => gap.kind === "missing_deliverable")).toHaveLength(1);
    expect(facts.handover[0]?.owner).toBe("项目经理甲");
    expect(facts.handover[0]?.items.length).toBeGreaterThanOrEqual(3);
  });

  it("已完成 / 已归档项目与未完成事实冲突时给出高风险待整改", () => {
    const facts = buildProjectSummaryFacts(source({
      project: {
        ...source().project,
        status: "done",
      },
      tasks: [
        {
          ...source().tasks[0]!,
          status: "active",
          displayStatus: "active",
          progress: 0.6,
          actualEnd: null,
        },
      ],
    }));

    const mismatch = facts.gaps.find((gap) => gap.kind === "status_mismatch");
    expect(mismatch?.severity).toBe("high");
    expect(mismatch?.owner).toBe("项目经理甲");
  });

  it("规则模板只作定性描述，AI 校验拒绝阿拉伯数字与相反结论", () => {
    const facts = buildProjectSummaryFacts(source({
      issues: [
        issue({
          id: "55555555-5555-4555-8555-555555555559",
          title: "仍未解决的问题",
        }),
      ],
    }));
    const template = buildTemplateNarrative(facts);
    expect(Object.values(template).every((value) => value.trim() !== "")).toBe(true);
    const templateText = Object.values(template).join("\n");
    expect(templateText).not.toMatch(/\d{4}-\d{2}-\d{2}|\d+\s*(?:个|项|条|篇|组)/);
    expect(templateText).not.toContain("共设置");

    const cleanNarrative = {
      overview: "项目按计划推进。",
      process: "过程记录完整。",
      issues: "问题按流程处理。",
      result: "形成阶段成果。",
      handover: "待办已明确责任人。",
      risks: "持续跟踪剩余风险。",
    };
    expect(invalidNarrativeNumbers({ ...cleanNarrative, overview: "项目历时 999 天" }, facts)).toEqual(["999"]);
    expect(invalidNarrativeNumbers(cleanNarrative, facts)).toEqual([]);

    const contradictions = invalidNarrativeClaims(
      {
        ...template,
        issues: "所有问题均已全部解决，无遗留问题。",
        result: "成果文件全部齐全。",
        risks: "没有风险和遗漏。",
      },
      facts,
    );
    expect(contradictions.length).toBeGreaterThanOrEqual(2);
  });
});
