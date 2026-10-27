/**
 * 审计路径解析（common 层，供全局异常过滤器使用；纯函数、无模块依赖）。
 * 越权 / 未命中留痕（C7-03）：从 URL 推出「对象类型 + 对象 id」，用于按对象检索。
 */

/** 路径段 → 审计对象类型（取最具体的一段：/projects/{id}/tasks/{tid} → task）。 */
/** 路径段解码（路由参数是百分号编码；审计对象 id 要与写入侧解码后的业务键一致）。 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const OBJECT_TYPE_BY_SEGMENT: Record<string, string> = {
  projects: "project",
  tasks: "task",
  reports: "daily_report",
  issues: "issue",
  nodes: "node",
  members: "project_member",
  stages: "stage",
  dicts: "dict_item",
  items: "dict_item",
  blueprint: "blueprint",
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DICT_STRUCTURAL_SEGMENTS = new Set(["dicts", "items"]);

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const PROJECT_SCOPED_HINTS = ["/projects/", "/nodes/", "/blueprint"];

/**
 * URL → 审计对象引用：只认 /api/v1 下的已知资源段；返回 null 表示该路由不记（如 /auth/*）。
 * objectId 取路径里最靠后的 uuid，缺省取最靠后的路径段（如 /dicts/region）；字典例外：与写入侧同形，取 type[:code]（路径段先解码）；
 * 工作日历例外：calendar_day 取业务日期、calendar_settings 取 default（与写入侧同形，h8）。
 */
export function objectRefOfUrl(url: string): { objectType: string; objectId: string } | null {
  const pathname = url.split("?")[0] ?? url;
  const segments = pathname.split("/").filter((segment) => segment.length > 0).map(safeDecode);
  if (segments[0] !== "api" || segments[1] !== "v1") return null;
  const rest = segments.slice(2);
  // 工作日历（h8）：对象 id 与写入侧同形 —— calendar_day 取业务日期（/calendar/days/{date}），
  // 顺延配置固定 default（/calendar/settings，单行配置）。
  if (rest[0] === "calendar") {
    if (rest[1] === "settings") return { objectType: "calendar_settings", objectId: "default" };
    if (rest[1] === "days" && rest[2] !== undefined) return { objectType: "calendar_day", objectId: rest[2] };
    return null;
  }
  let objectType: string | null = null;
  for (const segment of rest) {
    const mapped = OBJECT_TYPE_BY_SEGMENT[segment];
    if (mapped !== undefined) objectType = mapped;
  }
  if (objectType === null) return null;
  if (objectType === "dict_item") {
    // 字典：对象 id 与写入侧同形 —— type[:code]（items 是结构段，不参与）。
    const index = rest.indexOf("dicts");
    const tail = rest.slice(index + 1).filter((segment) => !DICT_STRUCTURAL_SEGMENTS.has(segment));
    if (tail.length > 0) return { objectType, objectId: tail.join(":") };
  }
  const uuids = rest.filter((segment) => UUID_PATTERN.test(segment));
  const objectId = uuids.length > 0 ? uuids[uuids.length - 1] : rest[rest.length - 1];
  if (objectId === undefined) return null;
  return { objectType, objectId };
}

/** 越权 / 未命中留痕判定：403 功能权限拒绝记录；CSRF 凭证失配不冒充越权；404 只记写请求与项目域路径，避免普通 404 噪声。 */
export function shouldRecordDenied(method: string, url: string, errorCode: string): boolean {
  if (errorCode === "CSRF_FAILED") return false;
  if (errorCode === "FORBIDDEN") return true;
  if (errorCode !== "NOT_FOUND") return false;
  if (WRITE_METHODS.has(method.toUpperCase())) return true;
  return PROJECT_SCOPED_HINTS.some((hint) => url.includes(hint));
}

/** objectId 是否 uuid（越权留痕判定 projectId 用）。 */
export function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}
