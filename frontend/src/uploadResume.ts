/**
 * 上传会话的本地续传索引（只存元数据，不存文件内容）。
 *
 * 浏览器刷新后无法保留原来的 File 句柄，但上传会话仍在服务端；用户重新选择同一内容时，
 * 用 SHA-256 + 项目 + 目标 + 名称找回会话，只补缺失分片。localStorage 不可用（隐私模式 /
 * 配额 / 被策略禁用）时静默降级为本次页面内不续传，不影响正常上传。
 */

const STORAGE_KEY = "libiaolink.upload-resume.v1";
const MAX_RECORDS = 24;
const EXPIRY_MARGIN_MS = 30_000;

export type UploadResumeRecord = {
  version: 1;
  projectId: string;
  fileId: string;
  uploadId: string;
  contentHash: string;
  fileName: string;
  sizeBytes: number;
  taskId: string | null;
  partSizeBytes: number;
  totalParts: number;
  expiresAt: string;
};

type ResumeQuery = {
  projectId: string;
  contentHash: string;
  fileName: string;
  sizeBytes: number;
  taskId: string | null;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function loadAll(): UploadResumeRecord[] {
  const target = storage();
  if (target === null) return [];
  try {
    const raw = target.getItem(STORAGE_KEY);
    if (raw === null || raw === "") return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is UploadResumeRecord => {
      if (typeof item !== "object" || item === null) return false;
      const row = item as Record<string, unknown>;
      return (
        row.version === 1 &&
        typeof row.projectId === "string" &&
        typeof row.fileId === "string" &&
        typeof row.uploadId === "string" &&
        typeof row.contentHash === "string" &&
        typeof row.fileName === "string" &&
        typeof row.sizeBytes === "number" &&
        (typeof row.taskId === "string" || row.taskId === null) &&
        typeof row.partSizeBytes === "number" &&
        typeof row.totalParts === "number" &&
        typeof row.expiresAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function saveAll(records: UploadResumeRecord[]): void {
  const target = storage();
  if (target === null) return;
  const now = Date.now();
  const kept = records
    .filter((record) => Date.parse(record.expiresAt) > now + EXPIRY_MARGIN_MS)
    .sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt))
    .slice(0, MAX_RECORDS);
  try {
    if (kept.length === 0) target.removeItem(STORAGE_KEY);
    else target.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // 本地索引是可选的加速信息；配额满或被策略禁用时不影响真正上传。
  }
}

function matches(record: UploadResumeRecord, query: ResumeQuery): boolean {
  return (
    record.projectId === query.projectId &&
    record.contentHash === query.contentHash.toLowerCase() &&
    record.fileName === query.fileName &&
    record.sizeBytes === query.sizeBytes &&
    record.taskId === query.taskId
  );
}

/** 查找仍可用的会话；过期 / 损坏记录顺手清掉。 */
export function findUploadResume(query: ResumeQuery): UploadResumeRecord | null {
  const records = loadAll();
  const now = Date.now();
  const found = records.find((record) => matches(record, query) && Date.parse(record.expiresAt) > now + EXPIRY_MARGIN_MS) ?? null;
  if (found === null) {
    saveAll(records);
    return null;
  }
  return found;
}

/** 记录 / 覆盖同一会话。 */
export function rememberUploadResume(record: UploadResumeRecord): void {
  const records = loadAll().filter((item) => item.uploadId !== record.uploadId);
  records.push(record);
  saveAll(records);
}

/** 上传完成、会话终止或确认不可续传时删除索引。 */
export function forgetUploadResume(uploadId: string): void {
  saveAll(loadAll().filter((item) => item.uploadId !== uploadId));
}
