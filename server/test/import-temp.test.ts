import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/common/errors/app-error.js";
import {
  assertTemporarySpace,
  cleanupStaleImportTempDirs,
  IMPORT_TEMP_PREFIX,
  isNoSpaceError,
} from "../src/common/http/import-temp.js";

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "libiaolink-temp-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("import temp workspace", () => {
  it("启动清扫只删除超过保龄的导入临时目录", async () => {
    const root = await testRoot();
    const stale = join(root, IMPORT_TEMP_PREFIX + "stale");
    const fresh = join(root, IMPORT_TEMP_PREFIX + "fresh");
    const unrelated = join(root, "other-service");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
    const now = Date.now();
    const old = new Date(now - 7 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    expect(cleanupStaleImportTempDirs({ root, now })).toEqual({ removed: 1, failed: 0 });
    await expect(access(stale)).rejects.toBeDefined();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it("磁盘余量不足时在接收上传前 fail closed", () => {
    expect(() => assertTemporarySpace(1, 0)).toThrowError(AppError);
    expect(() => assertTemporarySpace(1, 65 * 1024 * 1024)).not.toThrow();
    expect(() => assertTemporarySpace(-1, 65 * 1024 * 1024)).toThrowError(/预算非法/);
  });

  it("识别嵌套在所有层里的 ENOSPC", () => {
    expect(isNoSpaceError({ cause: { cause: { code: "ENOSPC" } } })).toBe(true);
    expect(isNoSpaceError({ code: "EDQUOT" })).toBe(true);
    expect(isNoSpaceError(new Error("other"))).toBe(false);
  });
});
