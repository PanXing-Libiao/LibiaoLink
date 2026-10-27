import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { Injectable } from "@nestjs/common";
import type { ProjectSummaryFacts, ProjectSummaryNarrative } from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { projects } from "../../db/schema/projects.js";
import { projectSummaries } from "../../db/schema/summaries.js";

export type ProjectSummaryRow = typeof projectSummaries.$inferSelect;

export interface ProjectSummaryInsertInput {
  projectId: string;
  dataCutoff: Date;
  facts: ProjectSummaryFacts;
  narrative: ProjectSummaryNarrative;
  generatorEngine: string;
  generatorModel: string | null;
  promptVersion: string;
  fallbackReason: string | null;
  generatedBy: string;
  generatedAt: Date;
}

export type ProjectSummaryConfirmResult =
  | { kind: "ok"; row: ProjectSummaryRow }
  | { kind: "not_found" }
  | { kind: "version_conflict" }
  | { kind: "not_draft" };

@Injectable()
export class ProjectSummaryRepository {
  constructor(private readonly database: DatabaseService) {}

  async findLatest(projectId: string): Promise<ProjectSummaryRow | null> {
    const rows = await this.database.db
      .select()
      .from(projectSummaries)
      .where(eq(projectSummaries.projectId, projectId))
      .orderBy(
        sql`case ${projectSummaries.status} when 'draft' then 0 when 'confirmed' then 1 else 2 end`,
        desc(projectSummaries.createdAt),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(projectId: string, summaryId: string): Promise<ProjectSummaryRow | null> {
    const rows = await this.database.db
      .select()
      .from(projectSummaries)
      .where(and(eq(projectSummaries.projectId, projectId), eq(projectSummaries.id, summaryId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findRecentGeneration(projectId: string, actorId: string, since: Date): Promise<ProjectSummaryRow | null> {
    const rows = await this.database.db
      .select()
      .from(projectSummaries)
      .where(
        and(
          eq(projectSummaries.projectId, projectId),
          eq(projectSummaries.generatedBy, actorId),
          gte(projectSummaries.generatedAt, since),
        ),
      )
      .orderBy(desc(projectSummaries.generatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(input: ProjectSummaryInsertInput, client: DbClient = this.database.db): Promise<ProjectSummaryRow> {
    const rows = await client
      .insert(projectSummaries)
      .values({
        projectId: input.projectId,
        dataCutoff: input.dataCutoff,
        status: "draft",
        facts: input.facts,
        narrative: input.narrative,
        generatorEngine: input.generatorEngine,
        generatorModel: input.generatorModel,
        promptVersion: input.promptVersion,
        fallbackReason: input.fallbackReason,
        generatedBy: input.generatedBy,
        generatedAt: input.generatedAt,
        version: 1,
        createdAt: input.generatedAt,
        updatedAt: input.generatedAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("project_summaries insert 未返回记录");
    return row;
  }

  async updateNarrative(
    projectId: string,
    summaryId: string,
    expectedVersion: number,
    narrative: ProjectSummaryNarrative,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<ProjectSummaryRow | null> {
    const rows = await client
      .update(projectSummaries)
      .set({
        narrative,
        version: sql`${projectSummaries.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(projectSummaries.projectId, projectId),
          eq(projectSummaries.id, summaryId),
          eq(projectSummaries.version, expectedVersion),
          eq(projectSummaries.status, "draft"),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async confirm(
    projectId: string,
    summaryId: string,
    expectedVersion: number,
    actorId: string,
    at: Date,
    afterConfirmed?: (tx: DbClient, row: ProjectSummaryRow) => Promise<void>,
  ): Promise<ProjectSummaryConfirmResult> {
    return this.database.db.transaction(async (tx): Promise<ProjectSummaryConfirmResult> => {
      await this.lockProject(tx, projectId);
      const currentRows = await tx
        .select()
        .from(projectSummaries)
        .where(and(eq(projectSummaries.projectId, projectId), eq(projectSummaries.id, summaryId)))
        .limit(1);
      const current = currentRows[0];
      if (current === undefined) return { kind: "not_found" };
      if (current.version !== expectedVersion) return { kind: "version_conflict" };
      if (current.status !== "draft") return { kind: "not_draft" };
      await tx
        .update(projectSummaries)
        .set({
          status: "superseded",
          version: sql`${projectSummaries.version} + 1`,
          updatedAt: at,
        })
        .where(
          and(
            eq(projectSummaries.projectId, projectId),
            ne(projectSummaries.id, summaryId),
            inArray(projectSummaries.status, ["draft", "confirmed"]),
          ),
        );
      const updatedRows = await tx
        .update(projectSummaries)
        .set({
          status: "confirmed",
          confirmedBy: actorId,
          confirmedAt: at,
          version: sql`${projectSummaries.version} + 1`,
          updatedAt: at,
        })
        .where(
          and(
            eq(projectSummaries.projectId, projectId),
            eq(projectSummaries.id, summaryId),
            eq(projectSummaries.version, expectedVersion),
            eq(projectSummaries.status, "draft"),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) return { kind: "version_conflict" };
      if (afterConfirmed !== undefined) await afterConfirmed(tx, updated);
      return { kind: "ok", row: updated };
    });
  }

  private async lockProject(tx: DbClient, projectId: string): Promise<void> {
    await tx.execute(sql`select ${projects.id} from ${projects} where ${projects.id} = ${projectId} for update`);
  }
}
