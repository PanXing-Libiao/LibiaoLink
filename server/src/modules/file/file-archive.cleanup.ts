import { Injectable } from "@nestjs/common";
import { ObjectStorage } from "../../storage/index.js";
import { isFileArchiveObjectKey } from "./file-archive.constants.js";

export interface FileArchiveCleanupJobContext {
  job: {
    payload: Record<string, unknown>;
  };
}

/** 一次性 jobs 消费者：TTL 到期后再等 10 分钟，按对象键彻底清除临时 ZIP。 */
@Injectable()
export class FileArchiveCleanupHandler {
  readonly transactional = false;

  constructor(private readonly storage: ObjectStorage) {}

  async run(context: FileArchiveCleanupJobContext): Promise<{ note: string }> {
    const objectKey = context.job.payload.objectKey;
    if (typeof objectKey !== "string" || !isFileArchiveObjectKey(objectKey)) {
      throw new Error("批量下载清理任务的对象键非法");
    }
    const result = await this.storage.purgeObject(objectKey);
    const batchId = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.zip$/i.exec(
      objectKey,
    )?.[1] ?? "未知批次";
    return {
      note:
        "临时 ZIP 已清理：批次 " +
        batchId +
        "（数据版本 " +
        String(result.deletedVersions) +
        " / delete marker " +
        String(result.deleteMarkers) +
        "）",
    };
  }
}
