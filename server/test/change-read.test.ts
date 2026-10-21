import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import { ChangeService } from "../src/modules/file/index.js";
import type { ChangeRequestListFilter, ChangeRequestSort } from "../src/modules/file/change.query.js";
import type {
  ChangeRequestJoinedRow,
  FileRepository,
  FileRow,
  FileVersionRow,
} from "../src/modules/file/file.repository.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const OTHER_FILE = "22222222-2222-4222-8222-22222222222a";
const FILE = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const CHANGE = "77777777-7777-4777-8777-777777777777";
const VERSION = "66666666-6666-4666-8666-666666666666";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const HASH = "a".repeat(64);
const NOW = new Date("2026-09-22T08:00:00Z");

function makeChangeRow(overrides: Partial<ChangeRequestJoinedRow> = {}): ChangeRequestJoinedRow {
  return {
    id: CHANGE,
    projectId: PROJECT,
    nodeId: NODE,
    stageKey: "design",
    reason: "客户要求把电机功率从 5.5kW 提到 7.5kW",
    beforeSummary: "5.5kW",
    afterSummary: "7.5kW",
    beforeSummaryFileIds: [],
    afterSummaryFileIds: [],
    status: "applied",
    appliedBy: ACTOR,
    writerBy: null,
    appliedAt: NOW,
    createdAt: NOW,
    fileId: FILE,
    versionId: VERSION,
    versionSeq: 2,
    ...overrides,
  };
}

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: FILE,
    projectId: PROJECT,
    nodeId: NODE,
    taskId: null,
    docType: "mechanical_drawing",
    name: "机械设计图纸.pdf",
    status: "changed",
    currentVersionId: VERSION,
    version: 3,
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: NOW,
    finalizedBy: ACTOR,
    recycledAt: null,
    recycledBy: null,
    recycledFromStatus: null,
    purgeAfter: null,
    ...overrides,
  };
}

function makeVersionRow(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: VERSION,
    fileId: FILE,
    seq: 2,
    objectKey: "projects/" + PROJECT + "/files/" + FILE + "/v2/" + HASH + ".pdf",
    sizeBytes: 1024,
    contentHash: HASH,
    mime: "application/pdf",
    uploadedBy: ACTOR,
    uploadedAt: NOW,
    changeRequestId: CHANGE,
    ...overrides,
  };
}

/** 权限替身：只记录「按哪个项目判定可见性」并允许用例切换可见性。 */
class FakePermissionService {
  visible = true;
  seen: { actorId: string; projectId: string }[] = [];

  async assertProjectVisible(
    actorId: string,
    projectId: string,
  ): Promise<{ projectId: string; member: boolean; projectManager: boolean }> {
    this.seen.push({ actorId, projectId });
    if (!this.visible) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    return { projectId, member: true, projectManager: false };
  }
}

/** 审计替身（Push 256）：详情读面回捞「变更前文件名」—— 预置 items，记录下推条件。 */
type FakeAuditItem = { changes: Array<{ field: string; from: unknown; to: unknown }> | null };

class FakeAuditService {
  items: FakeAuditItem[] = [];
  queries: Array<Record<string, unknown>> = [];

  async list(query: Record<string, unknown>): Promise<{ items: FakeAuditItem[]; page: number; limit: number; total: number }> {
    this.queries.push(query);
    return { items: this.items, page: 1, limit: 10, total: this.items.length };
  }
}

/** 仓储替身：记录列表下推参数，返回预置行（类型经 as unknown as FileRepository 桥接）。 */
class FakeFileRepository {
  changeItems: ChangeRequestJoinedRow[] = [];
  changeTotal = 0;
  listQueries: {
    projectId: string;
    filter: ChangeRequestListFilter;
    sorts: ChangeRequestSort[];
    limit: number;
    offset: number;
  }[] = [];
  joined: ChangeRequestJoinedRow | null = null;
  file: FileRow | null = null;
  version: FileVersionRow | null = null;

  async listChangeRequests(
    projectId: string,
    filter: ChangeRequestListFilter,
    sorts: ChangeRequestSort[],
    limit: number,
    offset: number,
  ): Promise<{ items: ChangeRequestJoinedRow[]; total: number }> {
    this.listQueries.push({ projectId, filter, sorts, limit, offset });
    return { items: this.changeItems.slice(offset, offset + limit), total: this.changeTotal };
  }

  async findChangeRequestJoinedById(changeRequestId: string): Promise<ChangeRequestJoinedRow | null> {
    return this.joined !== null && this.joined.id === changeRequestId ? this.joined : null;
  }

  async findFileById(fileId: string): Promise<FileRow | null> {
    return this.file !== null && this.file.id === fileId ? this.file : null;
  }

  async findVersionById(fileId: string, versionId: string): Promise<FileVersionRow | null> {
    if (this.version === null) return null;
    return this.version.fileId === fileId && this.version.id === versionId ? this.version : null;
  }
}

interface Harness {
  service: ChangeService;
  repo: FakeFileRepository;
  permission: FakePermissionService;
  audit: FakeAuditService;
}

function makeService(): Harness {
  const repo = new FakeFileRepository();
  const permission = new FakePermissionService();
  const audit = new FakeAuditService();
  const service = new ChangeService(
    repo as unknown as FileRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
  );
  return { service, repo, permission, audit };
}

describe("ChangeService.listProjectChanges（M4-04 变更读面 · 列表）", () => {
  it("列表：变更后文件 / 版本由 file_versions 反查，映射为契约视图（日期 ISO 化）", async () => {
    const h = makeService();
    h.repo.changeItems = [makeChangeRow()];
    h.repo.changeTotal = 1;

    const result = await h.service.listProjectChanges(PROJECT, { page: 1, limit: 20 });

    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        id: CHANGE,
        projectId: PROJECT,
        nodeId: NODE,
        stageKey: "design",
        reason: "客户要求把电机功率从 5.5kW 提到 7.5kW",
        beforeSummary: "5.5kW",
        afterSummary: "7.5kW",
        beforeSummaryFileIds: [],
        afterSummaryFileIds: [],
        status: "applied",
        appliedBy: ACTOR,
        writerBy: null,
        appliedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        fileId: FILE,
        versionId: VERSION,
        versionSeq: 2,
      },
    ]);
    const query = h.repo.listQueries[0]!;
    expect(query.projectId).toBe(PROJECT);
    expect(query.filter).toEqual({
      stageKeys: null,
      nodeId: null,
      fileId: null,
      appliedBy: null,
      keyword: null,
    });
    expect(query.sorts).toEqual([]);
    expect(query.offset).toBe(0);
  });

  it("列表（Push 319）：导入变更没有变更后文件 → fileId / versionId / versionSeq 为 null（不再被过滤）", async () => {
    const h = makeService();
    h.repo.changeItems = [makeChangeRow({ fileId: null, versionId: null, versionSeq: null })];
    h.repo.changeTotal = 1;

    const result = await h.service.listProjectChanges(PROJECT, { page: 1, limit: 20 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual({
      id: CHANGE,
      projectId: PROJECT,
      nodeId: NODE,
      stageKey: "design",
      reason: "客户要求把电机功率从 5.5kW 提到 7.5kW",
      beforeSummary: "5.5kW",
      afterSummary: "7.5kW",
      beforeSummaryFileIds: [],
      afterSummaryFileIds: [],
      status: "applied",
      appliedBy: ACTOR,
      writerBy: null,
      appliedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      fileId: null,
      versionId: null,
      versionSeq: null,
    });
  });

  it("列表：阶段多值 + 关键字（trim）+ 申请人 / 文件 / 节点筛选 + 分页排序下推 repository", async () => {
    const h = makeService();
    h.repo.changeTotal = 42;

    const result = await h.service.listProjectChanges(PROJECT, {
      "filter[stageKey]": "design, install",
      "filter[nodeId]": NODE,
      "filter[fileId]": FILE,
      "filter[appliedBy]": ACTOR,
      "filter[projectId]": PROJECT,
      q: "  电机  ",
      page: 3,
      limit: 10,
      sort: "appliedAt:desc,createdAt",
    });

    expect(result.total).toBe(42);
    const query = h.repo.listQueries[0]!;
    expect(query.filter).toEqual({
      stageKeys: ["design", "install"],
      nodeId: NODE,
      fileId: FILE,
      appliedBy: ACTOR,
      keyword: "电机",
    });
    expect(query.sorts).toEqual([
      { field: "appliedAt", direction: "desc" },
      { field: "createdAt", direction: "asc" },
    ]);
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
  });

  it("列表：非法输入一律 400（阶段 / 排序白名单 / 排序方向 / uuid / filter[projectId] 冲突）", async () => {
    const h = makeService();
    const cases: Record<string, unknown>[] = [
      { "filter[stageKey]": "unknown_stage" },
      { sort: "fileId" },
      { sort: "createdAt:sideways" },
      { "filter[nodeId]": "not-a-uuid" },
      { "filter[fileId]": "not-a-uuid" },
      { "filter[appliedBy]": "not-a-uuid" },
      { "filter[projectId]": OTHER_PROJECT },
    ];
    for (const extra of cases) {
      await expect(
        h.service.listProjectChanges(PROJECT, { page: 1, limit: 20, ...(extra as object) }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    }
    // 非法输入在查询解析阶段即失败，不触达仓储（不产生静默空列表）。
    expect(h.repo.listQueries).toHaveLength(0);
  });
});

describe("ChangeService.getChange（M4-04 变更读面 · 详情）", () => {
  it("详情：返回变更记录 + 变更后文件 + 变更后版本", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow();
    h.repo.file = makeFileRow();
    h.repo.version = makeVersionRow();

    const detail = await h.service.getChange(CHANGE, ACTOR);

    expect(detail.id).toBe(CHANGE);
    expect(detail.versionSeq).toBe(2);
    expect(detail.file).toMatchObject({ id: FILE, status: "changed", name: "机械设计图纸.pdf" });
    expect(detail.version).toMatchObject({ id: VERSION, seq: 2, changeRequestId: CHANGE });
    // Push 256：未更名的变更 = 无 name 审计 → 变更前文件名 null（前端回退显示当前名）。
    expect(detail.filePreviousName).toBeNull();
    expect(h.audit.queries[0]).toMatchObject({ objectType: "change", objectId: CHANGE, action: "create", page: 1 });
    // 可见性按「变更所属项目」判定（详情路径不含项目 id）。
    expect(h.permission.seen).toEqual([{ actorId: ACTOR, projectId: PROJECT }]);
  });

  it("（Push 256）详情：本次变更同时更名 → filePreviousName = 审计 name.from（未更名 null）", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow();
    h.repo.file = makeFileRow();
    h.repo.version = makeVersionRow();
    h.audit.items = [{ changes: [{ field: "status", from: "final", to: "changed" }, { field: "name", from: "回放-变更目标-图纸.xls", to: "回放-变更后-图纸.pptx" }] }];

    const detail = await h.service.getChange(CHANGE, ACTOR);

    expect(detail.file?.name).toBe("机械设计图纸.pdf");
    expect(detail.filePreviousName).toBe("回放-变更目标-图纸.xls");
  });

  it("详情：变更不存在 → 404", async () => {
    const h = makeService();
    await expect(h.service.getChange(CHANGE, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(h.permission.seen).toHaveLength(0);
  });

  it("详情：项目不可见（非成员）→ 404（防 IDOR，不泄露存在性）", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow({ projectId: OTHER_PROJECT });
    h.permission.visible = false;

    await expect(h.service.getChange(CHANGE, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(h.permission.seen).toEqual([{ actorId: ACTOR, projectId: OTHER_PROJECT }]);
  });

  it("详情：变更后版本缺失 → 500 INTERNAL（数据不一致，不静默返回空版本）", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow();
    h.repo.file = makeFileRow();
    h.repo.version = null;

    await expect(h.service.getChange(CHANGE, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
  });

  it("详情：fileId / versionId 半空 → 500 INTERNAL（半空 = 数据不一致）", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow({ versionId: null, versionSeq: null });
    h.repo.file = makeFileRow();

    await expect(h.service.getChange(CHANGE, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
  });

  it("详情（Push 319）：导入变更无变更后文件（fileId / versionId 全空）→ file / version 给 null", async () => {
    const h = makeService();
    h.repo.joined = makeChangeRow({ fileId: null, versionId: null, versionSeq: null });

    const detail = await h.service.getChange(CHANGE, ACTOR);

    expect(detail.fileId).toBeNull();
    expect(detail.versionId).toBeNull();
    expect(detail.versionSeq).toBeNull();
    expect(detail.file).toBeNull();
    expect(detail.version).toBeNull();
    expect(detail.filePreviousName).toBeNull();
  });
});
