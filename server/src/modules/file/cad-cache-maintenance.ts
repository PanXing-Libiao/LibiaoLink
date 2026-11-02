import { Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import { cadArtifacts, cadRetiredObjects } from "../../db/schema/cad.js";
import { files } from "../../db/schema/files.js";
import { ObjectStorage } from "../../storage/index.js";
import { CadArchiveRepository } from "./cad-archive.repository.js";
import { CadEngineClient } from "./cad-engine.client.js";
import { CAD_FORMAT_VERSIONS } from "./cad-release.js";
import type { CadNameCodepage } from "@libiaolink/contracts";

const currentVersion = sql`case ${cadArtifacts.sourceFormat}
  when 'STEP' then ${CAD_FORMAT_VERSIONS.STEP} when 'DXF' then ${CAD_FORMAT_VERSIONS.DXF}
  when 'DWG' then ${CAD_FORMAT_VERSIONS.DWG} end`;
const sameInput = sql`replacement.file_id=${cadArtifacts.fileId} and replacement.version_id=${cadArtifacts.versionId}
  and replacement.source_sha256=${cadArtifacts.sourceSHA256} and replacement.source_bytes=${cadArtifacts.sourceBytes}
  and replacement.name_codepage=${cadArtifacts.nameCodepage} and replacement.resource_set_hash=${cadArtifacts.resourceSetHash}
  and replacement.format_version=${currentVersion}`;
const noReaders = sql`not exists (select 1 from cad_views v where v.artifact_id=${cadArtifacts.id}
  and ((not v.cancelled and v.expires_at>now()) or v.lease_expires_at>now()))`;

/** Bounded idle work. Conversion still goes through the normal checked, single-worker queue. */
@Injectable()
export class CadCacheMaintenance {
  private nextRun = 0;
  private readonly logger = new Logger(CadCacheMaintenance.name);
  constructor(private readonly database: DatabaseService, private readonly archive: CadArchiveRepository,
    private readonly engine: CadEngineClient, private readonly storage: ObjectStorage) {}

  async runIfDue(): Promise<void> {
    if (!this.engine.enabled || Date.now() < this.nextRun) return;
    this.nextRun = Date.now() + 60_000;
    await this.warmRecent();
    await this.retireReplaced();
    await this.purgeRetired();
  }

  async warmRecent(): Promise<void> {
    const rows = await this.database.db.select({ artifact: cadArtifacts }).from(cadArtifacts)
      .innerJoin(files, eq(files.id, cadArtifacts.fileId)).where(and(
        sql`${files.status} <> 'recycled'`,
        inArray(cadArtifacts.sourceFormat, this.engine.dwgEnabled ? ["STEP", "DXF", "DWG"] : ["STEP", "DXF"]),
        sql`${cadArtifacts.lastAccessedAt}>now()-interval '7 days'`,
        sql`${cadArtifacts.formatVersion}<>${currentVersion}`,
        sql`not exists (select 1 from cad_artifacts replacement where ${sameInput})`,
      )).orderBy(desc(cadArtifacts.lastAccessedAt), cadArtifacts.id).limit(2);
    for (const { artifact } of rows) {
      // request is idempotent and preserves file/version/companion scope; it does not open a view.
      const warmed = await this.archive.request({ fileId: artifact.fileId, versionId: artifact.versionId,
        sourceSHA256: artifact.sourceSHA256, sourceBytes: artifact.sourceBytes, sourceName: artifact.sourceName,
        sourceFormat: artifact.sourceFormat, mainPath: artifact.mainPath, companions: artifact.companions,
        resourceSetHash: artifact.resourceSetHash }, artifact.nameCodepage as CadNameCodepage);
      await this.database.db.update(cadArtifacts).set({ lastAccessedAt: sql`greatest(${cadArtifacts.lastAccessedAt}, ${artifact.lastAccessedAt})` })
        .where(eq(cadArtifacts.id, warmed.id));
    }
  }

  async retireReplaced(): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const rows = await tx.select().from(cadArtifacts).where(and(
        sql`${cadArtifacts.formatVersion}<>${currentVersion}`,
        sql`(${cadArtifacts.state}<>'running' or ${cadArtifacts.claimUntil}<now())`, noReaders,
        sql`exists (select 1 from cad_artifacts replacement where ${sameInput} and replacement.state in ('completed','partial') and replacement.created_at>${cadArtifacts.createdAt})`,
      )).orderBy(cadArtifacts.id).limit(2).for("update", { skipLocked: true });
      for (const row of rows) {
        // Lock and recheck both contracts after candidate selection. A concurrent open may have won the row lock.
        const [eligible] = await tx.select({ id: cadArtifacts.id }).from(cadArtifacts)
          .where(and(eq(cadArtifacts.id, row.id), noReaders));
        if (!eligible) continue;
        const [replacement] = await tx.select({ id: cadArtifacts.id }).from(cadArtifacts).where(and(
          eq(cadArtifacts.fileId, row.fileId), eq(cadArtifacts.versionId, row.versionId),
          eq(cadArtifacts.sourceSHA256, row.sourceSHA256), eq(cadArtifacts.sourceBytes, row.sourceBytes),
          eq(cadArtifacts.nameCodepage, row.nameCodepage), eq(cadArtifacts.resourceSetHash, row.resourceSetHash),
          sql`${cadArtifacts.createdAt}>${row.createdAt}`,
          eq(cadArtifacts.formatVersion, CAD_FORMAT_VERSIONS[row.sourceFormat]), inArray(cadArtifacts.state, ["completed", "partial"]),
        )).for("share");
        if (!replacement) continue;
        if (row.objectPrefix) {
          // The database constraint limits this queue to one artifact generation, never a file/project root.
          await tx.insert(cadRetiredObjects).values({ prefix: row.objectPrefix,
            availableAt: new Date(Date.now() + 24 * 60 * 60_000) }).onConflictDoNothing();
        }
        await tx.delete(cadArtifacts).where(eq(cadArtifacts.id, row.id));
      }
    });
  }

  async purgeRetired(): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const rows = await tx.select().from(cadRetiredObjects).where(lte(cadRetiredObjects.availableAt, new Date()))
        .orderBy(cadRetiredObjects.availableAt, cadRetiredObjects.prefix).limit(2).for("update", { skipLocked: true });
      for (const row of rows) {
        try {
          await this.storage.purgePrefix(row.prefix);
        } catch {
          await tx.update(cadRetiredObjects).set({ availableAt: new Date(Date.now() + 5 * 60_000) })
            .where(eq(cadRetiredObjects.prefix, row.prefix));
          this.logger.warn("CAD retired artifact deletion failed; retained for retry");
          continue;
        }
        await tx.delete(cadRetiredObjects).where(eq(cadRetiredObjects.prefix, row.prefix));
      }
    });
  }
}
