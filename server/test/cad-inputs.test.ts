import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { CadInputIntegrityError, CadInputService, type CadArchiveSource } from "../src/modules/file/cad-inputs.js";

const mainId = "a1111111-1111-4111-8111-111111111111", companionId = "b2222222-2222-4222-8222-222222222222";
const version = "c3333333-3333-4333-8333-333333333333", companionVersion = "d4444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function payloadBytes(service: CadInputService, source: CadArchiveSource): Promise<Buffer> {
  const payload = await service.enginePayload(source);
  if (payload.body instanceof Uint8Array) return Buffer.from(payload.body);
  const chunks: Buffer[] = [];
  for await (const chunk of payload.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function fixture() {
  const main = Buffer.from("main drawing"), resource = Buffer.from("font bytes");
  const files = [{ id: mainId, projectId, name: "main.dxf", status: "draft" }, { id: companionId, projectId, name: "font.shx", status: "draft" }];
  const versions = [{ id: version, fileId: mainId, objectKey: "objects/main.dxf", contentHash: sha(main), sizeBytes: main.length },
    { id: companionVersion, fileId: companionId, objectKey: "objects/font.shx", contentHash: sha(resource), sizeBytes: resource.length }];
  const repository = { findFilesByIds: async () => files, findVersionsByIds: async () => versions };
  const permission = { assertProjectVisible: vi.fn(async () => {}) };
  const blobs = new Map([[versions[0]!.objectKey, main], [versions[1]!.objectKey, resource]]);
  const storage = { getObjectStream: vi.fn(async (key: string) => {
    const bytes = blobs.get(key); return bytes ? { sizeBytes: bytes.length, stream: Readable.from(bytes) } : null;
  }) };
  const service = new CadInputService(repository as never, permission as never, storage as never);
  const options = { mainPath: "drawings/main.dxf", companions: [{ fileId: companionId, versionId: companionVersion, path: "fonts/font.shx" }] };
  return { service, files, versions, permission, storage, blobs, options };
}

describe("CAD input set authorization and content identity", () => {
  it.each(["ttf", "otf", "ttc", "dgn", "dwf", "dwfx", "ctb", "stb"])("binds uploaded %s companions to the selected file version", async (extension) => {
    const f = fixture(); f.files[1]!.name = `font.${extension}`;
    const bytes = f.blobs.get(f.versions[1]!.objectKey)!;
    f.blobs.delete(f.versions[1]!.objectKey);
    f.versions[1]!.objectKey = `objects/font.${extension}`;
    f.blobs.set(f.versions[1]!.objectKey, bytes);
    f.options.companions[0]!.path = `fonts/font.${extension}`;
    const source = await f.service.resolve(mainId, version, "actor", f.options);
    expect(source.companions[0]!.path).toBe(`fonts/font.${extension}`);
    expect((await payloadBytes(f.service, source)).includes(Buffer.from(`fonts/font.${extension}`))).toBe(true);
    f.files[1]!.projectId = "another-project";
    await expect(f.service.assertAvailable(source, "actor")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps explicit version/path bindings and changes identity for a changed selection", async () => {
    const f = fixture(); const source = await f.service.resolve(mainId, version, "actor", f.options);
    expect(source.sourceFormat).toBe("DXF"); expect(source.companions).toHaveLength(1);
    const empty = await f.service.resolve(mainId, version, "actor", { companions: [] });
    expect(empty.resourceSetHash).not.toBe(source.resourceSetHash);
    const moved = await f.service.resolve(mainId, version, "actor", { ...f.options, mainPath: "other/main.dxf" });
    expect(moved.resourceSetHash).not.toBe(source.resourceSetHash);
    expect((await payloadBytes(f.service, source)).subarray(0, 8).toString()).toBe("DXFRES1\n");
    const upper = await f.service.resolve(mainId.toUpperCase(), version.toUpperCase(), "actor", { ...f.options,
      companions: f.options.companions.map((row) => ({ ...row, fileId: row.fileId.toUpperCase(), versionId: row.versionId.toUpperCase() })) });
    expect(upper.resourceSetHash).toBe(source.resourceSetHash);
  });
  it("rejects cross-project, recycled, wrong-version and duplicate/escaping paths", async () => {
    const f = fixture(); f.files[1]!.projectId = "another-project";
    await expect(f.service.resolve(mainId, version, "actor", f.options)).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.files[1]!.projectId = projectId; f.files[1]!.status = "recycled";
    await expect(f.service.resolve(mainId, version, "actor", f.options)).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.files[1]!.status = "draft";
    await expect(f.service.resolve(mainId, version, "actor", { ...f.options, companions: [{ ...f.options.companions[0]!, versionId: version }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.service.resolve(mainId, version, "actor", { ...f.options, companions: [{ ...f.options.companions[0]!, path: "../font.shx" }] })).rejects.toBeDefined();
    await expect(f.service.resolve(mainId, version, "actor", { ...f.options, companions: [...f.options.companions, ...f.options.companions] })).rejects.toBeDefined();
    expect(f.storage.getObjectStream).not.toHaveBeenCalled();
  });
  it("streams DWG bytes and rejects same-size content corruption without buffering the whole file", async () => {
    const f = fixture();
    f.files[0]!.name = "main.dwg";
    f.versions[0]!.objectKey = "objects/main.dwg";
    const main = f.blobs.get("objects/main.dxf")!;
    f.blobs.set(f.versions[0]!.objectKey, main);
    const source = await f.service.resolve(mainId, version, "actor", { companions: [] });
    const payload = await f.service.enginePayload(source);
    expect(payload.body instanceof Uint8Array).toBe(false);
    expect(payload.byteLength).toBe(main.byteLength);
    expect(payload.sha256).toBe(sha(main));
    expect(await payloadBytes(f.service, source)).toEqual(main);

    const corrupted = Buffer.from(main); corrupted[0] = corrupted[0]! ^ 1;
    f.storage.getObjectStream.mockResolvedValueOnce({ sizeBytes: corrupted.byteLength, stream: Readable.from(corrupted) });
    await expect(payloadBytes(f.service, source)).rejects.toBeInstanceOf(CadInputIntegrityError);
  });
  it("preserves bare DWG bytes and binds selected DWG resource paths and versions", async () => {
    const f = fixture();
    f.files[0]!.name = "main.dwg";
    f.versions[0]!.objectKey = "objects/main.dwg";
    f.blobs.set(f.versions[0]!.objectKey, f.blobs.get("objects/main.dxf")!);
    f.blobs.delete("objects/main.dxf");
    const main = f.blobs.get(f.versions[0]!.objectKey)!;
    const source = await f.service.resolve(mainId, version, "actor", { companions: [] });
    expect(source.sourceFormat).toBe("DWG");
    expect(source.mainPath).toBe("main.dwg");
    expect(source.companions).toHaveLength(0);
    expect(source.resourceSetHash).toBe("0".repeat(64));
    expect(await payloadBytes(f.service, source)).toEqual(main);
    const moved = await f.service.resolve(mainId, version, "actor", {
      mainPath: "drawings/main.dwg", companions: [],
    });
    expect(moved.resourceSetHash).not.toBe(source.resourceSetHash);
    const selected = await f.service.resolve(mainId, version, "actor", { ...f.options, mainPath: "drawings/main.dwg" });
    expect(selected.companions).toMatchObject([{ fileId: companionId, versionId: companionVersion, path: "fonts/font.shx" }]);
    expect(selected.resourceSetHash).not.toBe(moved.resourceSetHash);
    const bytes = await payloadBytes(f.service, selected), headerEnd = 12 + bytes.readUInt32LE(8);
    expect(bytes.subarray(0, 8).toString()).toBe("DXFRES1\n");
    expect(JSON.parse(bytes.subarray(12, headerEnd).toString())).toEqual({ version: "dxf-resources/1", main: "drawings/main.dwg",
      files: [{ path: "drawings/main.dwg", byteLength: main.length }, { path: "fonts/font.shx", byteLength: f.versions[1]!.sizeBytes }] });
    expect(bytes.subarray(headerEnd)).toEqual(Buffer.concat([main, f.blobs.get(f.versions[1]!.objectKey)!]));
    await expect(f.service.resolve(mainId, version, "actor", f.options)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    f.files[1]!.projectId = "another-project";
    await expect(f.service.assertAvailable(selected, "actor")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
