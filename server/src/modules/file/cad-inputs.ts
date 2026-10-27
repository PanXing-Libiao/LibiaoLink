import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { CadJobCreateBodySchema, CadCompanionSchema, z, type CadFormat, type CadJobCreateBody } from "@libiaolink/contracts";
import { createHash } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { ObjectStorage, versionFileName } from "../../storage/index.js";
import { PermissionService } from "../permission/index.js";
import { FileRepository } from "./file.repository.js";

export const CAD_DXF_INPUT_BYTES = 64 * 1024 * 1024;
export const CAD_EMPTY_RESOURCE_SET = "0".repeat(64);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const boundCompanion = CadCompanionSchema.extend({ sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/), sourceBytes: z.number().int().positive() });
export class CadInputIntegrityError extends ServiceUnavailableException {
  constructor() { super("原文件完整性检查未通过，请重新上传或下载核对"); }
}
export type CadBoundCompanion = z.infer<typeof boundCompanion>;
export type CadArchiveSource = {
  fileId: string; versionId: string; sourceSHA256: string; sourceBytes: number; sourceName: string;
  sourceFormat?: CadFormat; mainPath?: string | null; companions?: CadBoundCompanion[]; resourceSetHash?: string;
};
export type CadInputSource = CadArchiveSource & {
  sourceFormat: CadFormat; mainPath: string; companions: CadBoundCompanion[]; resourceSetHash: string;
};

export function cadFormat(name: string): CadFormat {
  if (/\.(step|stp)$/i.test(name)) return "STEP";
  if (/\.dxf$/i.test(name)) return "DXF";
  throw new AppError("NOT_FOUND", "该版本暂无 CAD 在线查看能力");
}

export function cadInputs(source: CadArchiveSource): CadInputSource {
  const format = cadFormat(source.sourceName);
  const companions = z.array(boundCompanion).max(127).parse(source.companions ?? []);
  const mainPath = source.mainPath ?? source.sourceName;
  if (format === "STEP" && companions.length) throw new AppError("VALIDATION_FAILED", "STEP 暂不接受配套文件");
  if (format === "DXF") {
    CadJobCreateBodySchema.parse({ mainPath, companions: companions.map(({ fileId, versionId, path }) => ({ fileId, versionId, path })) });
    if (mainPath.split("/").at(-1) !== source.sourceName) throw new AppError("VALIDATION_FAILED", "主图相对路径须保留原文件名");
  }
  companions.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const resourceSetHash = format === "STEP" ? CAD_EMPTY_RESOURCE_SET
    : digest(JSON.stringify([mainPath, companions.map((row) => [row.path, row.fileId, row.versionId, row.sourceSHA256, row.sourceBytes])]));
  if (source.sourceFormat && source.sourceFormat !== format || source.resourceSetHash && source.resourceSetHash !== resourceSetHash) {
    throw new Error("CAD input set identity mismatch");
  }
  return { ...source, sourceFormat: format, mainPath, companions, resourceSetHash };
}

export function cadResourceFingerprint(source: CadArchiveSource): string {
  const input = cadInputs(source);
  const files = [[input.mainPath, input.sourceSHA256], ...input.companions.map((row) => [row.path, row.sourceSHA256])]
    .sort((a, b) => Buffer.compare(Buffer.from(a[0]!), Buffer.from(b[0]!)));
  return digest(JSON.stringify([input.mainPath, files]));
}

/** File versions and project visibility own the entire input set, including cached derivatives. */
@Injectable()
export class CadInputService {
  constructor(private readonly files: FileRepository, private readonly permission: PermissionService, private readonly storage: ObjectStorage) {}

  async resolve(fileId: string, versionId: string, actorId: string, options: CadJobCreateBody): Promise<CadInputSource> {
    const selected = CadJobCreateBodySchema.parse(options);
    fileId = fileId.toLowerCase(); versionId = versionId.toLowerCase();
    selected.companions = selected.companions.map((row) => ({ ...row, fileId: row.fileId.toLowerCase(), versionId: row.versionId.toLowerCase() }));
    const refs = [{ fileId, versionId }, ...selected.companions];
    const rows = await this.versions(refs);
    const main = rows.get(versionId);
    if (!main || main.file.id !== fileId) throw new AppError("NOT_FOUND", "文件不存在或不可见");
    await this.permission.assertProjectVisible(actorId, main.file.projectId);
    const companions = selected.companions.map((ref) => {
      const row = rows.get(ref.versionId);
      if (!row || row.file.id !== ref.fileId || row.file.projectId !== main.file.projectId) throw new AppError("NOT_FOUND", "配套文件不存在或不可访问");
      const actual = versionFileName(row.file.name, row.version.objectKey).split(".").at(-1)?.toLowerCase();
      if (ref.path.split(".").at(-1)?.toLowerCase() !== actual) throw new AppError("VALIDATION_FAILED", "配套相对路径的扩展名须与文件版本一致");
      return { ...ref, sourceSHA256: row.version.contentHash, sourceBytes: row.version.sizeBytes };
    });
    const sourceName = versionFileName(main.file.name, main.version.objectKey);
    if (cadFormat(sourceName) === "STEP" && (selected.mainPath || companions.length)) throw new AppError("VALIDATION_FAILED", "STEP 暂不接受配套路径或文件");
    return cadInputs({ fileId, versionId, sourceName, sourceSHA256: main.version.contentHash,
      sourceBytes: main.version.sizeBytes, ...(selected.mainPath ? { mainPath: selected.mainPath } : {}), companions });
  }

  async assertAvailable(source: CadArchiveSource, actorId: string | null): Promise<void> {
    await this.boundVersions(cadInputs(source), actorId);
  }

  async payload(source: CadArchiveSource): Promise<Buffer> {
    const input = cadInputs(source);
    if (input.sourceFormat === "DXF" && input.sourceBytes + input.companions.reduce((sum, row) => sum + row.sourceBytes, 0) > CAD_DXF_INPUT_BYTES) {
      throw new ServiceUnavailableException("主图和配套文件合计不能超过 64 MiB");
    }
    const rows = await this.boundVersions(input, null);
    const entries = [{ versionId: input.versionId, path: input.mainPath, sourceBytes: input.sourceBytes, sourceSHA256: input.sourceSHA256 }, ...input.companions];
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const blobs: Buffer[] = [];
    // Bound concurrent storage streams as well as the total declared DXF input bytes.
    for (let i = 0; i < entries.length; i += 4) {
      blobs.push(...await Promise.all(entries.slice(i, i + 4).map(async (entry) => {
        const version = rows.get(entry.versionId)!.version;
        const object = await this.storage.getObjectStream(version.objectKey);
        if (!object || object.sizeBytes !== entry.sourceBytes) { object?.stream.destroy(); throw new CadInputIntegrityError(); }
        const chunks: Buffer[] = []; let total = 0; const hash = createHash("sha256");
        try {
          for await (const chunk of object.stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > entry.sourceBytes) throw new CadInputIntegrityError();
            hash.update(bytes); chunks.push(bytes);
          }
          if (total !== entry.sourceBytes || hash.digest("hex") !== entry.sourceSHA256) throw new CadInputIntegrityError();
          return Buffer.concat(chunks, total);
        } finally { object.stream.destroy(); }
      })));
    }
    if (input.sourceFormat === "STEP") return blobs[0]!;
    const header = Buffer.from(JSON.stringify({ version: "dxf-resources/1", main: input.mainPath,
      files: entries.map((entry) => ({ path: entry.path, byteLength: entry.sourceBytes })) }));
    if (header.byteLength > 128 * 1024) throw new Error("CAD input metadata exceeds budget");
    const prefix = Buffer.alloc(12); prefix.write("DXFRES1\n"); prefix.writeUInt32LE(header.byteLength, 8);
    return Buffer.concat([prefix, header, ...blobs]);
  }

  private async versions(refs: { fileId: string; versionId: string }[]) {
    const [files, versions] = await Promise.all([this.files.findFilesByIds(refs.map((row) => row.fileId)), this.files.findVersionsByIds(refs.map((row) => row.versionId))]);
    const byFile = new Map(files.filter((row) => row.status !== "recycled").map((row) => [row.id, row]));
    const result = new Map<string, { file: typeof files[number]; version: typeof versions[number] }>();
    for (const version of versions) {
      const file = byFile.get(version.fileId);
      if (file) result.set(version.id, { file, version });
    }
    return result;
  }

  private async boundVersions(input: CadInputSource, actorId: string | null) {
    const refs = [{ fileId: input.fileId, versionId: input.versionId, sourceSHA256: input.sourceSHA256, sourceBytes: input.sourceBytes }, ...input.companions];
    const rows = await this.versions(refs);
    const main = rows.get(input.versionId);
    if (!main || main.file.id !== input.fileId) throw new AppError("NOT_FOUND", "文件不存在或不可见");
    if (actorId !== null) await this.permission.assertProjectVisible(actorId, main.file.projectId);
    for (const ref of refs) {
      const row = rows.get(ref.versionId);
      if (!row || row.file.id !== ref.fileId || row.file.projectId !== main.file.projectId
        || row.version.contentHash !== ref.sourceSHA256 || row.version.sizeBytes !== ref.sourceBytes) {
        throw new AppError("NOT_FOUND", "主图或配套版本已不可访问");
      }
    }
    return rows;
  }
}
