import { Injectable } from "@nestjs/common";
import { and, eq, gt, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { cadArtifacts, cadViews } from "../../db/schema/cad.js";
import { CAD_ENGINE_VERSION } from "./cad-release.js";
import type { CadNameCodepage } from "@libiaolink/contracts";

export type CadArtifactRow = typeof cadArtifacts.$inferSelect;
export type CadViewRow = typeof cadViews.$inferSelect;
export type CadArchiveSource = { fileId: string; versionId: string; sourceSHA256: string; sourceBytes: number; sourceName: string };

@Injectable()
export class CadArchiveRepository {
  constructor(private readonly database: DatabaseService) {}

  async request(source: CadArchiveSource, codepage: CadNameCodepage, client: DbClient = this.database.db): Promise<CadArtifactRow> {
    const inserted = await client.insert(cadArtifacts).values({ ...source, engineVersion: CAD_ENGINE_VERSION, nameCodepage: codepage })
      .onConflictDoNothing({ target: [cadArtifacts.versionId, cadArtifacts.engineVersion, cadArtifacts.nameCodepage] }).returning();
    const row = inserted[0] ?? (await client.select().from(cadArtifacts).where(and(eq(cadArtifacts.versionId, source.versionId),
      eq(cadArtifacts.engineVersion, CAD_ENGINE_VERSION), eq(cadArtifacts.nameCodepage, codepage))).limit(1))[0];
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
    await this.database.db.update(cadViews).set({ cancelled: true, leaseExpiresAt: null }).where(eq(cadViews.id, id));
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

  async publish(row: CadArtifactRow, result: Pick<CadArtifactRow, "objectPrefix" | "manifestSHA256" | "manifestBytes" | "resourceLease" | "buffers" | "artifactBytes">): Promise<boolean> {
    const rows = await this.database.db.update(cadArtifacts).set({ ...result, state: "completed", phase: "completed",
      claimToken: null, claimUntil: null, error: null, errorCode: null, updatedAt: new Date() })
      .where(this.owner(row)).returning({ id: cadArtifacts.id });
    return rows.length > 0;
  }

  async fail(row: CadArtifactRow, code: string, message: string, retryable: boolean): Promise<void> {
    const retry = retryable && row.attempts < 3;
    await this.database.db.update(cadArtifacts).set({ state: retry ? "queued" : "failed", phase: retry ? "queued" : "failed",
      errorCode: code, error: message.slice(0, 500), claimToken: null, claimUntil: null,
      availableAt: new Date(Date.now() + Math.min(60_000, 5000 * 2 ** row.attempts)), updatedAt: new Date() }).where(this.owner(row));
  }

  async clearExpiredViews(): Promise<void> {
    await this.database.db.delete(cadViews).where(lt(cadViews.expiresAt, new Date()));
  }

  private owner(row: CadArtifactRow) {
    return and(eq(cadArtifacts.id, row.id), eq(cadArtifacts.state, "running"),
      eq(cadArtifacts.claimToken, row.claimToken!), gt(cadArtifacts.claimUntil, new Date()));
  }
}
