import { Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { aiModelProviders, aiModelSelection } from "../../db/schema/ai-models.js";

export type AiModelProviderRow = typeof aiModelProviders.$inferSelect;
export type ProviderWrite = {
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string | null;
  updatedBy: string;
};

@Injectable()
export class ModelConfigRepository {
  constructor(private readonly database: DatabaseService) {}

  list(): Promise<AiModelProviderRow[]> {
    return this.database.db.select().from(aiModelProviders).orderBy(asc(aiModelProviders.createdAt), asc(aiModelProviders.id));
  }

  async find(id: string, client: DbClient = this.database.db): Promise<AiModelProviderRow | null> {
    const rows = await client.select().from(aiModelProviders).where(eq(aiModelProviders.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async insert(id: string, input: ProviderWrite, client: DbClient): Promise<AiModelProviderRow> {
    const rows = await client.insert(aiModelProviders).values({ id, ...input, createdBy: input.updatedBy }).returning();
    return rows[0]!;
  }

  async update(id: string, version: number, input: ProviderWrite, client: DbClient): Promise<AiModelProviderRow | null> {
    const rows = await client.update(aiModelProviders).set({
      ...input, updatedAt: new Date(), version: sql.raw("version + 1"),
    }).where(and(eq(aiModelProviders.id, id), eq(aiModelProviders.version, version))).returning();
    return rows[0] ?? null;
  }

  async remove(id: string, client: DbClient): Promise<boolean> {
    const rows = await client.delete(aiModelProviders).where(eq(aiModelProviders.id, id)).returning({ id: aiModelProviders.id });
    return rows.length > 0;
  }

  async selection(client: DbClient = this.database.db): Promise<{ providerId: string; modelId: string } | null> {
    const rows = await client.select({ providerId: aiModelSelection.providerId, modelId: aiModelSelection.modelId })
      .from(aiModelSelection).where(eq(aiModelSelection.id, true)).limit(1);
    return rows[0] ?? null;
  }

  async active(): Promise<{ provider: AiModelProviderRow; modelId: string } | null> {
    const rows = await this.database.db.select({ provider: aiModelProviders, modelId: aiModelSelection.modelId })
      .from(aiModelSelection).innerJoin(aiModelProviders, eq(aiModelProviders.id, aiModelSelection.providerId))
      .where(eq(aiModelSelection.id, true)).limit(1);
    return rows[0] ?? null;
  }

  async activate(providerId: string, modelId: string, actorId: string, client: DbClient): Promise<void> {
    const values = { providerId, modelId, updatedBy: actorId, updatedAt: new Date() };
    await client.insert(aiModelSelection).values({ id: true, ...values })
      .onConflictDoUpdate({ target: aiModelSelection.id, set: values });
  }
}
