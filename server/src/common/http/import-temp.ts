import { readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors/app-error.js";

/** 导入相关临时目录的统一前缀；崩溃残留由启动清扫按该前缀识别。 */
export const IMPORT_TEMP_PREFIX = "libiaolink-import-";

/** 除本次上传本身外预留的磁盘余量，避免刚好写满系统临时盘。 */
const TEMP_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/** 超过该时长的同前缀目录视为崩溃残留；正常单次导入远低于此值。 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function temporaryStorageError(): AppError {
  return new AppError("INTERNAL", "服务器临时存储空间不足，请稍后重试");
}

/** Node / 文件系统可能把 ENOSPC 包在 cause 里；逐层识别写盘满额。 */
export function isNoSpaceError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "ENOSPC" || code === "EDQUOT") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 当前临时目录所在文件系统的可用字节；无法探测时返回 null，由实际写入错误兜底。 */
export function availableTempBytes(root: string = tmpdir()): number | null {
  try {
    const stats = statfsSync(root);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
}

/** 在接收大请求 / 下载对象前预检，避免先耗完网络或对象存储流量后才因磁盘满失败。 */
export function assertTemporarySpace(
  requiredBytes: number,
  availableBytes: number | null = availableTempBytes(),
): void {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
    throw new AppError("INTERNAL", "临时存储空间预算非法");
  }
  if (availableBytes !== null && availableBytes < requiredBytes + TEMP_FREE_SPACE_MARGIN_BYTES) {
    throw temporaryStorageError();
  }
}

/** 创建 0700 导入临时目录；requiredBytes 用于落盘前预检。 */
export async function createImportTempDirectory(requiredBytes: number): Promise<string> {
  assertTemporarySpace(requiredBytes);
  try {
    return await mkdtemp(join(tmpdir(), IMPORT_TEMP_PREFIX));
  } catch (error) {
    if (isNoSpaceError(error)) throw temporaryStorageError();
    throw new AppError("INTERNAL", "无法创建导入临时目录，请检查临时存储配置");
  }
}

export interface StaleTempCleanupResult {
  removed: number;
  failed: number;
}

/** 启动时清扫本进程前缀下的崩溃残留；按 mtime 保龄，不会碰活跃请求目录。 */
export function cleanupStaleImportTempDirs(options: {
  root?: string;
  now?: number;
  maxAgeMs?: number;
} = {}): StaleTempCleanupResult {
  const root = options.root ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STALE_AFTER_MS;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed: 0, failed: 1 };
  }
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(IMPORT_TEMP_PREFIX)) continue;
    const path = join(root, entry.name);
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
