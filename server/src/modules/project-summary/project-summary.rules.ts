import {
  ISSUE_STATE_NAMES,
  STAGE_NAMES,
  type DailyReport,
  type Issue,
  type ProjectSummaryFacts,
  type ProjectSummaryGap,
  type ProjectSummaryIssueFact,
  type ProjectSummaryNarrative,
  type ProjectSummaryTimelineEvent,
} from "@libiaolink/contracts";

const PROJECT_STATUS_NAMES: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  done: "已完成",
  archived: "已归档",
};

const TASK_STATUS_NAMES: Record<string, string> = {
  pending: "待开始",
  active: "进行中",
  done: "已完成",
  overdue: "已延期",
  early_done: "提前完成",
};

const FILE_STATUS_NAMES: Record<string, string> = {
  draft: "草稿",
  final: "已定档",
  changed: "变更后",
  archived: "已归档",
  recycled: "回收站",
};

const DAY_MS = 86_400_000;
const REPORT_STALE_DAYS = 30;
const MAX_FACTS_ISSUES = 500;
const MAX_FACTS_GAPS = 500;
const MAX_TIMELINE = 200;

/** 项目主数据的最小输入（避免纯规则层依赖具体模块服务类型）。 */
export interface SummaryProjectInput {
  id: string;
  code: string;
  name: string;
  customer: string | null;
  region: string;
  projectType: string;
  stageKey: string;
  status: string;
  managerNames: Array<string | null>;
  description: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface SummaryStageInput {
  stageKey: string;
  name: string;
  seq: number;
  status: "pending" | "active" | "done";
  nodes: { total: number; done: number };
  tasks: { total: number; done: number };
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  advancedAt: string | null;
}

export interface SummaryTaskInput {
  id: string;
  title: string;
  ownerIds: string[];
  ownerNames: Array<string | null>;
  status: "pending" | "active" | "done";
  displayStatus: string;
  progress: number;
  plannedEnd: string | null;
  actualEnd: string | null;
  deliverableTypes: string[];
  updatedAt: string;
  createdAt: string;
}

export interface SummaryFileInput {
  id: string;
  taskId: string | null;
  docType: string | null;
  name: string;
  status: string;
  finalizedAt: string | null;
  createdAt: string;
}

export interface SummaryChangeInput {
  id: string;
  reason: string;
  beforeSummary: string | null;
  afterSummary: string | null;
  stageKey: string | null;
  appliedAt: string;
}

export interface ProjectSummarySource {
  project: SummaryProjectInput;
  stages: SummaryStageInput[];
  tasks: SummaryTaskInput[];
  reports: DailyReport[];
  issues: Issue[];
  files: SummaryFileInput[];
  changes: SummaryChangeInput[];
  now: Date;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function nonEmpty(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function shanghaiDateOnly(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return pick("year") + "-" + pick("month") + "-" + pick("day");
}

function dateOnlyShift(dateOnly: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (match === null) return dateOnly;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

function atNoon(dateOnly: string): string {
  return new Date(dateOnly + "T12:00:00+08:00").toISOString();
}

function statusName(value: string): string {
  return PROJECT_STATUS_NAMES[value] ?? value;
}

function stageName(value: string): string {
  if (value === "") return "未分组";
  return (STAGE_NAMES as Record<string, string>)[value] ?? value;
}

function taskStatusName(value: string): string {
  return TASK_STATUS_NAMES[value] ?? value;
}

function fileStatusName(value: string): string {
  return FILE_STATUS_NAMES[value] ?? value;
}

function managerLabel(project: SummaryProjectInput): string {
  const names = project.managerNames.map((name) => nonEmpty(name)).filter((name) => name !== "");
  return clip(names.length === 0 ? "项目经理（姓名缺失）" : names.join("、"), 200);
}

function firstTaskOwner(task: SummaryTaskInput | undefined, project: SummaryProjectInput): string {
  if (task !== undefined) {
    const names = task.ownerNames.map((name) => nonEmpty(name)).filter((name) => name !== "");
    if (names.length > 0) return clip(names.join("、"), 200);
  }
  return managerLabel(project);
}

function issueFollowUpOwner(issue: Issue, project: SummaryProjectInput): string {
  const owner = nonEmpty(issue.ownerName);
  if (owner !== "") return clip(owner, 200);
  const department = nonEmpty(issue.ownerDepartment);
  if (department !== "") return clip(department, 200);
  return managerLabel(project);
}

export function issueResolutionOf(issue: Issue): ProjectSummaryIssueFact["resolution"] {
  if (issue.state !== "done") return "unresolved";
  return nonEmpty(issue.solution) !== "" && issue.closedAt !== null ? "resolved" : "needs_evidence";
}

function buildIssues(source: ProjectSummarySource): ProjectSummaryIssueFact[] {
  return [...source.issues]
    .sort((left, right) => right.raisedAt.localeCompare(left.raisedAt) || right.updatedAt.localeCompare(left.updatedAt))
    .map((issue) => ({
      id: issue.id,
      title: clip(issue.title, 500),
      state: issue.state,
      stateName: (ISSUE_STATE_NAMES as Record<string, string>)[issue.state] ?? issue.state,
      categories: issue.categories.slice(0, 20),
      raisedAt: issue.raisedAt,
      reporterName: issue.reporterName,
      ownerName: issue.ownerName,
      ownerDepartment: issue.ownerDepartment,
      solution: issue.solution === null ? null : clip(issue.solution, 2000),
      closedAt: issue.closedAt,
      updatedAt: issue.updatedAt,
      resolution: issueResolutionOf(issue),
      followUpOwner: issueFollowUpOwner(issue, source.project),
    }));
}

function buildCounts(source: ProjectSummarySource, issues: ProjectSummaryIssueFact[]): ProjectSummaryFacts["counts"] {
  const tasksDone = source.tasks.filter((task) => task.status === "done").length;
  const tasksActive = source.tasks.filter((task) => task.status === "active").length;
  const tasksPending = source.tasks.filter((task) => task.status === "pending").length;
  const finalStatuses = new Set(["final", "changed", "archived"]);
  const finalizedByTaskAndType = new Set<string>();
  for (const file of source.files) {
    if (file.taskId !== null && file.docType !== null && finalStatuses.has(file.status)) {
      finalizedByTaskAndType.add(file.taskId + "\u0000" + file.docType);
    }
  }
  let deliverablesRequired = 0;
  let deliverablesFinalized = 0;
  for (const task of source.tasks) {
    for (const docType of task.deliverableTypes) {
      deliverablesRequired += 1;
      if (finalizedByTaskAndType.has(task.id + "\u0000" + docType)) deliverablesFinalized += 1;
    }
  }
  return {
    tasksTotal: source.tasks.length,
    tasksDone,
    tasksActive,
    tasksPending,
    tasksOverdue: source.tasks.filter((task) => task.displayStatus === "overdue").length,
    tasksUnassigned: source.tasks.filter((task) => task.ownerIds.length === 0).length,
    reportsTotal: source.reports.length,
    reportsDraft: source.reports.filter((report) => report.state === "draft").length,
    reportsSubmitted: source.reports.filter((report) => report.state === "submitted").length,
    reportsSupplement: source.reports.filter((report) => report.state === "supplement").length,
    lastReportDate: source.reports.reduce<string | null>((latest, report) => (latest === null || report.date > latest ? report.date : latest), null),
    issuesTotal: source.issues.length,
    issuesResolved: issues.filter((issue) => issue.resolution === "resolved").length,
    issuesUnresolved: issues.filter((issue) => issue.resolution === "unresolved").length,
    issuesInProgress: issues.filter((issue) => issue.state === "in_progress").length,
    issuesClosedWithoutEvidence: issues.filter((issue) => issue.resolution === "needs_evidence").length,
    filesTotal: source.files.length,
    filesDraft: source.files.filter((file) => file.status === "draft").length,
    filesFinal: source.files.filter((file) => file.status === "final").length,
    filesChanged: source.files.filter((file) => file.status === "changed").length,
    filesArchived: source.files.filter((file) => file.status === "archived").length,
    changesTotal: source.changes.length,
    deliverablesRequired,
    deliverablesFinalized,
    deliverablesMissing: deliverablesRequired - deliverablesFinalized,
    stagesTotal: source.stages.length,
    stagesDone: source.stages.filter((stage) => stage.status === "done").length,
    stagesActive: source.stages.filter((stage) => stage.status === "active").length,
  };
}

function addGap(gaps: ProjectSummaryGap[], gap: ProjectSummaryGap): void {
  if (gaps.length < MAX_FACTS_GAPS) gaps.push({ ...gap, id: clip(gap.id, 200), title: clip(gap.title, 500), detail: clip(gap.detail, 2000), owner: clip(gap.owner, 200), action: clip(gap.action, 2000) });
}

function buildGaps(
  source: ProjectSummarySource,
  issues: ProjectSummaryIssueFact[],
  counts: ProjectSummaryFacts["counts"],
  lastReportDate: string | null,
  dataQuality: ProjectSummaryFacts["dataQuality"],
): ProjectSummaryGap[] {
  const gaps: ProjectSummaryGap[] = [];
  const today = shanghaiDateOnly(source.now);
  const finalStatuses = new Set(["final", "changed", "archived"]);
  const finalizedByTaskAndType = new Set<string>();
  for (const file of source.files) {
    if (file.taskId !== null && file.docType !== null && finalStatuses.has(file.status)) {
      finalizedByTaskAndType.add(file.taskId + "\u0000" + file.docType);
    }
  }

  for (const task of source.tasks) {
    const owner = firstTaskOwner(task, source.project);
    if (task.displayStatus === "overdue" && task.status !== "done") {
      addGap(gaps, {
        id: "overdue_task:" + task.id,
        kind: "overdue_task",
        severity: "high",
        title: "任务逾期未完成：" + task.title,
        detail: "计划完成日 " + (task.plannedEnd ?? "未填") + "，当前进度 " + String(Math.round(task.progress * 100)) + "%，状态 " + taskStatusName(task.displayStatus) + "。",
        owner,
        action: "由任务负责人确认剩余工作、完成日期与阻塞原因；项目经理复核是否调整计划。",
      });
    }
    if (task.status !== "done" && task.ownerIds.length === 0) {
      addGap(gaps, {
        id: "unassigned_task:" + task.id,
        kind: "unassigned_task",
        severity: "medium",
        title: "任务未分配负责人：" + task.title,
        detail: "任务仍未完成且负责人为空，无法形成明确交付责任人。",
        owner: managerLabel(source.project),
        action: "项目经理在任务表中指定负责人和计划完成日期。",
      });
    }
    for (const docType of task.deliverableTypes) {
      if (finalizedByTaskAndType.has(task.id + "\u0000" + docType)) continue;
      addGap(gaps, {
        id: "missing_deliverable:" + task.id + ":" + docType,
        kind: "missing_deliverable",
        severity: "high",
        title: "成果文件缺件：" + task.title + " / " + docType,
        detail: "任务要求输出该成果，但项目文件中没有与该任务关联且已定档（final / changed / archived）的对应文档。",
        owner,
        action: "负责人补齐文件并完成定档；确实不适用时由项目经理在任务/文件中登记调整依据。",
      });
    }
  }

  for (const issue of issues) {
    if (issue.resolution === "unresolved") {
      addGap(gaps, {
        id: "unresolved_issue:" + issue.id,
        kind: "unresolved_issue",
        severity: issue.state === "open" ? "high" : "medium",
        title: "问题未解决：" + issue.title,
        detail: "当前状态 " + issue.stateName + "，提出日期 " + issue.raisedAt + "；责任人 " + issue.followUpOwner + "。",
        owner: issue.followUpOwner,
        action: "更新处理进展；解决后填写解决方案并关闭问题。",
      });
    } else if (issue.resolution === "needs_evidence") {
      addGap(gaps, {
        id: "issue_evidence:" + issue.id,
        kind: "issue_evidence",
        severity: "medium",
        title: "问题关闭证据缺失：" + issue.title,
        detail: "问题状态为已完成，但解决方案或关闭记录至少一项为空，无法复核解决过程。",
        owner: issue.followUpOwner,
        action: "补录解决方案与关闭记录；若实际未解决，将状态退回处理中。",
      });
    }
  }

  if (source.project.status === "active" || source.project.status === "paused") {
    const projectAgeDays = Math.floor((Date.parse(today + "T00:00:00+08:00") - Date.parse(source.project.createdAt.slice(0, 10) + "T00:00:00+08:00")) / DAY_MS);
    if (projectAgeDays > REPORT_STALE_DAYS) {
      const staleBefore = dateOnlyShift(today, -REPORT_STALE_DAYS);
      if (lastReportDate === null) {
        addGap(gaps, {
          id: "stale_reports:none",
          kind: "stale_reports",
          severity: "low",
          title: "项目日报缺失",
          detail: "项目创建已超过 30 天，但没有读取到日报记录。",
          owner: managerLabel(source.project),
          action: "项目经理确认现场信息是否另有记录方式，并补齐必要日报。",
        });
      } else if (lastReportDate < staleBefore) {
        addGap(gaps, {
          id: "stale_reports:last",
          kind: "stale_reports",
          severity: "low",
          title: "项目日报长期未更新",
          detail: "最近一篇日报日期为 " + lastReportDate + "，距数据截止日已超过 30 天。",
          owner: managerLabel(source.project),
          action: "项目经理确认项目是否仍在推进，并补齐最新进展记录。",
        });
      }
    }
  }

  const doneOrArchived = source.project.status === "done" || source.project.status === "archived";
  if (doneOrArchived && (counts.tasksDone < counts.tasksTotal || counts.issuesUnresolved > 0 || counts.deliverablesMissing > 0)) {
    addGap(gaps, {
      id: "status_mismatch",
      kind: "status_mismatch",
      severity: "high",
      title: "项目状态与聚合事实不一致",
      detail: "项目状态为" + statusName(source.project.status) + "，但仍存在未完成任务、未解决问题或成果缺件。",
      owner: managerLabel(source.project),
      action: "项目经理复核项目状态；确认收尾后补齐任务、问题与成果记录，或在确认总结中留档说明。",
    });
  }

  if (source.stages.length === 0) {
    addGap(gaps, {
      id: "missing_baseline:stages",
      kind: "missing_baseline",
      severity: "medium",
      title: "项目阶段未建立",
      detail: "项目没有可读取的阶段记录，无法核对阶段推进过程。",
      owner: managerLabel(source.project),
      action: "项目经理确认蓝图导入状态，补齐阶段基线。",
    });
  }
  if (source.tasks.length === 0) {
    addGap(gaps, {
      id: "missing_baseline:tasks",
      kind: "missing_baseline",
      severity: "medium",
      title: "项目任务未建立",
      detail: "项目没有读取到任务记录，项目结果与责任分工无法从任务数据复核。",
      owner: managerLabel(source.project),
      action: "项目经理确认任务是否尚未建立，或历史任务是否存放在系统外。",
    });
  }

  if (source.issues.length > MAX_FACTS_ISSUES) {
    dataQuality.push({ severity: "medium", message: "问题共 " + String(source.issues.length) + " 条，事实包仅保留最近 " + String(MAX_FACTS_ISSUES) + " 条；统计数字仍按全部问题计算。" });
  }
  if (gaps.length >= MAX_FACTS_GAPS) {
    dataQuality.push({ severity: "medium", message: "待整改项超过 " + String(MAX_FACTS_GAPS) + " 条，事实包已截断；请先按高优先级处理。" });
  }
  return gaps;
}

function buildHandover(gaps: ProjectSummaryGap[]): ProjectSummaryFacts["handover"] {
  const byOwner = new Map<string, string[]>();
  for (const gap of gaps) {
    const items = byOwner.get(gap.owner) ?? [];
    if (items.length < 100) items.push(clip(gap.title + "：" + gap.action, 2000));
    byOwner.set(gap.owner, items);
  }
  return [...byOwner.entries()]
    .map(([owner, items]) => ({ owner, items }))
    .sort((left, right) => right.items.length - left.items.length || left.owner.localeCompare(right.owner, "zh-Hans-CN"))
    .slice(0, 100);
}

function pushTimeline(events: ProjectSummaryTimelineEvent[], event: ProjectSummaryTimelineEvent): void {
  events.push({
    ...event,
    title: clip(event.title, 500),
    detail: clip(event.detail, 2000),
    actorNames: event.actorNames.map((name) => clip(name, 100)).slice(0, 50),
  });
}

function buildTimeline(source: ProjectSummarySource, dataQuality: ProjectSummaryFacts["dataQuality"]): ProjectSummaryTimelineEvent[] {
  const events: ProjectSummaryTimelineEvent[] = [];
  pushTimeline(events, {
    date: source.project.createdAt,
    kind: "project",
    title: "项目创建",
    detail: source.project.code + " " + source.project.name,
    actorNames: source.project.managerNames.filter((name): name is string => name !== null),
  });
  for (const stage of source.stages) {
    const at = stage.advancedAt ?? (stage.actualEnd === null ? null : atNoon(stage.actualEnd)) ?? (stage.actualStart === null ? null : atNoon(stage.actualStart));
    if (at === null) continue;
    pushTimeline(events, {
      date: at,
      kind: "stage",
      title: "阶段状态：" + stage.name,
      detail: "节点 " + String(stage.nodes.done) + "/" + String(stage.nodes.total) + "，任务 " + String(stage.tasks.done) + "/" + String(stage.tasks.total) + "，状态 " + stage.status,
      actorNames: [],
    });
  }
  for (const task of source.tasks) {
    if (task.status !== "done" || task.actualEnd === null) continue;
    pushTimeline(events, {
      date: atNoon(task.actualEnd),
      kind: "task",
      title: "任务完成：" + task.title,
      detail: "进度 " + String(Math.round(task.progress * 100)) + "%，负责人 " + firstTaskOwner(task, source.project),
      actorNames: task.ownerNames.filter((name): name is string => name !== null),
    });
  }
  for (const report of source.reports) {
    const at = report.submittedAt ?? report.createdAt;
    const parts = [nonEmpty(report.doneWork) === "" ? "" : "完成：" + nonEmpty(report.doneWork), nonEmpty(report.plan) === "" ? "" : "计划：" + nonEmpty(report.plan)].filter((part) => part !== "");
    pushTimeline(events, {
      date: at,
      kind: "report",
      title: "日报：" + (report.authorName ?? "未署名"),
      detail: parts.join("；") || "已提交日报",
      actorNames: report.authorName === null ? [] : [report.authorName],
    });
  }
  for (const issue of source.issues) {
    pushTimeline(events, {
      date: issue.createdAt,
      kind: "issue",
      title: "问题登记：" + issue.title,
      detail: "状态 " + ((ISSUE_STATE_NAMES as Record<string, string>)[issue.state] ?? issue.state) + "，归类 " + issue.categories.join("、"),
      actorNames: issue.reporterName === null ? [] : [issue.reporterName],
    });
  }
  for (const change of source.changes) {
    pushTimeline(events, {
      date: change.appliedAt,
      kind: "change",
      title: "变更生效" + (change.stageKey === null ? "" : "：" + stageName(change.stageKey)),
      detail: [change.reason, nonEmpty(change.afterSummary) === "" ? "" : "变更后：" + nonEmpty(change.afterSummary)].filter((part) => part !== "").join("；"),
      actorNames: [],
    });
  }
  for (const file of source.files) {
    if (file.finalizedAt === null || !["final", "changed", "archived"].includes(file.status)) continue;
    pushTimeline(events, {
      date: file.finalizedAt,
      kind: "file",
      title: "文件" + fileStatusName(file.status) + "：" + file.name,
      detail: file.docType === null ? "普通附件" : "成果类型：" + file.docType,
      actorNames: [],
    });
  }
  events.sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, "zh-Hans-CN"));
  if (events.length <= MAX_TIMELINE) return events;
  dataQuality.push({ severity: "low", message: "过程事件超过 " + String(MAX_TIMELINE) + " 条，时间线仅保留项目创建与最近事件；统计数字不受影响。" });
  return [events[0], ...events.slice(-(MAX_TIMELINE - 1))].filter((event): event is ProjectSummaryTimelineEvent => event !== undefined);
}

function buildNarrative(facts: ProjectSummaryFacts): ProjectSummaryNarrative {
  const { project, counts, handover, gaps, dataQuality } = facts;
  const managers = managerLabel({
    id: project.id,
    code: project.code,
    name: project.name,
    customer: project.customer,
    region: project.region,
    projectType: project.projectType,
    stageKey: project.stageKey,
    status: project.status,
    managerNames: project.managerNames,
    description: project.description,
    createdAt: project.createdAt,
    archivedAt: project.archivedAt,
  });
  const issueSummary =
    counts.issuesUnresolved > 0
      ? "问题清单中仍有未解决或处理中的事项，需按责任人与建议动作继续跟进；已完成但缺少解决方案或关闭记录的事项，应补齐证据后再核销。"
      : counts.issuesClosedWithoutEvidence > 0
        ? "问题均已关闭，但部分事项缺少解决方案或关闭记录，需补齐关闭证据后再确认总结。"
        : counts.issuesTotal > 0
          ? "问题均已关闭，解决方案与关闭记录齐备；逐条结论以事实区为准。"
          : "本次未读取到项目问题记录，问题处理情况需结合现场事实与补充材料核对。";
  const resultSummary =
    counts.deliverablesMissing > 0
      ? "项目要求成果仍有缺件，需补齐并定档；已定档、变更后文件与缺件清单见事实区。"
      : counts.deliverablesRequired > 0
        ? "项目要求成果均有对应定稿或变更后文件；实际文件状态与定档时间见事实区。"
        : counts.filesTotal > 0
          ? "当前任务未登记必须成果类型，项目结果以已归档文件和任务完成记录为准。"
          : "当前未读取到项目文件或成果要求，项目结果需项目经理结合线下交付材料确认。";
  const handoverSummary =
    handover.length === 0
      ? "当前规则未识别需要接手的待整改事项，项目材料由" + managers + "归档留档。"
      : "待整改事项已按责任人和风险级别归组；建议由项目经理" + managers + "确认分派后，由各责任人按建议动作跟进并回填关闭证据。";
  const riskSummary =
    gaps.some((gap) => gap.severity === "high")
      ? "存在高风险待整改事项，应优先处理逾期、未分配、关闭证据与成果缺件问题，并由项目经理复核数据口径。"
      : gaps.length > 0
        ? "存在待整改事项，需跟踪逾期、责任分配、关闭证据与成果缺件情况；具体风险级别和建议动作见事实区。"
        : dataQuality.length > 0
          ? "未识别需整改的业务缺口，但存在数据口径提醒；建议补充基础记录后再确认正式总结。"
          : "当前规则未识别待整改事项或数据口径提醒；确认前仍应由项目经理复核事实包与现场实际。";
  return {
    overview:
      project.name + "由" + managers + "负责，当前处于" + project.stageName + "阶段，项目状态为" + project.statusName + "。" +
      (project.customer === null || project.customer === "" ? "" : "客户为" + project.customer + "。"),
    process:
      "项目阶段、任务执行、日报记录与变更处理已按统一口径汇总；具体节点、完成情况与证据数量见下方事实区。",
    issues: issueSummary,
    result: resultSummary,
    handover: handoverSummary,
    risks: riskSummary,
  };
}

/** 构建事实包：所有统计、问题结论、缺件判定和接手人都在本函数内按固定规则定稿。 */
export function buildProjectSummaryFacts(source: ProjectSummarySource): ProjectSummaryFacts {
  const dataQuality: ProjectSummaryFacts["dataQuality"] = [];
  const allIssues = buildIssues(source);
  const counts = buildCounts(source, allIssues);
  const gaps = buildGaps(source, allIssues, counts, counts.lastReportDate, dataQuality);
  const issues = allIssues.slice(0, MAX_FACTS_ISSUES);
  const handover = buildHandover(gaps);
  const timeline = buildTimeline(source, dataQuality);
  const managerNames = source.project.managerNames.slice(0, 200).map((name) => (nonEmpty(name) === "" ? "—" : name as string));
  const status = source.project.status as ProjectSummaryFacts["project"]["status"];
  return {
    generatedAt: source.now.toISOString(),
    dataCutoff: source.now.toISOString(),
    project: {
      id: source.project.id,
      code: source.project.code,
      name: source.project.name,
      customer: source.project.customer,
      region: source.project.region,
      projectType: source.project.projectType,
      stageKey: source.project.stageKey as ProjectSummaryFacts["project"]["stageKey"],
      stageName: stageName(source.project.stageKey),
      status,
      statusName: statusName(source.project.status),
      managerNames,
      description: source.project.description,
      createdAt: source.project.createdAt,
      archivedAt: source.project.archivedAt,
    },
    counts,
    stages: [...source.stages]
      .sort((left, right) => left.seq - right.seq)
      .slice(0, 50)
      .map((stage) => ({
        stageKey: stage.stageKey as ProjectSummaryFacts["stages"][number]["stageKey"],
        name: stage.name,
        seq: stage.seq,
        status: stage.status,
        nodeTotal: stage.nodes.total,
        nodeDone: stage.nodes.done,
        taskTotal: stage.tasks.total,
        taskDone: stage.tasks.done,
        plannedStart: stage.plannedStart,
        plannedEnd: stage.plannedEnd,
        actualStart: stage.actualStart,
        actualEnd: stage.actualEnd,
      })),
    timeline,
    issues,
    gaps,
    handover,
    dataQuality,
    evidence: {
      tasks: source.tasks.length,
      reports: source.reports.length,
      issues: source.issues.length,
      files: source.files.length,
      changes: source.changes.length,
      stages: source.stages.length,
    },
  };
}

export function buildTemplateNarrative(facts: ProjectSummaryFacts): ProjectSummaryNarrative {
  return buildNarrative(facts);
}


/** AI 叙述不得把脚本已判定的未解决 / 缺件 / 未完成改写成“全部解决 / 齐全 / 完成”。 */
export function invalidNarrativeClaims(narrative: ProjectSummaryNarrative, facts: ProjectSummaryFacts): string[] {
  const text = Object.values(narrative).join("\n");
  const violations: string[] = [];
  if (facts.counts.issuesUnresolved > 0 && /(全部|所有|均已|已经全部).{0,8}(解决|关闭)|无遗留问题/.test(text)) {
    violations.push("仍有未解决问题却表述为全部解决");
  }
  if (facts.counts.issuesClosedWithoutEvidence > 0 && /(全部|所有|均已).{0,10}(证据|记录).{0,10}(完整|齐备)/.test(text)) {
    violations.push("仍有问题关闭证据缺失却表述为记录完整");
  }
  if (facts.counts.deliverablesMissing > 0 && /(成果|资料|文件).{0,10}(全部|均已).{0,10}(齐全|齐备|交付|定档)/.test(text)) {
    violations.push("仍有成果缺件却表述为齐全");
  }
  if (facts.counts.tasksDone < facts.counts.tasksTotal && /(任务|工作).{0,10}(全部|均已).{0,10}(完成|交付)/.test(text)) {
    violations.push("仍有未完成任务却表述为全部完成");
  }
  if (facts.gaps.length > 0 && /(没有|无).{0,8}(待整改|风险|遗留|遗漏)/.test(text)) {
    violations.push("存在待整改项却表述为无风险或无遗漏");
  }
  return violations;
}

/** AI 叙述不得出现阿拉伯数字：统计与日期一律由事实表展示，避免同数不同义时被模型错配。 */
export function invalidNarrativeNumbers(narrative: ProjectSummaryNarrative, _facts: ProjectSummaryFacts): string[] {
  const used = JSON.stringify(narrative).match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(used)].slice(0, 20);
}
