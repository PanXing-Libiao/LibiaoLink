/**
 * content_translations（0047 · §6.16 ㉕ · Push 301）：手打内容英译译文库。
 * 表口径见 database/migrations/0047_content_translations.sql：键 = (source_lang, target_lang, source_hash)，
 * source_hash = sha256(source_text)；命中读、未命中引擎产出后 upsert（服务端 modules/translate）。
 */
import { bigserial, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const contentTranslations = pgTable(
  "content_translations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceLang: text("source_lang").notNull().default("zh"),
    targetLang: text("target_lang").notNull(),
    sourceHash: text("source_hash").notNull(),
    sourceText: text("source_text").notNull(),
    translatedText: text("translated_text").notNull(),
    engine: text("engine").notNull().default("hy-mt-1.5-1.8b"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_content_translations_key").on(table.sourceLang, table.targetLang, table.sourceHash),
    index("ix_content_translations_updated").on(table.updatedAt.desc()),
  ],
);
