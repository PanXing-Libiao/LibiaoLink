import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, notExists, sql } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { wecomGroupCandidates, wecomGroups } from "../../db/schema/notify.js";
import { isUniqueViolation } from "./project.repository.js";

export type WecomGroupRow = typeof wecomGroups.$inferSelect;
export type WecomGroupCandidateRow = typeof wecomGroupCandidates.$inferSelect;

/**
 * wecom_groups 数据访问（M5-03-2 接线段 · C2-05 群聊绑定）：一个项目最多一个群（project_id 唯一）、
 * 一个群最多绑一个项目（chatid 唯一，防重复播报 —— 换绑到别的项目 = 先解绑再绑）。
 * activated_at 的「换绑重置」语义由服务层判定后传入本层，本层只做数据访问与唯一冲突转译。
 */
@Injectable()
export class ProjectGroupRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByProject(projectId: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.select().from(wecomGroups).where(eq(wecomGroups.projectId, projectId)).limit(1);
    return rows[0] ?? null;
  }

  /** 自动发现候选：最近活跃优先；排除已经绑定到任何项目的 chatid。 */
  async listCandidates(since: Date, limit = 50, client: DbClient = this.database.db): Promise<WecomGroupCandidateRow[]> {
    const bound = client
      .select({ chatid: wecomGroups.chatid })
      .from(wecomGroups)
      .where(eq(wecomGroups.chatid, wecomGroupCandidates.chatid));
    return await client
      .select()
      .from(wecomGroupCandidates)
      .where(and(gte(wecomGroupCandidates.lastSeenAt, since), notExists(bound)))
      .orderBy(desc(wecomGroupCandidates.lastSeenAt), desc(wecomGroupCandidates.id))
      .limit(limit);
  }

  /** 按候选 id 读取（绑定前服务层校验时效；不存在 = null）。 */
  async findCandidateById(id: number, client: DbClient = this.database.db): Promise<WecomGroupCandidateRow | null> {
    const rows = await client.select().from(wecomGroupCandidates).where(eq(wecomGroupCandidates.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** 候选绑定成功后删除（同事务调用）；返回被删行，不存在 = null。 */
  async removeCandidate(id: number, client: DbClient = this.database.db): Promise<WecomGroupCandidateRow | null> {
    const rows = await client.delete(wecomGroupCandidates).where(eq(wecomGroupCandidates.id, id)).returning();
    return rows[0] ?? null;
  }

  /**
   * 解绑已激活群时恢复候选：保留群名，最近活跃 = 原 activated_at；已有候选按 last_seen_at 取较大值，
   * 防止旧绑定的恢复动作把刚收到的新消息时间回拨。
   */
  async restoreCandidate(
    input: { chatid: string; name: string | null; firstSeenAt: Date; lastSeenAt: Date },
    client: DbClient = this.database.db,
  ): Promise<WecomGroupCandidateRow> {
    const rows = await client
      .insert(wecomGroupCandidates)
      .values({ chatid: input.chatid, name: input.name, firstSeenAt: input.firstSeenAt, lastSeenAt: input.lastSeenAt })
      .onConflictDoUpdate({
        target: [wecomGroupCandidates.chatid],
        set: {
          name: input.name === null ? sql`${wecomGroupCandidates.name}` : input.name,
          lastSeenAt: sql`greatest(${wecomGroupCandidates.lastSeenAt}, ${input.lastSeenAt})`,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("wecom_group_candidates restore 未返回记录");
    }
    return row;
  }

  /**
   * 绑定 / 换绑（upsert 覆盖语义）：同项目重放幂等（同 chatid 时 activated_at 由服务层原样传回）；
   * chatid 撞其它项目唯一约束（uq_wecom_groups_chatid）→ 400 VALIDATION_FAILED（S8-1 草案：群绑定校验
   * 沿用 400 / 404，不新增错误码；专用码待 wmj 评审后如有需要再升格）。
   */
  async upsert(
    input: { projectId: string; chatid: string; name: string | null; activatedAt: Date | null },
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<WecomGroupRow> {
    try {
      const rows = await client
        .insert(wecomGroups)
        .values({
          projectId: input.projectId,
          chatid: input.chatid,
          name: input.name,
          activatedAt: input.activatedAt,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [wecomGroups.projectId],
          set: {
            chatid: input.chatid,
            name: input.name,
            activatedAt: input.activatedAt,
            updatedAt: at,
          },
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("wecom_groups upsert 未返回记录");
      }
      return row;
    } catch (error) {
      if (isUniqueViolation(error, "uq_wecom_groups_chatid")) {
        throw new AppError("VALIDATION_FAILED", "该群已被其它项目绑定（一个群只能绑一个项目；换绑请先解绑原项目）");
      }
      throw error;
    }
  }

  /** 解绑：返回被删行（未绑定返回 null —— 幂等语义由服务层落定）。 */
  async remove(projectId: string, client: DbClient = this.database.db): Promise<WecomGroupRow | null> {
    const rows = await client.delete(wecomGroups).where(eq(wecomGroups.projectId, projectId)).returning();
    return rows[0] ?? null;
  }
}