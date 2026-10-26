/**
 * PoC-9 回归（h5 · S6·PoC-9）：完成门禁拒绝三条证据 —— 服务端强校验（422 + missing 明细）、
 * 拒绝留痕（outbox `node.gate_rejected`，事务回滚后补写）、UI 置灰依据（can-complete 预检）。
 * 真机回放见 `server/scripts/poc9-replay.mjs`（round-trip + 拒绝后补件放行的闭环）。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { BlueprintService } from "../src/modules/blueprint/index.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { AuditService } from "../src/modules/admin/index.js";
import type { GateService } from "../src/modules/node/index.js";
import { FlowService } from "../src/modules/project/flow.service.js";
import type { FlowRepository } from "../src/modules/project/flow.repository.js";
import type { ProjectMemberRepository } from "../src/modules/project/project-member.repository.js";
import type { ProjectRepository } from "../src/modules/project/project.repository.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NODE = "22222222-2222-4222-8222-222222222222";
const STAGE = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const MANAGER = "55555555-5555-4555-8555-555555555555";

interface OutboxRow { topic: string; dedupeKey: string; payload: Record<string, unknown> }

class FakeDatabase {
  outbox: OutboxRow[] = [];
  /** 事务桩：把 appendOutbox 的 `insert().values()` 收集到数组（不连库）。 */
  tx = {
    insert: () => ({
      values: (value: OutboxRow) => {
        this.outbox.push(value);
        return Promise.resolve();
      },
    }),
  } as unknown as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
    insert: this.tx.insert,
  } as unknown as DatabaseService["db"];
}

function makeNode(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: NODE,
    projectId: PROJECT,
    stageId: STAGE,
    nodeKey: "contract",
    name: "合同签订",
    seq: "10.00",
    status: "pending",
    origin: "blueprint",
    doneAt: null,
    doneBy: null,
    deletedAt: null,
    deletedBy: null,
    sourceBlueprintVersion: 1,
    version: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

class FakeFlowRepository {
  node: Record<string, unknown> | null = makeNode();
  requirements: Record<string, unknown>[] = [{ id: "req-1", nodeId: NODE, requirementType: "required_doc", docType: "contract", minCount: 1 }];
  doneCalls: string[] = [];
  async lockNode(): Promise<Record<string, unknown> | null> {
    return this.node;
  }
  async findNodeById(): Promise<Record<string, unknown> | null> {
    return this.node;
  }
  async listRequirementsByNode(): Promise<Record<string, unknown>[]> {
    return this.requirements;
  }
  async markNodeDone(_tx: DbClient, nodeId: string, version: number): Promise<number> {
    this.doneCalls.push(nodeId + "@" + version);
    return version + 1;
  }
}

class FakeProjectRepository {
  touched: string[] = [];
  project: Record<string, unknown> | null = { id: PROJECT, status: "active", managerId: MANAGER, projectType: "default", stageKey: "presale" };
  async findRowById(): Promise<Record<string, unknown> | null> {
    return this.project;
  }
  async touch(projectId: string): Promise<void> {
    this.touched.push(projectId);
  }
}

class FakeGateService {
  missing: { docType: string; required: number; present: number }[] = [{ docType: "contract", required: 1, present: 0 }];
  async evaluateNode(): Promise<{ missing: { docType: string; required: number; present: number }[] }> {
    return { missing: this.missing };
  }
}

class FakePermissionService {
  admins = new Set<string>();
  async canManageGroupAccess(actorId: string): Promise<boolean> {
    return this.admins.has(actorId);
  }
}

class FakeProjectMemberRepository {
  async findByProjectAndUser(): Promise<null> {
    return null;
  }
}

/** 审计替身（h7）：只记录写入调用（拒绝留痕断言见 test/admin-audit.test.ts / 真机回放）。 */
class FakeAuditService {
  entries: unknown[] = [];
  async record(_client: unknown, input: unknown): Promise<void> {
    this.entries.push(input);
  }
}

function makeService(permission = new FakePermissionService()): {
  service: FlowService;
  db: FakeDatabase;
  flow: FakeFlowRepository;
  projects: FakeProjectRepository;
  gate: FakeGateService;
  permission: FakePermissionService;
} {
  const db = new FakeDatabase();
  const flow = new FakeFlowRepository();
  const projects = new FakeProjectRepository();
  const gate = new FakeGateService();
  const service = new FlowService(
    db as unknown as DatabaseService,
    flow as unknown as FlowRepository,
    projects as unknown as ProjectRepository,
    new FakeProjectMemberRepository() as unknown as ProjectMemberRepository,
    {} as unknown as BlueprintService,
    gate as unknown as GateService,
    permission as unknown as PermissionService,
    new FakeAuditService() as unknown as AuditService,
  );
  return { service, db, flow, projects, gate, permission };
}

describe("流程管理硬闸（管理员 / 项目经理）", () => {
  it("部门编辑账号不能凭遗留 roleCodes 获得项目经理豁免；部门权限管理员可以", async () => {
    const permission = new FakePermissionService();
    const { service } = makeService(permission);
    await expect(service.assertProjectManager(PROJECT, [MANAGER], ACTOR, "增删节点")).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
    permission.admins.add(ACTOR);
    await expect(service.assertProjectManager(PROJECT, [MANAGER], ACTOR, "增删节点")).resolves.toBeUndefined();
  });
});

describe("PoC-9 · 完成门禁拒绝（缺必交成果文件）", () => {
  it("服务端强校验：422 NODE_REQUIRED_DOC_MISSING + missing 明细，且不部分生效", async () => {
    const { service, flow, projects } = makeService();
    const error = await service.completeNode(NODE, 0, ACTOR).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("NODE_REQUIRED_DOC_MISSING");
    expect(appError.httpStatus).toBe(422);
    expect(appError.details).toHaveLength(1);
    expect(appError.details[0]?.code).toBe("required_doc");
    expect(appError.details[0]?.meta).toMatchObject({ docType: "contract", required: 1, present: 0 });
    expect(flow.doneCalls).toEqual([]);
    expect(projects.touched).toEqual([]);
  });

  it("拒绝留痕：事务回滚后补写 outbox node.gate_rejected（含 missing 与操作人）", async () => {
    const { service, db } = makeService();
    await service.completeNode(NODE, 0, ACTOR).catch(() => undefined);
    expect(db.outbox).toHaveLength(1);
    const event = db.outbox[0];
    expect(event?.topic).toBe("node.gate_rejected");
    expect(event?.dedupeKey.startsWith("node.gate_rejected:" + NODE + ":")).toBe(true);
    expect(event?.payload).toMatchObject({ nodeId: NODE, projectId: PROJECT, nodeKey: "contract", actorId: ACTOR });
    expect(event?.payload.missing).toEqual([{ docType: "contract", required: 1, present: 0 }]);
  });

  it("对照：门禁通过时正常完成（写 node.completed、走项目触点，无拒绝留痕）", async () => {
    const { service, db, flow, projects, gate } = makeService();
    gate.missing = [];
    const node = await service.completeNode(NODE, 0, ACTOR);
    expect(node.id).toBe(NODE);
    expect(flow.doneCalls).toEqual([NODE + "@0"]);
    expect(projects.touched).toEqual([PROJECT]);
    expect(db.outbox.map((item) => item.topic)).toEqual(["node.completed"]);
  });

  it("置灰依据：can-complete 预检返回 canComplete=false + missing（不替代事务内强校验）", async () => {
    const { service, gate } = makeService();
    const precheck = await service.canComplete(NODE);
    expect(precheck.canComplete).toBe(false);
    expect(precheck.missing).toEqual([{ docType: "contract", required: 1, present: 0 }]);
    gate.missing = [];
    const ok = await service.canComplete(NODE);
    expect(ok).toEqual({ canComplete: true, missing: [] });
  });

  it("预检边界：节点已完成时 canComplete=false（已完成后不再提示缺件）", async () => {
    const { service, flow } = makeService();
    flow.node = makeNode({ status: "done" });
    expect(await service.canComplete(NODE)).toEqual({ canComplete: false, missing: [] });
  });
});
