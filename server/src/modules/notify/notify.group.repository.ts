/**
 * wecom_groups / wecom_group_candidates / notify_deliveries 数据访问（M5-03-2 接线段 · C2-05 / C2-07 / C5-03）。
 * 边界（ADR 架构检查）：notify 属 PLATFORM、project 属 DOMAIN —— 本层**不得 import project 模块**，
 * 直接读 `db/schema/notify.ts` 的表（表访问允许；寻址键 = projectId，绑定行由 project 模块维护）。
 * 口径：投递时读绑定（换绑后未投递消息仍按当前绑定送出）；notify_deliveries 每次尝试一行，
 * 非 sent 行必须带非空 error（0046 CHECK）；activated_at 由群消息回调 ingest 置位（主动推送前置）；
 * 未绑定群回调写入 wecom_group_candidates staging 表（0058），绑定成功后由 project 模块删除。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { notifyDeliveries, wecomGroupCandidates, wecomGroups } from "../../db/schema/notify.js";
import { projects } from "../../db/schema/projects.js";

export type WecomGroupRow = typeof wecomGroups.$inferSelect;
export type WecomGroupCandidateRow = typeof wecomGroupCandidates.$inferSelect;

/** 投递留痕输入（服务层保证 CHECK 语义：sent ↔ sentAt 非空且 error 为空）。 */
export interface NotifyDeliveryInsert {
  outboxId: number | null;
  target: string;
  state: "sent" | "failed" | "deferred" | "dead";
  attempts: number;
  error: string | null;
  sentAt: Date | null;
}

@Injectable()
export class NotifyGroupRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 按项目读当前群绑定（投递时读；未绑定 = null）。 */
  async findGroupByProject(projectId: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.select().from(wecomGroups).where(eq(wecomGroups.projectId, projectId)).limit(1);
    return rows[0] ?? null;
  }

  /** 按 chatid 读绑定（回调 ingest 用；未绑定 = null）。 */
  async findGroupByChatid(chatid: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.select().from(wecomGroups).where(eq(wecomGroups.chatid, chatid)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * 群失败降级（C5-04 / B4 定案）读项目经理：projects.manager_ids[0]（软删 / 不存在 = null）。
   * 边界同文件头注：直接读表，不 import project 模块。
   */
  async findProjectManagerId(projectId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ managerIds: projects.managerIds })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0]?.managerIds[0] ?? null;
  }

  /** 回调 ingest：会话激活置位（仅未激活行命中；已激活 / 未绑定返回 null —— 幂等）。 */
  async activateByChatid(chatid: string, at: Date, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client
      .update(wecomGroups)
      .set({ activatedAt: at, updatedAt: at })
      .where(and(eq(wecomGroups.chatid, chatid), isNull(wecomGroups.activatedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** 群名命令：更新已绑定群的展示名（不改寻址 / 权限；调用方负责命令解析与长度校验）。 */
  async setGroupName(
    chatid: string,
    name: string,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WecomGroupRow | null> {
    const rows = await client
      .update(wecomGroups)
      .set({ name, updatedAt: at })
      .where(eq(wecomGroups.chatid, chatid))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * 未绑定群回调暂存（自动发现）：同 chatid upsert，保留首次发现时间并刷新最后活跃时间；
   * 回调没有群名时不清空已有名称。读面由 project 模块按候选 id 解析，不在这里暴露全文。
   */
  async observeCandidate(
    input: { chatid: string; name: string | null },
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WecomGroupCandidateRow> {
    const rows = await client
      .insert(wecomGroupCandidates)
      .values({ chatid: input.chatid, name: input.name, firstSeenAt: at, lastSeenAt: at })
      .onConflictDoUpdate({
        target: [wecomGroupCandidates.chatid],
        set: {
          name: input.name === null ? sql`${wecomGroupCandidates.name}` : input.name,
          lastSeenAt: at,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("wecom_group_candidates upsert 未返回记录");
    }
    return row;
  }

  /** 投递留痕：一次尝试一行（outbox_id 指向来源事件；事件行清理后置 null 留档不回删）。 */
  async insertDelivery(input: NotifyDeliveryInsert, client: DbClient = this.database.db): Promise<void> {
    await client.insert(notifyDeliveries).values({
      outboxId: input.outboxId,
      channel: "wecom_group",
      target: input.target,
      state: input.state,
      attempts: input.attempts,
      error: input.error,
      sentAt: input.sentAt,
    });
  }
}
