/** file 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export { FileModule } from "./file.module.js";
export { CadArchiveWorker } from "./cad-archive.worker.js";
export { FileService, EXPIRE_SWEEP_BATCH, RECYCLE_SWEEP_BATCH } from "./file.service.js";
export type { ProjectExportFileRef } from "./file.service.js";
export { ChangeService } from "./change.service.js";
export { PreviewService } from "./preview.service.js";
export { PreviewReadService } from "./preview-read.service.js";
export { PreviewConverter } from "./preview.converter.js";
export type { ConverterHealth } from "./preview.converter.js";
export { previewTargetsFor } from "./preview.targets.js";
export { buildPreviewJobPayload, parsePreviewJob, PREVIEW_JOB_TOPIC, previewJobDedupeKey } from "./preview.job.js";
export type { PreviewJob, PreviewJobInput, PreviewTarget } from "./preview.job.js";
export type {
  ChangeRequestJoinedRow,
  DuplicateFileRow,
  FileRow,
  FileVersionRow,
  UploadSessionRow,
} from "./file.repository.js";
