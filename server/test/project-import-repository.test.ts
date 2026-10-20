import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import { changeRequests } from "../src/db/schema/change.js";
import { fileLinks, fileVersions, files } from "../src/db/schema/files.js";
import { ProjectImportRepository } from "../src/modules/project-import/project-import.repository.js";

type FakeState = {
  changeExists: boolean;
  attached: Array<{ id: string }>;
  version: { id: string; changeRequestId: string | null } | null;
};

type FakeTx = {
  tx: DbClient;
  versionUpdates: Array<Record<string, unknown>>;
  fileUpdates: Array<Record<string, unknown>>;
  linkInserts: Array<Record<string, unknown>>;
};

/** 只实现 attachChangeFile 用到的 select / update / insert 链（不连库）。 */
function fakeTx(state: FakeState): FakeTx {
  const versionUpdates: Array<Record<string, unknown>> = [];
  const fileUpdates: Array<Record<string, unknown>> = [];
  const linkInserts: Array<Record<string, unknown>> = [];
  const tx = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            const columns = Object.keys(fields);
            let rows: unknown[] = [];
            if (table === changeRequests) rows = state.changeExists ? [{ id: "change" }] : [];
            else if (table === fileVersions) {
              rows = columns.length === 1 ? state.attached : state.version === null ? [] : [state.version];
            }
            return Object.assign(Promise.resolve(rows), { for: async () => rows });
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === fileVersions) versionUpdates.push(values);
          if (table === files) fileUpdates.push(values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          if (table === fileLinks) linkInserts.push(values);
        },
      }),
    }),
  } as unknown as DbClient;
  return { tx, versionUpdates, fileUpdates, linkInserts };
}

const repository = new ProjectImportRepository({ db: {} } as unknown as DatabaseService);
const AT = new Date("2026-10-20T00:00:00Z");
const input = { fileId: "file-1", versionId: "version-1", changeId: "change-1", actorId: "user-1", at: AT };

describe("ProjectImportRepository.attachChangeFile（一变更一版本）", () => {
  it("变更已有其它文件版本 → conflict，不写任何行", async () => {
    const fake = fakeTx({ changeExists: true, attached: [{ id: "version-2" }], version: { id: input.versionId, changeRequestId: null } });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("conflict");
    expect(fake.versionUpdates).toEqual([]);
    expect(fake.fileUpdates).toEqual([]);
    expect(fake.linkInserts).toEqual([]);
  });

  it("同一变更 + 同一版本重复调用 → already（幂等）", async () => {
    const fake = fakeTx({ changeExists: true, attached: [{ id: input.versionId }], version: { id: input.versionId, changeRequestId: input.changeId } });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("already");
    expect(fake.versionUpdates).toEqual([]);
    expect(fake.fileUpdates).toEqual([]);
    expect(fake.linkInserts).toEqual([]);
  });

  it("版本已挂其它变更 → conflict", async () => {
    const fake = fakeTx({ changeExists: true, attached: [], version: { id: input.versionId, changeRequestId: "change-2" } });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("conflict");
    expect(fake.versionUpdates).toEqual([]);
  });

  it("版本不存在 → missing", async () => {
    const fake = fakeTx({ changeExists: true, attached: [], version: null });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("missing");
  });

  it("变更不存在 → missing_change", async () => {
    const fake = fakeTx({ changeExists: false, attached: [], version: { id: input.versionId, changeRequestId: null } });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("missing_change");
    expect(fake.versionUpdates).toEqual([]);
  });

  it("成功 → 写版本变更 id + 文件状态置 changed + file_links(change)", async () => {
    const fake = fakeTx({ changeExists: true, attached: [], version: { id: input.versionId, changeRequestId: null } });
    await expect(repository.attachChangeFile(fake.tx, input)).resolves.toBe("attached");
    expect(fake.versionUpdates).toEqual([{ changeRequestId: input.changeId }]);
    expect(fake.fileUpdates).toEqual([{ status: "changed", updatedAt: AT }]);
    expect(fake.linkInserts).toEqual([
      {
        fileId: input.fileId,
        objectType: "change",
        objectId: input.changeId,
        kind: "",
        createdBy: input.actorId,
        createdAt: AT,
      },
    ]);
  });
});
