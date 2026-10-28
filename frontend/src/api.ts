/**
 * 后端接口调用封装（k6 起：会话由后端 /auth/* 承载）。
 * - 写请求自动回传 CSRF 同步 token：优先使用 /auth/me 缓存的 token，Cookie 可读时再兜底读 ll_csrf。
 * - 公网 WAF 可能把 ll_csrf 改写为 HttpOnly；收到 CSRF_FAILED 时刷新 /auth/me 并仅重试一次。
 * - 401 统一跳 SSO 登录，并带 returnTo 回跳当前页面。
 * 契约来源：shared/src/modules/identity.ts。
 */

import { trackLocalWrite } from "./liveSync";

const CSRF_COOKIE = "ll_csrf";
const CSRF_HEADER = "X-CSRF-Token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let rememberedCsrfToken: string | null = null;
let csrfTokenRefresh: Promise<string | null> | null = null;

/** 缓存 /auth/me 下发的 CSRF token；运行时兼容尚未带该字段的旧服务端。 */
export function rememberCsrfToken(token: unknown): void {
  if (typeof token === "string" && token !== "") {
    rememberedCsrfToken = token;
  }
}

export function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

function requestCsrfToken(): string | null {
  if (rememberedCsrfToken !== null) {
    return rememberedCsrfToken;
  }
  const cookieToken = readCookie(CSRF_COOKIE);
  if (cookieToken === null || cookieToken === "") {
    return null;
  }
  rememberedCsrfToken = cookieToken;
  return cookieToken;
}

async function fetchWithCsrfHeader(input: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    const token = requestCsrfToken();
    if (token !== null) {
      headers.set(CSRF_HEADER, token);
    }
  }
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}

/** fetch 封装：同源 Cookie + CSRF 头 + Accept: application/json；CSRF_FAILED 刷新 token 后仅重试一次。 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const response = await fetchWithCsrfHeader(input, init);
  if (SAFE_METHODS.has(method) || response.status !== 403) {
    return response;
  }
  const error = await toApiError(response.clone());
  if (error.code !== "CSRF_FAILED") {
    return response;
  }
  const token = await refreshCsrfToken();
  return token === null ? response : fetchWithCsrfHeader(input, init);
}

/** 跳 SSO 登录（带 returnTo，登录后回到当前页面）。 */
export function redirectToLogin(): void {
  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  window.location.replace("/auth/login?returnTo=" + encodeURIComponent(returnTo));
}


/** 业务接口统一错误信封（服务端 ApiErrorFilter 输出：{ code, message, details, traceId }）。 */
/** meta = 机器可读的补充字段（契约 shared/src/common/errors.ts 的 ErrorDetail.meta）——
 *  例：429 `RATE_LIMITED` 给 `meta.retryAt`（可重试时刻 · ISO）+ `meta.window`（限流窗口），
 *  页面据此置灰按钮 + 倒计时（《前端功能需求》§3.7 / §3.10）。 */
export type ApiErrorDetail = { code: string; message: string; path?: string; meta?: Record<string, unknown> };

/** 业务接口错误：页面按 code 分支（409 PROJECT_CODE_EXISTS / VERSION_CONFLICT …），details 给字段级提示。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  readonly traceId: string | null;

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = [], traceId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.traceId = traceId;
  }

  /** 字段级错误的落点（details[0].path，如 code / managerIds）；无字段级错误返回 null。 */
  fieldPath(): string | null {
    const first = this.details[0];
    return first === undefined || first.path === undefined ? null : first.path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 解析错误信封；非 JSON / 形状不符时按 INTERNAL 兜底（前端只做提示，不改变状态）。 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = response.status === 401 ? "AUTH_REQUIRED" : "INTERNAL";
  let message = "请求失败（HTTP " + String(response.status) + "）";
  let details: ApiErrorDetail[] = [];
  let traceId: string | null = null;
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload)) {
      if (typeof payload.code === "string") {
        code = payload.code;
      }
      if (typeof payload.message === "string" && payload.message !== "") {
        message = payload.message;
      }
      if (Array.isArray(payload.details)) {
        details = payload.details.filter(isRecord).map((item) => ({
          code: typeof item.code === "string" ? item.code : "VALIDATION_FAILED",
          message: typeof item.message === "string" ? item.message : "",
          path: typeof item.path === "string" ? item.path : undefined,
          meta: isRecord(item.meta) ? item.meta : undefined,
        }));
      }
      if (typeof payload.traceId === "string") {
        traceId = payload.traceId;
      }
    }
  } catch {
    // 非 JSON 响应（网关 / 代理错误页）：保留上面的兜底文案
  }
  return new ApiError(response.status, code, message, details, traceId);
}

/** 重新从 /auth/me 取得当前会话的 CSRF token；并发失败请求共享同一次刷新。 */
async function refreshCsrfToken(): Promise<string | null> {
  if (csrfTokenRefresh !== null) {
    return csrfTokenRefresh;
  }
  const refresh = (async (): Promise<string | null> => {
    try {
      const response = await fetch("/auth/me", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        rememberedCsrfToken = null;
        redirectToLogin();
        return null;
      }
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      const token = isRecord(payload) && typeof payload.csrfToken === "string" && payload.csrfToken !== "" ? payload.csrfToken : null;
      if (token !== null) {
        rememberedCsrfToken = token;
      }
      return token;
    } catch {
      return null;
    }
  })().finally(() => {
    csrfTokenRefresh = null;
  });
  csrfTokenRefresh = refresh;
  return refresh;
}

/** 解析 Content-Disposition：优先 RFC 5987 的 filename*，其次普通 filename。 */
export function fileNameFromContentDisposition(value: string | null): string | null {
  if (value === null || value === "") return null;
  const encoded = /filename\*\s*=\s*UTF-8\u0027\u0027([^;]+)/i.exec(value);
  if (encoded !== null && encoded[1] !== undefined) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(value);
  if (quoted !== null && quoted[1] !== undefined) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(value);
  return plain === null || plain[1] === undefined ? null : plain[1].trim();
}

/** 二进制下载（xlsx 等）：与 apiRequest 共享 401 / 错误信封口径，但不把响应体当 JSON。 */
export async function apiDownload(path: string, init: RequestInit = {}): Promise<{ blob: Blob; fileName: string | null }> {
  const response = await apiFetch(path, init);
  if (response.status === 401) {
    redirectToLogin();
    throw await toApiError(response);
  }
  if (!response.ok) throw await toApiError(response);
  const blob = await response.blob();
  return { blob, fileName: fileNameFromContentDisposition(response.headers.get("Content-Disposition")) };
}

/**
 * 业务接口请求（/api/v1/**）：同源 Cookie + 写请求自动带 CSRF 头（apiFetch）+ 统一错误信封。
 * - 2xx：返回 JSON（204 返回 undefined）
 * - 401：跳 SSO 登录（returnTo = 当前页）并抛错
 * - 其它非 2xx：抛 ApiError（status / code / details 供页面分支）
 */
async function performRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const finishWrite = SAFE_METHODS.has((init.method ?? "GET").toUpperCase()) ? null : trackLocalWrite();
  try {
    const response = await apiFetch(path, init);
    if (response.status === 401) {
      redirectToLogin();
      throw await toApiError(response);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } finally {
    finishWrite?.();
  }
}

// Shared reads are deduplicated; project fan-out cannot occupy an unbounded number of connections.
const reads = new Map<string, Promise<unknown>>();
const waiting: Array<() => void> = [];
let activeReads = 0;
async function boundedRead<T>(path: string, init: RequestInit): Promise<T> {
  if (activeReads >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
  else activeReads += 1;
  try { return await performRequest<T>(path, init); }
  finally {
    const next = waiting.shift();
    if (next === undefined) activeReads -= 1;
    else next();
  }
}
export function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!SAFE_METHODS.has((init.method ?? "GET").toUpperCase())) {
    // Reads begun before a write must not be reused by its subsequent reconciliation.
    reads.clear();
    return performRequest<T>(path, init).finally(() => { reads.clear(); });
  }
  if (init.signal !== undefined || init.headers !== undefined || init.method !== undefined) return boundedRead<T>(path, init);
  const current = reads.get(path);
  if (current !== undefined) return current as Promise<T>;
  const request = boundedRead<T>(path, init).finally(() => { if (reads.get(path) === request) reads.delete(path); });
  reads.set(path, request);
  return request;
}

/** 写请求（JSON body；CSRF 头由 apiFetch 补齐）。 */
export function apiSend<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (signal !== undefined) {
    init.signal = signal;
  }
  return apiRequest<T>(path, init);
}

/** Existing list APIs share page/limit; never silently treat their first page as the whole collection. */
export async function readAllPages<T>(path: string): Promise<{ items: T[]; total: number; page: number; limit: number }> {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= 100; page += 1) {
    const result = await apiRequest<{ items: T[]; total?: number }>(path + (path.includes("?") ? "&" : "?") + "page=" + String(page) + "&limit=200");
    items.push(...result.items);
    total = result.total ?? items.length;
    if (result.items.length === 0 || items.length >= total) return { items, total, page: 1, limit: Math.max(200, items.length) };
  }
  throw new ApiError(413, "LIST_TOO_LARGE", "列表超出本次读取范围，请缩小筛选后重试");
}
