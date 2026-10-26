import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";

export type UserRow = typeof users.$inferSelect;

/** 组织同步的目录记录（企微 / Casdoor 归一化后）：status 以目录为准。 */
export interface DirectoryUserProfile {
  casdoorId: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
  /** 目录快照中的群组键（可选；缺省 = 本次不更新群组关系）。 */
  groups?: string[];
}

export interface SsoProfile {
  casdoorId: string;
  username: string;
  displayName: string;
  email: string | null;
  owner: string | null;
  /** 令牌 groups 声明归一化结果；null = 令牌未下发该声明，不清空已同步关系。 */
  groups: string[] | null;
}

/** users 数据访问（SSO 为准；登录时按键 casdoor_id upsert）。 */
@Injectable()
export class UserRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsert(profile: SsoProfile): Promise<UserRow> {
    const rows = await this.database.db
      .insert(users)
      .values({
        casdoorId: profile.casdoorId,
        username: profile.username,
        displayName: profile.displayName,
        email: profile.email,
        owner: profile.owner,
      })
      .onConflictDoUpdate({
        target: users.casdoorId,
        set: {
          username: profile.username,
          displayName: profile.displayName,
          email: profile.email,
          owner: profile.owner,
          updatedAt: new Date(),
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("users upsert 未返回记录");
    }
    return row;
  }

  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.database.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByCasdoorId(casdoorId: string): Promise<UserRow | null> {
    const rows = await this.database.db.select().from(users).where(eq(users.casdoorId, casdoorId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * 组织同步 upsert（h1）：与登录 upsert 的差别只有一点 —— status 以目录为准（离职禁用 / 复职启用）。
   * 登录路径不重置 status，避免「被禁用后用旧 token 登录」把禁用状态冲掉。
   */
  async upsertFromDirectory(profile: DirectoryUserProfile, at: Date): Promise<UserRow> {
    const rows = await this.database.db
      .insert(users)
      .values({
        casdoorId: profile.casdoorId,
        username: profile.username,
        displayName: profile.displayName,
        email: profile.email,
        status: profile.status,
      })
      .onConflictDoUpdate({
        target: users.casdoorId,
        set: {
          username: profile.username,
          displayName: profile.displayName,
          email: profile.email,
          status: profile.status,
          updatedAt: at,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("users upsertFromDirectory 未返回记录");
    }
    return row;
  }

  async listAll(): Promise<UserRow[]> {
    return this.database.db.select().from(users).orderBy(users.casdoorId);
  }

  async updateStatus(id: string, status: "active" | "disabled", at: Date, client: DbClient = this.database.db): Promise<void> {
    await client.update(users).set({ status, updatedAt: at }).where(eq(users.id, id));
  }

  /** 内部离职回收（h1）：按目标态更新 status / removed_at（removedAt 未提供 = 不改动该列）。 */
  async updateInternalState(
    id: string,
    next: { status: "active" | "disabled"; removedAt?: Date | null },
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<void> {
    const patch: { status: "active" | "disabled"; updatedAt: Date; removedAt?: Date | null } = {
      status: next.status,
      updatedAt: at,
    };
    if (Object.prototype.hasOwnProperty.call(next, "removedAt")) {
      patch.removedAt = next.removedAt ?? null;
    }
    await client.update(users).set(patch).where(eq(users.id, id));
  }

  /** 内部离职回收：按工号定位（name 为准）。 */
  async findByUsername(username: string): Promise<UserRow | null> {
    const rows = await this.database.db.select().from(users).where(eq(users.username, username)).limit(1);
    return rows[0] ?? null;
  }

  /** 内部离职回收：邮箱兜底（大小写不敏感；命中多行时取工号升序首行）。 */
  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.database.db
      .select()
      .from(users)
      .where(sqlLowerEmail(email))
      .orderBy(asc(users.username))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 用户目录（A2 · M1）：只返回启用用户；q 匹配工号 / 姓名 / 邮箱；默认工号升序（分页稳定）。 */
  async listDirectory(options: { q: string | null; limit: number; offset: number }): Promise<{ rows: UserRow[]; total: number }> {
    const pattern = options.q === null ? null : "%" + options.q + "%";
    const where =
      pattern === null
        ? eq(users.status, "active")
        : and(
            eq(users.status, "active"),
            or(ilike(users.username, pattern), ilike(users.displayName, pattern), ilike(users.email, pattern)),
          );
    const rows = await this.database.db
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(users.username))
      .limit(options.limit)
      .offset(options.offset);
    const totals = await this.database.db.select({ value: count() }).from(users).where(where);
    return { rows, total: Number(totals[0]?.value ?? 0) };
  }
}

/** 邮箱兜底匹配：lower(email) = lower(入参)（email 可空，null 行自然不命中）。 */
function sqlLowerEmail(email: string) {
  return sql`lower(${users.email}) = lower(${email})`;
}

