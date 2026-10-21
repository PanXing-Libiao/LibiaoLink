/** translate 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export { TranslateModule } from "./translate.module.js";
export { TranslateService, TRANSLATE_ENGINE } from "./translate.service.js";
export type { ContentTranslationHitRow, ContentTranslationRow, ContentTranslationUpsert } from "./translate.repository.js";
