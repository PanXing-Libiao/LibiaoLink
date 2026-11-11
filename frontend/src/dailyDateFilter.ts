const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}

/** 严格校验 YYYY-MM-DD，并确认年月日真实存在（例如拒绝 2026-02-31）。 */
export function isDailyDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 读取项目深链的 `date` 参数；重复键认第一个，非法值返回 null。 */
export function parseDailyDateParam(search: string): string | null {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "date") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    return isDailyDate(value) ? value : null;
  }
  return null;
}

/** 日报 / 问题是否命中日期筛选；null = 不筛选。 */
export function matchesDailyDate(rowDate: string, dateFilter: string | null): boolean {
  return dateFilter === null || rowDate === dateFilter;
}

/** 从 hash 中移除全部 `date` 参数，保留路径 / 其它参数与顺序。 */
export function removeDailyDateParam(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const separator = raw.indexOf("?");
  if (separator === -1) {
    return hash;
  }
  const path = raw.slice(0, separator);
  const query = raw.slice(separator + 1);
  const kept: string[] = [];
  let removed = false;
  for (const chunk of query.split("&")) {
    if (chunk === "") {
      continue;
    }
    const equals = chunk.indexOf("=");
    const key = safeDecode(equals === -1 ? chunk : chunk.slice(0, equals));
    if (key === "date") {
      removed = true;
      continue;
    }
    kept.push(chunk);
  }
  if (!removed) {
    return hash;
  }
  return "#" + path + (kept.length === 0 ? "" : "?" + kept.join("&"));
}
