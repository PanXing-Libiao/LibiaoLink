import { Sha256, toHex } from "./sha256";

type Request = { file: Blob; chunkBytes?: number };
type Reply = { type: "done"; digest: string } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Reply) => void;
  close: () => void;
};

/** 在 Worker 内按块读取文件并增量计算 SHA-256，避免主线程持有整份大文件。 */
scope.onmessage = (event) => {
  void (async () => {
    try {
      const file = event.data.file;
      if (!(file instanceof Blob)) throw new Error("无效的文件输入");
      const chunkBytes = Math.max(64 * 1024, Math.min(event.data.chunkBytes ?? 2 * 1024 * 1024, 8 * 1024 * 1024));
      const hash = new Sha256();
      let offset = 0;
      while (offset < file.size) {
        const chunk = await file.slice(offset, Math.min(offset + chunkBytes, file.size)).arrayBuffer();
        hash.update(new Uint8Array(chunk));
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) throw new Error("文件读取提前结束");
      }
      scope.postMessage({ type: "done", digest: toHex(hash.digest()) });
      scope.close();
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      scope.close();
    }
  })();
};
