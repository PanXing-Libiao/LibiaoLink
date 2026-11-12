/** 项目文件批量下载（服务端 ZIP）的统一限制与临时对象口径。 */
export const FILE_ARCHIVE_MAX_ITEM_COUNT = 50;
export const FILE_ARCHIVE_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const FILE_ARCHIVE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const FILE_ARCHIVE_GENERATION_TIMEOUT_MS = 4 * 60 * 1000;
export const FILE_ARCHIVE_CLEANUP_DELAY_MS = 10 * 60 * 1000;
export const FILE_ARCHIVE_CLEANUP_JOB_KIND = "file.download-archive.cleanup";
export const FILE_ARCHIVE_OBJECT_PREFIX = "temp/file-archives/";

export function fileArchiveObjectKey(batchId: string): string {
  return FILE_ARCHIVE_OBJECT_PREFIX + batchId + ".zip";
}

export function isFileArchiveObjectKey(value: string): boolean {
  return /^temp\/file-archives\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i.test(
    value,
  );
}
