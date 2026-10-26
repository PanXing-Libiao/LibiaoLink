import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { AuditService } from "../audit/index.js";
import { DepartmentRepository } from "./department.repository.js";
import { SessionService } from "./session.service.js";
import { UserGroupRepository } from "./user-group.repository.js";
import { UserRepository } from "./user.repository.js";

/** 目录记录：同步适配器（企微 / Casdoor）归一化后的输入；本服务不直接访问外部系统。 */
export interface OrgDepartmentRecord {
  sourceId: string;
  name: string;
  parentSourceId: string | null;
  status: "active" | "disabled";
}

export interface OrgUserRecord {
  casdoorId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  /** 目录群组键；undefined = 本次快照未提供群组字段（不更新已有关系）。 */
  groups?: string[];
}

/** 一次目录快照（拉取时间为调用方给定；ClockService 随 worker 卡片接入）。 */
export interface OrgDirectorySnapshot {
  pulledAt: Date;
  departments: OrgDepartmentRecord[];
  users: OrgUserRecord[];
}

/** 快照中缺失的用户：report = 只进差异报告；disable = 按安全阀执行禁用 + 踢线（离职回收闭环）。 */
export type MissingUserPolicy = "report" | "disable";

export interface OrgSyncOptions {
  missingUserPolicy?: MissingUserPolicy;
}

/** 差异报告（v0.3 §3.2：组织同步产出差异报告；停用 / 离职触发会话撤销）。 */
export interface OrgSyncReport {
  pulledAt: string;
  departments: {
    created: number;
    updated: number;
    disabled: number;
    disabledNames: string[];
    /** 父部门不在快照内、已按根处理的部门 sourceId（快照数据问题，需上游核对）。 */
    unresolvedParents: string[];
  };
  users: {
    created: number;
    updated: number;
    disabled: number;
    enabled: number;
    sessionsRevoked: number;
    disabledUsernames: string[];
  };
  missing: {
    departmentSourceIds: string[];
    casdoorIds: string[];
    policy: MissingUserPolicy;
    disabled: boolean;
    /** 缺失用户超过安全阀阈值：只报告不执行，需人工确认。 */
    skippedByThreshold: boolean;
  };
}

/** 缺失即禁用的安全阀：缺失的在职用户数 ≤ max(3, 在职总数 × 20%) 才执行，防快照故障误伤全员。 */
const MISSING_DISABLE_MIN = 3;
const MISSING_DISABLE_RATIO = 0.2;

/** 部门快照排序：父先于子（upsert 时才能解析 parent_id）；成环即 400（快照数据问题，不静默）。 */
function orderDepartments(records: readonly OrgDepartmentRecord[]): OrgDepartmentRecord[] {
  const byId = new Map<string, OrgDepartmentRecord>();
  for (const record of records) {
    if (byId.has(record.sourceId)) {
      throw new AppError("VALIDATION_FAILED", "部门快照存在重复 sourceId：" + record.sourceId);
    }
    byId.set(record.sourceId, record);
  }
  const ordered: OrgDepartmentRecord[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (record: OrgDepartmentRecord): void => {
    if (visited.has(record.sourceId)) return;
    if (visiting.has(record.sourceId)) {
      throw new AppError("VALIDATION_FAILED", "部门快照存在环：" + record.sourceId);
    }
    visiting.add(record.sourceId);
    if (record.parentSourceId !== null) {
      const parent = byId.get(record.parentSourceId);
      if (parent !== undefined) visit(parent);
    }
    visiting.delete(record.sourceId);
    visited.add(record.sourceId);
    ordered.push(record);
  };
  for (const record of records) visit(record);
  return ordered;
}

/**
 * 组织同步引擎（h1 · D1-02 / D1-07）：消费目录快照 —— 部门树 upsert + 缺失停用、用户 upsert + 离职停用 + 踢线，产出差异报告。
 * 外部拉取（Casdoor / 企微）由适配器承担；Casdoor 已由 worker 启动即自动同步并周期轮询，本服务保持纯领域逻辑、可单测。
 * 留痕（Push 173）：用户停用 / 启用逐条写审计（objectType = user、entry = system、actorId = null —— 系统动作）；
 * 批次运行报告仍经返回值下发（新建 / 更新计数不逐条落审计，避免首次全量同步刷屏）。
 */
@Injectable()
export class OrgSyncService {
  constructor(
    private readonly departments: DepartmentRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
    private readonly groups?: UserGroupRepository,
  ) {}

  async applySnapshot(snapshot: OrgDirectorySnapshot, options: OrgSyncOptions = {}): Promise<OrgSyncReport> {
    const policy: MissingUserPolicy = options.missingUserPolicy ?? "report";
    const now = new Date();

    const departmentPart = await this.syncDepartments(snapshot.departments, now);
    const userPart = await this.syncUsers(snapshot.users, policy, now);

    return {
      pulledAt: snapshot.pulledAt.toISOString(),
      departments: departmentPart,
      users: userPart.users,
      missing: {
        departmentSourceIds: departmentPart.missingSourceIds,
        casdoorIds: userPart.missingCasdoorIds,
        policy,
        disabled: userPart.missingDisabled,
        skippedByThreshold: userPart.skippedByThreshold,
      },
    };
  }

  private async syncDepartments(records: readonly OrgDepartmentRecord[], at: Date): Promise<DepartmentPart> {
    const ordered = orderDepartments(records);
    const snapshotIds = new Set(records.map((record) => record.sourceId));
    const existing = await this.departments.listSynced();
    const existingBySource = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      if (row.sourceId !== null) existingBySource.set(row.sourceId, row);
    }

    const idBySourceId = new Map<string, string>();
    const unresolvedParents: string[] = [];
    let created = 0;
    let updated = 0;
    for (const record of ordered) {
      let parentId: string | null = null;
      if (record.parentSourceId !== null) {
        const resolved = idBySourceId.get(record.parentSourceId);
        if (resolved === undefined) {
          unresolvedParents.push(record.sourceId);
        } else {
          parentId = resolved;
        }
      }
      const before = existingBySource.get(record.sourceId);
      if (before === undefined) {
        created += 1;
      } else if (before.name !== record.name || before.parentId !== parentId || before.status !== record.status) {
        updated += 1;
      }
      const row = await this.departments.upsertBySourceId(
        { sourceId: record.sourceId, name: record.name, parentId, status: record.status },
        at,
      );
      idBySourceId.set(record.sourceId, row.id);
    }

    const missingActive = existing.filter(
      (row) => row.sourceId !== null && !snapshotIds.has(row.sourceId) && row.status === "active",
    );
    const disabledIds = await this.departments.disableByIds(missingActive.map((row) => row.id), at);
    const disabledIdSet = new Set(disabledIds);
    return {
      created,
      updated,
      disabled: disabledIds.length,
      disabledNames: missingActive.filter((row) => disabledIdSet.has(row.id)).map((row) => row.name),
      unresolvedParents,
      missingSourceIds: missingActive.map((row) => row.sourceId ?? ""),
    };
  }

  private async syncUsers(records: readonly OrgUserRecord[], policy: MissingUserPolicy, at: Date): Promise<UserPart> {
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.casdoorId)) {
        throw new AppError("VALIDATION_FAILED", "用户快照存在重复 casdoorId：" + record.casdoorId);
      }
      seen.add(record.casdoorId);
    }

    const existing = await this.users.listAll();
    const byCasdoorId = new Map(existing.map((row) => [row.casdoorId, row]));
    let created = 0;
    let updated = 0;
    let enabled = 0;
    let sessionsRevoked = 0;
    const disabledUsernames: string[] = [];

    for (const record of records) {
      const before = byCasdoorId.get(record.casdoorId);
      const row = await this.users.upsertFromDirectory(record, at);
      if (this.groups !== undefined && record.groups !== undefined) {
        await this.groups.replaceForUser(row.id, record.groups, at);
      }
      if (before === undefined) {
        created += 1;
        continue;
      }
      if (
        before.username !== record.username ||
        before.displayName !== record.displayName ||
        before.email !== record.email ||
        before.status !== record.status
      ) {
        updated += 1;
      }
      if (before.status === "active" && row.status === "disabled") {
        disabledUsernames.push(row.username);
        const revoked = await this.sessions.revokeAllForUser(row.id);
        sessionsRevoked += revoked;
        await this.audit.record(this.database.db, {
          actorId: null,
          action: "update",
          objectType: "user",
          objectId: row.id,
          entry: "system",
          summary: "组织同步 · 停用用户（目录标记离职）：" + row.displayName + "（" + row.username + "，撤销会话 " + revoked + " 个）",
          changes: [{ field: "status", from: "active", to: "disabled" }],
          metadata: { source: "org_sync", reason: "directory_disabled", casdoorId: row.casdoorId, sessionsRevoked: revoked },
        });
      } else if (before.status === "disabled" && row.status === "active") {
        enabled += 1;
        await this.audit.record(this.database.db, {
          actorId: null,
          action: "update",
          objectType: "user",
          objectId: row.id,
          entry: "system",
          summary: "组织同步 · 启用用户（复职）：" + row.displayName + "（" + row.username + "）",
          changes: [{ field: "status", from: "disabled", to: "active" }],
          metadata: { source: "org_sync", reason: "directory_enabled", casdoorId: row.casdoorId },
        });
      }
    }

    const missingActive = existing.filter((row) => row.status === "active" && !seen.has(row.casdoorId));
    const activeCount = existing.filter((row) => row.status === "active").length;
    const allowed = Math.max(MISSING_DISABLE_MIN, Math.floor(activeCount * MISSING_DISABLE_RATIO));
    let missingDisabled = false;
    let skippedByThreshold = false;
    if (policy === "disable" && missingActive.length > 0) {
      if (missingActive.length <= allowed) {
        for (const row of missingActive) {
          await this.users.updateStatus(row.id, "disabled", at);
          const revoked = await this.sessions.revokeAllForUser(row.id);
          sessionsRevoked += revoked;
          disabledUsernames.push(row.username);
          await this.audit.record(this.database.db, {
            actorId: null,
            action: "update",
            objectType: "user",
            objectId: row.id,
            entry: "system",
            summary: "组织同步 · 停用用户（目录缺失 · 策略 disable 执行）：" + row.displayName + "（" + row.username + "，撤销会话 " + revoked + " 个）",
            changes: [{ field: "status", from: "active", to: "disabled" }],
            metadata: { source: "org_sync", reason: "missing_from_snapshot", casdoorId: row.casdoorId, sessionsRevoked: revoked },
          });
        }
        missingDisabled = true;
      } else {
        skippedByThreshold = true;
      }
    }

    return {
      users: {
        created,
        updated,
        disabled: disabledUsernames.length,
        enabled,
        sessionsRevoked,
        disabledUsernames,
      },
      missingCasdoorIds: missingActive.map((row) => row.casdoorId),
      missingDisabled,
      skippedByThreshold,
    };
  }
}

interface DepartmentPart {
  created: number;
  updated: number;
  disabled: number;
  disabledNames: string[];
  unresolvedParents: string[];
  missingSourceIds: string[];
}

interface UserPart {
  users: OrgSyncReport["users"];
  missingCasdoorIds: string[];
  missingDisabled: boolean;
  skippedByThreshold: boolean;
}
