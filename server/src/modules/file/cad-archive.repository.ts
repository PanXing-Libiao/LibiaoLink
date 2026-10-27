import { Injectable } from "@nestjs/common";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { cadArtifacts, cadViews } from "../../db/schema/cad.js";
import { files } from "../../db/schema/files.js";
import { AuditService, type AuditRecordInput } from "../admin/index.js";
import { CAD_ENGINE_VERSION } from "./cad-release.js";
import type { CadNameCodepage } from "@libiaolink/contracts";
import { cadInputs, type CadArchiveSource } from "./cad-inputs.js";
export type { CadArchiveSource } from "./cad-inputs.js";

export type CadArtifactRow = typeof cadArtifacts.$inferSelect;
export type CadViewRow = typeof cadViews.$inferSelect;
export type CadFailureContext = { nativeJobId?: string; terminalState?: "failed" | "timed-out" | "cancelled" };

const TIMEOUT_CODES = new Set(["job-timeout", "job-queue-timeout", "conversion-timeout"]);
const LIMIT_CODES = new Set(["job-memory-quota", "job-output-quota", "artifact-budget", "engine-busy"]);

@Injectable()
export class CadArchiveRepository {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async request(source: CadArchiveSource, codepage: CadNameCodepage, client: DbClient = this.database.db): Promise<CadArtifactRow> {
    const input = cadInputs(source);
    codepage = input.sourceFormat === "DXF" ? "UTF8" : codepage;
    const inserted = await client.insert(cadArtifacts).values({ ...input, engineVersion: CAD_ENGINE_VERSION, nameCodepage: codepage })
      .onConflictDoNothing({ target: [cadArtifacts.versionId, cadArtifacts.engineVersion, cadArtifacts.nameCodepage, cadArtifacts.resourceSetHash] }).returning();
    const row = inserted[0] ?? (await client.select().from(cadArtifacts).where(and(eq(cadArtifacts.versionId, source.versionId),
      eq(cadArtifacts.engineVersion, CAD_ENGINE_VERSION), eq(cadArtifacts.nameCodepage, codepage),
      eq(cadArtifacts.resourceSetHash, input.resourceSetHash))).limit(1))[0];
    if (!row || row.fileId !== source.fileId || row.sourceSHA256 !== source.sourceSHA256 || row.sourceBytes !== source.sourceBytes) {
      throw new Error("CAD version identity mismatch");
    }
    return row;
  }

  async openView(artifactId: string, actorId: string, viewId: string): Promise<CadViewRow> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    const rows = await this.database.db.insert(cadViews).values({ artifactId, actorId, viewId, expiresAt })
      .onConflictDoUpdate({ target: [cadViews.actorId, cadViews.viewId, cadViews.artifactId],
        set: { expiresAt, cancelled: false, leaseExpiresAt: null } }).returning();
    return rows[0]!;
  }

  async view(jobId: string, source: CadArchiveSource, actorId: string, viewId: string) {
    if (!/^[a-f0-9]{32}$/.test(jobId)) return null;
    const id = jobId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const rows = await this.database.db.select({ view: cadViews, artifact: cadArtifacts }).from(cadViews)
      .innerJoin(cadArtifacts, eq(cadArtifacts.id, cadViews.artifactId)).where(and(eq(cadViews.id, id),
        eq(cadViews.actorId, actorId), eq(cadViews.viewId, viewId), gt(cadViews.expiresAt, new Date()),
        eq(cadArtifacts.versionId, source.versionId), eq(cadArtifacts.fileId, source.fileId),
        eq(cadArtifacts.engineVersion, CAD_ENGINE_VERSION), eq(cadArtifacts.sourceSHA256, source.sourceSHA256))).limit(1);
    return rows[0] ?? null;
  }

  async cancelView(id: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [view] = await tx.update(cadViews).set({ cancelled: true, leaseExpiresAt: null })
        .where(and(eq(cadViews.id, id), eq(cadViews.cancelled, false))).returning();
      if (!view) return;
      const [artifact] = await tx.select().from(cadArtifacts).where(eq(cadArtifacts.id, view.artifactId));
      if (!artifact) throw new Error("CAD view lost its artifact");
      await this.recordAudit(tx, artifact, {
        actorId: view.actorId, action: "update", result: "succeeded", entry: "api", summary: "取消 CAD 预览窗口",
        metadata: { operation: "cad.cancelled", versionId: artifact.versionId, artifactId: artifact.id,
          engineVersion: artifact.engineVersion, nameCodepage: artifact.nameCodepage,
          viewId: view.viewId, viewJobId: view.id.replaceAll("-", "") },
      });
    });
  }

  async rejectInput(source: CadArchiveSource, actorId: string, viewId: string, codepage: CadNameCodepage, limitBytes: number, inputSetBytes = source.sourceBytes): Promise<void> {
    await this.recordAudit(this.database.db, source, {
      actorId, action: "update", result: "failed", entry: "api", summary: "CAD 输入大小超出处理限制",
      metadata: { operation: "cad.limit_exceeded", errorCode: "input-limit", versionId: source.versionId,
        engineVersion: CAD_ENGINE_VERSION, nameCodepage: codepage, viewId, sourceBytes: source.sourceBytes, inputSetBytes, limitBytes },
    });
  }
  async lease(id: string, release = false): Promise<void> {
    await this.database.db.update(cadViews).set({ leaseExpiresAt: release ? null : new Date(Date.now() + 300_000) })
      .where(and(eq(cadViews.id, id), eq(cadViews.cancelled, false)));
  }

  async retry(id: string, expectedState: string, objectPrefix?: string | null): Promise<void> {
    await this.database.db.update(cadArtifacts).set({ state: "queued", phase: "queued", attempts: 0,
      availableAt: new Date(), claimToken: null, claimUntil: null, error: null, errorCode: null, updatedAt: new Date() })
      .where(and(eq(cadArtifacts.id, id), eq(cadArtifacts.state, expectedState),
        objectPrefix ? eq(cadArtifacts.objectPrefix, objectPrefix) : undefined));
  }

  async claim(): Promise<CadArtifactRow | null> {
    return this.database.db.transaction(async (tx) => {
      const now = new Date();
      const row = (await tx.select().from(cadArtifacts).where(and(eq(cadArtifacts.engineVersion, CAD_ENGINE_VERSION),
        or(and(eq(cadArtifacts.state, "queued"), lt(cadArtifacts.availableAt, now)),
          and(eq(cadArtifacts.state, "running"), lt(cadArtifacts.claimUntil, now)))))
        .orderBy(cadArtifacts.availableAt).limit(1).for("update", { skipLocked: true }))[0];
      if (!row) return null;
      if (row.state === "running" || row.attempts >= 3) {
        await this.recordFailure(tx, row, "worker-interrupted", row.attempts < 3);
      }
      if (row.attempts >= 3) {
        await tx.update(cadArtifacts).set({ state: "failed", phase: "failed", claimToken: null, claimUntil: null,
          errorCode: "worker-interrupted", error: "CAD 后台任务多次中断，请重新打开后重试", updatedAt: now })
          .where(eq(cadArtifacts.id, row.id));
        return null;
      }
      const token = randomUUID();
      const rows = await tx.update(cadArtifacts).set({ state: "running", phase: "reading", claimToken: token,
        claimUntil: new Date(Date.now() + 60_000), attempts: row.attempts + 1, updatedAt: now })
        .where(eq(cadArtifacts.id, row.id)).returning();
      return rows[0] ?? null;
    });
  }

  async renew(row: CadArtifactRow, phase?: string): Promise<boolean> {
    const rows = await this.database.db.update(cadArtifacts).set({ claimUntil: new Date(Date.now() + 60_000),
      updatedAt: new Date(), ...(phase ? { phase } : {}) }).where(this.owner(row)).returning({ id: cadArtifacts.id });
    return rows.length > 0;
  }

  async publish(row: CadArtifactRow, result: Pick<CadArtifactRow, "objectPrefix" | "manifestSHA256" | "manifestBytes" | "resourceLease" | "buffers" | "artifactBytes">,
    state: "completed" | "partial" = "completed"): Promise<boolean> {
    const rows = await this.database.db.update(cadArtifacts).set({ ...result, state, phase: state,
      claimToken: null, claimUntil: null, error: null, errorCode: null, updatedAt: new Date() })
      .where(this.owner(row)).returning({ id: cadArtifacts.id });
    return rows.length > 0;
  }

  async fail(row: CadArtifactRow, code: string, message: string, retryable: boolean, context: CadFailureContext = {}): Promise<void> {
    const retry = retryable && row.attempts < 3;
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx.update(cadArtifacts).set({ state: retry ? "queued" : "failed", phase: retry ? "queued" : "failed",
        errorCode: code, error: message.slice(0, 500), claimToken: null, claimUntil: null,
        availableAt: new Date(Date.now() + Math.min(60_000, 5000 * 2 ** row.attempts)), updatedAt: new Date() })
        .where(this.owner(row)).returning();
      if (updated) await this.recordFailure(tx, updated, code, retry, context);
    });
  }

  async clearExpiredViews(): Promise<void> {
    await this.database.db.delete(cadViews).where(lt(cadViews.expiresAt, new Date()));
  }

  async purgeInputs(fileId: string, client: DbClient = this.database.db): Promise<string[]> {
    const rows = await client.delete(cadArtifacts).where(or(eq(cadArtifacts.fileId, fileId),
      sql`${cadArtifacts.companions} @> ${JSON.stringify([{ fileId }])}::jsonb`)).returning({ prefix: cadArtifacts.objectPrefix });
    return rows.flatMap((row) => row.prefix ? [row.prefix] : []);
  }

  private async recordFailure(client: DbClient, row: CadArtifactRow, code: string, retry: boolean, context: CadFailureContext = {}) {
    const timedOut = context.terminalState === "timed-out" || TIMEOUT_CODES.has(code);
    const limited = LIMIT_CODES.has(code);
    await this.recordAudit(client, row, {
      actorId: null, action: "update", result: "failed", entry: "system",
      summary: timedOut ? "CAD 解析超时" : limited ? "CAD 解析资源超限" : "CAD 后台任务失败",
      metadata: { operation: timedOut ? "cad.timed_out" : limited ? "cad.limit_exceeded" : "cad.failed",
        versionId: row.versionId, artifactId: row.id, engineVersion: row.engineVersion, nameCodepage: row.nameCodepage,
        attempt: row.attempts, errorCode: code, retryScheduled: retry, ...context },
    });
  }

  private async recordAudit(client: DbClient, source: Pick<CadArchiveSource, "fileId" | "versionId">,
    input: Omit<AuditRecordInput, "objectType" | "objectId" | "projectId">) {
    const [file] = await client.select({ projectId: files.projectId }).from(files).where(eq(files.id, source.fileId));
    if (!file) throw new Error("CAD audit file is unavailable");
    await this.audit.record(client, { ...input, objectType: "file", objectId: source.fileId, projectId: file.projectId });
  }

  private owner(row: CadArtifactRow) {
    return and(eq(cadArtifacts.id, row.id), eq(cadArtifacts.state, "running"),
      eq(cadArtifacts.claimToken, row.claimToken!), gt(cadArtifacts.claimUntil, new Date()));
  }
}
