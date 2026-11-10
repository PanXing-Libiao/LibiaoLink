import type { ExportImageExtension } from "./project-export.workbook.js";

const IMAGE_HEADER_PROBE_BYTES = 8;

export function sniffProjectExportImage(bytes: Uint8Array): ExportImageExtension | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  return null;
}

/**
 * ZIP 附件流的有界旁路捕获器。原始 chunk 始终原样交给 ZIP writer；
 * 仅当文件头确认是 PNG / JPEG / GIF 且未超过上限时保留副本。
 */
export class ProjectArchiveImageCapture {
  private chunks: Buffer[] = [];
  private sizeBytes = 0;
  private headerProbe = Buffer.alloc(0);
  private state: "probing" | "capturing" | "discarded" = "probing";

  constructor(private readonly maxBytes: number) {}

  readonly onChunk = (chunk: Buffer): void => {
    if (this.state === "discarded") return;
    if (chunk.byteLength === 0) return;
    if (this.sizeBytes + chunk.byteLength > this.maxBytes) {
      this.discard();
      return;
    }

    this.chunks.push(Buffer.from(chunk));
    this.sizeBytes += chunk.byteLength;
    if (this.state === "capturing") return;

    const remaining = IMAGE_HEADER_PROBE_BYTES - this.headerProbe.byteLength;
    if (remaining > 0) {
      this.headerProbe = Buffer.concat([this.headerProbe, chunk.subarray(0, remaining)]);
    }
    if (sniffProjectExportImage(this.headerProbe) !== null) {
      this.state = "capturing";
      this.headerProbe = Buffer.alloc(0);
    } else if (this.headerProbe.byteLength >= IMAGE_HEADER_PROBE_BYTES) {
      this.discard();
    }
  };

  take(): Buffer | null {
    if (this.state === "discarded" || this.sizeBytes === 0) {
      this.discard();
      return null;
    }
    const bytes = Buffer.concat(this.chunks, this.sizeBytes);
    this.discard();
    return sniffProjectExportImage(bytes) === null ? null : bytes;
  }

  discard(): void {
    this.state = "discarded";
    this.chunks = [];
    this.sizeBytes = 0;
    this.headerProbe = Buffer.alloc(0);
  }
}
