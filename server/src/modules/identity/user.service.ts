import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { readCasdoorGroupKeys } from "./casdoor-groups.js";
import { UserGroupRepository } from "./user-group.repository.js";
import { UserRepository, type SsoProfile, type UserRow } from "./user.repository.js";

/** claims → users 的归一化口径（ADR-010：JWT-Custom 的 name=工号、displayName=姓名）。 */
export function normalizeSsoProfile(claims: Record<string, unknown>): SsoProfile {
  const casdoorId = firstString(claims.id, claims.sub);
  if (casdoorId === null) {
    throw new AppError("AUTH_CALLBACK_FAILED", "ID Token 缺少用户标识（id）");
  }
  const username = firstString(claims.name) ?? casdoorId;
  const displayName = firstString(claims.displayName) ?? username;
  const owner = firstString(claims.owner);
  return {
    casdoorId,
    username,
    displayName,
    email: firstString(claims.email),
    owner,
    groups: readCasdoorGroupKeys(claims.groups, owner),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}


/** 用户目录项（A2 · M1 契约：shared/src/modules/users.ts 的 UserSummary 形状）。 */
export interface UserDirectoryItem {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: "active" | "disabled";
}

export interface UserDirectoryPage {
  items: UserDirectoryItem[];
  page: number;
  limit: number;
  total: number;
}

/** 用户用例：登录 upsert（不重新启用已禁用账号）+ 对外 getUser 与用户目录（h1）。 */
@Injectable()
export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly groups?: UserGroupRepository,
  ) {}

  async upsertFromClaims(claims: Record<string, unknown>): Promise<UserRow> {
    const profile = normalizeSsoProfile(claims);
    const row = await this.users.upsert(profile);
    if (this.groups !== undefined && profile.groups !== null) {
      await this.groups.replaceForUser(row.id, profile.groups, new Date());
    }
    return row;
  }

  async getUser(userId: string): Promise<UserRow> {
    const row = await this.users.findById(userId);
    if (row === null) {
      throw new AppError("NOT_FOUND", "用户不存在");
    }
    return row;
  }

  /** 用户目录（A2 · M1）：只返回启用用户；q 命中工号 / 姓名 / 邮箱；默认工号升序（分页不跳行）。 */
  async listUsers(query: { q?: string | undefined; page: number; limit: number }): Promise<UserDirectoryPage> {
    const keyword = query.q?.trim() ?? "";
    const { rows, total } = await this.users.listDirectory({
      q: keyword === "" ? null : keyword,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        email: row.email,
        status: row.status === "active" ? "active" : "disabled",
      })),
      page: query.page,
      limit: query.limit,
      total,
    };
  }
}
