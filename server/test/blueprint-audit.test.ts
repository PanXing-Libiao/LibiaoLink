/**
 * 蓝图写路径审计（Push 173）：保存草稿 / 导入 / 发布 —— 审计与写入同事务；发布幂等短路不写审计。
 * 覆盖：create / update 动作与 summary 前缀；changes = 名称 + 阶段 / 节点计数；publish 的 publishedVersion 变更；
 * 权限拒绝（403）与校验失败（422）不落库不留痕；发布无变更（幂等）不写审计。
 * 契约见 shared/src/modules/flow.ts；真机口径见 server/src/modules/blueprint/README.md。
 */
import { describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { AuditRecordInput, AuditService } from "../src/modules/audit/index.js";
import type { BlueprintRepository, BlueprintRow } from "../src/modules/blueprint/blueprint.repository.js";
import { BlueprintService } from "../src/modules/blueprint/blueprint.service.js";
import type { Blueprint } from "../src/modules/blueprint/blueprint.validation.js";
import type { PermissionService } from "../src/modules/permission/index.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const BP_ID = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-10-08T02:00:00Z");

function blueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    schemaVersion: 1,
    blueprintVersion: 1,
    name: "标准模板",
    projectType: "default",
    updatedAt: AT.toISOString(),
    stages: [{ key: "design", name: "设计开发", seq: 10, nodes: [{ key: "design.mech", name: "机械设计", seq: 10, constraints: [] }] }],
    ...overrides,
  } as Blueprint;
}

function makeRow(overrides: Partial<BlueprintRow> = {}): BlueprintRow {
  return {
    id: BP_ID,
    projectType: "default",
    name: "标准模板",
    draftPayload: blueprint() as unknown as Record<string, unknown>,
    draftUpdatedAt: AT,
    draftUpdatedBy: null,
    publishedVersion: 0,
    version: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class FakeBlueprintRepository {
  rows: BlueprintRow[] = [];
  versions: { blueprintVersion: number; payload: Blueprint; publishedBy: string | null; publishedAt: Date }[] = [];
  publishCalls: number[] = [];
  findClients: unknown[] = [];

  async findByProjectType(projectType: string, client: DbClient = {} as DbClient): Promise<BlueprintRow | null> {
    this.findClients.push(client);
    const row = this.rows.find((item) => item.projectType === projectType);
    return row === undefined ? null : { ...row };
  }

  async insertDraft(
    projectType: string,
    name: string,
    payload: Blueprint,
    actorId: string | null,
    at: Date,
    _client: DbClient = {} as DbClient,
  ): Promise<BlueprintRow> {
    const row = makeRow({ projectType, name, draftPayload: payload as unknown as Record<string, unknown>, draftUpdatedBy: actorId, createdAt: at, updatedAt: at });
    this.rows.push(row);
    return { ...row };
  }

  async updateDraft(
    id: string,
    payload: Blueprint,
    actorId: string | null,
    at: Date,
    _client: DbClient = {} as DbClient,
  ): Promise<BlueprintRow | null> {
    const index = this.rows.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = this.rows[index] as BlueprintRow;
    const next: BlueprintRow = {
      ...current,
      name: payload.name,
      draftPayload: payload as unknown as Record<string, unknown>,
      draftUpdatedBy: actorId,
      version: current.version + 1,
      updatedAt: at,
    };
    this.rows[index] = next;
    return { ...next };
  }

  async findVersion(
    _blueprintId: string,
    version: number,
  ): Promise<{ blueprintVersion: number; payload: Blueprint; publishedBy: string | null; publishedAt: Date } | null> {
    return this.versions.find((item) => item.blueprintVersion === version) ?? null;
  }

  async publishVersion(
    blueprintId: string,
    blueprintVersion: number,
    payload: Blueprint,
    _issues: unknown[],
    actorId: string | null,
    at: Date,
    _client: DbClient = {} as DbClient,
  ): Promise<void> {
    this.versions.push({ blueprintVersion, payload, publishedBy: actorId, publishedAt: at });
    this.publishCalls.push(blueprintVersion);
    const index = this.rows.findIndex((item) => item.id === blueprintId);
    if (index >= 0) {
      const current = this.rows[index] as BlueprintRow;
      this.rows[index] = {
        ...current,
        draftPayload: payload as unknown as Record<string, unknown>,
        publishedVersion: blueprintVersion,
        version: current.version + 1,
        updatedAt: at,
      };
    }
  }
}

class FakePermission {
  constructor(private readonly allowed = true) {}
  async assertCan(_actorId: string, key: string, _context?: unknown, message?: string): Promise<void> {
    if (!this.allowed) throw new AppError("FORBIDDEN", message ?? "无权限：" + key);
  }
  async assertCanManageBlueprint(_actorId: string, message?: string): Promise<void> {
    if (!this.allowed) throw new AppError("FORBIDDEN", message ?? "无权限：blueprint.manage");
  }
}

class FakeAuditService {
  records: AuditRecordInput[] = [];
  clients: unknown[] = [];
  async record(client: DbClient, input: AuditRecordInput): Promise<void> {
    this.clients.push(client);
    this.records.push(input);
  }
}

class FakeDatabase {
  readonly tx = { kind: "tx" } as unknown as DbClient;
  readonly db = {
    transaction: (callback: (tx: DbClient) => Promise<unknown>) => callback(this.tx),
  } as unknown as DatabaseService["db"];
}

function makeService(options: { allowed?: boolean; rows?: BlueprintRow[] } = {}) {
  const repo = new FakeBlueprintRepository();
  repo.rows = options.rows ?? [];
  const audit = new FakeAuditService();
  const database = new FakeDatabase();
  const permission = new FakePermission(options.allowed ?? true);
  const service = new BlueprintService(
    repo as unknown as BlueprintRepository,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    database as unknown as DatabaseService,
  );
  return { service, repo, audit, database };
}

describe("蓝图写路径审计（Push 173）", () => {
  it("首次保存：action=create；changes = 名称 + 阶段 / 节点计数（from null）；审计与写入同事务", async () => {
    const { service, repo, audit, database } = makeService();
    await service.saveDraft("default", blueprint(), ACTOR);
    expect(repo.rows).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "create",
      objectType: "blueprint",
      objectId: BP_ID,
      summary: "新建蓝图：default（标准模板）",
      changes: [
        { field: "name", from: null, to: "标准模板" },
        { field: "nodeCount", from: null, to: 1 },
        { field: "stageCount", from: null, to: 1 },
      ],
      metadata: { projectType: "default", source: "save" },
    });
    expect(repo.findClients[0]).toBe(database.tx);
    expect(audit.clients[0]).toBe(database.tx);
  });

  it("再次保存（有变更）：action=update；changes 只含变化字段", async () => {
    const { service, repo, audit } = makeService({ rows: [makeRow()] });
    const changed = blueprint({
      name: "标准模板 V2",
      stages: [
        {
          key: "design",
          name: "设计开发",
          seq: 10,
          nodes: [
            { key: "design.mech", name: "机械设计", seq: 10, constraints: [] },
            { key: "design.elec", name: "电气设计", seq: 20, constraints: [] },
          ],
        },
      ],
    });
    await service.saveDraft("default", changed, ACTOR);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.version).toBe(1);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: "update",
      objectType: "blueprint",
      objectId: BP_ID,
      summary: "保存蓝图草稿：default（标准模板 V2）",
      changes: [
        { field: "name", from: "标准模板", to: "标准模板 V2" },
        { field: "nodeCount", from: 1, to: 2 },
      ],
      metadata: { projectType: "default", source: "save" },
    });
  });

  it("导入：summary 前缀 = 导入蓝图；metadata.source = import", async () => {
    const { service, audit } = makeService({ rows: [makeRow()] });
    await service.importBlueprint("default", blueprint({ name: "导入模板" }), ACTOR);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: "update",
      summary: "导入蓝图：default（导入模板）",
      metadata: { projectType: "default", source: "import" },
    });
  });

  it("发布：版本号 +1、审计记 publishedVersion；与版本写入同事务", async () => {
    const draft = blueprint({ name: "标准模板 V2" });
    const row = makeRow({ name: "标准模板 V2", draftPayload: draft as unknown as Record<string, unknown>, publishedVersion: 1 });
    const { service, repo, audit, database } = makeService({ rows: [row] });
    repo.versions.push({ blueprintVersion: 1, payload: blueprint(), publishedBy: null, publishedAt: AT });
    const view = await service.publish("default", ACTOR);
    expect(repo.publishCalls).toEqual([2]);
    expect(view.publishedVersion).toBe(2);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      actorId: ACTOR,
      action: "update",
      objectType: "blueprint",
      objectId: BP_ID,
      summary: "发布蓝图 v2：default（标准模板 V2）",
      changes: [{ field: "publishedVersion", from: 1, to: 2 }],
      metadata: { projectType: "default", stageCount: 1, nodeCount: 1 },
    });
    expect(audit.clients[0]).toBe(database.tx);
  });

  it("发布幂等（草稿 = 已发布）：不写版本、不写审计", async () => {
    const published = blueprint();
    const row = makeRow({ draftPayload: published as unknown as Record<string, unknown>, publishedVersion: 1 });
    const { service, repo, audit } = makeService({ rows: [row] });
    repo.versions.push({ blueprintVersion: 1, payload: published, publishedBy: null, publishedAt: AT });
    const view = await service.publish("default", ACTOR);
    expect(repo.publishCalls).toEqual([]);
    expect(audit.records).toEqual([]);
    expect(view.status).toBe("published");
  });

  it("权限不足：403 且不落库不留痕", async () => {
    const { service, repo, audit } = makeService({ allowed: false });
    await expect(service.saveDraft("default", blueprint(), ACTOR)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repo.rows).toEqual([]);
    expect(audit.records).toEqual([]);
  });

  it("校验不通过：422 且不落库不留痕", async () => {
    const { service, repo, audit } = makeService();
    await expect(service.saveDraft("default", blueprint({ stages: [] }), ACTOR)).rejects.toMatchObject({
      code: "BLUEPRINT_SCHEMA_INVALID",
    });
    expect(repo.rows).toEqual([]);
    expect(audit.records).toEqual([]);
  });
});
