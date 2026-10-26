/**
 * Casdoor 群组键归一化（2026-10-23）：令牌 groups / 管理 API group.name 统一成 owner/name。
 * 返回值是权限键，不能用中文 displayName 替代；显示名由 casdoorGroupName 单独抽。
 */
export function casdoorGroupKey(owner: string | null, name: string): string {
  const trimmedName = trimSlashes(name);
  if (trimmedName === "") return "";
  if (trimmedName.includes("/")) return trimmedName;
  const trimmedOwner = trimSlashes(owner ?? "");
  return trimmedOwner === "" ? trimmedName : trimmedOwner + "/" + trimmedName;
}

/** 群组键对应的展示名：保留第一个斜杠之后的完整路径，兼容嵌套群组。 */
export function casdoorGroupName(groupKey: string): string {
  const normalized = trimSlashes(groupKey);
  const slash = normalized.indexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/**
 * 读取令牌 groups 声明：缺失返回 null（登录路径据此不清空已同步关系），
 * 空数组返回 []（目录明确表示无群组），非法条目跳过。
 */
export function readCasdoorGroupKeys(raw: unknown, owner: string | null): string[] | null {
  if (raw === undefined || raw === null) return null;
  const items = Array.isArray(raw) ? raw : [raw];
  const keys: string[] = [];
  for (const item of items) {
    let key = "";
    if (typeof item === "string") {
      key = casdoorGroupKey(owner, item);
    } else if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      const name = firstString(record.name, record.displayName);
      if (name !== null) key = casdoorGroupKey(firstString(record.owner) ?? owner, name);
    }
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end).trim();
}
