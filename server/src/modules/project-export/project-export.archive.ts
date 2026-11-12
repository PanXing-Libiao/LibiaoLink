import type { ProjectExportFileRef } from "../file/index.js";

export { ZipWriter as ProjectZipWriter } from "../../common/zip/index.js";
export { shouldCompressZipEntry as shouldCompressProjectArchiveEntry } from "../../common/zip/index.js";
export type { ZipWriteResult as ProjectZipWriteResult } from "../../common/zip/index.js";

export type ProjectExportFormat = "xlsx" | "zip";
export type ProjectArchiveAttachmentStatus = "included" | "missing" | "skipped";

export const PROJECT_ARCHIVE_MAX_FILE_COUNT = 3_000;
export const PROJECT_ARCHIVE_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const PROJECT_ARCHIVE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface ProjectArchiveAttachmentSource {
  /** 稳定键只用于本次导出内回填 Excel 链接，不写入 ZIP 或 manifest。 */
  key: string;
  sourcePage: string;
  sourceRow: number;
  sourceRecord: string;
  attachmentType: string;
  /** 相对「附件」目录的子路径，如「日报及问题汇总/现场工作附图」。 */
  directory: string;
  fileId: string;
  fileName: string;
}

export interface ProjectArchiveFile {
  relativePath: string;
  zipDirectory: string;
  fileName: string;
  fileId: string;
  ref: ProjectExportFileRef | null;
  sizeBytes: number | null;
  sha256: string | null;
  status: ProjectArchiveAttachmentStatus;
}

export interface ProjectArchiveAttachmentReference extends ProjectArchiveAttachmentSource {
  file: ProjectArchiveFile;
}

export interface ProjectArchivePlan {
  references: ProjectArchiveAttachmentReference[];
  files: ProjectArchiveFile[];
}

export interface ProjectArchiveManifestAttachment {
  sourcePage: string;
  sourceRow: number;
  sourceRecord: string;
  attachmentType: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number | null;
  sha256: string | null;
  status: ProjectArchiveAttachmentStatus;
}

export interface ProjectArchiveManifest {
  schemaVersion: 1;
  exportedAt: string;
  project: { code: string; name: string };
  workbook: string;
  attachments: ProjectArchiveManifestAttachment[];
  summary: {
    attachmentCount: number;
    fileCount: number;
    includedCount: number;
    includedFileCount: number;
    missingCount: number;
    skippedCount: number;
    attachmentBytes: number;
  };
}

const WINDOWS_INVALID = /[\\/:*?"<>|\u0000-\u001f]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;
const LEADING_DOTS = /^\.+/;

/** 保留中文与项目编号外面的方括号；只清掉跨平台文件名 / ZIP 路径不能安全使用的字符。 */
export function sanitizeProjectArchiveSegment(value: string, fallback: string, maxLength = 140): string {
  let result = value.replace(WINDOWS_INVALID, "_").replace(LEADING_DOTS, "").replace(TRAILING_DOTS_OR_SPACES, "").trim();
  if (result === "") result = fallback;
  return result.slice(0, maxLength).replace(TRAILING_DOTS_OR_SPACES, "") || fallback;
}

export function projectArchiveHref(relativePath: string): string {
  return "./" + relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function splitFileName(value: string): { stem: string; extension: string } {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { stem: value, extension: "" };
  return { stem: value.slice(0, dot), extension: value.slice(dot) };
}

function allocFileName(directory: string, requestedName: string, fileId: string, used: Map<string, string>): string {
  const clean = sanitizeProjectArchiveSegment(requestedName, "文件");
  const { stem, extension } = splitFileName(clean);
  let candidate = clean;
  let suffix = 2;
  while (true) {
    const key = directory.toLowerCase() + "\u0000" + candidate.toLowerCase();
    const owner = used.get(key);
    if (owner === undefined || owner === fileId) {
      used.set(key, fileId);
      return candidate;
    }
    candidate = sanitizeProjectArchiveSegment(stem.slice(0, Math.max(1, 120 - extension.length)) + "_" + String(suffix), "文件") + extension;
    suffix += 1;
  }
}

/**
 * 只规划被 Excel 业务行引用的附件，不打包项目文件库里的散文件。
 * 同一目录中的同一文件只入包一次；同目录重名文件追加 _2、_3，绝不覆盖。
 */
export function planProjectArchiveAttachments(
  sources: readonly ProjectArchiveAttachmentSource[],
  refs: ReadonlyMap<string, ProjectExportFileRef>,
): ProjectArchivePlan {
  const references: ProjectArchiveAttachmentReference[] = [];
  const files: ProjectArchiveFile[] = [];
  const fileByKey = new Map<string, ProjectArchiveFile>();
  const usedNames = new Map<string, string>();
  let includedCandidates = 0;
  let reservedBytes = 0;

  for (const source of sources) {
    const ref = refs.get(source.fileId) ?? null;
    const directory = ["附件", ...source.directory.split("/").map((part) => sanitizeProjectArchiveSegment(part, "附件"))].join("/");
    const planKey = directory.toLowerCase() + "\u0000" + source.fileId;
    let file = fileByKey.get(planKey);
    if (file === undefined) {
      const fileName = allocFileName(directory, ref?.name ?? source.fileName, source.fileId, usedNames);
      let status: ProjectArchiveAttachmentStatus = "included";
      if (ref === null || ref.objectKey === null) {
        status = "missing";
      } else if (ref.sizeBytes !== null && ref.sizeBytes > PROJECT_ARCHIVE_MAX_FILE_BYTES) {
        status = "skipped";
      } else if (includedCandidates >= PROJECT_ARCHIVE_MAX_FILE_COUNT) {
        status = "skipped";
      } else if (ref.sizeBytes !== null && reservedBytes + ref.sizeBytes > PROJECT_ARCHIVE_MAX_TOTAL_BYTES) {
        status = "skipped";
      }
      if (status === "included") {
        includedCandidates += 1;
        reservedBytes += ref?.sizeBytes ?? 0;
      }
      file = {
        relativePath: directory + "/" + fileName,
        zipDirectory: directory,
        fileName,
        fileId: source.fileId,
        ref,
        sizeBytes: ref?.sizeBytes ?? null,
        sha256: null,
        status,
      };
      files.push(file);
      fileByKey.set(planKey, file);
    }
    references.push({ ...source, file });
  }
  return { references, files };
}

export function projectArchiveLinks(plan: ProjectArchivePlan): Map<string, string> {
  const links = new Map<string, string>();
  for (const reference of plan.references) {
    if (reference.file.status !== "included") continue;
    links.set(reference.key, projectArchiveHref(reference.file.relativePath));
  }
  return links;
}

export function buildProjectArchiveManifest(input: {
  project: { code: string; name: string };
  workbook: string;
  plan: ProjectArchivePlan;
  exportedAt: Date;
}): ProjectArchiveManifest {
  const attachments = input.plan.references.map((reference) => ({
    sourcePage: reference.sourcePage,
    sourceRow: reference.sourceRow,
    sourceRecord: reference.sourceRecord,
    attachmentType: reference.attachmentType,
    fileName: reference.file.fileName,
    relativePath: reference.file.relativePath,
    sizeBytes: reference.file.sizeBytes,
    sha256: reference.file.sha256,
    status: reference.file.status,
  }));
  const includedFiles = input.plan.files.filter((file) => file.status === "included");
  return {
    schemaVersion: 1,
    exportedAt: input.exportedAt.toISOString(),
    project: input.project,
    workbook: input.workbook,
    attachments,
    summary: {
      attachmentCount: attachments.length,
      fileCount: input.plan.files.length,
      includedCount: attachments.filter((attachment) => attachment.status === "included").length,
      includedFileCount: includedFiles.length,
      missingCount: attachments.filter((attachment) => attachment.status === "missing").length,
      skippedCount: attachments.filter((attachment) => attachment.status === "skipped").length,
      attachmentBytes: includedFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    },
  };
}

export function projectArchiveManifestJson(manifest: ProjectArchiveManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
