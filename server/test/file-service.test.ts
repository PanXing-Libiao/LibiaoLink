import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ClockService } from "../src/common/clock/clock.service.js";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import type { DatabaseService } from "../src/db/database.service.js";
import type { AuditService } from "../src/modules/admin/index.js";
import { FileService } from "../src/modules/file/index.js";
import type { CadArchiveService } from "../src/modules/file/cad-archive.service.js";
import type {
  ChangeRequestInsertInput,
  ChangeRequestRow,
  DuplicateFileRow,
  FileCompletePatch,
  FileInsertInput,
  FileLinkInsertInput,
  FileNodeBriefRow,
  FileProjectBriefRow,
  FileRow,
  FileStatePatch,
  FileTaskBriefRow,
  FileVersionInsertInput,
  FileVersionRow,
  UploadSessionInsertInput,
  UploadSessionPatch,
  UploadSessionRow,
} from "../src/modules/file/file.repository.js";
import type { FileRepository } from "../src/modules/file/file.repository.js";
import type { PreviewArtifactRow, PreviewRepository } from "../src/modules/file/preview.repository.js";
import type { FileListFilter, FileListSort } from "../src/modules/file/file.query.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import { ObjectStorage, StorageError } from "../src/storage/index.js";
import type {
  CompleteMultipartUploadInput,
  CopyObjectInput,
  CopyObjectResult,
  CreateMultipartUploadInput,
  DownloadUrlInput,
  MultipartUploadKeyInput,
  MultipartUploadRef,
  ObjectHead,
  ObjectPrefixResult,
  PartUploadUrlInput,
  GetObjectResult,
  PurgeObjectResult,
  PurgePrefixResult,
  PutObjectInput,
  SignedUrl,
  UploadedPart,
} from "../src/storage/index.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const FILE = "22222222-2222-4222-8222-222222222222";
const OTHER_FILE = "22222222-2222-4222-8222-22222222222a";
const NODE = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "44444444-4444-4444-8444-44444444444a";
const SESSION = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const VERSION_A = "66666666-6666-4666-8666-66666666666a";
const VERSION_B = "66666666-6666-4666-8666-66666666666b";
const VERSION_C = "66666666-6666-4666-8666-66666666666c";
const ARTIFACT = "77777777-7777-4777-8777-777777777777";
const IMG_A = "88888888-8888-4888-8888-88888888888a";
const IMG_B = "88888888-8888-4888-8888-88888888888b";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const OTHER_ACTOR = "caa8d763-4b6a-4967-9b26-7d1086272c9c";
const NOW = new Date("2026-09-21T08:00:00Z");
const MI_B = 1024 * 1024;
const PDF_PREFIX = new TextEncoder().encode("%PDF-1.7\nunit-test\n");
const ZIP_PREFIX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const PNG_PREFIX = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_PREFIX = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_PREFIX = new TextEncoder().encode('<!doctype html><html><body><script>alert(1)</script></body></html>');
function uploadBytes(prefix: Uint8Array, size = 12 * MI_B, fill = 0): Buffer {
  const bytes = Buffer.alloc(size, fill);
  bytes.set(prefix.subarray(0, size));
  return bytes;
}
const HASH = createHash("sha256").update(uploadBytes(PDF_PREFIX)).digest("hex");
const OTHER_HASH = createHash("sha256").update(uploadBytes(PDF_PREFIX, 12 * MI_B, 1)).digest("hex");
const STAGING_KEY = `projects/${PROJECT}/files/${FILE}/staging/${SESSION}`;
const CONTRACT_KEY = `projects/${PROJECT}/files/${FILE}/v1/${HASH}.pdf`;
const CONTRACT_KEY_V2 = `projects/${PROJECT}/files/${FILE}/v2/${OTHER_HASH}.pdf`;
const CONTRACT_KEY_V3 = `projects/${PROJECT}/files/${FILE}/v3/${HASH}.pdf`;
const ARTIFACT_KEY = `previews/${HASH}/1.0.0/pdf`;
const ENV = {
  UPLOAD_MAX_SIZE_MB: 2048,
  UPLOAD_SESSION_TTL_HOURS: 24,
  FILE_RECYCLE_RETENTION_DAYS: 30,
  PREVIEW_PIPELINE_VERSION: "1.0.0",
} as unknown as Env;

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: FILE,
    projectId: PROJECT,
    nodeId: null,
    taskId: null,
    docType: null,
    name: "机械设计图纸.pdf",
    status: "draft",
    currentVersionId: null,
    version: 0,
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: null,
    finalizedBy: null,
    recycledAt: null,
    recycledBy: null,
    recycledFromStatus: null,
    purgeAfter: null,
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<UploadSessionRow> = {}): UploadSessionRow {
  return {
    id: SESSION,
    fileId: FILE,
    intent: "version",
    status: "active",
    objectKey: STAGING_KEY,
    storageUploadId: null,
    partSizeBytes: 8 * MI_B,
    totalParts: 2,
    sizeBytes: 12 * MI_B,
    contentHash: null,
    mime: null,
    changePayload: null,
    createdBy: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 24 * 3_600_000),
    completedAt: null,
    abortedAt: null,
    ...overrides,
  };
}

function makeVersionRow(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: VERSION,
    fileId: FILE,
    seq: 1,
    objectKey: CONTRACT_KEY,
    sizeBytes: 12 * MI_B,
    contentHash: HASH,
    mime: null,
    uploadedBy: ACTOR,
    uploadedAt: NOW,
    changeRequestId: null,
    ...overrides,
  };
}

/** 产物行（M4-05 收口：只 ready 行有对象键）。 */
function makeArtifactRow(overrides: Partial<PreviewArtifactRow> = {}): PreviewArtifactRow {
  return {
    id: ARTIFACT,
    fileId: FILE,
    versionId: VERSION_A,
    contentHash: HASH,
    target: "pdf",
    pipelineVersion: "1.0.0",
    status: "ready",
    objectKey: ARTIFACT_KEY,
    error: null,
    generatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function part(partNumber: number, sizeBytes: number): UploadedPart {
  return { partNumber, sizeBytes, etag: "\"etag-" + partNumber + "\"", lastModified: NOW };
}

/** 仓储替身：只记录调用并返回预置行（类型经 as unknown as FileRepository 桥接）。 */
class FakeFileRepository {
  project: FileProjectBriefRow | null = { id: PROJECT, status: "active", deletedAt: null };
  node: FileNodeBriefRow | null = { id: NODE, projectId: PROJECT, deletedAt: null };
  task: FileTaskBriefRow | null = { id: TASK, projectId: PROJECT, finalizedAt: null };
  file: FileRow | null = makeFileRow();
  session: UploadSessionRow | null = makeSessionRow();
  duplicate: DuplicateFileRow | null = null;
  attachmentDuplicate: DuplicateFileRow | null = null;
  expiredRows: (UploadSessionRow & { projectId: string })[] = [];
  /** 锁会话时抛错（验证过期清理「单条失败不阻断」）。 */
  failLockFor: string | null = null;
  /** 首次探测位次（copy 前）；默认 1。 */
  nextSeqBase = 1;
  /** true 时模拟「copy 之后、事务内复核之前」被并发完成抢了位次。 */
  seqDriftOnLock = false;

  insertedFiles: FileInsertInput[] = [];
  insertedSessions: UploadSessionInsertInput[] = [];
  insertedVersions: FileVersionInsertInput[] = [];
  sessionPatches: { id: string; patch: UploadSessionPatch }[] = [];
  duplicateQueries: { projectId: string; contentHash: string; excludeFileId: string }[] = [];
  attachmentDuplicateQueries: { projectId: string; contentHash: string }[] = [];
  /** Push 314：摘要附图校验预置行（listSummaryFileBriefs 只回其中 id 命中项）。 */
  summaryFileBriefs: { id: string; projectId: string; status: string }[] = [];
  summaryFileQueries: string[][] = [];
  lockSessionCalls = 0;

  async findProjectBrief(): Promise<FileProjectBriefRow | null> {
    return this.project;
  }

  async findNodeBrief(): Promise<FileNodeBriefRow | null> {
    return this.node;
  }

  async findTaskBrief(): Promise<FileTaskBriefRow | null> {
    return this.task;
  }

  async listSummaryFileBriefs(ids: readonly string[]): Promise<{ id: string; projectId: string; status: string }[]> {
    this.summaryFileQueries.push([...ids]);
    return this.summaryFileBriefs.filter((row) => ids.includes(row.id));
  }

  async insertFile(input: FileInsertInput): Promise<FileRow> {
    this.insertedFiles.push(input);
    const row = makeFileRow({
      projectId: input.projectId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      docType: input.docType,
      name: input.name,
      status: input.status,
      createdBy: input.createdBy,
      version: 0,
      currentVersionId: null,
    });
    this.file = row;
    return row;
  }

  async insertSession(input: UploadSessionInsertInput): Promise<UploadSessionRow> {
    this.insertedSessions.push(input);
    const row = makeSessionRow({
      id: input.id,
      fileId: input.fileId,
      intent: input.intent,
      objectKey: input.objectKey,
      partSizeBytes: input.partSizeBytes,
      totalParts: input.totalParts,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      mime: input.mime,
      changePayload: input.changePayload,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    this.session = row;
    return row;
  }

  async findDuplicateByHash(projectId: string, contentHash: string, excludeFileId: string): Promise<DuplicateFileRow | null> {
    this.duplicateQueries.push({ projectId, contentHash, excludeFileId });
    return this.duplicate;
  }

  async findAttachmentDuplicateByHash(projectId: string, contentHash: string): Promise<DuplicateFileRow | null> {
    this.attachmentDuplicateQueries.push({ projectId, contentHash });
    return this.attachmentDuplicate;
  }

  async findFileById(fileId: string): Promise<FileRow | null> {
    return this.findFile(fileId);
  }

  async findSessionById(sessionId: string): Promise<UploadSessionRow | null> {
    return this.session !== null && this.session.id === sessionId ? this.session : null;
  }

  /** 会话查找：先看当前会话，再看批量过期列表（过期清理场景）。 */
  private sessionById(sessionId: string): UploadSessionRow | null {
    if (this.session !== null && this.session.id === sessionId) return this.session;
    return this.expiredRows.find((row) => row.id === sessionId) ?? null;
  }

  async lockSession(_tx: unknown, sessionId: string): Promise<UploadSessionRow | null> {
    this.lockSessionCalls += 1;
    if (this.failLockFor === sessionId) throw new Error("fake: lockSession 失败");
    return this.sessionById(sessionId);
  }

  async updateSession(sessionId: string, patch: UploadSessionPatch): Promise<UploadSessionRow> {
    this.sessionPatches.push({ id: sessionId, patch });
    const current = this.sessionById(sessionId);
    if (current === null) throw new Error("fake: 会话不存在");
    const next = { ...current, ...patch } as UploadSessionRow;
    if (this.session !== null && this.session.id === sessionId) {
      this.session = next;
    } else {
      this.expiredRows = this.expiredRows.map((row) => (row.id === sessionId ? { ...next, projectId: row.projectId } : row));
    }
    return next;
  }

  async lockFile(_tx: unknown, fileId: string): Promise<FileRow | null> {
    return this.findFile(fileId);
  }

  async updateFileOnComplete(fileId: string, patch: FileCompletePatch): Promise<FileRow> {
    if (this.file === null) throw new Error("fake: 文件不存在");
    this.file = {
      ...this.file,
      id: fileId,
      currentVersionId: patch.currentVersionId,
      version: patch.version,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      updatedAt: patch.updatedAt,
    };
    return this.file;
  }

  async nextVersionSeq(_fileId: string, client?: unknown): Promise<number> {
    if (client === undefined) return this.nextSeqBase;
    return this.nextSeqBase + (this.seqDriftOnLock ? 1 : 0);
  }

  async insertVersion(input: FileVersionInsertInput): Promise<FileVersionRow> {
    this.insertedVersions.push(input);
    const row = makeVersionRow({
      id: this.nextVersionId ?? VERSION,
      fileId: input.fileId,
      seq: input.seq,
      objectKey: input.objectKey,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      mime: input.mime,
      uploadedBy: input.uploadedBy,
      uploadedAt: input.uploadedAt,
      changeRequestId: input.changeRequestId ?? null,
    });
    this.versions.push(row);
    return row;
  }

  // ---------- M4-04：变更写入（申请即通过） ----------

  /** 变更申请写入（applyChangeInTx 经 insertChangeRequest 落库）。 */
  insertedChanges: ChangeRequestInsertInput[] = [];
  /** 节点阶段 key（变更记录的默认变更阶段；null = 节点无阶段）。 */
  nodeStageKey: string | null = null;
  /** R01 匹配结果（deliverable = 文件成果类型）。 */
  deliverableTaskIds: string[] = [];
  /** R01 查询记录。 */
  deliverableQueries: { projectId: string; deliverable: string }[] = [];
  /** R01 回写记录（任务 change_refs 追加 + 去重，A1-07 多条 · 迁移 0020）。 */
  changeRefAppends: { taskIds: string[]; changeRequestId: string }[] = [];

  async insertChangeRequest(input: ChangeRequestInsertInput): Promise<ChangeRequestRow> {
    this.insertedChanges.push(input);
    return {
      id: input.id,
      projectId: input.projectId,
      nodeId: input.nodeId,
      stageKey: input.stageKey,
      reason: input.reason,
      beforeSummary: input.beforeSummary,
      afterSummary: input.afterSummary,
      beforeSummaryFileIds: input.beforeSummaryFileIds,
      afterSummaryFileIds: input.afterSummaryFileIds,
      status: "applied",
      appliedBy: input.appliedBy,
      writerBy: null,
      appliedAt: input.appliedAt,
      createdAt: input.createdAt,
    };
  }

  async findNodeStageKey(): Promise<string | null> {
    return this.nodeStageKey;
  }

  async listTaskIdsByDeliverable(projectId: string, deliverable: string): Promise<string[]> {
    this.deliverableQueries.push({ projectId, deliverable });
    return [...this.deliverableTaskIds];
  }

  async appendTasksChangeRefs(taskIds: readonly string[], changeRequestId: string): Promise<number> {
    this.changeRefAppends.push({ taskIds: [...taskIds], changeRequestId });
    return taskIds.length;
  }

  async listExpiredActiveSessions(): Promise<(UploadSessionRow & { projectId: string })[]> {
    return this.expiredRows;
  }

  // ---------- M4-02：版本 / 定档 / 回溯 / 回收站 ----------

  /** 版本链（含 complete / rollback 新插入的版本）。 */
  versions: FileVersionRow[] = [];
  /** 下一次 insertVersion 的返回 id（默认 VERSION；多版本场景由用例指定）。 */
  nextVersionId: string | null = null;
  /** 回收站到期清理入口（worker 批量）。 */
  expiredRecycledRows: FileRow[] = [];
  /** 记录状态流转 patch（定档 / 回溯 / 回收 / 恢复 / 彻底删除）。 */
  filePatches: { id: string; patch: FileStatePatch }[] = [];
  /** 记录彻底删除的文件（purge / 到期清理）。 */
  deletedFiles: string[] = [];
  /** 多文件场景（回收站批量清理）：`file` 为主，`otherFiles` 为补充。 */
  otherFiles: FileRow[] = [];

  private findFile(fileId: string): FileRow | null {
    if (this.file !== null && this.file.id === fileId) return this.file;
    return this.otherFiles.find((row) => row.id === fileId) ?? null;
  }

  async findVersionById(fileId: string, versionId: string): Promise<FileVersionRow | null> {
    return this.versions.find((row) => row.fileId === fileId && row.id === versionId) ?? null;
  }

  async listVersions(fileId: string): Promise<FileVersionRow[]> {
    return this.versions.filter((row) => row.fileId === fileId).sort((left, right) => left.seq - right.seq);
  }

  /** 任务定档置位调用记录（Push 249 · 文件定档联动任务定档）。 */
  finalizedTasks: { taskId: string; actorId: string }[] = [];

  async markTaskFinalized(taskId: string, _at: Date, actorId: string): Promise<string | null> {
    this.finalizedTasks.push({ taskId, actorId });
    return taskId;
  }

  /** 定档兜底撤销调用记录（防绕过补漏）。 */
  abortedTaskUploadSessions: { taskId: string; at: Date }[] = [];
  /** abortActiveTaskUploadSessions 的返回条数（任务审计 metadata 断言用）。 */
  abortedTaskSessionCount = 0;

  async abortActiveTaskUploadSessions(taskId: string, at: Date): Promise<number> {
    this.abortedTaskUploadSessions.push({ taskId, at });
    return this.abortedTaskSessionCount;
  }

  async updateFileState(fileId: string, patch: FileStatePatch): Promise<FileRow> {
    this.filePatches.push({ id: fileId, patch });
    const target = this.findFile(fileId);
    if (target === null) throw new Error("fake: 文件不存在");
    const next = { ...target, ...patch } as FileRow;
    if (this.file !== null && this.file.id === fileId) this.file = next;
    else this.otherFiles = this.otherFiles.map((row) => (row.id === fileId ? next : row));
    return next;
  }

  async listExpiredRecycledFiles(): Promise<FileRow[]> {
    return this.expiredRecycledRows;
  }

  async deleteVersionsByFile(fileId: string): Promise<number> {
    const before = this.versions.length;
    this.versions = this.versions.filter((row) => row.fileId !== fileId);
    return before - this.versions.length;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.deletedFiles.push(fileId);
    if (this.file !== null && this.file.id === fileId) this.file = null;
    this.otherFiles = this.otherFiles.filter((row) => row.id !== fileId);
  }

  // ---------- M4-03：多态关联与文件库查询 ----------

  /** complete 幂等写入的关联（project 必写；node / task 有则写）。 */
  insertedLinks: FileLinkInsertInput[] = [];
  /** 文件库列表返回（SQL 条件与排序由真机回放覆盖，替身只验证解析与映射）。 */
  libraryItems: FileRow[] = [];
  libraryTotal = 0;
  libraryQueries: { projectId: string; filter: FileListFilter; sorts: FileListSort[]; limit: number; offset: number }[] = [];

  async insertFileLinks(rows: readonly FileLinkInsertInput[]): Promise<void> {
    const seen = new Set(this.insertedLinks.map((row) => row.fileId + "|" + row.objectType + "|" + row.objectId));
    for (const row of rows) {
      const key = row.fileId + "|" + row.objectType + "|" + row.objectId;
      if (seen.has(key)) continue;
      seen.add(key);
      this.insertedLinks.push(row);
    }
  }

  async listProjectFiles(
    projectId: string,
    filter: FileListFilter,
    sorts: FileListSort[],
    limit: number,
    offset: number,
  ): Promise<{ items: FileRow[]; total: number }> {
    this.libraryQueries.push({ projectId, filter, sorts, limit, offset });
    return { items: this.libraryItems.slice(offset, offset + limit), total: this.libraryTotal };
  }
}

/** 对象存储替身：断言「键形态」「调用顺序」「按版本清理」。 */
class FakeObjectStorage extends ObjectStorage {
  readonly bucket = "test-bucket";
  parts: UploadedPart[] = [];
  head: ObjectHead | null = null;
  listError: Error | null = null;
  prefix: Uint8Array | null = PDF_PREFIX;
  prefixError: Error | null = null;
  readonly prefixReads: { objectKey: string; maxBytes: number }[] = [];
  readonly streamReads: string[] = [];
  fill = 0;

  uploadBytes(): Uint8Array {
    return this.source?.bytes ?? uploadBytes(this.prefix ?? new Uint8Array(), this.head?.sizeBytes ?? 12 * MI_B, this.fill);
  }

  override async getObjectStream(objectKey: string) {
    this.streamReads.push(objectKey);
    if (this.prefixError !== null) throw this.prefixError;
    if (this.source === null && this.prefix === null) return null;
    const bytes = this.uploadBytes();
    return { stream: Readable.from([bytes.subarray(0, 13), bytes.subarray(13)]), sizeBytes: bytes.byteLength, contentType: null };
  }

  created: CreateMultipartUploadInput[] = [];
  signed: PartUploadUrlInput[] = [];
  listed: MultipartUploadKeyInput[] = [];
  completed: CompleteMultipartUploadInput[] = [];
  aborted: MultipartUploadKeyInput[] = [];
  copied: CopyObjectInput[] = [];
  purged: string[] = [];

  async createMultipartUpload(input: CreateMultipartUploadInput): Promise<MultipartUploadRef> {
    this.created.push(input);
    return { objectKey: input.objectKey, uploadId: "storage-1" };
  }

  async signPartUploadUrl(input: PartUploadUrlInput): Promise<SignedUrl> {
    this.signed.push(input);
    return { url: "https://s3.test/" + input.objectKey + "?partNumber=" + input.partNumber, expiresAt: new Date(NOW.getTime() + 900_000) };
  }

  async listParts(input: MultipartUploadKeyInput): Promise<UploadedPart[]> {
    this.listed.push(input);
    if (this.listError !== null) throw this.listError;
    return this.parts;
  }

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<{ etag: string | null }> {
    this.completed.push(input);
    return { etag: "\"merged-etag\"" };
  }

  async abortMultipartUpload(input: MultipartUploadKeyInput): Promise<void> {
    this.aborted.push(input);
  }

  async headObject(objectKey: string): Promise<ObjectHead | null> {
    if (this.head === null) return null;
    return { ...this.head, objectKey };
  }

  async signDownloadUrl(input: DownloadUrlInput): Promise<SignedUrl> {
    return { url: "https://s3.test/" + input.objectKey, expiresAt: new Date(NOW.getTime() + 300_000) };
  }

  async purgeObject(objectKey: string): Promise<PurgeObjectResult> {
    this.purged.push(objectKey);
    return { deletedVersions: 1, deleteMarkers: 0 };
  }

  async purgePrefix(prefix: string): Promise<PurgePrefixResult> {
    this.purged.push(prefix);
    return { deletedVersions: 0, deleteMarkers: 0, deletedObjects: 0 };
  }

  async copyObject(input: CopyObjectInput): Promise<CopyObjectResult> {
    this.copied.push(input);
    return { etag: "\"copy-etag\"", versionId: null };
  }

  // ---- M4-05c：预览队列用（源字节直读 / 产物字节直写）----
  /** 预置源对象（null = 对象不存在，用于「源对象缺失」用例）。 */
  source: GetObjectResult | null = null;
  readonly puts: PutObjectInput[] = [];
  putError: Error | null = null;

  async getObject(objectKey: string): Promise<GetObjectResult | null> {
    if (this.source === null) return null;
    return { ...this.source, objectKey };
  }

  async readObjectPrefix(objectKey: string, maxBytes: number): Promise<ObjectPrefixResult | null> {
    this.prefixReads.push({ objectKey, maxBytes });
    if (this.prefixError !== null) throw this.prefixError;
    if (this.prefix === null) return null;
    return { objectKey, bytes: this.prefix.slice(0, maxBytes), contentType: null };
  }

  async putObject(input: PutObjectInput): Promise<{ etag: string | null }> {
    if (this.putError !== null) throw this.putError;
    this.puts.push(input);
    return { etag: "\"put-etag\"" };
  }

  async probe(): Promise<void> {}
}

/** 产物仓储替身（M4-05 收口：只实现清理用到的两个方法）。 */
class FakePreviewRepository {
  rows: PreviewArtifactRow[] = [];
  async listReadyByVersionIds(versionIds: readonly string[]): Promise<PreviewArtifactRow[]> {
    return this.rows.filter((row) => row.status === "ready" && versionIds.includes(row.versionId));
  }

}

class FakePermissionService {
  visible = true;
  canUpload = true;
  /** 彻底删除（purge）仅部门权限管理员：默认非管理员，用例按需放行。 */
  groupAccessAdmin = false;

  async assertProjectVisible(_actorId: string, projectId: string): Promise<{ projectId: string; member: boolean; projectManager: boolean }> {
    if (!this.visible) throw new Error("fake: 项目不可见");
    return { projectId, member: true, projectManager: false };
  }

  async assertCan(): Promise<void> {
    if (!this.canUpload) throw new Error("fake: 无权限");
  }

  async canManageGroupAccess(): Promise<boolean> {
    return this.groupAccessAdmin;
  }
}

class FakeAuditService {
  entries: unknown[] = [];
  async record(_client: unknown, input: unknown): Promise<void> {
    this.entries.push(input);
  }
}

class FakeDatabase {
  outbox: unknown[] = [];
  db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(this.makeTx()),
  };
  makeTx() {
    return {
      insert: () => ({
        // appendOutbox 只 await values()（普通对象 await 仍是它自己）；appendOutboxIfAbsent 会继续挂
        // onConflictDoUpdate —— 替身两种都记一笔（唯一约束冲突的真行为由真库回放覆盖）。
        values: (value: unknown) => {
          this.outbox.push(value);
          return { onConflictDoUpdate: async () => {} };
        },
      }),
    };
  }
}

interface Harness {
  service: FileService;
  repo: FakeFileRepository;
  previews: FakePreviewRepository;
  storage: FakeObjectStorage;
  permission: FakePermissionService;
  audit: FakeAuditService;
  database: FakeDatabase;
  clock: ClockService;
}

function makeService(env: Partial<Env> = {}, cadArchive?: CadArchiveService): Harness {
  const repo = new FakeFileRepository();
  const previews = new FakePreviewRepository();
  const storage = new FakeObjectStorage();
  const permission = new FakePermissionService();
  const audit = new FakeAuditService();
  const database = new FakeDatabase();
  const clock = new ClockService();
  clock.setSource(() => NOW);
  const config = new AppConfig({ ...ENV, ...env } as Env);
  const service = new FileService(
    database as unknown as DatabaseService,
    repo as unknown as FileRepository,
    previews as unknown as PreviewRepository,
    storage,
    permission as unknown as PermissionService,
    audit as unknown as AuditService,
    config,
    clock,
    cadArchive,
  );
  return { service, repo, previews, storage, permission, audit, database, clock };
}

describe("FileService.createUpload（M4-01 发起上传）", () => {
  it("发起上传：建 draft 文件 + 暂存键会话，返回分片计划与会话视图", async () => {
    const h = makeService();
    const result = await h.service.createUpload(
      { projectId: PROJECT, name: "机械设计图纸.pdf", sizeBytes: 12 * MI_B, mime: "application/pdf", intent: "version" },
      ACTOR,
    );

    expect(result.file.status).toBe("draft");
    expect(result.file.version).toBe(0);
    expect(result.file.createdBy).toBe(ACTOR);
    expect(result.reused).toBe(false);
    const upload = result.upload!;
    expect(upload.intent).toBe("version");
    expect(upload.status).toBe("active");
    expect(upload.partSizeBytes).toBe(8 * MI_B);
    expect(upload.totalParts).toBe(2);
    expect(upload.createdAt).toBe(NOW.toISOString());
    expect(upload.expiresAt).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
    expect(result.duplicateHint).toBeNull();

    // 会话先写暂存键（ADR-006）：…/staging/{sessionId}（sessionId 由服务端生成）
    const inserted = h.repo.insertedSessions[0]!;
    expect(inserted.objectKey).toBe(`projects/${PROJECT}/files/${FILE}/staging/${inserted.id}`);
    expect(inserted.id).toBe(upload.id);
    expect(inserted.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 3_600_000));
    expect(h.repo.insertedFiles[0]!.status).toBe("draft");
    // init 未给哈希 → 不查秒传提示
    expect(h.repo.duplicateQueries).toHaveLength(0);
    // 审计：一条 create（objectType=file，metadata 带 uploadId）
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ action: "create", objectType: "file", objectId: FILE });
  });

  it("附件域（2026-10-12）：命中同项目既有同内容附件 → 秒传复用，不新建文件 / 会话（reused=true、upload=null）", async () => {
    const h = makeService();
    h.repo.attachmentDuplicate = {
      fileId: OTHER_FILE,
      name: "机械设计图纸-v1.pdf",
      sizeBytes: 12 * MI_B,
      uploadedBy: OTHER_ACTOR,
      uploadedAt: new Date("2026-09-10T02:00:00Z"),
    };
    h.repo.otherFiles = [makeFileRow({ id: OTHER_FILE, name: "机械设计图纸-v1.pdf", version: 1, currentVersionId: VERSION })];
    const result = await h.service.createUpload(
      { projectId: PROJECT, name: "机械设计图纸.pdf", sizeBytes: 12 * MI_B, contentHash: HASH.toUpperCase(), intent: "version" },
      ACTOR,
    );

    expect(result.reused).toBe(true);
    expect(result.upload).toBeNull();
    expect(result.file.id).toBe(OTHER_FILE);
    expect(result.duplicateHint).toEqual({
      fileId: OTHER_FILE,
      name: "机械设计图纸-v1.pdf",
      sizeBytes: 12 * MI_B,
      uploadedBy: OTHER_ACTOR,
      uploadedAt: "2026-09-10T02:00:00.000Z",
    });
    // 哈希统一小写后查询；复用不落文件 / 会话 / 审计
    expect(h.repo.attachmentDuplicateQueries).toEqual([{ projectId: PROJECT, contentHash: HASH }]);
    expect(h.repo.insertedFiles).toHaveLength(0);
    expect(h.repo.insertedSessions).toHaveLength(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  it("任务成果上传（带 taskId）：同内容仍每次新建文件，只回秒传提示（不阻断）—— 附件域复用不吞任务归属", async () => {
    const h = makeService();
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: null };
    h.repo.attachmentDuplicate = {
      fileId: OTHER_FILE,
      name: "机械设计图纸-v1.pdf",
      sizeBytes: 12 * MI_B,
      uploadedBy: OTHER_ACTOR,
      uploadedAt: new Date("2026-09-10T02:00:00Z"),
    };
    h.repo.duplicate = {
      fileId: OTHER_FILE,
      name: "机械设计图纸-v1.pdf",
      sizeBytes: 12 * MI_B,
      uploadedBy: OTHER_ACTOR,
      uploadedAt: new Date("2026-09-10T02:00:00Z"),
    };
    const result = await h.service.createUpload(
      { projectId: PROJECT, name: "机械设计图纸.pdf", sizeBytes: 12 * MI_B, contentHash: HASH.toUpperCase(), intent: "version", taskId: TASK },
      ACTOR,
    );

    expect(result.reused).toBe(false);
    const upload = result.upload!;
    expect(upload.intent).toBe("version");
    expect(result.duplicateHint).toEqual({
      fileId: OTHER_FILE,
      name: "机械设计图纸-v1.pdf",
      sizeBytes: 12 * MI_B,
      uploadedBy: OTHER_ACTOR,
      uploadedAt: "2026-09-10T02:00:00.000Z",
    });
    expect(h.repo.attachmentDuplicateQueries).toHaveLength(0);
    expect(h.repo.insertedSessions[0]!.contentHash).toBe(HASH);
    expect(h.repo.duplicateQueries[0]).toMatchObject({ projectId: PROJECT, contentHash: HASH, excludeFileId: FILE });
  });

  // 「intent=change 缺 fileId」在契约层（zod）即被拒、到不了服务层 —— 该面由契约回放
  // （shared/scripts/upload-intent-replay.mjs）与真机回放 U21 兜住；服务层测 M4-04 放开后的目标解析与载荷落库。
  it("intent=change + fileId（目标 final）→ 建会话：change_payload 落库、不新建文件、审计记待生效变更", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", version: 3, currentVersionId: VERSION, docType: "CAD图纸" });
    const result = await h.service.createUpload(
      {
        projectId: PROJECT,
        name: "机械设计图纸.pdf",
        sizeBytes: MI_B,
        intent: "change",
        fileId: FILE,
        change: { reason: "设计变更（变更单 CR-2026-0918）", afterSummary: "按变更单调整孔位" },
      },
      ACTOR,
    );

    expect(result.file.id).toBe(FILE);
    expect(result.upload!.intent).toBe("change");
    expect(h.repo.insertedFiles).toHaveLength(0);
    expect(h.repo.insertedSessions).toHaveLength(1);
    expect(h.repo.insertedSessions[0]).toMatchObject({ fileId: FILE, intent: "change" });
    // 变更申请随会话落 change_payload（契约 ChangeIntentBody）：未给字段补空；Push 256 起随带 fileName（变更后文件名称）
    expect(h.repo.insertedSessions[0]!.changePayload).toEqual({
      reason: "设计变更（变更单 CR-2026-0918）",
      beforeSummary: null,
      afterSummary: "按变更单调整孔位",
      beforeSummaryFileIds: [],
      afterSummaryFileIds: [],
      stageKey: null,
      fileName: "机械设计图纸.pdf",
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "update",
      objectType: "file",
      objectId: FILE,
      changes: [{ field: "pendingChange", from: null, to: "设计变更（变更单 CR-2026-0918）" }],
      metadata: { intent: "change", targetFileId: FILE },
    });
  });

  it("intent=change（Push 256 · 业务口径「变更后文件的名字后后缀要用变更选择的」）→ name = 变更后文件名称：与目标不同不再 400，随会话 change_payload.fileName 落库", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", version: 3, currentVersionId: VERSION, docType: "CAD图纸" });
    const result = await h.service.createUpload(
      {
        projectId: PROJECT,
        name: "回放-变更后.pptx",
        sizeBytes: MI_B,
        intent: "change",
        fileId: FILE,
        change: { reason: "换扩展名（xls → pptx）" },
      },
      ACTOR,
    );

    expect(result.file.id).toBe(FILE);
    expect(result.upload!.intent).toBe("change");
    expect(h.repo.insertedFiles).toHaveLength(0);
    expect(h.repo.insertedSessions[0]!.changePayload).toEqual({
      reason: "换扩展名（xls → pptx）",
      beforeSummary: null,
      afterSummary: null,
      beforeSummaryFileIds: [],
      afterSummaryFileIds: [],
      stageKey: null,
      fileName: "回放-变更后.pptx",
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      summary: "发起变更上传（定档后变更）：机械设计图纸.pdf → 回放-变更后.pptx",
    });
  });

  it("Push 314：intent=change 摘要附图随会话落 change_payload（去重保序）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", version: 3, currentVersionId: VERSION, docType: "CAD图纸" });
    h.repo.summaryFileBriefs = [
      { id: IMG_A, projectId: PROJECT, status: "changed" },
      { id: IMG_B, projectId: PROJECT, status: "final" },
    ];

    const result = await h.service.createUpload(
      {
        projectId: PROJECT,
        name: "机械设计图纸.pdf",
        sizeBytes: MI_B,
        intent: "change",
        fileId: FILE,
        change: {
          reason: "附图的变更（带前后照片）",
          afterSummary: "按变更单调整孔位",
          beforeSummaryFileIds: [IMG_A, IMG_A, IMG_B],
          afterSummaryFileIds: [IMG_B],
        },
      },
      ACTOR,
    );

    expect(result.upload!.intent).toBe("change");
    expect(h.repo.summaryFileQueries).toEqual([[IMG_A, IMG_B]]);
    expect(h.repo.insertedSessions[0]!.changePayload).toEqual({
      reason: "附图的变更（带前后照片）",
      beforeSummary: null,
      afterSummary: "按变更单调整孔位",
      beforeSummaryFileIds: [IMG_A, IMG_B],
      afterSummaryFileIds: [IMG_B],
      stageKey: null,
      fileName: "机械设计图纸.pdf",
    });
  });

  it("Push 314 反例：摘要附图缺失 / 跨项目 / 已回收 → 400（不落会话）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", version: 3, currentVersionId: VERSION, docType: "CAD图纸" });
    h.repo.summaryFileBriefs = [
      { id: IMG_A, projectId: PROJECT, status: "recycled" },
      { id: IMG_B, projectId: OTHER_PROJECT, status: "final" },
    ];

    await expect(
      h.service.createUpload(
        {
          projectId: PROJECT,
          name: "机械设计图纸.pdf",
          sizeBytes: MI_B,
          intent: "change",
          fileId: FILE,
          change: { reason: "附图非法", beforeSummaryFileIds: [IMG_A, IMG_B] },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(h.repo.insertedSessions).toHaveLength(0);
  });

  it("intent=change 反例：目标非定档（draft / recycled）409；跨项目 400；不存在 404（均不落会话）", async () => {
    const h = makeService();
    const change = (overrides: Record<string, unknown> = {}) =>
      h.service.createUpload(
        {
          projectId: PROJECT,
          name: "机械设计图纸.pdf",
          sizeBytes: MI_B,
          intent: "change",
          fileId: FILE,
          change: { reason: "设计变更" },
          ...overrides,
        },
        ACTOR,
      );

    h.repo.file = makeFileRow({ status: "draft" });
    await expect(change()).rejects.toMatchObject({ code: "FILE_STATE_INVALID", httpStatus: 409 });

    h.repo.file = makeFileRow({ status: "recycled", version: 2 });
    await expect(change()).rejects.toMatchObject({ code: "FILE_STATE_INVALID", httpStatus: 409 });

    h.repo.file = makeFileRow({ status: "final", projectId: OTHER_PROJECT });
    await expect(change()).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ code: "invalid_file", path: "fileId" }],
    });

    h.repo.file = null;
    await expect(change()).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(h.repo.insertedSessions).toHaveLength(0);
  });

  it("intent=change（Push 254 续 · 业务口径「不是已经定档了吗 为什么变更申请里面还是未定档」）：任务已定档 → 其名下的 draft 文件同样放行（不必先行文件级定档）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", taskId: TASK, version: 2, currentVersionId: VERSION });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: NOW };
    const result = await h.service.createUpload(
      {
        projectId: PROJECT,
        name: "机械设计图纸.pdf",
        sizeBytes: MI_B,
        intent: "change",
        fileId: FILE,
        change: { reason: "任务定档后变更" },
      },
      ACTOR,
    );

    expect(result.file.id).toBe(FILE);
    expect(result.upload!.intent).toBe("change");
    expect(h.repo.insertedSessions).toHaveLength(1);
  });

  it("intent=change 续·反例：draft 文件但任务未定档 / 未挂接任务 → 仍 409（新分支不误放行）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", taskId: TASK, version: 2, currentVersionId: VERSION });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: null };
    await expect(
      h.service.createUpload(
        {
          projectId: PROJECT,
          name: "机械设计图纸.pdf",
          sizeBytes: MI_B,
          intent: "change",
          fileId: FILE,
          change: { reason: "任务未定档" },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "FILE_STATE_INVALID", httpStatus: 409 });

    const h2 = makeService();
    h2.repo.file = makeFileRow({ status: "draft", taskId: null, version: 2, currentVersionId: VERSION });
    await expect(
      h2.service.createUpload(
        {
          projectId: PROJECT,
          name: "机械设计图纸.pdf",
          sizeBytes: MI_B,
          intent: "change",
          fileId: FILE,
          change: { reason: "无挂接任务" },
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "FILE_STATE_INVALID", httpStatus: 409 });
  });

  it("intent=version + fileId（目标 draft）→ 追加版本：复用文件行（不新建）+ 审计 update + 秒传提示恒空", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", version: 2, currentVersionId: VERSION });
    h.repo.duplicate = { fileId: OTHER_FILE, name: "旧版本.pdf", sizeBytes: MI_B, uploadedBy: OTHER_ACTOR, uploadedAt: NOW };
    const result = await h.service.createUpload(
      { projectId: PROJECT, name: "机械设计图纸.pdf", sizeBytes: MI_B, contentHash: HASH, intent: "version", fileId: FILE },
      ACTOR,
    );

    expect(result.file.id).toBe(FILE);
    expect(result.duplicateHint).toBeNull();
    expect(h.repo.duplicateQueries).toHaveLength(0);
    expect(h.repo.insertedFiles).toHaveLength(0);
    expect(h.repo.insertedSessions).toHaveLength(1);
    expect(h.repo.insertedSessions[0]!.fileId).toBe(FILE);
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "update",
      objectType: "file",
      objectId: FILE,
      metadata: { targetFileId: FILE },
    });
  });

  it("intent=version + fileId 反例：目标非 draft 409 / 跨项目与名称不一致 400 / 不存在 404", async () => {
    const h = makeService();
    const append = (overrides: Record<string, unknown> = {}) =>
      h.service.createUpload(
        { projectId: PROJECT, name: "机械设计图纸.pdf", sizeBytes: MI_B, intent: "version", fileId: FILE, ...overrides },
        ACTOR,
      );

    h.repo.file = makeFileRow({ status: "final" });
    await expect(append()).rejects.toMatchObject({ code: "FILE_STATE_INVALID", httpStatus: 409 });

    h.repo.file = makeFileRow({ status: "draft", projectId: OTHER_PROJECT });
    await expect(append()).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ code: "invalid_file", path: "fileId" }],
    });

    h.repo.file = makeFileRow({ status: "draft" });
    await expect(append({ name: "改名.pdf" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ code: "name_mismatch", path: "name" }],
    });
    await expect(append({ docType: "合同" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ code: "doc_type_mismatch", path: "docType" }],
    });

    h.repo.file = null;
    await expect(append()).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    expect(h.repo.insertedSessions).toHaveLength(0);
  });

  it("超过 UPLOAD_MAX_SIZE_MB → 400 VALIDATION_FAILED（details 带 limitBytes）", async () => {
    const h = makeService({ UPLOAD_MAX_SIZE_MB: 1 } as Partial<Env>);
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "大文件.zip", sizeBytes: 2 * MI_B, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: [{ code: "too_large", path: "sizeBytes", meta: { limitBytes: MI_B } }],
    });
    expect(h.repo.insertedFiles).toHaveLength(0);
  });

  it("项目已归档 → 409 PROJECT_ARCHIVED；项目不存在 → 404", async () => {
    const h = makeService();
    h.repo.project = { id: PROJECT, status: "archived", deletedAt: null };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({ code: "PROJECT_ARCHIVED", httpStatus: 409 });

    h.repo.project = null;
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("nodeId / taskId 跨项目 → 400（防挂接到别的项目）", async () => {
    const h = makeService();
    h.repo.node = { id: NODE, projectId: OTHER_PROJECT, deletedAt: null };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, nodeId: NODE, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ code: "invalid_node", path: "nodeId" }] });

    h.repo.node = { id: NODE, projectId: PROJECT, deletedAt: new Date("2026-09-01T00:00:00Z") };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, nodeId: NODE, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    h.repo.node = { id: NODE, projectId: PROJECT, deletedAt: null };
    h.repo.task = { id: TASK, projectId: OTHER_PROJECT, finalizedAt: null };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, taskId: TASK, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: [{ code: "invalid_task", path: "taskId" }] });
  });

  it("同项目 nodeId / taskId → 允许（随文件落库）", async () => {
    const h = makeService();
    const result = await h.service.createUpload(
      { projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, nodeId: NODE, taskId: TASK, docType: "CAD图纸", intent: "version" },
      ACTOR,
    );
    expect(result.file.nodeId).toBe(NODE);
    expect(result.file.taskId).toBe(TASK);
    expect(result.file.docType).toBe("CAD图纸");
  });
});

describe("FileService.signParts（分片预签名 / 断点续传）", () => {
  it("首次取分片 URL：登记存储侧 UploadId（行锁下只建一次）", async () => {
    const h = makeService();
    const result = await h.service.signParts(FILE, SESSION, { partNumbers: [1, 2] }, ACTOR);

    expect(h.storage.created).toHaveLength(1);
    expect(h.storage.created[0]!.objectKey).toBe(STAGING_KEY);
    expect(h.repo.sessionPatches[0]!.patch.storageUploadId).toBe("storage-1");
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(result.partSizeBytes).toBe(8 * MI_B);
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
    expect(h.storage.signed.map((p) => p.partNumber)).toEqual([1, 2]);
  });

  it("已有存储侧 UploadId → 直接签名，不重复建会话", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-9" });
    const result = await h.service.signParts(FILE, SESSION, { partNumbers: [2] }, ACTOR);

    expect(h.storage.created).toHaveLength(0);
    expect(h.storage.signed[0]).toMatchObject({ uploadId: "storage-9", partNumber: 2 });
    expect(result.parts).toHaveLength(1);
  });

  it("分片号超出会话范围 → 400（不触存储）", async () => {
    const h = makeService();
    await expect(h.service.signParts(FILE, SESSION, { partNumbers: [3] }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: [{ code: "out_of_range", path: "partNumbers" }],
    });
    expect(h.storage.created).toHaveLength(0);
  });

  it("会话过期：惰性置 expired + 清暂存，回 410", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", expiresAt: new Date(NOW.getTime() - 1) });
    await expect(h.service.signParts(FILE, SESSION, { partNumbers: [1] }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_SESSION_EXPIRED",
      httpStatus: 410,
    });

    expect(h.storage.aborted).toHaveLength(1);
    expect(h.storage.purged).toEqual([STAGING_KEY]);
    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("expired");
    expect(h.audit.entries.at(-1)).toMatchObject({ actorId: null, objectType: "file", objectId: FILE, metadata: { uploadId: SESSION } });
  });

  it("会话已中止 → 410；会话不属于该文件 → 404", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ status: "aborted" });
    await expect(h.service.signParts(FILE, SESSION, { partNumbers: [1] }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_SESSION_EXPIRED",
      httpStatus: 410,
    });

    h.repo.session = makeSessionRow({ fileId: OTHER_FILE });
    await expect(h.service.signParts(FILE, SESSION, { partNumbers: [1] }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });
});

describe("FileService.getUpload（会话状态 / 续传依据）", () => {
  it("按 ListParts 回已传与缺失分片", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", totalParts: 4 });
    h.storage.parts = [part(1, 8 * MI_B), part(3, 8 * MI_B)];
    const view = await h.service.getUpload(FILE, SESSION, ACTOR);

    expect(view.uploadedPartNumbers).toEqual([1, 3]);
    expect(view.missingPartNumbers).toEqual([2, 4]);
    expect(view.status).toBe("active");
  });

  it("尚未建存储侧会话 → 已传为空、缺失全部（不触存储）", async () => {
    const h = makeService();
    const view = await h.service.getUpload(FILE, SESSION, ACTOR);
    expect(view.uploadedPartNumbers).toEqual([]);
    expect(view.missingPartNumbers).toEqual([1, 2]);
    expect(h.storage.listed).toHaveLength(0);
  });

  it("会话过期 → 409 FILE_STATE_INVALID（惰性清理）", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", expiresAt: new Date(NOW.getTime() - 1) });
    await expect(h.service.getUpload(FILE, SESSION, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("expired");
    expect(h.storage.purged).toEqual([STAGING_KEY]);
  });

  it("已完成的会话 → 409（不可续传）", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ status: "completed", completedAt: NOW });
    await expect(h.service.getUpload(FILE, SESSION, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
  });
});

function declareActualHash(h: Harness): string {
  const hash = createHash("sha256").update(h.storage.uploadBytes()).digest("hex");
  h.repo.session!.contentHash = hash;
  return hash;
}

describe("FileService.completeUpload（合并 / 复制到契约键 / 落版本）", () => {
  function readyHarness(cadArchive?: CadArchiveService): Harness {
    const h = makeService({}, cadArchive);
    h.repo.file = makeFileRow();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/pdf" });
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = { objectKey: STAGING_KEY, sizeBytes: 12 * MI_B, etag: "\"merged-etag\"", contentType: "application/pdf", lastModified: NOW };
    return h;
  }

  it.each([null, HASH])("实际字节与 complete 哈希不符，即使 init 申报为 %s 也拒绝，不复制、不落版本、不投任务", async (declared) => {
    const h = readyHarness();
    const bytes = Buffer.alloc(128 * 1024);
    bytes.set(PDF_PREFIX);
    bytes[bytes.length - 1] = 1;
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: declared, sizeBytes: bytes.length });
    h.storage.head = { ...h.storage.head!, sizeBytes: bytes.length };
    h.storage.source = { objectKey: STAGING_KEY, bytes, sizeBytes: bytes.length, contentType: "application/pdf" };

    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "FILE_HASH_MISMATCH", httpStatus: 422,
    });
    expect(h.storage.copied).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
  });

  it("STEP 上传完成即在版本事务内登记后台解析，不等待 native 转换", async () => {
    const uploaded = vi.fn().mockResolvedValue(undefined);
    const h = readyHarness({ uploaded } as unknown as CadArchiveService);
    h.repo.file = makeFileRow({ name: "总装.step" });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/octet-stream" });
    h.storage.prefix = Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;");
    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: declareActualHash(h) }, ACTOR);
    expect(result.version.id).toBe(VERSION);
    expect(uploaded).toHaveBeenCalledOnce();
    expect(uploaded.mock.calls[0]?.[0]).toEqual({ fileId: FILE, versionId: VERSION, sourceSHA256: h.repo.insertedVersions[0]!.contentHash,
      sourceBytes: 12 * MI_B, sourceName: "总装.step" });
    expect(uploaded.mock.calls[0]?.[1]).toBeDefined();
    expect(h.database.outbox[0]).toMatchObject({ topic: "file.version.created" });
  });

  it("成功：合并 → HEAD 校验 → 复制契约键 → 写版本 / 文件 / 会话 + 审计 + outbox → 清暂存", async () => {
    const h = readyHarness();
    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);

    // 合并按编号升序提交
    expect(h.storage.completed[0]!.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    // 键形态：暂存键 → 契约键
    expect(h.storage.copied[0]).toMatchObject({
      sourceKey: STAGING_KEY,
      destinationKey: CONTRACT_KEY,
      contentType: "application/octet-stream",
    });
    expect(h.storage.prefixReads).toEqual([]);
    expect(h.storage.streamReads).toEqual([STAGING_KEY]);
    expect(h.storage.purged).toEqual([STAGING_KEY]);

    const version = h.repo.insertedVersions[0]!;
    expect(version.objectKey).toBe(CONTRACT_KEY);
    expect(version.seq).toBe(1);
    expect(version.sizeBytes).toBe(12 * MI_B);
    expect(version.contentHash).toBe(HASH);
    expect(version.mime).toBe("application/pdf");

    expect(result.file.currentVersionId).toBe(VERSION);
    expect(result.file.version).toBe(1);
    expect(result.version.seq).toBe(1);
    expect(result.changeRequest).toBeNull();

    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("completed");
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "complete",
      objectType: "file",
      objectId: FILE,
      metadata: { uploadId: SESSION, versionSeq: 1, objectKey: CONTRACT_KEY, duplicateOf: null },
    });
    expect(h.database.outbox).toHaveLength(1);
    expect(h.database.outbox[0]).toMatchObject({ topic: "file.version.created", dedupeKey: "file.version.created:" + VERSION, status: "pending" });
  });

  it("H1 · S2：MIME 大小写 / 参数被规范化落库，原对象固定 application/octet-stream", async () => {
    const h = readyHarness();
    h.repo.file = makeFileRow({ name: "部署图纸.PDF" });
    h.repo.session = makeSessionRow({
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: " Application/PDF ; charset=binary",
    });

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);

    expect(result.version.mime).toBe("application/pdf");
    expect(h.repo.insertedVersions[0]!.mime).toBe("application/pdf");
    expect(h.storage.copied[0]).toMatchObject({
      destinationKey: `projects/${PROJECT}/files/${FILE}/v1/${HASH}.pdf`,
      contentType: "application/octet-stream",
    });
  });

  it("H1 · S2：扩展名 / 声明 MIME 冲突 → 422 拒绝，不复制、不落版本", async () => {
    const h = readyHarness();
    h.repo.file = makeFileRow({ name: "poc.png" });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "image/svg+xml" });
    h.storage.prefix = PNG_PREFIX;

    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: [{ code: "mime_mismatch", path: "mime", meta: { extension: "png", expectedMime: "image/png" } }],
    });
    expect(h.storage.copied).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("H1 · S2：扩展名 / 文件头冲突（含双扩展名 .svg.png）→ 422 拒绝，不能靠改名绕过", async () => {
    for (const name of ["伪造.png", "伪造.svg.png"]) {
      const h = readyHarness();
      h.repo.file = makeFileRow({ name });
      h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "image/png" });
      h.storage.prefix = SVG_PREFIX;

      await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        httpStatus: 400,
        details: [{ code: "content_mismatch", path: "mime", meta: { expectedMime: "image/png" } }],
      });
      expect(h.storage.copied).toHaveLength(0);
      expect(h.repo.insertedVersions).toHaveLength(0);
    }
  });

  it("H1 · S2：HTML / SVG 可按规范 MIME 入库，但原对象只保存为不透明字节", async () => {
    const html = readyHarness();
    html.repo.file = makeFileRow({ name: "说明.html" });
    html.repo.session = makeSessionRow({
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "TEXT/HTML; charset=utf-8",
    });
    html.storage.prefix = HTML_PREFIX;
    const htmlHash = declareActualHash(html);
    const htmlResult = await html.service.completeUpload(FILE, SESSION, { contentHash: htmlHash }, ACTOR);
    expect(htmlResult.version.mime).toBe("text/html");
    expect(html.storage.copied[0]).toMatchObject({ contentType: "application/octet-stream" });

    const svg = readyHarness();
    svg.repo.file = makeFileRow({ name: "矢量图.svg" });
    svg.repo.session = makeSessionRow({
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "image/svg+xml; charset=utf-8",
    });
    svg.storage.prefix = SVG_PREFIX;
    const svgHash = declareActualHash(svg);
    const svgResult = await svg.service.completeUpload(FILE, SESSION, { contentHash: svgHash }, ACTOR);
    expect(svgResult.version.mime).toBe("image/svg+xml");
    expect(svg.storage.copied[0]).toMatchObject({ contentType: "application/octet-stream" });
  });

  it("H1 · S2：无扩展名即使声明 image/svg+xml 也保存为 octet-stream（不进入 SVG 预览）", async () => {
    const h = readyHarness();
    h.repo.file = makeFileRow({ name: "无扩展名" });
    h.repo.session = makeSessionRow({
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "image/svg+xml",
    });
    h.storage.prefix = SVG_PREFIX;

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: declareActualHash(h) }, ACTOR);

    expect(result.version.mime).toBe("application/octet-stream");
    expect(h.repo.insertedVersions[0]!.objectKey).toBe(`projects/${PROJECT}/files/${FILE}/v1/${h.repo.insertedVersions[0]!.contentHash}.bin`);
    expect(h.storage.copied[0]).toMatchObject({ contentType: "application/octet-stream" });
  });

  it("分片未齐 → 409 UPLOAD_INCOMPLETE（details 带缺失分片；不合并）", async () => {
    const h = readyHarness();
    h.storage.parts = [part(1, 8 * MI_B)];
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_INCOMPLETE",
      httpStatus: 409,
      details: [{ code: "missing_parts", meta: { missing: [2] } }],
    });
    expect(h.storage.completed).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("尚未上传任何分片 → 409 UPLOAD_INCOMPLETE（缺失全部）", async () => {
    const h = readyHarness();
    h.repo.session = makeSessionRow({ storageUploadId: null });
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_INCOMPLETE",
      httpStatus: 409,
      details: [{ code: "missing_parts", meta: { missing: [1, 2] } }],
    });
    expect(h.storage.listed).toHaveLength(0);
  });

  it("合并后大小与声明不一致 → 409 UPLOAD_INCOMPLETE（size_mismatch）", async () => {
    const h = readyHarness();
    h.storage.head = { objectKey: STAGING_KEY, sizeBytes: 11 * MI_B, etag: null, contentType: null, lastModified: NOW };
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_INCOMPLETE",
      httpStatus: 409,
      details: [{ code: "size_mismatch", path: "sizeBytes" }],
    });
    expect(h.storage.copied).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("合并结果在存储侧不存在 → 409 UPLOAD_INCOMPLETE", async () => {
    const h = readyHarness();
    h.storage.head = null;
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_INCOMPLETE",
      httpStatus: 409,
    });
    expect(h.storage.copied).toHaveLength(0);
  });

  it("哈希与发起时声明不一致 → 422 FILE_HASH_MISMATCH（不复制、不落库）", async () => {
    const h = readyHarness();
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: OTHER_HASH }, ACTOR)).rejects.toMatchObject({
      code: "FILE_HASH_MISMATCH",
      httpStatus: 422,
      details: [{ code: "hash_mismatch", path: "contentHash" }],
    });
    expect(h.storage.copied).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("init 未给哈希 → complete 的哈希即为准（大小校验仍生效）", async () => {
    const h = readyHarness();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: null });
    h.storage.fill = 1;
    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: OTHER_HASH.toUpperCase() }, ACTOR);
    expect(result.version.contentHash).toBe(OTHER_HASH);
    expect(h.storage.copied[0]!.destinationKey).toBe(`projects/${PROJECT}/files/${FILE}/v1/${OTHER_HASH}.pdf`);
  });

  it("会话过期 → 410（先惰性清理）", async () => {
    const h = readyHarness();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", expiresAt: new Date(NOW.getTime() - 1) });
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_SESSION_EXPIRED",
      httpStatus: 410,
    });
    expect(h.storage.completed).toHaveLength(0);
  });

  it("存储侧会话已不存在（ListParts 报错）→ 410 UPLOAD_SESSION_EXPIRED", async () => {
    const h = readyHarness();
    h.storage.listError = new StorageError("upload_not_found", "NoSuchUpload");
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "UPLOAD_SESSION_EXPIRED",
      httpStatus: 410,
    });
  });

  it("copy 后位次被并发完成抢占 → 500 INTERNAL（不写半份版本）", async () => {
    const h = readyHarness();
    h.repo.seqDriftOnLock = true;
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
  });

  it("copyObject 存储失败 → 映射为契约错误（不落库）", async () => {
    const h = readyHarness();
    h.storage.copyObject = async () => {
      throw new StorageError("unavailable", "S3 不可用");
    };
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("暂存清理失败只告警：版本已落库，complete 仍成功", async () => {
    const h = readyHarness();
    h.storage.purgeObject = async () => {
      throw new Error("purge 失败");
    };
    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(result.version.seq).toBe(1);
    expect(h.repo.insertedVersions).toHaveLength(1);
  });
});

describe("FileService.abortUpload（取消上传）", () => {
  it("取消：中止分片 + 清暂存 + 置 aborted + 审计（幂等返回）", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1" });
    const result = await h.service.abortUpload(FILE, SESSION, ACTOR);

    expect(result.upload.status).toBe("aborted");
    expect(h.storage.aborted[0]).toMatchObject({ objectKey: STAGING_KEY, uploadId: "storage-1" });
    expect(h.storage.purged).toEqual([STAGING_KEY]);
    expect(h.repo.sessionPatches.at(-1)!.patch).toMatchObject({ status: "aborted", abortedAt: NOW });
    expect(h.audit.entries.at(-1)).toMatchObject({ action: "delete", objectType: "file", objectId: FILE, metadata: { uploadId: SESSION } });
  });

  it("重复取消（已 aborted / 已 expired）→ 幂等返回，不重复清存储", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ status: "aborted" });
    const result = await h.service.abortUpload(FILE, SESSION, ACTOR);
    expect(result.upload.status).toBe("aborted");
    expect(h.storage.aborted).toHaveLength(0);
    expect(h.storage.purged).toHaveLength(0);
  });

  it("已完成的上传 → 409（回退走版本回溯 M4-02）", async () => {
    const h = makeService();
    h.repo.session = makeSessionRow({ status: "completed", completedAt: NOW });
    await expect(h.service.abortUpload(FILE, SESSION, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
    expect(h.storage.purged).toHaveLength(0);
  });
});

describe("FileService.sweepExpiredSessions（worker 定时清理）", () => {
  const EXPIRED_A = "77777777-7777-4777-8777-777777777777";
  const EXPIRED_B = "88888888-8888-4888-8888-888888888888";

  function expiredRow(id: string, overrides: Partial<UploadSessionRow> = {}): UploadSessionRow & { projectId: string } {
    return {
      ...makeSessionRow({
        id,
        objectKey: `projects/${PROJECT}/files/${FILE}/staging/${id}`,
        storageUploadId: null,
        status: "active",
        expiresAt: new Date(NOW.getTime() - 60_000),
        ...overrides,
      }),
      projectId: PROJECT,
    };
  }

  it("逐条清理过期会话：中止分片 + 清暂存 + 置 expired，返回扫描 / 清理计数", async () => {
    const h = makeService();
    const rowA = expiredRow(EXPIRED_A, { storageUploadId: "storage-1" });
    const rowB = expiredRow(EXPIRED_B);
    h.repo.expiredRows = [rowA, rowB];
    const result = await h.service.sweepExpiredSessions();

    expect(result).toEqual({ scanned: 2, expired: 2 });
    expect(h.storage.aborted).toHaveLength(1);
    expect(h.storage.purged).toEqual([rowA.objectKey, rowB.objectKey]);
    expect(h.repo.sessionPatches.filter((p) => p.patch.status === "expired")).toHaveLength(2);
    expect(h.audit.entries).toHaveLength(2);
  });

  it("单条失败不阻断后续（只记告警）", async () => {
    const h = makeService();
    h.repo.failLockFor = EXPIRED_A;
    h.repo.expiredRows = [expiredRow(EXPIRED_A), expiredRow(EXPIRED_B)];
    const result = await h.service.sweepExpiredSessions();
    expect(result.scanned).toBe(2);
    expect(result.expired).toBe(1);
  });
});

describe("FileService.purgeFile（彻底删除 · 仅管理员）", () => {
  function recycledHarness(): Harness {
    const h = makeService();
    h.repo.file = makeFileRow({
      status: "recycled",
      version: 7,
      currentVersionId: VERSION_B,
      recycledAt: NOW,
      recycledBy: ACTOR,
      recycledFromStatus: "draft",
      purgeAfter: new Date(NOW.getTime() + 86_400_000),
    });
    h.repo.versions = [
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH }),
      makeVersionRow({ id: VERSION_B, seq: 2, objectKey: CONTRACT_KEY_V2, contentHash: OTHER_HASH }),
    ];
    return h;
  }

  it("非管理员 → 403 FORBIDDEN（对象与元数据都不动）", async () => {
    const h = recycledHarness();
    await expect(h.service.purgeFile(FILE, { version: 7 }, ACTOR)).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
    expect(h.storage.purged).toHaveLength(0);
    expect(h.repo.deletedFiles).toHaveLength(0);
  });

  it("管理员 + 回收站文件：按版本清对象 + 清 current_version_id + 删版本与文件行 + 留痕", async () => {
    const h = recycledHarness();
    h.permission.groupAccessAdmin = true;
    const result = await h.service.purgeFile(FILE, { version: 7, reason: "合规要求" }, ACTOR);

    expect(result).toEqual({ fileId: FILE, purgedAt: NOW.toISOString() });
    expect(h.storage.purged).toEqual([CONTRACT_KEY, CONTRACT_KEY_V2]);
    expect(h.repo.filePatches.at(-1)!.patch).toEqual({ currentVersionId: null });
    expect(h.repo.deletedFiles).toEqual([FILE]);
    expect(h.repo.versions).toHaveLength(0);
    expect(h.audit.entries.at(-1)).toMatchObject({
      actorId: ACTOR,
      action: "delete",
      objectType: "file",
      objectId: FILE,
      metadata: { source: "api", deletedVersions: 2, reason: "合规要求" },
    });
  });

  it("非回收站 → 409 FILE_STATE_INVALID；乐观锁不匹配 → 409（不清对象）", async () => {
    const h = recycledHarness();
    h.permission.groupAccessAdmin = true;
    h.repo.file = makeFileRow({ status: "final", version: 2 });
    await expect(h.service.purgeFile(FILE, { version: 2 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });

    const h2 = recycledHarness();
    h2.permission.groupAccessAdmin = true;
    await expect(h2.service.purgeFile(FILE, { version: 6 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(h2.storage.purged).toHaveLength(0);
    expect(h2.repo.deletedFiles).toHaveLength(0);
  });

  it("对象清理失败 → 映射契约错误且元数据不删（重试收敛）", async () => {
    const h = recycledHarness();
    h.permission.groupAccessAdmin = true;
    h.storage.purgeObject = async () => {
      throw new StorageError("unavailable", "S3 不可用");
    };
    await expect(h.service.purgeFile(FILE, { version: 7 }, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
    expect(h.repo.deletedFiles).toHaveLength(0);
    expect(h.repo.versions).toHaveLength(2);
  });
});

describe("FileService 预览产物清理（版本隔离）", () => {
  const ARTIFACT_FAILED = "88888888-8888-4888-8888-888888888888";

  function recycledHarness(): Harness {
    const h = makeService();
    h.repo.file = makeFileRow({
      status: "recycled",
      version: 7,
      currentVersionId: VERSION_B,
      recycledAt: NOW,
      recycledBy: ACTOR,
      recycledFromStatus: "draft",
      purgeAfter: new Date(NOW.getTime() + 86_400_000),
    });
    h.repo.versions = [
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH }),
      makeVersionRow({ id: VERSION_B, seq: 2, objectKey: CONTRACT_KEY_V2, contentHash: OTHER_HASH }),
    ];
    h.permission.groupAccessAdmin = true;
    return h;
  }

  it("唯一引用：清产物对象（与版本对象同序）+ 审计记数", async () => {
    const h = recycledHarness();
    h.previews.rows = [makeArtifactRow({ versionId: VERSION_A })];

    await h.service.purgeFile(FILE, { version: 7 }, ACTOR);

    expect(h.storage.purged).toEqual([CONTRACT_KEY, CONTRACT_KEY_V2, ARTIFACT_KEY]);
    const last = h.audit.entries.at(-1) as { summary: string; metadata: Record<string, unknown> };
    expect(last.metadata).toMatchObject({ previewArtifactsPurged: 1 });
    expect(last.summary).toContain("1 份预览产物");
  });

  it("同哈希的另一版本有独立产物：只清本文件的源对象和产物，不转移缓存归属", async () => {
    const h = recycledHarness();
    const otherKey = `previews/versions/${VERSION_C}/${HASH}/1.0.0/pdf`;
    const other = makeArtifactRow({ id: "99999999-9999-4999-8999-999999999999", fileId: OTHER_FILE, versionId: VERSION_C, objectKey: otherKey });
    h.previews.rows = [makeArtifactRow({ versionId: VERSION_A }), other];
    await h.service.purgeFile(FILE, { version: 7 }, ACTOR);
    expect(h.storage.purged).toEqual([CONTRACT_KEY, CONTRACT_KEY_V2, ARTIFACT_KEY]);
    expect(h.storage.purged).not.toContain(otherKey);
    expect(other).toMatchObject({ fileId: OTHER_FILE, versionId: VERSION_C });
  });

  it("not_ready / failed 行（无对象键）：不反查、不调存储", async () => {
    const h = recycledHarness();
    h.previews.rows = [
      makeArtifactRow({ versionId: VERSION_A, status: "not_ready", objectKey: null, generatedAt: null }),
      makeArtifactRow({
        id: ARTIFACT_FAILED,
        versionId: VERSION_B,
        status: "failed",
        objectKey: null,
        generatedAt: null,
        error: "转换超时",
      }),
    ];

    await h.service.purgeFile(FILE, { version: 7 }, ACTOR);

    expect(h.storage.purged).toEqual([CONTRACT_KEY, CONTRACT_KEY_V2]);
  });

  it("产物对象清理失败 → 映射契约错误并回滚（元数据与产物行都不动）", async () => {
    const h = recycledHarness();
    h.previews.rows = [makeArtifactRow({ versionId: VERSION_A })];
    h.storage.purgeObject = async (objectKey: string) => {
      if (objectKey === ARTIFACT_KEY) throw new StorageError("unavailable", "S3 不可用");
      h.storage.purged.push(objectKey);
      return { deletedVersions: 1, deleteMarkers: 0 };
    };

    await expect(h.service.purgeFile(FILE, { version: 7 }, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
    expect(h.repo.deletedFiles).toHaveLength(0);
    expect(h.repo.versions).toHaveLength(2);
    expect(h.previews.rows).toHaveLength(1);
  });

  it("回收站到期清理（worker）走同一路径：连带清产物对象 + system 留痕", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({
      status: "recycled",
      version: 2,
      recycledAt: new Date(NOW.getTime() - 31 * 86_400_000),
      recycledBy: ACTOR,
      recycledFromStatus: "draft",
      purgeAfter: new Date(NOW.getTime() - 86_400_000),
    });
    h.repo.versions = [makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH })];
    h.repo.expiredRecycledRows = [h.repo.file];
    h.previews.rows = [makeArtifactRow({ versionId: VERSION_A })];

    expect(await h.service.sweepExpiredRecycled()).toEqual({ scanned: 1, purged: 1 });
    expect(h.storage.purged).toEqual([CONTRACT_KEY, ARTIFACT_KEY]);
    expect(h.audit.entries.at(-1)).toMatchObject({
      actorId: null,
      metadata: { source: "system", deletedVersions: 1, previewArtifactsPurged: 1 },
    });
  });
});

describe("FileService.sweepExpiredRecycled（回收站到期清理 · worker）", () => {
  const FILE_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const VERSION_B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const KEY_B = `projects/${PROJECT}/files/${FILE_B}/v1/${HASH}.pdf`;

  function recycledRow(overrides: Partial<FileRow> = {}): FileRow {
    return makeFileRow({
      status: "recycled",
      version: 2,
      recycledAt: new Date(NOW.getTime() - 31 * 86_400_000),
      recycledBy: ACTOR,
      recycledFromStatus: "draft",
      purgeAfter: new Date(NOW.getTime() - 86_400_000),
      ...overrides,
    });
  }

  it("批量彻底删除到期文件：对象按版本清 + 元数据删 + system 留痕（actorId = null）", async () => {
    const h = makeService();
    const rowA = recycledRow();
    const rowB = recycledRow({ id: FILE_B });
    h.repo.file = rowA;
    h.repo.otherFiles = [rowB];
    h.repo.versions = [
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH }),
      makeVersionRow({ id: VERSION_B1, fileId: FILE_B, seq: 1, objectKey: KEY_B, contentHash: HASH }),
    ];
    h.repo.expiredRecycledRows = [rowA, rowB];

    const result = await h.service.sweepExpiredRecycled();
    expect(result).toEqual({ scanned: 2, purged: 2 });
    expect(h.storage.purged).toEqual([CONTRACT_KEY, KEY_B]);
    expect(h.repo.deletedFiles).toEqual([FILE, FILE_B]);
    expect(h.audit.entries).toHaveLength(2);
    expect(h.audit.entries.at(-1)).toMatchObject({
      actorId: null,
      action: "delete",
      objectId: FILE_B,
      metadata: { source: "system", deletedVersions: 1 },
    });
  });

  it("单条失败不阻断后续（下轮重试）；并发恢复的文件在锁下复核后跳过（不删对象）", async () => {
    const h = makeService();
    h.storage.purgeObject = async (objectKey: string) => {
      if (objectKey === CONTRACT_KEY) throw new StorageError("unavailable", "S3 不可用");
      return { deletedVersions: 1, deleteMarkers: 0 };
    };
    const rowA = recycledRow();
    const rowB = recycledRow({ id: FILE_B });
    h.repo.file = rowA;
    h.repo.otherFiles = [rowB];
    h.repo.versions = [
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH }),
      makeVersionRow({ id: VERSION_B1, fileId: FILE_B, seq: 1, objectKey: KEY_B, contentHash: HASH }),
    ];
    h.repo.expiredRecycledRows = [rowA, rowB];
    const result = await h.service.sweepExpiredRecycled();
    expect(result).toEqual({ scanned: 2, purged: 1 });
    expect(h.repo.deletedFiles).toEqual([FILE_B]);

    const restored = makeService();
    const row = recycledRow();
    restored.repo.file = makeFileRow({ status: "draft", version: 9 });
    restored.repo.versions = [makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH })];
    restored.repo.expiredRecycledRows = [row];
    expect(await restored.service.sweepExpiredRecycled()).toEqual({ scanned: 1, purged: 0 });
    expect(restored.storage.purged).toHaveLength(0);
    expect(restored.repo.deletedFiles).toHaveLength(0);
  });
});

describe("FileService.recycleFile / restoreFile（回收站：保留 30 天可恢复）", () => {
  it("回收：status=recycled + recycled 三列成对写 + purgeAfter = 保留期 + 乐观锁 + 审计", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", version: 6, finalizedAt: NOW, finalizedBy: ACTOR, currentVersionId: VERSION });
    const result = await h.service.recycleFile(FILE, { version: 6, reason: "现场作废" }, ACTOR);

    expect(result.status).toBe("recycled");
    expect(result.recycledAt).toBe(NOW.toISOString());
    expect(result.recycledBy).toBe(ACTOR);
    expect(result.recycledFromStatus).toBe("final");
    expect(h.repo.filePatches.at(-1)!.patch).toMatchObject({
      status: "recycled",
      recycledFromStatus: "final",
      purgeAfter: new Date(NOW.getTime() + 30 * 86_400_000),
      version: 7,
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "delete",
      objectType: "file",
      objectId: FILE,
      metadata: { fromStatus: "final", retainedDays: 30, reason: "现场作废" },
    });
  });

  it("保留期可配置：FILE_RECYCLE_RETENTION_DAYS = 7 → purgeAfter = 7 天后", async () => {
    const h = makeService({ FILE_RECYCLE_RETENTION_DAYS: 7 } as Partial<Env>);
    h.repo.file = makeFileRow({ status: "draft", version: 1 });
    await h.service.recycleFile(FILE, { version: 1 }, ACTOR);
    expect(h.repo.filePatches.at(-1)!.patch.purgeAfter).toEqual(new Date(NOW.getTime() + 7 * 86_400_000));
  });

  it("重复回收 → 409；乐观锁不匹配 → 409（不写状态）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "recycled", version: 7 });
    await expect(h.service.recycleFile(FILE, { version: 7 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });

    h.repo.file = makeFileRow({ status: "draft", version: 7 });
    await expect(h.service.recycleFile(FILE, { version: 6 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(h.repo.filePatches).toHaveLength(0);
  });

  it("恢复：回到进入前状态 + 清回收站三列与 purgeAfter + 审计 update", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({
      status: "recycled",
      version: 7,
      finalizedAt: NOW,
      finalizedBy: ACTOR,
      recycledAt: NOW,
      recycledBy: ACTOR,
      recycledFromStatus: "final",
      purgeAfter: new Date(NOW.getTime() + 86_400_000),
    });
    const result = await h.service.restoreFile(FILE, { version: 7 }, ACTOR);

    expect(result.status).toBe("final");
    expect(result.recycledAt).toBeNull();
    expect(result.recycledBy).toBeNull();
    expect(result.recycledFromStatus).toBeNull();
    expect(result.version).toBe(8);
    expect(h.repo.filePatches.at(-1)!.patch).toMatchObject({
      status: "final",
      recycledAt: null,
      recycledBy: null,
      recycledFromStatus: null,
      purgeAfter: null,
      version: 8,
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "update",
      objectId: FILE,
      changes: [{ field: "status", from: "recycled", to: "final" }],
    });
  });

  it("未回收的文件恢复 → 409 FILE_STATE_INVALID（不写状态）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", version: 2 });
    await expect(h.service.restoreFile(FILE, { version: 2 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
    expect(h.repo.filePatches).toHaveLength(0);
  });
});

describe("FileService.rollbackFile（版本回溯 · 生成新版本不删历史）", () => {
  function draftWithTwoVersions(): Harness {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION_B, version: 4 });
    h.repo.versions = [
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY, contentHash: HASH }),
      makeVersionRow({ id: VERSION_B, seq: 2, objectKey: CONTRACT_KEY_V2, contentHash: OTHER_HASH }),
    ];
    h.repo.nextSeqBase = 3;
    h.repo.nextVersionId = VERSION_C;
    return h;
  }

  it("成功：复制目标版对象到新版本契约键 + 新版本行 + current 指向新版本 + 审计 + outbox", async () => {
    const h = draftWithTwoVersions();
    const result = await h.service.rollbackFile(FILE, { toVersionId: VERSION_A, reason: "现场按 v1 施工", version: 4 }, ACTOR);

    expect(h.storage.copied).toHaveLength(1);
    expect(h.storage.copied[0]).toMatchObject({
      sourceKey: CONTRACT_KEY,
      destinationKey: CONTRACT_KEY_V3,
      contentType: "application/octet-stream",
    });
    expect(result.version).toMatchObject({ id: VERSION_C, seq: 3, contentHash: HASH, uploadedBy: ACTOR });
    expect(result.file.currentVersionId).toBe(VERSION_C);
    expect(result.file.version).toBe(5);
    expect(result.changeRequest).toBeNull();
    expect(h.repo.insertedVersions[0]).toMatchObject({ seq: 3, objectKey: CONTRACT_KEY_V3, contentHash: HASH });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "rollback",
      objectType: "file",
      objectId: FILE,
      metadata: { toVersionId: VERSION_A, fromSeq: 1, newSeq: 3, reason: "现场按 v1 施工" },
    });
    expect(h.database.outbox.at(-1)).toMatchObject({
      topic: "file.version.created",
      dedupeKey: "file.version.created:" + VERSION_C,
      status: "pending",
    });
  });

  it("定档后回溯 = 变更（M4-04 申请即通过）：changeRequest 非空 + 状态 changed + change 关联 / R01 / 审计 / outbox", async () => {
    const h = draftWithTwoVersions();
    h.repo.file = makeFileRow({ status: "final", currentVersionId: VERSION_B, version: 4, docType: "CAD图纸", nodeId: NODE });
    h.repo.deliverableTaskIds = [TASK];
    h.repo.nodeStageKey = "construction";

    const result = await h.service.rollbackFile(FILE, { toVersionId: VERSION_A, reason: "变更回溯到 v1", version: 4 }, ACTOR);

    expect(h.storage.copied).toHaveLength(1);
    expect(result.file.status).toBe("changed");
    expect(result.changeRequest).toMatchObject({
      status: "applied",
      reason: "变更回溯到 v1",
      fileId: FILE,
      versionId: VERSION_C,
      versionSeq: 3,
      nodeId: NODE,
      stageKey: "construction",
      appliedBy: ACTOR,
    });
    // 新版本挂变更 + 变更记录（无摘要 / 阶段取节点默认）+ R01 回写
    expect(h.repo.insertedVersions[0]!.changeRequestId).toBe(result.changeRequest!.id);
    expect(h.repo.insertedChanges[0]).toMatchObject({
      nodeId: NODE,
      stageKey: "construction",
      reason: "变更回溯到 v1",
      beforeSummary: null,
      afterSummary: null,
    });
    expect(h.repo.changeRefAppends).toEqual([{ taskIds: [TASK], changeRequestId: result.changeRequest!.id }]);
    expect(h.repo.insertedLinks.map((row) => row.objectType)).toContain("change");
    // 变更审计（objectType=change）+ 回溯审计（带 changeRequestId）
    expect(h.audit.entries.at(-2)).toMatchObject({
      action: "create",
      objectType: "change",
      objectId: result.changeRequest!.id,
      changes: [{ field: "status", from: "final", to: "changed" }],
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "rollback",
      objectType: "file",
      objectId: FILE,
      metadata: { toVersionId: VERSION_A, reason: "变更回溯到 v1", changeRequestId: result.changeRequest!.id },
    });
    expect(h.database.outbox.map((row) => (row as { topic: string }).topic)).toEqual(["change.applied", "file.version.created"]);
  });

  it("回收站中回溯 → 409 FILE_STATE_INVALID（不复制对象、不落版本）", async () => {
    const h = draftWithTwoVersions();
    h.repo.file = makeFileRow({
      status: "recycled",
      version: 5,
      recycledAt: NOW,
      recycledBy: ACTOR,
      recycledFromStatus: "draft",
      purgeAfter: new Date(NOW.getTime() + 86_400_000),
    });
    await expect(h.service.rollbackFile(FILE, { toVersionId: VERSION_A, reason: "回退", version: 5 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
    expect(h.storage.copied).toHaveLength(0);
    expect(h.repo.insertedVersions).toHaveLength(0);
  });

  it("目标版本不存在 → 404；目标即当前版本 → 400 already_current（均不复制对象）", async () => {
    const h = draftWithTwoVersions();
    await expect(h.service.rollbackFile(FILE, { toVersionId: VERSION_C, reason: "回退", version: 4 }, ACTOR)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(h.service.rollbackFile(FILE, { toVersionId: VERSION_B, reason: "回退", version: 4 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: [{ code: "already_current", path: "toVersionId" }],
    });
    expect(h.storage.copied).toHaveLength(0);
  });

  it("乐观锁不匹配 → 409（对象已复制但事务不落版本）；位次被并发占用 → 500 INTERNAL", async () => {
    const h = draftWithTwoVersions();
    await expect(h.service.rollbackFile(FILE, { toVersionId: VERSION_A, reason: "回退", version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);

    const h2 = draftWithTwoVersions();
    h2.repo.seqDriftOnLock = true;
    await expect(h2.service.rollbackFile(FILE, { toVersionId: VERSION_A, reason: "回退", version: 4 }, ACTOR)).rejects.toMatchObject({
      code: "INTERNAL",
      httpStatus: 500,
    });
    expect(h2.repo.insertedVersions).toHaveLength(0);
  });
});

describe("FileService.getFile / listFileVersions（M4-02 读面）", () => {
  it("详情：含当前版本；无版本时 currentVersion = null", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 1 });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    const detail = await h.service.getFile(FILE, ACTOR);
    expect(detail.id).toBe(FILE);
    expect(detail.currentVersion).toMatchObject({ id: VERSION, seq: 1, contentHash: HASH });

    h.repo.file = makeFileRow({ currentVersionId: null });
    expect((await h.service.getFile(FILE, ACTOR)).currentVersion).toBeNull();
  });

  it("版本链：按 seq 升序回 items / total；文件不存在 → 404", async () => {
    const h = makeService();
    h.repo.versions = [
      makeVersionRow({ id: VERSION_B, seq: 2, objectKey: CONTRACT_KEY_V2, contentHash: OTHER_HASH }),
      makeVersionRow({ id: VERSION_A, seq: 1, objectKey: CONTRACT_KEY }),
    ];
    const list = await h.service.listFileVersions(FILE, ACTOR);
    expect(list.total).toBe(2);
    expect(list.items.map((item) => item.seq)).toEqual([1, 2]);

    h.repo.file = null;
    await expect(h.service.getFile(FILE, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(h.service.listFileVersions(FILE, ACTOR)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });
});

describe("FileService.finalizeFile（定档锁版）", () => {
  it("成功：draft → final + finalized 成对字段 + 乐观锁递增 + 审计 + outbox", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 5 });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    const result = await h.service.finalizeFile(FILE, { version: 5 }, ACTOR);

    expect(result.status).toBe("final");
    expect(result.finalizedAt).toBe(NOW.toISOString());
    expect(result.finalizedBy).toBe(ACTOR);
    expect(result.version).toBe(6);
    expect(h.repo.filePatches.at(-1)!.patch).toMatchObject({ status: "final", finalizedBy: ACTOR, version: 6 });
    expect(h.audit.entries.at(-1)).toMatchObject({ action: "complete", objectType: "file", objectId: FILE });
    expect(
      h.database.outbox.find((entry) => (entry as { topic: string }).topic === "file.finalized"),
    ).toMatchObject({
      topic: "file.finalized",
      dedupeKey: "file.finalized:" + FILE + ":6",
      status: "pending",
    });
    // M4-05c 定档预生成（P1）：PDF 2026-10-08 并入查看器通道、图片 S6-前置 起改原对象直签 —— 均不再投 preview.job
    // （业务口径「统一用onlyoffice」）；本用例只有 file.finalized，预生成负例见下方 .png / .zip 用例。
    expect((h.database.outbox as { topic: string }[]).map((entry) => entry.topic)).toEqual(["file.finalized"]);
  });

  it("并发定档（version 不匹配）→ 409 VERSION_CONFLICT（details 带 current / expected）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", version: 5 });
    await expect(h.service.finalizeFile(FILE, { version: 4 }, ACTOR)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
      details: [{ code: "version_conflict", meta: { expected: 4, current: 5 } }],
    });
    expect(h.repo.filePatches).toHaveLength(0);
  });

  it("状态不允许（final / recycled）→ 409 FILE_STATE_INVALID；无版本 → 400 no_version", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", currentVersionId: VERSION, version: 6 });
    await expect(h.service.finalizeFile(FILE, { version: 6 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });

    h.repo.file = makeFileRow({ status: "recycled", version: 3 });
    await expect(h.service.finalizeFile(FILE, { version: 3 }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });

    h.repo.file = makeFileRow({ status: "draft", version: 0 });
    await expect(h.service.finalizeFile(FILE, { version: 0 }, ACTOR)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: [{ code: "no_version", path: "version" }],
    });
    expect(h.database.outbox).toHaveLength(0);
  });

  it("定档预生成：非预览类型（.zip）不投 preview.job —— 判不出通道就不占转换配额", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 1, name: "交付包.zip" });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    await h.service.finalizeFile(FILE, { version: 1 }, ACTOR);

    expect((h.database.outbox as { topic: string }[]).map((entry) => entry.topic)).toEqual(["file.finalized"]);
  });

  it("定档预生成：图片版本（.png）不投 preview.job（S6-前置 直签后转换管线无投递）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 1, name: "现场照片.png" });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1, mime: "image/png" })];
    await h.service.finalizeFile(FILE, { version: 1 }, ACTOR);

    expect((h.database.outbox as { topic: string }[]).map((entry) => entry.topic)).toEqual(["file.finalized"]);
  });
});

describe("FileService.listProjectFiles（M4-03 文件库查询）", () => {
  it("筛选解析下推：多值状态 / 类型 + UUID + 关键字 trim + 分页 offset + 排序", async () => {
    const h = makeService();
    h.repo.libraryItems = [makeFileRow()];
    h.repo.libraryTotal = 7;

    const result = await h.service.listProjectFiles(PROJECT, {
      "filter[nodeId]": NODE,
      "filter[status]": "draft, final",
      "filter[docType]": "CAD图纸,合同",
      "filter[uploadedBy]": ACTOR,
      q: "  图纸  ",
      page: 1,
      limit: 50,
      sort: "createdAt:desc",
    });

    const query = h.repo.libraryQueries[0]!;
    expect(query.projectId).toBe(PROJECT);
    expect(query.filter).toEqual({
      nodeId: NODE,
      taskId: null,
      statuses: ["draft", "final"],
      docTypes: ["CAD图纸", "合同"],
      uploadedBy: ACTOR,
      keyword: "图纸",
    });
    expect(query.sorts).toEqual([{ field: "createdAt", direction: "desc" }]);
    expect(query.limit).toBe(50);
    expect(query.offset).toBe(0);
    expect(result).toMatchObject({ page: 1, limit: 50, total: 7 });
    expect(result.items[0]).toMatchObject({ id: FILE, projectId: PROJECT, status: "draft", name: "机械设计图纸.pdf" });
    expect(result.items[0]!.createdAt).toBe(NOW.toISOString());

    // 分页 offset 下推（page 3 / limit 10 → offset = 20）
    await h.service.listProjectFiles(PROJECT, { page: 3, limit: 10 });
    expect(h.repo.libraryQueries[1]!.offset).toBe(20);
  });

  it("默认口径：不带筛选 = 全 null（仓储默认排除 recycled）；空排序 = 默认时间倒序", async () => {
    const h = makeService();
    await h.service.listProjectFiles(PROJECT, { page: 1, limit: 50 });
    const query = h.repo.libraryQueries[0]!;
    expect(query.filter).toEqual({
      nodeId: null,
      taskId: null,
      statuses: null,
      docTypes: null,
      uploadedBy: null,
      keyword: null,
    });
    expect(query.sorts).toEqual([]);
    expect(query.offset).toBe(0);
  });

  it("非法输入一律 400 且不落查询：sort 白名单外 / 非法状态 / 非法类型 / 非 UUID / 非法方向", async () => {
    const h = makeService();
    await expect(h.service.listProjectFiles(PROJECT, { page: 1, limit: 50, sort: "sizeBytes:desc" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    await expect(
      h.service.listProjectFiles(PROJECT, { page: 1, limit: 50, "filter[status]": "draft,pending" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    await expect(
      h.service.listProjectFiles(PROJECT, { page: 1, limit: 50, "filter[docType]": "CAD图纸,发票" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    await expect(
      h.service.listProjectFiles(PROJECT, { page: 1, limit: 50, "filter[taskId]": "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    await expect(h.service.listProjectFiles(PROJECT, { page: 1, limit: 50, sort: "createdAt:up" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(h.repo.libraryQueries).toHaveLength(0);
  });
});

describe("FileService.completeUpload 关联写入（M4-03 file_links）", () => {
  function readyHarness(): Harness {
    const h = makeService();
    h.repo.file = makeFileRow({ nodeId: NODE, taskId: TASK });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/pdf" });
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = {
      objectKey: STAGING_KEY,
      sizeBytes: 12 * MI_B,
      etag: "\"merged-etag\"",
      contentType: "application/pdf",
      lastModified: NOW,
    };
    return h;
  }

  it("上传成功写 file_links：project 必写 + node / task 有则写", async () => {
    const h = readyHarness();
    await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(h.repo.insertedLinks.map((row) => [row.objectType, row.objectId])).toEqual([
      ["project", PROJECT],
      ["node", NODE],
      ["task", TASK],
    ]);
    expect(
      h.repo.insertedLinks.every(
        (row) => row.fileId === FILE && row.createdBy === ACTOR && row.createdAt.getTime() === NOW.getTime(),
      ),
    ).toBe(true);
  });

  it("无节点 / 任务挂接 = 只写 project 一行", async () => {
    const h = readyHarness();
    h.repo.file = makeFileRow();
    await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(h.repo.insertedLinks.map((row) => row.objectType)).toEqual(["project"]);
  });

  it("重复完成（追加版本 / 重试）幂等：同一 (file, object) 不产生重复行", async () => {
    const h = readyHarness();
    await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    const first = h.repo.insertedLinks.length;
    h.repo.file = makeFileRow({ nodeId: NODE, taskId: TASK, version: 1, currentVersionId: VERSION });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/pdf" });
    await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(h.repo.insertedLinks).toHaveLength(first);
  });
});

describe("FileService.completeUpload 变更写入（M4-04 申请即通过 · intent=change）", () => {
  /** 定档文件 + change 意图会话（分片齐、哈希一致、载荷带摘要）。 */
  function changeHarness(): Harness {
    const h = makeService();
    h.repo.file = makeFileRow({
      status: "final",
      nodeId: NODE,
      docType: "CAD图纸",
      version: 3,
      currentVersionId: VERSION_A,
    });
    h.repo.session = makeSessionRow({
      intent: "change",
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "application/pdf",
      changePayload: {
        reason: "设计变更（变更单 CR-2026-0918）",
        beforeSummary: "v1 按初版施工",
        afterSummary: "按变更单调整孔位",
        stageKey: null,
      },
    });
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = {
      objectKey: STAGING_KEY,
      sizeBytes: 12 * MI_B,
      etag: "\"merged-etag\"",
      contentType: "application/pdf",
      lastModified: NOW,
    };
    return h;
  }

  it("Push 314：摘要附图随 complete 落 change_requests 并随读面回显", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "final", nodeId: NODE, taskId: TASK, docType: "CAD图纸", version: 3, currentVersionId: VERSION_A });
    h.repo.session = makeSessionRow({
      intent: "change",
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "application/pdf",
      changePayload: {
        reason: "带图变更",
        beforeSummary: "变更前照片随摘要",
        afterSummary: null,
        beforeSummaryFileIds: [IMG_A],
        afterSummaryFileIds: [IMG_B],
        stageKey: null,
      },
    });
    h.repo.nodeStageKey = "construction";

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);

    expect(h.repo.insertedChanges[0]).toMatchObject({
      beforeSummary: "变更前照片随摘要",
      beforeSummaryFileIds: [IMG_A],
      afterSummaryFileIds: [IMG_B],
    });
    expect(result.changeRequest).toMatchObject({
      beforeSummary: "变更前照片随摘要",
      beforeSummaryFileIds: [IMG_A],
      afterSummaryFileIds: [IMG_B],
    });
  });

  it("生效链路：change_requests(applied) + 版本挂 change_request_id + 状态 changed + change 关联 + R01 回写 + 变更审计 + outbox", async () => {
    const h = changeHarness();
    // Push 255：文件同时挂任务（TASK）—— 归属回写与 R01 结果先去重再写
    h.repo.file = makeFileRow({ status: "final", nodeId: NODE, taskId: TASK, docType: "CAD图纸", version: 3, currentVersionId: VERSION_A });
    h.repo.deliverableTaskIds = [TASK, OTHER_TASK];
    h.repo.nodeStageKey = "construction";

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);

    // 变更记录：载荷取自会话 change_payload；stageKey 缺省时按节点阶段回填
    expect(h.repo.insertedChanges).toHaveLength(1);
    const change = h.repo.insertedChanges[0]!;
    expect(change).toMatchObject({
      projectId: PROJECT,
      nodeId: NODE,
      stageKey: "construction",
      reason: "设计变更（变更单 CR-2026-0918）",
      beforeSummary: "v1 按初版施工",
      afterSummary: "按变更单调整孔位",
      appliedBy: ACTOR,
    });
    // 新版本挂变更；文件 final → changed；会话完成
    expect(h.repo.insertedVersions[0]!.changeRequestId).toBe(change.id);
    expect(result.file.status).toBe("changed");
    expect(result.version.changeRequestId).toBe(change.id);
    expect(result.changeRequest).toMatchObject({
      id: change.id,
      projectId: PROJECT,
      status: "applied",
      reason: "设计变更（变更单 CR-2026-0918）",
      nodeId: NODE,
      stageKey: "construction",
      fileId: FILE,
      versionId: VERSION,
      versionSeq: 1,
      appliedBy: ACTOR,
    });
    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("completed");
    // 多态关联：project / node / task（文件挂 TASK，Push 255 用例）/ change（change 指向本次变更）
    expect(h.repo.insertedLinks.map((row) => row.objectType)).toEqual(["project", "node", "task", "change"]);
    expect(h.repo.insertedLinks.find((row) => row.objectType === "change")!.objectId).toBe(change.id);
    // 任务关联（Push 255）：① 所属任务（TASK）② R01 docType ∈ deliverable_types 多值命中（TASK / OTHER_TASK）—— 并集去重后写 change_refs
    expect(h.repo.deliverableQueries).toEqual([{ projectId: PROJECT, deliverable: "CAD图纸" }]);
    expect(h.repo.changeRefAppends).toEqual([{ taskIds: [TASK, OTHER_TASK], changeRequestId: change.id }]);
    // 审计：变更 create（objectType=change）+ 上传 complete（metadata 带 changeRequestId）
    expect(h.audit.entries.at(-2)).toMatchObject({
      action: "create",
      objectType: "change",
      objectId: change.id,
      projectId: PROJECT,
      changes: [{ field: "status", from: "final", to: "changed" }],
      metadata: {
        fileId: FILE,
        versionId: VERSION,
        versionSeq: 1,
        nodeId: NODE,
        stageKey: "construction",
        deliverableType: "CAD图纸",
        matchedTasks: [TASK, OTHER_TASK],
        ownerTaskId: TASK,
        linkedTaskIds: [TASK, OTHER_TASK],
        linkedTasks: 2,
      },
    });
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "complete",
      objectType: "file",
      objectId: FILE,
      metadata: { changeRequestId: change.id },
    });
    // outbox：先变更广播（change.applied）、再既有版本广播
    expect(h.database.outbox.map((row) => (row as { topic: string }).topic)).toEqual(["change.applied", "file.version.created"]);
    expect(h.database.outbox[0]).toMatchObject({
      dedupeKey: "change.applied:" + change.id,
      status: "pending",
      payload: { changeRequestId: change.id, fileId: FILE, versionId: VERSION, matchedTasks: [TASK, OTHER_TASK], ownerTaskId: TASK },
    });
  });

  it("（Push 256）变更后文件名称随上传采纳（业务口径「变更后文件的名字后后缀要用变更选择的」）：完成时 files.name 更名 + 对象键 / 存储元数据用新扩展名 + 审计记 name 变化", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "final", nodeId: NODE, taskId: TASK, docType: "CAD图纸", version: 3, currentVersionId: VERSION_A });
    h.repo.session = makeSessionRow({
      intent: "change",
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      changePayload: {
        reason: "变更后文件后缀随上传",
        beforeSummary: null,
        afterSummary: null,
        stageKey: null,
        fileName: "回放-变更后.pptx",
      },
    });
    h.storage.prefix = ZIP_PREFIX;
    h.repo.deliverableTaskIds = [TASK];
    h.repo.nodeStageKey = "construction";

    await h.service.completeUpload(FILE, SESSION, { contentHash: declareActualHash(h) }, ACTOR);

    // files.name 更名；新版本对象键 / 存储元数据用变更后扩展名（.pptx）——历史版本对象键不动（假旧名不改写）
    expect(h.repo.file!.name).toBe("回放-变更后.pptx");
    expect(h.repo.insertedVersions[0]!.objectKey).toBe(`projects/${PROJECT}/files/${FILE}/v1/${h.repo.insertedVersions[0]!.contentHash}.pptx`);
    expect(h.storage.copied[0]!.destinationKey).toBe(`projects/${PROJECT}/files/${FILE}/v1/${h.repo.insertedVersions[0]!.contentHash}.pptx`);
    expect(h.storage.copied[0]!.metadata).toMatchObject({ "file-name": encodeURIComponent("回放-变更后.pptx") });
    // 审计：完成变更上传记「旧名 → 新名」；变更 create 审计的 changes 同步带 name 变化
    const completeAudit = h.audit.entries.at(-1) as { summary: string; changes: { field: string; from: unknown; to: unknown }[] };
    expect(completeAudit.summary).toContain("机械设计图纸.pdf → 回放-变更后.pptx");
    expect(completeAudit.changes).toContainEqual({ field: "name", from: "机械设计图纸.pdf", to: "回放-变更后.pptx" });
    const changeAudit = h.audit.entries.at(-2) as { changes: { field: string }[] };
    expect(changeAudit.changes).toContainEqual({ field: "name", from: "机械设计图纸.pdf", to: "回放-变更后.pptx" });
  });

  it("（Push 255）成果类型为空但文件挂了任务 → 所属任务直接回写变更关联（业务反馈「变更记录 / 变更关联没显示」）", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "changed", nodeId: NODE, taskId: TASK, docType: null, version: 4, currentVersionId: VERSION_A });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    try {
      const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
      expect(result.changeRequest).not.toBeNull();
      expect(result.file.status).toBe("changed");
      // 前端上传口不带成果类型（doc_type 空）→ R01 零匹配；但变更发生在 TASK 里 → 该任务必须拿到 change_refs
      expect(h.repo.deliverableQueries).toHaveLength(0);
      expect(h.repo.changeRefAppends).toEqual([{ taskIds: [TASK], changeRequestId: result.changeRequest!.id }]);
      expect(h.audit.entries.at(-2)).toMatchObject({
        action: "create",
        objectType: "change",
        metadata: { matchedTasks: [], ownerTaskId: TASK, linkedTaskIds: [TASK], linkedTasks: 1 },
      });
      expect(warn.mock.calls.some((call) => String(call[0]).includes("变更无关联任务"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("所属任务为空 + R01 无匹配（成果类型为空）→ 只记日志、不阻断变更生效", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "changed", nodeId: NODE, docType: null, version: 4, currentVersionId: VERSION_A });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    try {
      const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
      expect(result.changeRequest).not.toBeNull();
      expect(result.file.status).toBe("changed");
      expect(h.repo.deliverableQueries).toHaveLength(0);
      expect(h.repo.changeRefAppends).toEqual([{ taskIds: [], changeRequestId: result.changeRequest!.id }]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("变更无关联任务"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("会话持有期间目标被改回未定档（draft）→ 409 FILE_STATE_INVALID，版本与变更均不落", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "draft", nodeId: NODE, docType: "CAD图纸", version: 3, currentVersionId: VERSION_A });
    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "FILE_STATE_INVALID",
      httpStatus: 409,
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.repo.insertedChanges).toHaveLength(0);
    expect(h.database.outbox).toHaveLength(0);
  });

  it("（Push 254 续）会话持有期间任务已定档 + 目标 draft → 放行：版本 + 变更落库、状态 changed（业务口径「不是已经定档了吗」）", async () => {
    const h = changeHarness();
    h.repo.file = makeFileRow({ status: "draft", nodeId: NODE, taskId: TASK, docType: "CAD图纸", version: 3, currentVersionId: VERSION_A });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: NOW };
    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(result.file.status).toBe("changed");
    expect(h.repo.insertedVersions).toHaveLength(1);
    expect(h.repo.insertedChanges).toHaveLength(1);
  });
});


describe("Push 249 · 任务定档联动与写口闸（业务口径「若是则上传文件后该任务定档不支持任何修改」）", () => {
  const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");

  it("挂接任务的文件定档：同事务置位任务定档 + 写任务审计；未挂接任务的文件定档不置位", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 5, taskId: TASK });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    h.repo.abortedTaskSessionCount = 2;
    await h.service.finalizeFile(FILE, { version: 5 }, ACTOR);

    expect(h.repo.finalizedTasks).toEqual([{ taskId: TASK, actorId: ACTOR }]);
    // 定档兜底：撤销在途 version 上传会话，条数记入任务审计 metadata
    expect(h.repo.abortedTaskUploadSessions).toEqual([{ taskId: TASK, at: NOW }]);
    expect(h.audit.entries.map((entry) => (entry as { objectType: string }).objectType)).toEqual(["file", "task"]);
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "update",
      objectType: "task",
      objectId: TASK,
      projectId: PROJECT,
      metadata: { fileId: FILE, fileStatus: "final", abortedUploadSessions: 2 },
    });

    const h2 = makeService();
    h2.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 1, taskId: null });
    h2.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    await h2.service.finalizeFile(FILE, { version: 1 }, ACTOR);
    expect(h2.repo.finalizedTasks).toEqual([]);
    expect(h2.repo.abortedTaskUploadSessions).toEqual([]);
    expect(h2.audit.entries.map((entry) => (entry as { objectType: string }).objectType)).toEqual(["file"]);
  });

  it("任务已定档：intent=version 新增上传 → 409 TASK_FINALIZED（不落会话）", async () => {
    const h = makeService();
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, taskId: TASK, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
      details: [{ code: "task_finalized", path: "taskId" }],
    });
    expect(h.repo.insertedSessions).toHaveLength(0);
    expect(h.repo.insertedFiles).toHaveLength(0);
  });

  it("任务已定档：文件改名 → 409 TASK_FINALIZED（不落库）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", taskId: TASK, version: 2 });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    await expect(h.service.renameFile(FILE, { version: 2, name: "新名.pdf" }, ACTOR)).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
    });
    expect(h.repo.filePatches).toHaveLength(0);
  });

  it("先开会话、后定档：completeUpload 事务内复核 → 409 TASK_FINALIZED（不落版本、会话不完成）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ taskId: TASK });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/pdf" });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = {
      objectKey: STAGING_KEY,
      sizeBytes: 12 * MI_B,
      etag: "\"merged-etag\"",
      contentType: "application/pdf",
      lastModified: NOW,
    };

    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
      details: [{ code: "task_finalized", path: "taskId" }],
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.repo.sessionPatches).toHaveLength(0);
  });

  it("任务已定档：change 意图 completeUpload 照常成功（A4-13 修改走变更，唯一保留通道）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", docType: "CAD图纸", taskId: TASK, currentVersionId: VERSION, version: 1 });
    h.repo.session = makeSessionRow({
      intent: "change",
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "application/pdf",
      changePayload: { reason: "按变更单调整孔位", beforeSummary: null, afterSummary: null, stageKey: null },
    });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    h.repo.deliverableTaskIds = [TASK];
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = { objectKey: STAGING_KEY, sizeBytes: 12 * MI_B, etag: null, contentType: null, lastModified: NOW };

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(result.changeRequest).not.toBeNull();
    expect(h.repo.insertedVersions).toHaveLength(1);
    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("completed");
  });

  it("未定档任务：intent=version 上传照常（对照）", async () => {
    const h = makeService();
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: null };
    const created = await h.service.createUpload(
      { projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, taskId: TASK, intent: "version" },
      ACTOR,
    );
    expect(created.file.name).toBe("图纸.pdf");
    expect(h.repo.finalizedTasks).toEqual([]);
  });
});


describe("Push 249 · 任务定档联动与写口闸（业务口径「若是则上传文件后该任务定档不支持任何修改」）", () => {
  const FINALIZED_AT = new Date("2026-10-08T02:00:00Z");

  it("挂接任务的文件定档：同事务置位任务定档 + 写任务审计；未挂接任务的文件定档不置位", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 5, taskId: TASK });
    h.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    h.repo.abortedTaskSessionCount = 2;
    await h.service.finalizeFile(FILE, { version: 5 }, ACTOR);

    expect(h.repo.finalizedTasks).toEqual([{ taskId: TASK, actorId: ACTOR }]);
    // 定档兜底：撤销在途 version 上传会话，条数记入任务审计 metadata
    expect(h.repo.abortedTaskUploadSessions).toEqual([{ taskId: TASK, at: NOW }]);
    expect(h.audit.entries.map((entry) => (entry as { objectType: string }).objectType)).toEqual(["file", "task"]);
    expect(h.audit.entries.at(-1)).toMatchObject({
      action: "update",
      objectType: "task",
      objectId: TASK,
      projectId: PROJECT,
      metadata: { fileId: FILE, fileStatus: "final", abortedUploadSessions: 2 },
    });

    const h2 = makeService();
    h2.repo.file = makeFileRow({ status: "draft", currentVersionId: VERSION, version: 1, taskId: null });
    h2.repo.versions = [makeVersionRow({ id: VERSION, seq: 1 })];
    await h2.service.finalizeFile(FILE, { version: 1 }, ACTOR);
    expect(h2.repo.finalizedTasks).toEqual([]);
    expect(h2.repo.abortedTaskUploadSessions).toEqual([]);
    expect(h2.audit.entries.map((entry) => (entry as { objectType: string }).objectType)).toEqual(["file"]);
  });

  it("任务已定档：intent=version 新增上传 → 409 TASK_FINALIZED（不落会话）", async () => {
    const h = makeService();
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    await expect(
      h.service.createUpload({ projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, taskId: TASK, intent: "version" }, ACTOR),
    ).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
      details: [{ code: "task_finalized", path: "taskId" }],
    });
    expect(h.repo.insertedSessions).toHaveLength(0);
    expect(h.repo.insertedFiles).toHaveLength(0);
  });

  it("任务已定档：文件改名 → 409 TASK_FINALIZED（不落库）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", taskId: TASK, version: 2 });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    await expect(h.service.renameFile(FILE, { version: 2, name: "新名.pdf" }, ACTOR)).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
    });
    expect(h.repo.filePatches).toHaveLength(0);
  });

  it("先开会话、后定档：completeUpload 事务内复核 → 409 TASK_FINALIZED（不落版本、会话不完成）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ taskId: TASK });
    h.repo.session = makeSessionRow({ storageUploadId: "storage-1", contentHash: HASH, mime: "application/pdf" });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = {
      objectKey: STAGING_KEY,
      sizeBytes: 12 * MI_B,
      etag: "\"merged-etag\"",
      contentType: "application/pdf",
      lastModified: NOW,
    };

    await expect(h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR)).rejects.toMatchObject({
      code: "TASK_FINALIZED",
      httpStatus: 409,
      details: [{ code: "task_finalized", path: "taskId" }],
    });
    expect(h.repo.insertedVersions).toHaveLength(0);
    expect(h.repo.sessionPatches).toHaveLength(0);
  });

  it("任务已定档：change 意图 completeUpload 照常成功（A4-13 修改走变更，唯一保留通道）", async () => {
    const h = makeService();
    h.repo.file = makeFileRow({ status: "final", docType: "CAD图纸", taskId: TASK, currentVersionId: VERSION, version: 1 });
    h.repo.session = makeSessionRow({
      intent: "change",
      storageUploadId: "storage-1",
      contentHash: HASH,
      mime: "application/pdf",
      changePayload: { reason: "按变更单调整孔位", beforeSummary: null, afterSummary: null, stageKey: null },
    });
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: FINALIZED_AT };
    h.repo.deliverableTaskIds = [TASK];
    h.storage.parts = [part(1, 8 * MI_B), part(2, 4 * MI_B)];
    h.storage.head = { objectKey: STAGING_KEY, sizeBytes: 12 * MI_B, etag: null, contentType: null, lastModified: NOW };

    const result = await h.service.completeUpload(FILE, SESSION, { contentHash: HASH }, ACTOR);
    expect(result.changeRequest).not.toBeNull();
    expect(h.repo.insertedVersions).toHaveLength(1);
    expect(h.repo.sessionPatches.at(-1)!.patch.status).toBe("completed");
  });

  it("未定档任务：intent=version 上传照常（对照）", async () => {
    const h = makeService();
    h.repo.task = { id: TASK, projectId: PROJECT, finalizedAt: null };
    const created = await h.service.createUpload(
      { projectId: PROJECT, name: "图纸.pdf", sizeBytes: MI_B, taskId: TASK, intent: "version" },
      ACTOR,
    );
    expect(created.file.name).toBe("图纸.pdf");
    expect(h.repo.finalizedTasks).toEqual([]);
  });
});
