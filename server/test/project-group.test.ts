import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type {
  ProjectGroupRepository,
  WecomGroupCandidateRow,
  WecomGroupRow,
} from "../src/modules/project/project-group.repository.js";
import {
  PROJECT_GROUP_CANDIDATE_TTL_MS,
  ProjectGroupService,
  maskChatid,
  toProjectGroupCandidateView,
  toProjectGroupView,
} from "../src/modules/project/project-group.service.js";
import type { ProjectRepository, ProjectRow, ProjectViewRow } from "../src/modules/project/project.repository.js";
import { DatabaseService } from "../src/db/database.service.js";
import type { AuditService } from "../src/modules/admin/index.js";

const AT = new Date("2026-10-12T06:00:00.000Z");
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const CHATID = "AbcDefGhiJkLmNoPqrStUv-12";
const CHATID_2 = "ZyxWvuTsrQpoNmlKjiHgFe-34";
const RECENT = new Date(Date.now() - 60_000);

async function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 AppError，但未抛出");
}

function projectRow(overrides: Partial<ProjectRow> & { id: string }): ProjectRow {
  return {
    code: "CNBJ-20260708-0001",
    seqNo: 1,
    name: "XX 客户分拣项目",
    customer: "XX 客户",
    region: "华东",
    projectType: "分拣",
    managerIds: [UUID_A],
    stageKey: "presale",
    status: "active",
    description: null,
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    deletedBy: null,
    archivedAt: null,
    archivedBy: null,
    ...overrides,
  };
}

function candidateRow(
  overrides: Partial<WecomGroupCandidateRow> & { id: number; chatid: string },
): WecomGroupCandidateRow {
  return {
    name: null,
    firstSeenAt: RECENT,
    lastSeenAt: RECENT,
    ...overrides,
  };
}

function groupRow(overrides: Partial<WecomGroupRow> & { projectId: string; chatid: string }): WecomGroupRow {
  return {
    id: 1,
    name: null,
    enabled: true,
    activatedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

// ---------- 内存替身（不连库；与仓储方法签名同形） ----------

class FakeGroupRepository {
  rows = new Map<string, WecomGroupRow>();
  candidates = new Map<number, WecomGroupCandidateRow>();
  lastUpsert: { projectId: string; chatid: string; name: string | null; activatedAt: Date | null } | null = null;

  async findByProject(projectId: string): Promise<WecomGroupRow | null> {
    return this.rows.get(projectId) ?? null;
  }

  async listCandidates(since: Date): Promise<WecomGroupCandidateRow[]> {
    const bound = new Set([...this.rows.values()].map((row) => row.chatid));
    return [...this.candidates.values()]
      .filter((row) => row.lastSeenAt >= since && !bound.has(row.chatid))
      .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
  }

  async findCandidateById(id: number): Promise<WecomGroupCandidateRow | null> {
    return this.candidates.get(id) ?? null;
  }

  async removeCandidate(id: number): Promise<WecomGroupCandidateRow | null> {
    const row = this.candidates.get(id) ?? null;
    this.candidates.delete(id);
    return row;
  }

  /** 模拟 uq_wecom_groups_chatid 唯一约束：chatid 被他项目占用 → 400（与仓储转译同形）。 */
  async upsert(
    input: { projectId: string; chatid: string; name: string | null; activatedAt: Date | null },
    at: Date,
  ): Promise<WecomGroupRow> {
    for (const row of this.rows.values()) {
      if (row.projectId !== input.projectId && row.chatid === input.chatid) {
        throw new AppError("VALIDATION_FAILED", "该群已被其它项目绑定（一个群只能绑一个项目；换绑请先解绑原项目）");
      }
    }
    this.lastUpsert = input;
    const row = groupRow({ projectId: input.projectId, chatid: input.chatid, name: input.name, activatedAt: input.activatedAt, updatedAt: at });
    this.rows.set(input.projectId, row);
    return row;
  }

  async remove(projectId: string): Promise<WecomGroupRow | null> {
    const row = this.rows.get(projectId) ?? null;
    this.rows.delete(projectId);
    return row;
  }
}

class FakeProjectRepository {
  rows: ProjectViewRow[] = [];
  lastTouched: { id: string; at: Date } | null = null;

  async findViewById(id: string): Promise<ProjectViewRow | null> {
    return this.rows.find((view) => view.project.id === id && view.project.deletedAt === null) ?? null;
  }

  async touch(id: string, at: Date): Promise<void> {
    this.lastTouched = { id, at };
  }
}

class FakeAuditService {
  entries: unknown[] = [];
  async record(_client: unknown, input: unknown): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(rows: ProjectRow[] = []): {
  service: ProjectGroupService;
  groups: FakeGroupRepository;
  projects: FakeProjectRepository;
  audit: FakeAuditService;
} {
  const audit = new FakeAuditService();
  const groups = new FakeGroupRepository();
  const projects = new FakeProjectRepository();
  projects.rows = rows.map((row) => ({ project: row, managerNames: [null] }));
  const fakeDb = {
    db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) },
  };
  return {
    service: new ProjectGroupService(
      fakeDb as unknown as DatabaseService,
      groups as unknown as ProjectGroupRepository,
      projects as unknown as ProjectRepository,
      audit as unknown as AuditService,
    ),
    groups,
    projects,
    audit,
  };
}

// ---------- 掩码与视图 ----------

describe("maskChatid / toProjectGroupView（读面最小暴露）", () => {
  it("掩码 = **** + 末 4 位（全文不出读面）", () => {
    expect(maskChatid(CHATID)).toBe("****v-12");
  });

  it("候选群视图：只回掩码 / 群名 / 最近活跃时间，不泄露 chatid 全文", () => {
    expect(
      toProjectGroupCandidateView(candidateRow({ id: 9, chatid: CHATID, name: "自动发现群", lastSeenAt: RECENT })),
    ).toEqual({
      id: 9,
      name: "自动发现群",
      chatidMasked: "****v-12",
      lastSeenAt: RECENT.toISOString(),
    });
  });

  it("未绑定 → bound:false 全 null；已绑定 → 掩码 + activated + ISO 时间", () => {
    expect(toProjectGroupView(UUID_A, null)).toEqual({
      projectId: UUID_A,
      bound: false,
      name: null,
      chatidMasked: null,
      activated: false,
      updatedAt: null,
    });
    const view = toProjectGroupView(
      UUID_A,
      groupRow({ projectId: UUID_A, chatid: CHATID, name: "项目群", activatedAt: AT }),
    );
    expect(view).toEqual({
      projectId: UUID_A,
      bound: true,
      name: "项目群",
      chatidMasked: "****v-12",
      activated: true,
      updatedAt: AT.toISOString(),
    });
  });
});

// ---------- GET ----------

describe("ProjectGroupService.getGroup", () => {
  it("未绑定 → bound:false；已绑定 → 掩码回显", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    expect((await service.getGroup(UUID_A)).bound).toBe(false);
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: CHATID, name: "项目群" }));
    const bound = await service.getGroup(UUID_A);
    expect(bound.bound).toBe(true);
    expect(bound.chatidMasked).toBe("****v-12");
  });

  it("项目不存在 / 已软删 → 404 NOT_FOUND", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, deletedAt: AT })]);
    await expectAppErrorAsync(() => service.getGroup(UUID_A), "NOT_FOUND");
  });
});

describe("ProjectGroupService.getCandidates", () => {
  it("候选列表：最近活跃优先，排除已绑定 chatid", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    const older = new Date(RECENT.getTime() - 60_000);
    groups.candidates.set(1, candidateRow({ id: 1, chatid: CHATID, name: "较早群", lastSeenAt: older }));
    groups.candidates.set(2, candidateRow({ id: 2, chatid: CHATID_2, lastSeenAt: RECENT }));
    groups.candidates.set(3, candidateRow({ id: 3, chatid: "BoundGroup-abcdef", lastSeenAt: RECENT }));
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: "BoundGroup-abcdef" }));

    const result = await service.getCandidates(UUID_A);

    expect(result.items.map((item) => item.id)).toEqual([2, 1]);
    expect(result.items[0]).toEqual({
      id: 2,
      name: null,
      chatidMasked: "****e-34",
      lastSeenAt: RECENT.toISOString(),
    });
  });

  it("项目不存在 / 已软删 → 404 NOT_FOUND", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, deletedAt: AT })]);
    await expectAppErrorAsync(() => service.getCandidates(UUID_A), "NOT_FOUND");
  });
});

// ---------- PUT ----------

describe("ProjectGroupService.putGroup", () => {
  it("首次绑定：activated_at 置 null、审计记掩码变化、刷新项目 updatedAt", async () => {
    const { service, groups, projects, audit } = makeService([projectRow({ id: UUID_A })]);
    const view = await service.putGroup(UUID_A, { chatid: CHATID, name: "项目群" }, UUID_B);
    expect(view.bound).toBe(true);
    expect(view.activated).toBe(false);
    expect(view.chatidMasked).toBe("****v-12");
    expect(groups.lastUpsert?.activatedAt).toBeNull();
    expect(projects.lastTouched?.id).toBe(UUID_A);
    const entry = audit.entries[0] as {
      action: string;
      objectType: string;
      objectId: string;
      changes: { field: string; from: unknown; to: unknown }[];
      metadata: Record<string, unknown>;
    };
    expect(entry.action).toBe("update");
    expect(entry.objectType).toBe("project");
    expect(entry.objectId).toBe(UUID_A);
    expect(entry.changes).toContainEqual({ field: "groupChatid", from: null, to: "****v-12" });
    expect(entry.changes).toContainEqual({ field: "groupName", from: null, to: "项目群" });
    // 首次绑定不算「换绑」：chatidChanged=false（换绑置 true，见下一例）`n    expect(entry.metadata).toEqual({ bound: true, chatidChanged: false, activated: false });
  });

  it("同 chatid 重放：保留激活态（activated_at 原样传回）、无变化字段不进 changes", async () => {
    const { service, groups, audit } = makeService([projectRow({ id: UUID_A })]);
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: CHATID, name: "项目群", activatedAt: AT }));
    const view = await service.putGroup(UUID_A, { chatid: CHATID, name: "项目群" }, UUID_B);
    expect(view.activated).toBe(true);
    expect(groups.lastUpsert?.activatedAt).toBe(AT);
    const entry = audit.entries[0] as { changes: unknown[] };
    expect(entry.changes).toEqual([]);
  });

  it("换绑（chatid 变更）：activated_at 重置 null、summary 记换绑、changes 记新旧掩码", async () => {
    const { service, groups, audit } = makeService([projectRow({ id: UUID_A })]);
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: CHATID, activatedAt: AT }));
    const view = await service.putGroup(UUID_A, { chatid: CHATID_2 }, UUID_B);
    expect(view.activated).toBe(false);
    expect(groups.lastUpsert?.activatedAt).toBeNull();
    const entry = audit.entries[0] as { summary: string; changes: unknown[] };
    expect(entry.summary).toContain("换绑");
    expect(entry.changes).toContainEqual({ field: "groupChatid", from: "****v-12", to: "****e-34" });
  });

  it("name 缺省 = 覆盖清空（null）", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: CHATID, name: "旧名" }));
    await service.putGroup(UUID_A, { chatid: CHATID }, UUID_B);
    expect(groups.lastUpsert?.name).toBeNull();
  });

  it("chatid 已被其它项目绑定 → 400 VALIDATION_FAILED（仓储唯一约束转译透传）", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A }), projectRow({ id: UUID_B, code: "CNBJ-20260708-0002" })]);
    groups.rows.set(UUID_B, groupRow({ projectId: UUID_B, chatid: CHATID }));
    await expectAppErrorAsync(() => service.putGroup(UUID_A, { chatid: CHATID }, UUID_B), "VALIDATION_FAILED");
  });

  it("归档项目 → 409 PROJECT_ARCHIVED（写路径保护，不触绑定 / updatedAt）", async () => {
    const { service, groups, projects } = makeService([projectRow({ id: UUID_A, status: "archived" })]);
    await expectAppErrorAsync(() => service.putGroup(UUID_A, { chatid: CHATID }, UUID_B), "PROJECT_ARCHIVED");
    expect(groups.lastUpsert).toBeNull();
    expect(projects.lastTouched).toBeNull();
  });

  it("项目不存在 → 404 NOT_FOUND", async () => {
    const { service } = makeService([]);
    await expectAppErrorAsync(() => service.putGroup(UUID_A, { chatid: CHATID }, UUID_B), "NOT_FOUND");
  });

  it("candidateId 绑定：沿用候选群名，lastSeenAt 作为激活时刻，并删除候选行", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    groups.candidates.set(9, candidateRow({ id: 9, chatid: CHATID, name: "自动发现群", lastSeenAt: RECENT }));

    const view = await service.putGroup(UUID_A, { candidateId: 9 }, UUID_B);

    expect(view).toMatchObject({ bound: true, activated: true, name: "自动发现群", chatidMasked: "****v-12" });
    expect(groups.lastUpsert).toMatchObject({ projectId: UUID_A, chatid: CHATID, name: "自动发现群", activatedAt: RECENT });
    expect(groups.candidates.has(9)).toBe(false);
  });

  it("candidateId 绑定：允许覆盖群名备注", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    groups.candidates.set(9, candidateRow({ id: 9, chatid: CHATID, name: "候选名", lastSeenAt: RECENT }));

    await service.putGroup(UUID_A, { candidateId: 9, name: "项目正式群名" }, UUID_B);

    expect(groups.lastUpsert?.name).toBe("项目正式群名");
  });

  it("candidateId 不存在 / 超过 30 天：404 NOT_FOUND（不写绑定）", async () => {
    const { service, groups } = makeService([projectRow({ id: UUID_A })]);
    await expectAppErrorAsync(() => service.putGroup(UUID_A, { candidateId: 404 }, UUID_B), "NOT_FOUND");
    expect(groups.lastUpsert).toBeNull();

    const expired = new Date(Date.now() - PROJECT_GROUP_CANDIDATE_TTL_MS - 60_000);
    groups.candidates.set(10, candidateRow({ id: 10, chatid: CHATID, lastSeenAt: expired }));
    await expectAppErrorAsync(() => service.putGroup(UUID_A, { candidateId: 10 }, UUID_B), "NOT_FOUND");
    expect(groups.lastUpsert).toBeNull();
  });
});

// ---------- DELETE ----------

describe("ProjectGroupService.deleteGroup", () => {
  it("已绑定 → 解绑（返回 bound:false；审计 action=delete；刷新 updatedAt）", async () => {
    const { service, groups, projects, audit } = makeService([projectRow({ id: UUID_A })]);
    groups.rows.set(UUID_A, groupRow({ projectId: UUID_A, chatid: CHATID, name: "项目群" }));
    const view = await service.deleteGroup(UUID_A, UUID_B);
    expect(view).toEqual({
      projectId: UUID_A,
      bound: false,
      name: null,
      chatidMasked: null,
      activated: false,
      updatedAt: null,
    });
    expect(groups.rows.size).toBe(0);
    expect(projects.lastTouched?.id).toBe(UUID_A);
    const entry = audit.entries[0] as { action: string; changes: unknown[] };
    expect(entry.action).toBe("delete");
    expect(entry.changes).toEqual([
      { field: "groupChatid", from: "****v-12", to: null },
      { field: "groupName", from: "项目群", to: null },
    ]);
  });

  it("未绑定 → 幂等（bound:false；不写审计、不触 updatedAt）", async () => {
    const { service, projects, audit } = makeService([projectRow({ id: UUID_A })]);
    const view = await service.deleteGroup(UUID_A, UUID_B);
    expect(view.bound).toBe(false);
    expect(audit.entries).toEqual([]);
    expect(projects.lastTouched).toBeNull();
  });

  it("归档项目 → 409 PROJECT_ARCHIVED", async () => {
    const { service } = makeService([projectRow({ id: UUID_A, status: "archived" })]);
    await expectAppErrorAsync(() => service.deleteGroup(UUID_A, UUID_B), "PROJECT_ARCHIVED");
  });
});