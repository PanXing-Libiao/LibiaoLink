import { describe, expect, it } from "vitest";
import { ProjectArchiveBodySchema, ProjectUpdateBodySchema } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import { DatabaseService } from "../src/db/database.service.js";
import type { AuditService } from "../src/modules/admin/index.js";
import { ArchiveRepository, type ArchiveViewRow } from "../src/modules/project/archive.repository.js";
import { ArchiveService } from "../src/modules/project/archive.service.js";
import { FlowService } from "../src/modules/project/flow.service.js";
import { ProjectRepository, type ProjectRow, type ProjectViewRow } from "../src/modules/project/project.repository.js";
import { buildProjectFilter } from "../src/modules/project/project.query.js";

const AT = new Date("2026-09-28T06:00:00.000Z");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

async function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error("预期抛出 AppError，但未抛出");
}

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT_ID,
    code: "CNBJ-20260928-0001",
    seqNo: 1,
    name: "XX 客户分拣项目",
    customer: null,
    region: "华东",
    projectType: "分拣",
    managerIds: [ACTOR],
    stageKey: "acceptance",
    status: "active",
    description: null,
    version: 3,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    deletedBy: null,
    archivedAt: null,
    archivedBy: null,
    ...overrides,
  };
}

interface ArchiveInserted {
  projectId: string;
  archivedAt: Date;
  archivedBy: string;
  snapshot: Record<string, unknown>;
  acknowledgedMissing: unknown[];
}

class FakeArchiveRepository {
  project: ProjectRow | null = projectRow();
  stage: { stageKey: string; status: string; advancedAt: Date | null } | null = { stageKey: "acceptance", status: "active", advancedAt: null };
  unfinished: { id: string; title: string; stageKey: string | null; status: string }[] = [];
  taskCounts: Record<string, number> = { pending: 0, active: 1, done: 1 };
  fileRows: { id: string; name: string; docType: string | null; status: string; nodeId: string | null; versionCount: number; latestSeq: number | null; latestUploadedAt: Date | null }[] = [];
  changeRows: { id: string; reason: string; stageKey: string | null; appliedAt: Date }[] = [];
  reportCounts: Record<string, number> = { draft: 0, submitted: 2, supplement: 0 };
  issueCounts: Record<string, number> = { open: 0, in_progress: 1, done: 0 };
  inserted: ArchiveInserted | null = null;
  aborted = 0;
  record: ArchiveViewRow | null = null;
  lastExpectedVersion: number | null = null;

  async lockProjectRow(): Promise<ProjectRow | null> {
    return this.project;
  }

  async findStage(): Promise<{ stageKey: string; status: string; advancedAt: Date | null } | null> {
    return this.stage;
  }

  async listUnfinishedTasks(): Promise<{ id: string; title: string; stageKey: string | null; status: string }[]> {
    return this.unfinished;
  }

  async countTasksByStatus(): Promise<Record<string, number>> {
    return this.taskCounts;
  }

  async listFileSnapshotRows() {
    return this.fileRows;
  }

  async listChanges() {
    return this.changeRows;
  }

  async countReportsByState(): Promise<Record<string, number>> {
    return this.reportCounts;
  }

  async countIssuesByState(): Promise<Record<string, number>> {
    return this.issueCounts;
  }

  async updateProjectArchived(_tx: unknown, _projectId: string, at: Date, actorId: string, expectedVersion: number): Promise<ProjectRow | null> {
    this.lastExpectedVersion = expectedVersion;
    if (this.project === null || this.project.version !== expectedVersion || this.project.deletedAt !== null) return null;
    this.project = { ...this.project, status: "archived", archivedAt: at, archivedBy: actorId, version: expectedVersion + 1, updatedAt: at };
    return this.project;
  }

  async insertArchive(_tx: unknown, input: ArchiveInserted): Promise<{ id: string }> {
    this.inserted = input;
    this.record = {
      archive: {
        id: "archive-1",
        projectId: input.projectId,
        archivedAt: input.archivedAt,
        archivedBy: input.archivedBy,
        snapshot: input.snapshot,
        acknowledgedMissing: input.acknowledgedMissing,
      },
      archivedByName: "张工",
    } as unknown as ArchiveViewRow;
    return { id: "archive-1" };
  }

  async abortActiveUploadSessions(): Promise<number> {
    this.aborted += 1;
    return 1;
  }

  async findArchive(): Promise<ArchiveViewRow | null> {
    return this.record;
  }
}

class FakeProjectRepository {
  view: ProjectViewRow | null = { project: projectRow(), managerNames: ["张工"] };
  async findViewById(): Promise<ProjectViewRow | null> {
    return this.view;
  }
}

class FakeFlowService {
  calls: string[] = [];
  reject = false;
  async assertProjectEditor(_projectId: string, _actorId: string, action: string): Promise<void> {
    this.calls.push(action);
    if (this.reject) throw new AppError("FORBIDDEN", "仅项目编辑者可执行" + action);
  }
}

class FakeAuditService {
  entries: { action?: string; result?: string; metadata?: Record<string, unknown> }[] = [];
  async record(_client: unknown, input: { action?: string; result?: string; metadata?: Record<string, unknown> }): Promise<void> {
    this.entries.push(input);
  }
}

function makeService() {
  const repo = new FakeArchiveRepository();
  const projects = new FakeProjectRepository();
  const flow = new FakeFlowService();
  const audit = new FakeAuditService();
  const fakeDb = { db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) } };
  const service = new ArchiveService(
    fakeDb as unknown as DatabaseService,
    repo as unknown as ArchiveRepository,
    projects as unknown as ProjectRepository,
    flow as unknown as FlowService,
    audit as unknown as AuditService,
  );
  return { service, repo, projects, flow, audit };
}

describe("项目归档（任务全部完成口径）", () => {
  it("契约：confirm 缺省 false；PATCH 更新体不接受 status=archived", () => {
    expect(ProjectArchiveBodySchema.parse({ version: 3 })).toEqual({ version: 3, confirm: false });
    expect(ProjectArchiveBodySchema.parse({ version: 3, confirm: true }).confirm).toBe(true);
    expect(ProjectUpdateBodySchema.safeParse({ version: 3, status: "archived" }).success).toBe(false);
    expect(ProjectUpdateBodySchema.safeParse({ version: 3, status: "paused" }).success).toBe(true);
  });

  it("有未完成任务时 409 ARCHIVE_NOT_READY，confirm=true 也不能越过", async () => {
    const { service, repo, audit } = makeService();
    repo.unfinished = [
      { id: "t1", title: "装配工装", stageKey: null, status: "active" },
      { id: "t2", title: "现场验收", stageKey: "acceptance", status: "pending" },
    ];
    const error = await expectAppErrorAsync(() => service.archiveProject(PROJECT_ID, { version: 3, confirm: true }, ACTOR), "ARCHIVE_NOT_READY");
    expect(error.httpStatus).toBe(409);
    expect(error.details).toHaveLength(2);
    expect(error.details.every((item) => item.code === "task_not_done" && item.path === "missing")).toBe(true);
    expect(repo.project?.status).toBe("active");
    expect(repo.inserted).toBeNull();
    expect(repo.aborted).toBe(0);
    expect(audit.entries).toHaveLength(0);
  });

  it("全部任务完成即可归档：阶段未推进、存在 draft 文件也不阻断，confirm=false 同样成功", async () => {
    const { service, repo, audit } = makeService();
    repo.fileRows = [
      { id: "f1", name: "未定档图纸", docType: "图纸", status: "draft", nodeId: null, versionCount: 1, latestSeq: 1, latestUploadedAt: AT },
    ];
    repo.changeRows = [{ id: "c1", reason: "设计变更", stageKey: "design", appliedAt: AT }];
    const view = await service.archiveProject(PROJECT_ID, { version: 3, confirm: false }, ACTOR);
    expect(repo.project?.status).toBe("archived");
    expect(repo.project?.archivedBy).toBe(ACTOR);
    expect(repo.project?.version).toBe(4);
    expect(repo.inserted?.acknowledgedMissing).toEqual([]);
    expect(repo.aborted).toBe(1);
    expect(audit.entries[0]?.action).toBe("archive");
    expect(audit.entries[0]?.result).toBeUndefined();
    expect(view.projectId).toBe(PROJECT_ID);
    expect(view.id).toBe("archive-1");
    expect(view.snapshot.stage).toEqual({ stageKey: "acceptance", status: "active", advancedAt: null });
    expect(view.snapshot.tasks.total).toBe(2);
    expect(view.snapshot.files.items[0]?.status).toBe("draft");
    expect(view.snapshot.changes.total).toBe(1);
    expect(view.snapshot.reports.byState.submitted).toBe(2);
    expect(view.snapshot.issues.byState.in_progress).toBe(1);
  });

  it("幂等与并发：已归档 409 PROJECT_ARCHIVED；版本不匹配 409 VERSION_CONFLICT", async () => {
    const archivedCase = makeService();
    archivedCase.repo.project = projectRow({ status: "archived", archivedAt: AT, archivedBy: ACTOR });
    await expectAppErrorAsync(() => archivedCase.service.archiveProject(PROJECT_ID, { version: 3, confirm: true }, ACTOR), "PROJECT_ARCHIVED");
    const conflictCase = makeService();
    await expectAppErrorAsync(() => conflictCase.service.archiveProject(PROJECT_ID, { version: 2, confirm: true }, ACTOR), "VERSION_CONFLICT");
  });

  it("权限：项目编辑者判定拒绝 403 FORBIDDEN；通过时断言带上动作名", async () => {
    const rejected = makeService();
    rejected.flow.reject = true;
    await expectAppErrorAsync(() => rejected.service.archiveProject(PROJECT_ID, { version: 3, confirm: true }, ACTOR), "FORBIDDEN");
    const passed = makeService();
    await passed.service.archiveProject(PROJECT_ID, { version: 3, confirm: false }, ACTOR);
    expect(passed.flow.calls).toEqual(["项目归档"]);
  });

  it("清单读面：未归档 404；有记录返回视图（含操作人姓名快照）", async () => {
    const { service, repo } = makeService();
    await expectAppErrorAsync(() => service.getArchive(PROJECT_ID), "NOT_FOUND");
    repo.record = {
      archive: {
        id: "archive-1",
        projectId: PROJECT_ID,
        archivedAt: AT,
        archivedBy: ACTOR,
        snapshot: {},
        acknowledgedMissing: [],
      },
      archivedByName: "张工",
    } as unknown as ArchiveViewRow;
    const view = await service.getArchive(PROJECT_ID);
    expect(view.archivedByName).toBe("张工");
    expect(view.projectId).toBe(PROJECT_ID);
  });

  it("归档检索：filter[archivedYear] 解析为四位年份数组，非法年份 400", () => {
    const filter = buildProjectFilter({ "filter[archivedYear]": "2025, 2026", page: 1, limit: 20 });
    expect(filter.archivedYears).toEqual([2025, 2026]);
    expect(buildProjectFilter({ page: 1, limit: 20 }).archivedYears).toBeNull();
    expect(() => buildProjectFilter({ "filter[archivedYear]": "26", page: 1, limit: 20 })).toThrow(AppError);
    expect(() => buildProjectFilter({ "filter[archivedYear]": "3026", page: 1, limit: 20 })).toThrow(AppError);
  });
});
