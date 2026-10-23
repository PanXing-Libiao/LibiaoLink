import { AppError } from "../../common/errors/app-error.js";
import { readCasdoorGroupKeys } from "./casdoor-groups.js";
import type { OrgDepartmentRecord, OrgDirectorySnapshot, OrgUserRecord } from "./org-sync.service.js";

/**
 * Casdoor 目录拉取适配器（h1 · D1-02）：管理 API → OrgDirectorySnapshot，喂给 OrgSyncService。
 * 定时调度（worker 周期拉取）随 i5 接线；本类保持「一次拉取 = 一个快照」的纯拉取语义，可被内部端点 / worker 复用。
 * 字段映射按 Casdoor 模型（user: id / name / displayName / email / isForbidden / isDeleted；
 * group: name / displayName / parentId / isTopGroup / isDeleted）；正式环境字段核对随 g7。
 */

/** 用户分页大小：与 Casdoor 管理 API 的 p / pageSize 口径一致。 */
export const CASDOOR_USER_PAGE_SIZE = 100;
const MAX_USER_PAGES = 200;

export interface CasdoorDirectorySettings {
  issuer: string;
  owner: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 归一化：目录用户 → 同步记录；缺 id / name 的脏行返回 null（调用方跳过）。 */
export function normalizeCasdoorUser(raw: unknown, owner: string | null = null): OrgUserRecord | null {
  if (!isRecord(raw)) return null;
  const casdoorId = firstString(raw.id);
  const username = firstString(raw.name);
  if (casdoorId === null || username === null) return null;
  const isForbidden = raw.isForbidden === true;
  const isDeleted = raw.isDeleted === true;
  const claimOwner = firstString(raw.owner) ?? owner;
  return {
    casdoorId,
    username,
    displayName: firstString(raw.displayName) ?? username,
    email: firstString(raw.email),
    status: isForbidden || isDeleted ? "disabled" : "active",
    groups: readCasdoorGroupKeys(raw.groups, claimOwner) ?? undefined,
  };
}

/** 归一化：目录群组 → 部门记录（sourceId = group name，组织同步只面对单一 owner）；isDeleted 组跳过（走缺失停用）。 */
export function normalizeCasdoorGroup(raw: unknown): OrgDepartmentRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.isDeleted === true) return null;
  const sourceId = firstString(raw.name);
  if (sourceId === null) return null;
  const parentSourceId = raw.isTopGroup === true ? null : firstString(raw.parentId);
  return {
    sourceId,
    name: firstString(raw.displayName) ?? sourceId,
    parentSourceId,
    status: "active",
  };
}

export class CasdoorDirectorySource {
  constructor(private readonly settings: CasdoorDirectorySettings) {}

  async pull(): Promise<OrgDirectorySnapshot> {
    if (this.settings.owner === "" || this.settings.clientId === "" || this.settings.clientSecret === "") {
      throw new AppError("INTERNAL", "Casdoor 目录未配置（CASDOOR_ORG_NAME / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET）");
    }
    const users = await this.pullUsers();
    const departments = await this.pullGroups();
    return { pulledAt: new Date(), departments, users };
  }

  /** 用户全量分页拉取：p / pageSize 翻页；服务端忽略分页（返回重复页）时以去重保护停页。 */
  private async pullUsers(): Promise<OrgUserRecord[]> {
    const collected: OrgUserRecord[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
      const payload = await this.fetchJson("/api/get-users", {
        owner: this.settings.owner,
        p: String(page),
        pageSize: String(CASDOOR_USER_PAGE_SIZE),
      });
      const items = parseListPayload(payload, "get-users");
      let added = 0;
      for (const item of items) {
        const record = normalizeCasdoorUser(item, this.settings.owner);
        if (record === null || seen.has(record.casdoorId)) continue;
        seen.add(record.casdoorId);
        collected.push(record);
        added += 1;
      }
      if (items.length < CASDOOR_USER_PAGE_SIZE || added === 0) return collected;
    }
    throw new AppError("INTERNAL", "Casdoor get-users 分页超过上限 " + String(MAX_USER_PAGES) + " 页，疑似分页参数无效");
  }

  private async pullGroups(): Promise<OrgDepartmentRecord[]> {
    const payload = await this.fetchJson("/api/get-groups", { owner: this.settings.owner });
    const items = parseListPayload(payload, "get-groups");
    const seen = new Set<string>();
    const records: OrgDepartmentRecord[] = [];
    for (const item of items) {
      const record = normalizeCasdoorGroup(item);
      if (record === null || seen.has(record.sourceId)) continue;
      seen.add(record.sourceId);
      records.push(record);
    }
    return records;
  }

  private async fetchJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.settings.issuer);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("clientId", this.settings.clientId);
    url.searchParams.set("clientSecret", this.settings.clientSecret);
    const fetchImpl = this.settings.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.settings.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new AppError("INTERNAL", "Casdoor 目录拉取失败（" + path + "）：" + describeError(error));
    }
    if (!response.ok) {
      throw new AppError("INTERNAL", "Casdoor 目录返回 HTTP " + String(response.status) + "（" + path + "）");
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AppError("INTERNAL", "Casdoor 目录响应不是 JSON（" + path + "）");
    }
  }
}

/** Casdoor 统一响应信封：status = ok 且 data 为数组；其余一律视为拉取失败（不静默）。 */
function parseListPayload(payload: unknown, what: string): unknown[] {
  if (!isRecord(payload)) {
    throw new AppError("INTERNAL", "Casdoor " + what + " 响应结构异常");
  }
  if (payload.status !== "ok") {
    const message = typeof payload.msg === "string" && payload.msg !== "" ? "：" + payload.msg : "";
    throw new AppError("INTERNAL", "Casdoor " + what + " 返回 status=" + String(payload.status ?? "(缺失)") + message);
  }
  if (!Array.isArray(payload.data)) {
    throw new AppError("INTERNAL", "Casdoor " + what + " 响应缺少 data 数组");
  }
  return payload.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
