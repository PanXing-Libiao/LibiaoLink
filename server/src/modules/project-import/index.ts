/** project-import 模块唯一公开出口（跨模块只允许 import 本文件；ADR-010 / g6）。 */
export { ProjectImportModule } from "./project-import.module.js";
export { ProjectImportService } from "./project-import.service.js";
export type { ImportLocale, ImportPreviewInput } from "./project-import.service.js";
export { IMPORT_PREVIEW_SWEEP_BATCH, IMPORT_PREVIEW_SWEEP_INTERVAL_MS, ProjectImportRepository } from "./project-import.repository.js";
export type {
  ImportChangeInsert,
  ImportFileInsert,
  ImportReportInsert,
  ImportReportIssueInsert,
  ImportTaskInsert,
  PreviewInsertInput,
} from "./project-import.repository.js";
export { convertLegacyWorkbook, clean as cleanLegacyCell } from "./legacy.js";
export type { LegacyChange, LegacyIssueSeed, LegacyManualFile, LegacyParse, LegacyTask } from "./legacy.js";
export { parseWorkbook, ZipArchive } from "./xlsx.js";
export type { ParsedWorkbook, SheetGrid, SheetImageAnchor } from "./xlsx.js";
export { PEOPLE_REGISTRY, proposeAccount, stripParen } from "./people.js";
