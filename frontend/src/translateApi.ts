/** 导出报告英文译文通道 —— 业务口径 2026-10-10（「项目进展描述……需要翻译」；方案与实测见 前端功能需求.md §6.16 ⑭/⑮/⑯）。
 *
 * 契约：POST /api/v1/translate（Push 301 起由服务端实现，前端不再直连引擎）
 *   入参 { q: string, source: "zh", target: "en", format: "text" }
 *   出参 { translatedText: string }
 * 服务端口径（Push 301 · 2026-10-13 业务口径「保存的时候后台自动翻译 并且写入数据库 下次切换翻译的时候直接调用即可」）：
 *   库优先（content_translations，键 = sha256(原文)）→ 未命中调内网引擎（HY-MT1.5-1.8B，env TRANSLATE_ORIGIN）→
 *   回包落库；术语保护 / 回换 / 规整在服务端做（server/src/modules/translate/translate.text.ts），本端 q 一律**原文**。
 *   批量直取：POST /api/v1/translate/batch（只读查库）—— 英文界面切页一次请求拿整页已存译文。
 * （旧口径：开发环境 Vite 直连 127.0.0.1:5008 翻译引擎 + 前端做术语占位符保护；Push 301 起两条都移除 ——
 *  避免「同一原文两种键互相命中不了」与保存链路预热漏保护。）
 *
 * 容错（重要）：本模块**从不抛错** —— 任何一条拿不到译文就跳过（返回表里没有该条），
 * 调用方（导出流程）保持中文原文照出：通道不可用不影响导出的可用性。
 *
 * 三级取词：L1 会话缓存 → L2 服务端译文库（batch 直取）→ L3 单条 /translate（服务端库命中即出、未命中引擎 + 落库）。
 * 保存链路（task / project 控制器）已把新写入的手打中文后台翻好入库，切换语言 / 导出绝大多数条目在 L1 / L2 就绪。
 */

import { apiFetch } from "./api";

/** 服务端译文库批量查库上限（契约 TRANSLATE_BATCH_MAX = 400）。 */
const BATCH_MAX = 400;

/** 中文痕迹（含 CJK 基本区才值得翻 / 查库）：纯英文 / 数字文本不进通道（与保存链路预热同口径）。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/;

/** 并发上限：单条服务 + 导出场景（去重后个位数）小并发即可，同时防批量导入时打满请求。 */
const MAX_CONCURRENCY = 4;

/** 会话级译文缓存上限（Map 插入序淘汰最老一条）：防长会话里无限攒；进展描述一般几十条量级，600 条足够宽松。 */
const CACHE_LIMIT = 600;

/** 预热失败后的静默退避（毫秒）：通道不可用时，别让每次页面数据刷新都重打一遍失败请求；导出路径不受退避限制（用户正等着）。 */
const PREFETCH_RETRY_MS = 60000;

/** 会话级「原文 → 英文」缓存（同一 SPA 会话内跨页面共用）：写进展描述时预热、导出直接命中。 */
const translationCache = new Map<string, string>();

/** 译文缓存版本号（每条译文入缓存 +1）：语言切换「手打内容」显示用 —— 组件订阅它，译文到位即重渲染。 */
let translationRevision = 0;

/** 缓存变更订阅（同上）：返回退订函数。 */
const translationListeners = new Set<() => void>();

export function subscribeTranslations(listener: () => void): () => void {
  translationListeners.add(listener);
  return () => {
    translationListeners.delete(listener);
  };
}

export function getTranslationRevision(): number {
  return translationRevision;
}

function notifyTranslations(): void {
  translationRevision += 1;
  translationListeners.forEach((listener) => {
    listener();
  });
}

/** 在途请求（原文 → 同一个 Promise）：预热与导出同时要同一条时只打一次机器翻译。 */
const inFlight = new Map<string, Promise<string | null>>();

/** 预热失败时间（原文 → 时间戳）：退避窗口内不再为它发起预热。 */
const failedAt = new Map<string, number>();

/** 去重 + 去空（缓存键与请求体都用原文整串，与导出查表口径一致）。 */
function uniqueTexts(texts: readonly string[]): string[] {
  return Array.from(new Set(texts.filter((text) => text.trim() !== "")));
}

/** 写缓存（顺带清失败标记；超限时按插入序丢最老一条）。 */
function cachePut(source: string, translated: string): void {
  failedAt.delete(source);
  translationCache.delete(source);
  translationCache.set(source, translated);
  while (translationCache.size > CACHE_LIMIT) {
    const oldest = translationCache.keys().next();
    if (oldest.done) {
      break;
    }
    translationCache.delete(oldest.value);
  }
  notifyTranslations();
}

/** 单条翻译（POST /api/v1/translate，原文入参；服务端库优先 → 引擎 → 落库），失败返回 null（不抛错）。 */
async function translateOne(text: string): Promise<string | null> {
  try {
    const response = await apiFetch("/api/v1/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source: "zh", target: "en", format: "text" }),
    });
    if (!response.ok) {
      return null;
    }
    const data: unknown = await response.json();
    const translatedText =
      typeof data === "object" && data !== null ? (data as { translatedText?: unknown }).translatedText : undefined;
    if (typeof translatedText !== "string" || translatedText === "") {
      return null;
    }
    return translatedText;
  } catch {
    return null;
  }
}

/**
 * 服务端译文库批量直取（POST /api/v1/translate/batch · 只读查库）：一次请求（≤400 条）把已存译文写进会话缓存。
 * 返回「新写入缓存的条数」；失败 / 未命中静默（未命中条目由调用方继续走单条通道）。
 */
async function lookupStoredBatch(texts: readonly string[]): Promise<number> {
  const cjk = texts.filter((text) => CJK_PATTERN.test(text));
  let added = 0;
  for (let at = 0; at < cjk.length; at += BATCH_MAX) {
    const chunk = cjk.slice(at, at + BATCH_MAX);
    try {
      const response = await apiFetch("/api/v1/translate/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qs: chunk, source: "zh", target: "en" }),
      });
      if (!response.ok) {
        continue;
      }
      const data: unknown = await response.json();
      const items =
        typeof data === "object" && data !== null ? (data as { translations?: unknown }).translations : undefined;
      if (!Array.isArray(items)) {
        continue;
      }
      for (const item of items) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const q = (item as { q?: unknown }).q;
        const translatedText = (item as { translatedText?: unknown }).translatedText;
        if (typeof q !== "string" || typeof translatedText !== "string" || translatedText === "") {
          continue;
        }
        if (!translationCache.has(q)) {
          cachePut(q, translatedText);
          added += 1;
        }
      }
    } catch {
      // 服务端不可达 / 网关错误：静默跳过，未命中条目继续走单条通道
    }
  }
  return added;
}

/** 同一原文共用一次在途请求（预热与导出并发时只打一条机器翻译）；成功后写缓存、失败记退避时间。 */
function translateOneShared(text: string): Promise<string | null> {
  const existing = inFlight.get(text);
  if (existing !== undefined) {
    return existing;
  }
  const task = (async () => {
    try {
      const translated = await translateOne(text);
      if (translated === null) {
        failedAt.set(text, Date.now());
        return null;
      }
      cachePut(text, translated);
      return translated;
    } finally {
      inFlight.delete(text);
    }
  })();
  inFlight.set(text, task);
  return task;
}

/**
 * 后台预热（保存即翻译的读侧提速 · §6.16 ㉑ / ㉕）：把一批中文文本静默补进会话缓存 —— 不等待、不抛错。
 * ① 批量查服务端译文库（L2，一次请求）；② 未入库的再逐条 /translate（L3，服务端命中即出、未命中引擎 + 落库）。
 * 已缓存 / 在途 / 退避窗口内失败过的条目直接跳过（失败不弹提示；导出时仍按原行为现场重试、静默降级）。
 */
export function prefetchZhToEn(texts: readonly string[]): void {
  void prefetchZhToEnAsync(texts);
}

async function prefetchZhToEnAsync(texts: readonly string[]): Promise<void> {
  const now = Date.now();
  const queue = uniqueTexts(texts).filter(
    (text) => !translationCache.has(text) && !inFlight.has(text) && (failedAt.get(text) ?? 0) + PREFETCH_RETRY_MS <= now,
  );
  if (queue.length === 0) {
    return;
  }
  await lookupStoredBatch(queue);
  const missing = queue.filter((text) => !translationCache.has(text) && !inFlight.has(text) && CJK_PATTERN.test(text));
  if (missing.length === 0) {
    return;
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, missing.length) }, async () => {
      while (cursor < missing.length) {
        const at = cursor;
        cursor += 1;
        const text = missing[at];
        if (text === undefined) {
          return;
        }
        await translateOneShared(text);
      }
    }),
  );
}

/** 会话缓存直取（不打请求）：给「抽屉打开即显示译文」这类场景用；没命中返回 null（调用方再走 translateZhToEn）。 */
export function cachedZhToEn(text: string): string | null {
  return translationCache.get(text) ?? null;
}

/** 把一批中文文本翻成英文（L1 会话缓存 → L2 服务端译文库 → L3 单条现场翻：去重 + 限并发 + 逐条容错）；
 * 返回「原文 → 英文」映射（含命中缓存的条目），失败 / 拿不到译文的条目不在表里。
 * onProgress(done, total)：命中缓存 / 库直取的条目一开始即计入 done、未就绪的每完成一条回报一次（含失败条目）——
 * 导出等待浮层用它显示「项目进展描述翻译中 + 预计需要 XX 秒」（§6.16 ⑳，见 components/ExportProgressOverlay.tsx）。 */
export async function translateZhToEn(
  texts: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<ReadonlyMap<string, string>> {
  const unique = uniqueTexts(texts);
  const missing = unique.filter((text) => !translationCache.has(text));
  onProgress?.(unique.length - missing.length, unique.length);
  if (missing.length > 0) {
    await lookupStoredBatch(missing);
  }
  const stillMissing = unique.filter((text) => !translationCache.has(text));
  let done = unique.length - stillMissing.length;
  onProgress?.(done, unique.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, stillMissing.length) }, async () => {
    while (cursor < stillMissing.length) {
      const at = cursor;
      cursor += 1;
      const text = stillMissing[at];
      if (text === undefined) {
        return;
      }
      await translateOneShared(text);
      done += 1;
      onProgress?.(done, unique.length);
    }
  });
  await Promise.all(workers);
  const results = new Map<string, string>();
  for (const text of unique) {
    const hit = translationCache.get(text);
    if (hit !== undefined) {
      results.set(text, hit);
    }
  }
  return results;
}
