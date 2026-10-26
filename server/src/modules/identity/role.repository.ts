import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import { roles, userRoles } from "../../db/schema/identity.js";

export type RoleRow = typeof roles.$inferSelect;

/** 历史角色数据维护（roles / user_roles）；不再提供授权画像读取。 */
@Injectable()
export class RoleRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<RoleRow[]> {
    return this.database.db.select().from(roles).orderBy(asc(roles.code));
  }

  async findByCode(code: string): Promise<RoleRow | null> {
    const rows = await this.database.db.select().from(roles).where(eq(roles.code, code)).limit(1);
    return rows[0] ?? null;
  }

  /** 绑定用户与角色（重复调用幂等）。 */
  async assign(userId: string, roleId: string): Promise<void> {
    await this.database.db.insert(userRoles).values({ userId, roleId }).onConflictDoNothing();
  }

  async revoke(userId: string, roleId: string): Promise<boolean> {
    const rows = await this.database.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
      .returning({ roleId: userRoles.roleId });
    return rows.length > 0;
  }
}
