import { Injectable, Logger } from "@nestjs/common";
import type { AuditLog, AuditLogListResponse } from "@libiaolink/contracts";
import type { AuditAction, AuditEntry, AuditObjectType, AuditResult } from "@libiaolink/contracts";
import type { DeniedAuditInput, AuditSink } from "../../common/audit/audit-sink.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import type { AuditChangeEntry } from "../../db/schema/admin.js";
import { AuditRepository, type AuditListFilter, type AuditRow } from "./audit.repository.js";
import { parseAuditListFilters } from "./audit.query.js";

/** 审计查询入参（契约 AuditLogListQuery 的 infer 结果；多值筛选为逗号分隔字符串，见 audit.query.ts）。 */
export interface AuditListQueryInput {
  objectType?: string;
  objectId?: string;
  actorId?: string;
  action?: string;
  result?: string;
  projectId?: string;
  /** 关键字（Push 260 · C7-04 搜索）：操作内容（摘要 / 字段级修改明细）/ 操作人姓名快照。 */
  q?: string;
  from?: string;
  to?: string;
  beforeId?: number;
  page: number;
  limit: number;
}

/** 操作记录查看范围：管理员不传；普通账号至少限本人，项目经理可附有效管理项目。 */
export interface AuditVisibility {
  actorId: string;
  managedProjectIds?: readonly string[];
}

/** 业务留痕入参：业务用例只填业务语义，result / entry / 时间由本服务补全。 */
export interface AuditRecordInput {
  actorId: string | null;
  action: AuditAction;
  objectType: AuditObjectType;
  objectId: string;
  projectId?: string | null;
  result?: AuditResult;
  summary: string;
  changes?: AuditChangeEntry[] | null;
  metadata?: Record<string, unknown>;
  /** 审计入口（audit_logs.entry）：缺省 api；身份侧系统动作（离职回收 / 组织同步）显式传 system。 */
  entry?: AuditEntry;
}

/**
 * 审计服务（h7 · C7-01 / C7-02 / C7-03 / C7-05）：
 * 1) 业务留痕 record()：由业务用例在**同一事务**内调用（谁、何时、对什么、从什么改成什么）；
 * 2) 越权留痕 recordDenied()：全局异常过滤器在 403 / 项目域 404 时调用，独立连接、失败只记日志（不影响响应）；
 * 3) 检索 list()：按对象 / 操作人 / 动作 / 结果 / 项目 / 时间区间 + 关键字 q（Push 260：摘要 / 操作人姓名 / 变化明细 ILIKE）（h7 验收项②），occurredAt 降序；
 * 4) 防篡改：只 INSERT / SELECT（库级已收回 UPDATE / DELETE）；保留 ≥6 个月由运维按月清理。
 *
 * Push 173：本服务随审计出口迁至 audit 模块（admin 模块依赖 identity 守卫，identity 需写审计 —— 独立模块避免循环）；
 * admin/index.ts 保持 re-export 兼容既有调用方。
 */
@Injectable()
export class AuditService implements AuditSink {
  private static readonly ACTOR_NAME_TTL_MS = 60_000;

  private readonly logger = new Logger(AuditService.name);
  private readonly actorNames = new Map<string, { name: string | null; at: number }>();

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AuditRepository,
  ) {}

  /** 追加写（业务事务内调用：与业务写入同事务，C7-01）。 */
  async record(client: DbClient, input: AuditRecordInput): Promise<void> {
    await this.repository.insert(client, {
      occurredAt: new Date(),
      actorId: input.actorId,
      actorName: await this.actorName(input.actorId, client),
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      projectId: input.projectId ?? null,
      result: input.result ?? "succeeded",
      entry: input.entry ?? "api",
      summary: input.summary,
      changes: input.changes ?? null,
      metadata: input.metadata ?? {},
    });
  }

  /** 独立连接追加写（登录成功等无业务事务的留痕）：失败向上抛，由调用方决定响应。 */
  async recordStandalone(input: AuditRecordInput): Promise<void> {
    await this.record(this.database.db, input);
  }

  /** 越权 / 未命中留痕（C7-03）：吞错 + 告警日志；告警推送（企微）随 M5 通知模块。 */
  async recordDenied(input: DeniedAuditInput): Promise<void> {
    try {
      await this.repository.insert(this.database.db, {
        occurredAt: new Date(),
        actorId: input.actorId,
        actorName: input.actorName ?? (await this.actorName(input.actorId)),
        action: "deny",
        objectType: input.objectType,
        objectId: input.objectId,
        projectId: input.projectId,
        result: "denied",
        entry: "api",
        summary: input.summary,
        changes: null,
        metadata: input.metadata,
      });
    } catch (error) {
      this.logger.warn("越权留痕写入失败：" + String(error));
    }
  }

  /**
   * 审计检索（C7-04 的服务端口径：多条件筛选；导出随 u12）。
   * visibility 缺省 = 管理员全量；传入后由仓储以「本人记录 OR 有效管理项目记录」复合过滤，
   * 用户自己的项目 / 操作人筛选仍与可见条件取交集。
   */
  async list(query: AuditListQueryInput, visibility?: AuditVisibility): Promise<AuditLogListResponse> {
    const keyword = query.q?.trim() ?? "";
    const multi = parseAuditListFilters(query);
    const projectIds = multi.projectIds;
    if (projectIds !== undefined && projectIds.length === 0) {
      return { items: [], page: query.page, limit: query.limit, total: 0, windowId: null };
    }
    const filter: AuditListFilter = {
      objectTypes: multi.objectTypes,
      objectId: query.objectId,
      actorIds: multi.actorIds,
      actions: multi.actions,
      results: multi.results,
      projectIds,
      keyword: keyword === "" ? undefined : keyword,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      viewerActorId: visibility?.actorId,
      viewerManagedProjectIds: visibility?.managedProjectIds === undefined ? undefined : [...visibility.managedProjectIds],
    };
    const offset = (query.page - 1) * query.limit;
    const { items, total, windowId } = await this.repository.listPage(filter, query.limit, offset, query.beforeId);
    return { items: items.map(toAuditLog), page: query.page, limit: query.limit, total, windowId: windowId ?? null };
  }

  /** 操作人姓名快照（写审计时冗余；带 60s 缓存，避免每写一条查一次 users）。 */
  private async actorName(actorId: string | null, client: DbClient = this.database.db): Promise<string | null> {
    if (actorId === null) return null;
    const now = Date.now();
    const cached = this.actorNames.get(actorId);
    if (cached !== undefined && now - cached.at < AuditService.ACTOR_NAME_TTL_MS) return cached.name;
    const name = await this.repository.findUserDisplayName(actorId, client);
    this.actorNames.set(actorId, { name, at: now });
    return name;
  }
}

/** 行 → 契约（Date → ISO；changes / metadata 原样下发）。 */
export function toAuditLog(row: AuditRow): AuditLog {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action as AuditLog["action"],
    objectType: row.objectType as AuditLog["objectType"],
    objectId: row.objectId,
    projectId: row.projectId,
    result: row.result as AuditLog["result"],
    entry: row.entry as AuditLog["entry"],
    summary: row.summary,
    changes: row.changes ?? null,
    metadata: row.metadata,
  };
}
