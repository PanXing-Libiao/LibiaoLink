import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { files, fileVersions } from "./files.js";
import type { CadCompanion } from "@libiaolink/contracts";
type CadBoundCompanion = CadCompanion & { sourceSHA256: string; sourceBytes: number };

export type CadStoredBuffer = { sha256: string; byteLength: number; objectKey: string };

export const cadArtifacts = pgTable("cad_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  sourceSHA256: text("source_sha256").notNull(),
  sourceBytes: bigint("source_bytes", { mode: "number" }).notNull(),
  sourceName: text("source_name").notNull(),
  sourceFormat: text("source_format").$type<"STEP" | "DXF" | "DWG">().notNull().default("STEP"),
  mainPath: text("main_path"),
  companions: jsonb("companions").$type<CadBoundCompanion[]>().notNull().default([]),
  resourceSetHash: text("resource_set_hash").notNull().default("0".repeat(64)),
  engineVersion: text("engine_version").notNull(),
  formatVersion: text("format_version").notNull().default(""),
  nameCodepage: text("name_codepage").notNull().default("GB"),
  state: text("state").notNull().default("queued"),
  phase: text("phase").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  claimToken: uuid("claim_token"),
  claimUntil: timestamp("claim_until", { withTimezone: true }),
  objectPrefix: text("object_prefix"),
  manifestSHA256: text("manifest_sha256"),
  manifestBytes: bigint("manifest_bytes", { mode: "number" }),
  resourceLease: text("resource_lease"),
  buffers: jsonb("buffers").$type<CadStoredBuffer[]>(),
  artifactBytes: bigint("artifact_bytes", { mode: "number" }).notNull().default(0),
  errorCode: text("error_code"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("uq_cad_artifacts_input_set").on(t.versionId, t.formatVersion, t.nameCodepage, t.resourceSetHash),
  index("ix_cad_artifacts_queue").on(t.state, t.availableAt),
  index("ix_cad_artifacts_file").on(t.fileId),
  check("ck_cad_artifacts_state", sql`${t.state} in ('queued','running','completed','partial','failed','timed-out')`),
  check("ck_cad_artifacts_input_set", sql`${t.sourceFormat} in ('STEP','DXF','DWG') and ${t.resourceSetHash} ~ '^[a-f0-9]{64}$' and length(coalesce(${t.mainPath},${t.sourceName})) between 1 and 1024 and jsonb_typeof(${t.companions}) = 'array' and jsonb_array_length(${t.companions}) <= 127 and ((${t.sourceFormat} in ('DXF','DWG') and ${t.mainPath} is not null and (${t.sourceFormat} <> 'DWG' or (${t.companions} = '[]'::jsonb and ${t.resourceSetHash} = repeat('0',64)))) or (${t.sourceFormat} = 'STEP' and ${t.state} <> 'partial' and ${t.companions} = '[]'::jsonb and ${t.resourceSetHash} = repeat('0',64)))`),
  check("ck_cad_artifacts_encoding", sql`${t.nameCodepage} in ('GB','UTF8')`),
  check("ck_cad_artifacts_format_version", sql`length(${t.formatVersion}) between 1 and 512`),
  check("ck_cad_artifacts_source", sql`${t.sourceSHA256} ~ '^[a-f0-9]{64}$' and ${t.sourceBytes} > 0`),
  check("ck_cad_artifacts_ready", sql`${t.state} not in ('completed','partial') or (${t.objectPrefix} is not null and ${t.manifestSHA256} is not null and ${t.manifestSHA256} ~ '^[a-f0-9]{64}$' and ${t.manifestBytes} is not null and ${t.manifestBytes} > 0 and ${t.resourceLease} is not null and ${t.resourceLease} ~ '^[a-f0-9]{48}$' and ${t.buffers} is not null)`),
]);

export const cadViews = pgTable("cad_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  artifactId: uuid("artifact_id").notNull().references(() => cadArtifacts.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull(),
  viewId: text("view_id").notNull(),
  cancelled: boolean("cancelled").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (t) => [
  unique("uq_cad_views_window").on(t.actorId, t.viewId, t.artifactId),
  index("ix_cad_views_expiry").on(t.expiresAt),
  check("ck_cad_views_id", sql`${t.viewId} ~ '^[a-f0-9]{32}$'`),
]);
