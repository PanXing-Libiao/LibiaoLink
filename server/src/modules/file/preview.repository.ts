import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/db-client.js";
import { DatabaseService } from "../../db/database.service.js";
import { previewArtifacts } from "../../db/schema/preview.js";
import type { PreviewTarget } from "./preview.job.js";

/** 预览缓存按 version_id + pipeline_version + target 隔离（迁移 0067）。
 * contentHash 仅绑定该不可变版本，不作为跨文件或跨项目的读取凭据。
 * ready / failed 仅可由 not_ready 转入，过期失败任务不能降级已就绪产物。
 */

export type PreviewArtifactRow = typeof previewArtifacts.$inferSelect;

/** 版本缓存键；contentHash 同时参与读写条件，防止版本元数据不一致时复用产物。 */
export interface PreviewArtifactKey {
  versionId: string;
  contentHash: string;
  pipelineVersion: string;
  target: PreviewTarget;
}

@Injectable()
export class PreviewRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByKey(key: PreviewArtifactKey, client: DbClient = this.database.db): Promise<PreviewArtifactRow | null> {
    const rows = await client.select().from(previewArtifacts).where(this.keyWhere(key)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * 首次请求登记（not_ready）：同版本缓存键已存在（含并发插入）**不覆盖**，原样返回既有行 ——
   * 调用方据此判断「已有 ready 就复用 / 已有 failed 就按缓存态处理，不做原地重试」。
   */
  async ensureRequested(
    input: { fileId: string; versionId: string } & PreviewArtifactKey,
    client: DbClient = this.database.db,
  ): Promise<PreviewArtifactRow> {
    const inserted = await client
      .insert(previewArtifacts)
      .values({
        fileId: input.fileId,
        versionId: input.versionId,
        contentHash: input.contentHash,
        pipelineVersion: input.pipelineVersion,
        target: input.target,
        status: "not_ready",
      })
      .onConflictDoNothing({
        target: [previewArtifacts.versionId, previewArtifacts.pipelineVersion, previewArtifacts.target],
      })
      .returning();
    if (inserted[0] !== undefined) {
      return inserted[0];
    }
    const existing = await this.findByKey(input, client);
    if (existing === null) {
      throw new Error("预览产物登记失败：版本缓存键写入后读不到行（并发删除？）");
    }
    return existing;
  }

  /** 产物就绪：object_key / generated_at 成对写入（ck_preview_artifacts_ready_pair），失败原因保持为空。 */
  async markReady(
    key: PreviewArtifactKey,
    input: { objectKey: string; generatedAt: Date },
    client: DbClient = this.database.db,
  ): Promise<void> {
    await client
      .update(previewArtifacts)
      .set({
        status: "ready",
        objectKey: input.objectKey,
        generatedAt: input.generatedAt,
        error: null,
        updatedAt: input.generatedAt,
      })
      .where(and(this.keyWhere(key), eq(previewArtifacts.status, "not_ready")));
  }

  /**
   * 产物失败：error 与 failed 成对（ck_preview_artifacts_failed_pair），object_key / generated_at 必须清空
   * （ready 成对约束是双向的）。error 由调用方截到 ≤ 500（CHECK ck_preview_artifacts_error_length）。
   */
  async markFailed(
    key: PreviewArtifactKey,
    input: { error: string; updatedAt: Date },
    client: DbClient = this.database.db,
  ): Promise<void> {
    await client
      .update(previewArtifacts)
      .set({
        status: "failed",
        error: input.error,
        objectKey: null,
        generatedAt: null,
        updatedAt: input.updatedAt,
      })
      .where(and(this.keyWhere(key), eq(previewArtifacts.status, "not_ready")));
  }

  /**
   * 待清理候选（M4-05 收口 · 彻底删除 / 到期清理）：这些版本名下的 **ready** 产物行。
   * 只有 ready 行才有对象键（库侧成对 CHECK）；not_ready / failed 无对象，行随版本级联即可。
   */
  async listReadyByVersionIds(
    versionIds: readonly string[],
    client: DbClient = this.database.db,
  ): Promise<PreviewArtifactRow[]> {
    if (versionIds.length === 0) return [];
    return client
      .select()
      .from(previewArtifacts)
      .where(and(inArray(previewArtifacts.versionId, [...versionIds]), eq(previewArtifacts.status, "ready")));
  }

  private keyWhere(key: PreviewArtifactKey) {
    return and(
      eq(previewArtifacts.versionId, key.versionId),
      eq(previewArtifacts.contentHash, key.contentHash),
      eq(previewArtifacts.pipelineVersion, key.pipelineVersion),
      eq(previewArtifacts.target, key.target),
    );
  }
}
