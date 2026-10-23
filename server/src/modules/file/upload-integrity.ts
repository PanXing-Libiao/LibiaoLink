import { createHash } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { ObjectStorage, toApiError } from "../../storage/index.js";

/** 合并后的暂存对象只允许服务端操作；流式核验实际字节，仅保留文件头供 MIME 裁决。 */
export async function inspectUploadedObject(
  storage: ObjectStorage,
  objectKey: string,
  expectedSize: number,
  prefixLimit: number,
): Promise<{ contentHash: string; prefix: Uint8Array }> {
  try {
    const source = await storage.getObjectStream(objectKey);
    if (source === null) throw new AppError("UPLOAD_INCOMPLETE", "合并结果在对象存储侧不可读取，请重新上传");
    const hash = createHash("sha256");
    const prefix = Buffer.alloc(Math.min(expectedSize, prefixLimit));
    let size = 0;
    for await (const chunk of source.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + bytes.byteLength > expectedSize) {
        throw new AppError("UPLOAD_INCOMPLETE", "源对象实际大小超过声明，请重新上传");
      }
      if (size < prefix.byteLength) prefix.set(bytes.subarray(0, prefix.byteLength - size), size);
      size += bytes.byteLength;
      hash.update(bytes);
    }
    if (size !== expectedSize) throw new AppError("UPLOAD_INCOMPLETE", "源对象读取不完整，请重新上传");
    return { contentHash: hash.digest("hex"), prefix };
  } catch (error) {
    throw toApiError(error);
  }
}
