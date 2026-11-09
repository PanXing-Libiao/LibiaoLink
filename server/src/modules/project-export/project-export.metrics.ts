import { performance } from "node:perf_hooks";

export type ProjectExportTelemetryStatus = "success" | "failed" | "cancelled";
export type ProjectExportTelemetryMode = "legacy" | "stream" | "archive";

type TimingName =
  | "dataLoad"
  | "attachmentOpen"
  | "attachmentZipWrite"
  | "thumbnailLoad"
  | "thumbnailDecode"
  | "thumbnailGenerate"
  | "workbook"
  | "imageInjection"
  | "archiveFinalize"
  | "audit";

type Timings = Record<TimingName, number>;

interface Counts {
  attachmentsPlanned: number;
  attachmentsIncluded: number;
  attachmentsMissing: number;
  attachmentsSkipped: number;
  duplicateFileIds: number;
  objectStreamCalls: number;
  objectGetCalls: number;
  attachmentBytesRead: number;
  thumbnailBytesRead: number;
  objectBytesRead: number;
  requestedImages: number;
  embeddedImages: number;
  imageLinks: number;
  missingImages: number;
  rows: number;
  outputBytes: number;
}

export interface ProjectExportTelemetryResult {
  mode: ProjectExportTelemetryMode;
  rows: number;
  images: number;
  imageLinks: number;
  missingImages: number;
  outputBytes: number;
}

function zeroTimings(): Timings {
  return {
    dataLoad: 0,
    attachmentOpen: 0,
    attachmentZipWrite: 0,
    thumbnailLoad: 0,
    thumbnailDecode: 0,
    thumbnailGenerate: 0,
    workbook: 0,
    imageInjection: 0,
    archiveFinalize: 0,
    audit: 0,
  };
}

function zeroCounts(): Counts {
  return {
    attachmentsPlanned: 0,
    attachmentsIncluded: 0,
    attachmentsMissing: 0,
    attachmentsSkipped: 0,
    duplicateFileIds: 0,
    objectStreamCalls: 0,
    objectGetCalls: 0,
    attachmentBytesRead: 0,
    thumbnailBytesRead: 0,
    objectBytesRead: 0,
    requestedImages: 0,
    embeddedImages: 0,
    imageLinks: 0,
    missingImages: 0,
    rows: 0,
    outputBytes: 0,
  };
}

function rounded(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  return error === undefined ? null : typeof error;
}

/** 单次项目导出的临时指标。不保存文件名、对象键或业务内容。 */
export class ProjectExportTelemetry {
  private readonly startedAt = performance.now();
  private readonly timings = zeroTimings();
  private readonly counts = zeroCounts();
  private mode: ProjectExportTelemetryMode | null = null;

  constructor(
    private readonly projectId: string,
    private readonly format: "xlsx" | "zip",
  ) {}

  setMode(mode: ProjectExportTelemetryMode): void {
    this.mode = mode;
  }

  async measure<T>(name: TimingName, work: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      this.addDuration(name, performance.now() - startedAt);
    }
  }

  measureSync<T>(name: TimingName, work: () => T): T {
    const startedAt = performance.now();
    try {
      return work();
    } finally {
      this.addDuration(name, performance.now() - startedAt);
    }
  }

  addDuration(name: TimingName, durationMs: number): void {
    this.timings[name] += Math.max(0, durationMs);
  }

  recordObjectStreamCall(): void {
    this.counts.objectStreamCalls += 1;
  }

  recordObjectStreamBytes(sizeBytes: number): void {
    this.addBytes("attachmentBytesRead", sizeBytes);
  }

  recordObjectGetCall(): void {
    this.counts.objectGetCalls += 1;
  }

  recordObjectGetBytes(sizeBytes: number): void {
    this.addBytes("thumbnailBytesRead", sizeBytes);
  }

  recordAttachmentPlan(fileIds: readonly string[]): void {
    this.counts.attachmentsPlanned = fileIds.length;
    this.counts.duplicateFileIds = Math.max(0, fileIds.length - new Set(fileIds).size);
  }

  recordAttachmentStatuses(statuses: readonly ("included" | "missing" | "skipped")[]): void {
    this.counts.attachmentsIncluded = statuses.filter((status) => status === "included").length;
    this.counts.attachmentsMissing = statuses.filter((status) => status === "missing").length;
    this.counts.attachmentsSkipped = statuses.filter((status) => status === "skipped").length;
  }

  setRequestedImages(count: number): void {
    this.counts.requestedImages = count;
  }

  recordResult(result: ProjectExportTelemetryResult): void {
    this.mode = result.mode;
    this.counts.rows = result.rows;
    this.counts.embeddedImages = result.images;
    this.counts.imageLinks = result.imageLinks;
    this.counts.missingImages = result.missingImages;
    this.counts.outputBytes = result.outputBytes;
  }

  snapshot(status: ProjectExportTelemetryStatus, error?: unknown): Record<string, unknown> {
    this.counts.objectBytesRead = this.counts.attachmentBytesRead + this.counts.thumbnailBytesRead;
    const result: Record<string, unknown> = {
      event: "project_export_metrics",
      projectId: this.projectId,
      format: this.format,
      mode: this.mode,
      status,
      totalMs: rounded(performance.now() - this.startedAt),
      timingsMs: Object.fromEntries(Object.entries(this.timings).map(([key, value]) => [key, rounded(value)])),
      counts: { ...this.counts },
    };
    const code = errorCode(error);
    const name = errorName(error);
    if (code !== null) result.errorCode = code;
    if (name !== null) result.errorName = name;
    return result;
  }

  private addBytes(target: "attachmentBytesRead" | "thumbnailBytesRead", sizeBytes: number): void {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return;
    this.counts[target] += sizeBytes;
  }
}
