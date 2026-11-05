import { Sha256, sha256Hex, toHex } from "./sha256";

const WORKER_THRESHOLD_BYTES = 4 * 1024 * 1024;
const WORKER_CHUNK_BYTES = 2 * 1024 * 1024;

type WorkerReply = { type: "done"; digest: string } | { type: "error"; message: string };

/** 小文件直接哈希；大文件在 Worker 内分块增量哈希，避免冻结界面并限制峰值内存。 */
export async function sha256Blob(blob: Blob): Promise<string> {
  if (blob.size < WORKER_THRESHOLD_BYTES) {
    return sha256Hex(await blob.arrayBuffer());
  }
  if (typeof Worker !== "undefined") {
    try {
      return await hashInWorker(blob);
    } catch {
      // Worker 被策略禁用或启动失败时回退主线程分块哈希，仍不持有整份文件。
    }
  }
  return hashOnMainThread(blob);
}

async function hashOnMainThread(blob: Blob): Promise<string> {
  const hash = new Sha256();
  let offset = 0;
  while (offset < blob.size) {
    const chunk = await blob.slice(offset, Math.min(offset + WORKER_CHUNK_BYTES, blob.size)).arrayBuffer();
    hash.update(new Uint8Array(chunk));
    offset += chunk.byteLength;
    if (chunk.byteLength === 0) throw new Error("文件读取提前结束");
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  return toHex(hash.digest());
}

function hashInWorker(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./sha256.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      action();
    };
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === "done") {
        finish(() => resolve(reply.digest));
      } else {
        finish(() => reject(new Error(reply.message)));
      }
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(new Error(event.message === "" ? "文件哈希 Worker 启动失败" : event.message)));
    });
    worker.addEventListener("messageerror", () => {
      finish(() => reject(new Error("文件哈希 Worker 消息不可用")));
    });
    worker.postMessage({ file: blob, chunkBytes: WORKER_CHUNK_BYTES });
  });
}
