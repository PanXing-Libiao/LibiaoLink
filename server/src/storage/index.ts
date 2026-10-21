/** storage 唯一公开出口（基础设施层；跨目录只允许 import 本文件）。 */
export {
  ObjectStorage,
  StorageError,
  toApiError,
} from "./object-storage.js";
export type {
  CompleteMultipartUploadInput,
  CopyObjectInput,
  CopyObjectResult,
  CreateMultipartUploadInput,
  DownloadUrlInput,
  GetObjectResult,
  ObjectPrefixResult,
  MultipartUploadKeyInput,
  MultipartUploadRef,
  ObjectHead,
  PartUploadUrlInput,
  PurgeObjectResult,
  PurgePrefixResult,
  PutObjectInput,
  SignedUrl,
  StorageFailureCode,
  UploadedPart,
} from "./object-storage.js";
export { buildObjectKey, buildPreviewArtifactKey, buildUploadStagingKey, extensionOf, versionFileName } from "./object-key.js";
export type { ObjectKeyInput } from "./object-key.js";
export {
  DEFAULT_PART_SIZE_BYTES,
  MAX_PARTS,
  MAX_PART_SIZE_BYTES,
  MIN_PART_SIZE_BYTES,
  missingPartNumbers,
  planUpload,
  SINGLE_COPY_MAX_BYTES,
} from "./part-plan.js";
export type { UploadPlan } from "./part-plan.js";
export { contentDisposition, createS3Client, createS3ObjectStorage, resolveForcePathStyle, S3ObjectStorage } from "./s3-object-storage.js";
export type { S3ObjectStorageOptions, StorageLogger } from "./s3-object-storage.js";
export { StorageModule } from "./storage.module.js";
