import { access, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Response } from "express";
import type { IncomingMessage } from "node:http";
import type { ProjectImportPreview, ProjectImportResult } from "@libiaolink/contracts";
import { AppError } from "../src/common/errors/app-error.js";
import { parseMultipart, readMultipartFile, readRequestBody } from "../src/common/http/multipart.js";
import { ProjectImportController } from "../src/modules/project-import/project-import.controller.js";
import type { ProjectImportService } from "../src/modules/project-import/project-import.service.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const BOUNDARY = "----libiaolink-import-test";

function multipartBody(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      "--" + BOUNDARY + "\r\n" +
        'Content-Disposition: form-data; name="file"; filename="book.xlsx"' + "\r\n" +
        "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n",
      "utf8",
    ),
    bytes,
    Buffer.from("\r\n--" + BOUNDARY + "--\r\n", "utf8"),
  ]);
}

function requestOf(chunks: Buffer[], contentLength?: number): IncomingMessage {
  const request = Readable.from(chunks);
  Object.defineProperty(request, "headers", {
    value: contentLength === undefined ? {} : { "content-length": String(contentLength) },
  });
  return request as unknown as IncomingMessage;
}

describe("import HTTP body budgets", () => {
  it("preallocates a declared body and parses multipart file bytes without a second copy", async () => {
    const body = multipartBody(Buffer.from("xlsx-bytes", "utf8"));
    const read = await readRequestBody(requestOf([body.subarray(0, 17), body.subarray(17)], body.length), body.length);
    expect(read.equals(body)).toBe(true);

    const parts = parseMultipart(read, BOUNDARY);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.bytes.toString("utf8")).toBe("xlsx-bytes");
    expect(parts[0]?.bytes.buffer).toBe(read.buffer);
  });

  it("streams multipart file to a temporary disk range without buffering the whole body", async () => {
    const fileBytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
    const body = multipartBody(fileBytes);
    const upload = await readMultipartFile(
      requestOf([body.subarray(0, 1), body.subarray(1, 70_001), body.subarray(70_001)], body.length),
      "multipart/form-data; boundary=" + BOUNDARY,
      "file",
      fileBytes.length,
    );
    expect(upload).not.toBeNull();
    if (upload === null) return;
    try {
      const bodyOnDisk = await readFile(upload.path);
      expect(bodyOnDisk.equals(body)).toBe(true);
      expect(upload.sizeBytes).toBe(fileBytes.length);
      expect(bodyOnDisk.subarray(upload.offset, upload.offset + upload.sizeBytes).equals(fileBytes)).toBe(true);
    } finally {
      await upload.cleanup();
    }
    await expect(access(upload.path)).rejects.toBeDefined();
  });

  it("rejects an oversized streamed multipart file and removes its temporary directory", async () => {
    const fileBytes = Buffer.alloc(17, 1);
    const body = multipartBody(fileBytes);
    const upload = await readMultipartFile(
      requestOf([body], body.length),
      "multipart/form-data; boundary=" + BOUNDARY,
      "file",
      16,
    ).catch((caught: unknown) => caught);
    expect(upload).toBeInstanceOf(AppError);
    expect((upload as AppError).code).toBe("IMPORT_FILE_INVALID");
  });

  it("rejects an oversized Content-Length as IMPORT_FILE_INVALID", async () => {
    const error = await readRequestBody(requestOf([], 11), 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("IMPORT_FILE_INVALID");
  });
});

class DeferredImportService {
  previewCalls = 0;
  commitCalls = 0;
  lastPreviewInput: unknown = null;
  entered!: () => void;
  releasePreview!: () => void;
  readonly enteredPreview = new Promise<void>((resolve) => {
    this.entered = resolve;
  });
  readonly previewGate = new Promise<void>((resolve) => {
    this.releasePreview = resolve;
  });

  async preview(input: unknown): Promise<ProjectImportPreview> {
    this.previewCalls += 1;
    this.lastPreviewInput = input;
    this.entered();
    await this.previewGate;
    return { previewId: "preview-1" } as ProjectImportPreview;
  }

  async commit(): Promise<ProjectImportResult> {
    this.commitCalls += 1;
    return { projectId: "project-1" } as ProjectImportResult;
  }
}

describe("ProjectImportController import gate", () => {
  it("rejects preview and commit while another import is in flight, then releases the gate", async () => {
    const imports = new DeferredImportService();
    const controller = new ProjectImportController(imports as unknown as ProjectImportService);
    const firstBody = multipartBody(Buffer.from("first", "utf8"));
    const first = controller.preview(
      requestOf([firstBody], firstBody.length),
      "multipart/form-data; boundary=" + BOUNDARY,
      "zh-CN",
      ACTOR_ID,
    );
    await imports.enteredPreview;

    const secondBody = multipartBody(Buffer.from("second", "utf8"));
    const second = await controller
      .preview(
        requestOf([secondBody], secondBody.length),
        "multipart/form-data; boundary=" + BOUNDARY,
        "zh-CN",
        ACTOR_ID,
      )
      .catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(AppError);
    expect((second as AppError).code).toBe("RATE_LIMITED");

    const response = { writableEnded: false, on: () => response } as unknown as Response;
    const commit = await controller
      .commit(response, { previewId: "preview-1", region: "英国", projectType: "飞箱", addMissingNodes: true }, "zh-CN", ACTOR_ID)
      .catch((caught: unknown) => caught);
    expect(commit).toBeInstanceOf(AppError);
    expect((commit as AppError).code).toBe("RATE_LIMITED");
    expect(imports.commitCalls).toBe(0);

    imports.releasePreview();
    await first;
    expect(imports.previewCalls).toBe(1);
    expect(imports.lastPreviewInput).toMatchObject({ fileName: "book.xlsx", actorId: ACTOR_ID });
    expect(imports.lastPreviewInput).not.toHaveProperty("bytes");
    expect(imports.lastPreviewInput).toHaveProperty("sourceFile");
  });
});
