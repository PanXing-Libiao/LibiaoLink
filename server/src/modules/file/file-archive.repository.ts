import { Injectable } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { jobs } from "../../db/schema/platform.js";
import { files, fileVersions } from "../../db/schema/files.js";
import { projects } from "../../db/schema/projects.js";
import { DatabaseService } from "../../db/database.service.js";
import type { FileRow, FileVersionRow } from "./file.repository.js";
import { FILE_ARCHIVE_CLEANUP_JOB_KIND } from "./file-archive.constants.js";

export interface FileArchiveProjectRow {
  id: string;
  code: string;
  name: string;
  status: string;
  deletedAt: Date | null;
}

export interface FileArchiveCleanupJobInput {
  batchId: string;
  objectKey: string;
  runAt: Date;
}

/** 批量下载专用的只读查询与一次性清理任务写入；不引入业务表或迁移。 */
@Injectable()
export class FileArchiveRepository {
  constructor(private readonly database: DatabaseService) {}

  async findProject(projectId: string): Promise<FileArchiveProjectRow | null> {
    const rows = await this.database.db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        status: projects.status,
        deletedAt: projects.deletedAt,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findFilesByIds(ids: readonly string[]): Promise<FileRow[]> {
    if (ids.length === 0) return [];
    return this.database.db.select().from(files).where(inArray(files.id, [...new Set(ids)]));
  }

  async findVersionsByIds(ids: readonly string[]): Promise<FileVersionRow[]> {
    if (ids.length === 0) return [];
    return this.database.db.select().from(fileVersions).where(inArray(fileVersions.id, [...new Set(ids)]));
  }

  /** 一次性 ZIP 清理任务：dedupeKey 保证同一批次只入队一次。 */
  async enqueueCleanup(input: FileArchiveCleanupJobInput): Promise<void> {
    await this.database.db
      .insert(jobs)
      .values({
        kind: FILE_ARCHIVE_CLEANUP_JOB_KIND,
        payload: { batchId: input.batchId, objectKey: input.objectKey },
        cron: null,
        runAt: input.runAt,
        status: "pending",
        dedupeKey: "file-archive-cleanup:" + input.batchId,
      })
      .onConflictDoNothing({ target: jobs.dedupeKey });
  }
}
