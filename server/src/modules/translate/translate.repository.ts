/**
 * content_translations 数据访问（0047 · §6.16 ㉕ · Push 301）：
 * 读 = 按 (source_lang, target_lang, source_hash) 单条 / 批量（IN）；
 * 写 = upsert（同键覆盖译文与 engine、抬 updated_at —— 换引擎重翻走同一条路径）。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import { contentTranslations } from "../../db/schema/translate.js";

/** 单条读回行（服务层只关心译文与产出引擎）。 */
export interface ContentTranslationRow {
  sourceText: string;
  translatedText: string;
  engine: string;
}

/** 批量读回行（键 = source_hash）。 */
export interface ContentTranslationHitRow {
  sourceHash: string;
  translatedText: string;
}

/** upsert 输入（服务层已完成 hash / engine 收敛）。 */
export interface ContentTranslationUpsert {
  sourceLang: string;
  targetLang: string;
  sourceHash: string;
  sourceText: string;
  translatedText: string;
  engine: string;
}

@Injectable()
export class TranslateRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 单条按哈希读（命中直出）。 */
  async findByHash(sourceLang: string, targetLang: string, sourceHash: string): Promise<ContentTranslationRow | null> {
    const rows = await this.database.db
      .select({ sourceText: contentTranslations.sourceText, translatedText: contentTranslations.translatedText, engine: contentTranslations.engine })
      .from(contentTranslations)
      .where(
        and(
          eq(contentTranslations.sourceLang, sourceLang),
          eq(contentTranslations.targetLang, targetLang),
          eq(contentTranslations.sourceHash, sourceHash),
        ),
      )
.limit(1);
    return rows[0] ?? null;
  }

  /** 批量按哈希读（只读查库端点用；空数组直接短路）。 */
  async findManyByHashes(sourceLang: string, targetLang: string, sourceHashes: readonly string[]): Promise<ContentTranslationHitRow[]> {
    if (sourceHashes.length === 0) {
      return [];
    }
    return this.database.db
      .select({ sourceHash: contentTranslations.sourceHash, translatedText: contentTranslations.translatedText })
      .from(contentTranslations)
      .where(
        and(
          eq(contentTranslations.sourceLang, sourceLang),
          eq(contentTranslations.targetLang, targetLang),
          inArray(contentTranslations.sourceHash, [...sourceHashes]),
        ),
      );
  }

  /** 同键 upsert：新增或覆盖译文（updated_at 抬到写入时刻）。 */
  async upsert(input: ContentTranslationUpsert, at: Date): Promise<void> {
    await this.database.db
      .insert(contentTranslations)
      .values({
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        sourceHash: input.sourceHash,
        sourceText: input.sourceText,
        translatedText: input.translatedText,
        engine: input.engine,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [contentTranslations.sourceLang, contentTranslations.targetLang, contentTranslations.sourceHash],
        set: {
          sourceText: input.sourceText,
          translatedText: input.translatedText,
          engine: input.engine,
          updatedAt: at,
        },
      });
  }
}
