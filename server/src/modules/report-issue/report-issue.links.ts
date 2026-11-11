/**
 * 日报 / 问题附图关联 + 成对删除（Push 215 · 方案一）：
 * - 日报两张图都挂 file_links(object_type=report)，用 kind 区分：onsite 现场工作附图 / issue 当前问题附图；
 * - 日报提交生成问题时，问题图「删 report 侧链 + 建 issue 侧链」转挂到问题，问题侧可独立增删
 *   （file_links(object_type=issue)，kind 恒为空串 —— 问题侧只有一种图，不再细分）；
 * - 成对删除的行清理：file_links 是多态关联（无外键到 report / issue），必须由应用层删；
 *   issue_events.issue_id 无级联，先删事件再删问题；issues.source_report_id 无级联，先删问题再删日报。
 * 文件校验：附图必须属于本项目且未进回收站（400，不是 404 —— 请求体里的引用不成立）。
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import type { DbClient } from "../../db/db-client.js";
import { fileLinks, fileVersions, files } from "../../db/schema/files.js";
import { dailyReports, issueEvents, issues } from "../../db/schema/reports.js";

/** 附图引用（契约 FilePhotoRef）。 */
export interface FilePhotoRefRow {
  fileId: string;
  name: string;
}

/** 查询海报专用附件元数据（对象键仅留在服务端，不进入公开 API 响应）。 */
export interface FilePosterPhotoRow extends FilePhotoRefRow {
  objectKey: string | null;
  mime: string | null;
}

/** 日报附图两类（file_links.kind）。 */
export type ReportPhotoKind = "onsite" | "issue";

/** 校验文件存在、属于本项目且未进回收站；返回 fileId → 文件名。 */
export async function assertPhotoFilesInProject(
  projectId: string,
  fileIds: readonly string[],
  client: DbClient,
): Promise<Map<string, string>> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return new Map();
  const rows = await client
    .select({ id: files.id, name: files.name })
    .from(files)
    .where(and(eq(files.projectId, projectId), inArray(files.id, unique), ne(files.status, "recycled")));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const missing = unique.filter((id) => !names.has(id));
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "附图文件不存在 / 不属于本项目，或已进回收站",
      missing.map((id) => ({ code: "unknown_file", message: "文件：" + id, path: "photoFileIds" })),
    );
  }
  return names;
}

/** 批量读日报附图（kind 分组，插入序）。 */
export async function loadReportPhotos(
  reportIds: readonly string[],
  client: DbClient,
): Promise<Map<string, { onsite: FilePhotoRefRow[]; issue: FilePhotoRefRow[] }>> {
  const result = new Map<string, { onsite: FilePhotoRefRow[]; issue: FilePhotoRefRow[] }>();
  const unique = [...new Set(reportIds)];
  for (const id of unique) result.set(id, { onsite: [], issue: [] });
  if (unique.length === 0) return result;
  const rows = await client
    .select({ objectId: fileLinks.objectId, kind: fileLinks.kind, fileId: fileLinks.fileId, name: files.name })
    .from(fileLinks)
    .leftJoin(files, eq(files.id, fileLinks.fileId))
    .where(and(eq(fileLinks.objectType, "report"), inArray(fileLinks.objectId, unique)))
    .orderBy(fileLinks.createdAt, fileLinks.id);
  for (const row of rows) {
    const bucket = result.get(row.objectId);
    if (bucket === undefined) continue;
    const ref: FilePhotoRefRow = { fileId: row.fileId, name: row.name ?? "" };
    if (row.kind === "issue") bucket.issue.push(ref);
    else if (row.kind === "onsite") bucket.onsite.push(ref);
  }
  return result;
}

/** 批量读问题附图（file_links(object_type=issue)，插入序）。 */
export async function loadIssuePhotos(issueIds: readonly string[], client: DbClient): Promise<Map<string, FilePhotoRefRow[]>> {
  const result = new Map<string, FilePhotoRefRow[]>();
  const unique = [...new Set(issueIds)];
  for (const id of unique) result.set(id, []);
  if (unique.length === 0) return result;
  const rows = await client
    .select({ objectId: fileLinks.objectId, fileId: fileLinks.fileId, name: files.name })
    .from(fileLinks)
    .leftJoin(files, eq(files.id, fileLinks.fileId))
    .where(and(eq(fileLinks.objectType, "issue"), inArray(fileLinks.objectId, unique)))
    .orderBy(fileLinks.createdAt, fileLinks.id);
  for (const row of rows) {
    const bucket = result.get(row.objectId);
    if (bucket !== undefined) bucket.push({ fileId: row.fileId, name: row.name ?? "" });
  }
  return result;
}

async function loadPosterPhotoRows(
  objectType: "report" | "issue",
  objectIds: readonly string[],
  client: DbClient,
): Promise<Array<{ objectId: string; kind: string; photo: FilePosterPhotoRow }>> {
  const unique = [...new Set(objectIds)];
  if (unique.length === 0) return [];
  const rows = await client
    .select({
      objectId: fileLinks.objectId,
      kind: fileLinks.kind,
      fileId: fileLinks.fileId,
      name: files.name,
      objectKey: fileVersions.objectKey,
      mime: fileVersions.mime,
    })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.fileId))
    .leftJoin(fileVersions, eq(fileVersions.id, files.currentVersionId))
    .where(and(eq(fileLinks.objectType, objectType), inArray(fileLinks.objectId, unique)))
    .orderBy(fileLinks.createdAt, fileLinks.id);
  return rows.map((row) => ({
    objectId: row.objectId,
    kind: row.kind,
    photo: {
      fileId: row.fileId,
      name: row.name,
      objectKey: row.objectKey,
      mime: row.mime,
    },
  }));
}

/** 日报查询海报附件：日报图与问题图分开，附带当前版本 objectKey / MIME，不读对象字节。 */
export async function loadReportPosterPhotos(
  reportIds: readonly string[],
  client: DbClient,
): Promise<Map<string, { onsite: FilePosterPhotoRow[]; issue: FilePosterPhotoRow[] }>> {
  const result = new Map<string, { onsite: FilePosterPhotoRow[]; issue: FilePosterPhotoRow[] }>();
  for (const id of new Set(reportIds)) result.set(id, { onsite: [], issue: [] });
  const rows = await loadPosterPhotoRows("report", reportIds, client);
  for (const row of rows) {
    const bucket = result.get(row.objectId);
    if (bucket === undefined) continue;
    if (row.kind === "issue") bucket.issue.push(row.photo);
    else if (row.kind === "onsite") bucket.onsite.push(row.photo);
  }
  return result;
}

/** 问题查询海报附件：保持 file_links 插入顺序，附带当前版本 objectKey / MIME。 */
export async function loadIssuePosterPhotos(
  issueIds: readonly string[],
  client: DbClient,
): Promise<Map<string, FilePosterPhotoRow[]>> {
  const result = new Map<string, FilePosterPhotoRow[]>();
  for (const id of new Set(issueIds)) result.set(id, []);
  const rows = await loadPosterPhotoRows("issue", issueIds, client);
  for (const row of rows) {
    result.get(row.objectId)?.push(row.photo);
  }
  return result;
}

/** 追加写日报附图（on conflict do nothing 幂等）。 */
export async function insertReportPhotos(
  reportId: string,
  kind: ReportPhotoKind,
  fileIds: readonly string[],
  actorId: string,
  at: Date,
  client: DbClient,
): Promise<void> {
  if (fileIds.length === 0) return;
  await client
    .insert(fileLinks)
    .values(fileIds.map((fileId) => ({ fileId, objectType: "report", objectId: reportId, kind, createdBy: actorId, createdAt: at })))
    .onConflictDoNothing();
}

/** 整体替换某日报某一类附图（先清后建；空数组 = 清空）。 */
export async function replaceReportPhotos(
  reportId: string,
  kind: ReportPhotoKind,
  fileIds: readonly string[],
  actorId: string,
  at: Date,
  client: DbClient,
): Promise<void> {
  await client
    .delete(fileLinks)
    .where(and(eq(fileLinks.objectType, "report"), eq(fileLinks.objectId, reportId), eq(fileLinks.kind, kind)));
  await insertReportPhotos(reportId, kind, fileIds, actorId, at, client);
}

/** 整体替换问题附图（file_links(object_type=issue)；空数组 = 清空）。 */
export async function replaceIssuePhotos(
  issueId: string,
  fileIds: readonly string[],
  actorId: string,
  at: Date,
  client: DbClient,
): Promise<void> {
  await client.delete(fileLinks).where(and(eq(fileLinks.objectType, "issue"), eq(fileLinks.objectId, issueId)));
  if (fileIds.length === 0) return;
  await client
    .insert(fileLinks)
    .values(fileIds.map((fileId) => ({ fileId, objectType: "issue", objectId: issueId, kind: "", createdBy: actorId, createdAt: at })))
    .onConflictDoNothing();
}

/** 问题图转挂（A3-09 提交生成问题）：report 侧 kind='issue' 的链删除，在 issue 侧重建（保序）。 */
export async function moveIssuePhotosToIssue(
  reportId: string,
  issueId: string,
  actorId: string,
  at: Date,
  client: DbClient,
): Promise<void> {
  const conditions = and(eq(fileLinks.objectType, "report"), eq(fileLinks.objectId, reportId), eq(fileLinks.kind, "issue"));
  const rows = await client.select({ fileId: fileLinks.fileId }).from(fileLinks).where(conditions).orderBy(fileLinks.createdAt, fileLinks.id);
  await client.delete(fileLinks).where(conditions);
  if (rows.length === 0) return;
  await client
    .insert(fileLinks)
    .values(rows.map((row) => ({ fileId: row.fileId, objectType: "issue", objectId: issueId, kind: "", createdBy: actorId, createdAt: at })))
    .onConflictDoNothing();
}

/** 删链（file_links 无外键到 report / issue，多态由应用层清理）。 */
export async function deleteFileLinks(objectType: "report" | "issue", objectIds: readonly string[], client: DbClient): Promise<void> {
  if (objectIds.length === 0) return;
  await client
    .delete(fileLinks)
    .where(and(eq(fileLinks.objectType, objectType), inArray(fileLinks.objectId, [...objectIds])));
}

/** 删问题域行：事件 → 问题侧链 → 问题行三步（issue_events.issue_id 无级联）。 */
export async function purgeIssues(issueIds: readonly string[], client: DbClient): Promise<void> {
  if (issueIds.length === 0) return;
  const ids = [...issueIds];
  await client.delete(issueEvents).where(inArray(issueEvents.issueId, ids));
  await deleteFileLinks("issue", ids, client);
  await client.delete(issues).where(inArray(issues.id, ids));
}

/** 删日报及其派生问题（成对删除），返回连带删除的问题 id 列表（含全部派生问题）。 */
export async function purgeReportCascade(reportId: string, client: DbClient): Promise<string[]> {
  const rows = await client.select({ id: issues.id }).from(issues).where(eq(issues.sourceReportId, reportId));
  const issueIds = rows.map((row) => row.id);
  await purgeIssues(issueIds, client);
  await deleteFileLinks("report", [reportId], client);
  await client.delete(dailyReports).where(eq(dailyReports.id, reportId));
  return issueIds;
}
