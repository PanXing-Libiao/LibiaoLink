import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import { userGroupMemberships } from "../../db/schema/access.js";
import { casdoorGroupName } from "./casdoor-groups.js";

export interface ObservedUserGroup {
  groupKey: string;
  groupName: string;
  memberCount: number;
}

/** 用户 ↔ Casdoor 群组关系：登录 / 目录同步写，权限判定只读。 */
@Injectable()
export class UserGroupRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 整体替换一个用户的群组关系（空数组 = 清空；同一事务内删除 + 写入）。 */
  async replaceForUser(userId: string, groupKeys: readonly string[], at: Date): Promise<void> {
    const unique = Array.from(new Set(groupKeys.filter((key) => key.trim() !== "")));
    await this.database.db.transaction(async (tx) => {
      await tx.delete(userGroupMemberships).where(eq(userGroupMemberships.userId, userId));
      if (unique.length === 0) return;
      await tx.insert(userGroupMemberships).values(
        unique.map((groupKey) => ({
          userId,
          groupKey,
          groupName: casdoorGroupName(groupKey) || groupKey,
          syncedAt: at,
        })),
      );
    });
  }

  async listKeys(userId: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ groupKey: userGroupMemberships.groupKey })
      .from(userGroupMemberships)
      .where(eq(userGroupMemberships.userId, userId));
    return rows.map((row) => row.groupKey);
  }

  /** 权限管理页可选项：当前目录已观察到的群组 + 人数（同组多行取最新展示名）。 */
  async listObserved(): Promise<ObservedUserGroup[]> {
    const rows = await this.database.db
      .select({
        groupKey: userGroupMemberships.groupKey,
        groupName: userGroupMemberships.groupName,
        userId: userGroupMemberships.userId,
      })
      .from(userGroupMemberships);
    const byKey = new Map<string, { groupName: string; users: Set<string> }>();
    for (const row of rows) {
      const entry = byKey.get(row.groupKey) ?? { groupName: row.groupName, users: new Set<string>() };
      entry.users.add(row.userId);
      byKey.set(row.groupKey, entry);
    }
    return Array.from(byKey.entries())
      .map(([groupKey, entry]) => ({ groupKey, groupName: entry.groupName, memberCount: entry.users.size }))
      .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  }
}
