import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config/config.module.js";
import type { Env } from "../src/config/env.js";
import { ImportAdmissionGate } from "../src/modules/project-import/import-admission.gate.js";

const MIB = 1024 * 1024;
const IMPORT_MAX_TEST_BYTES = 256 * MIB;

function createGate(previewBudget = 3, commitLimit = 1): ImportAdmissionGate {
  return new ImportAdmissionGate(
    new AppConfig({
      IMPORT_CONCURRENCY_BUDGET: previewBudget,
      IMPORT_COMMIT_CONCURRENCY: commitLimit,
    } as Env),
  );
}

describe("ImportAdmissionGate preview", () => {
  it("三个小文件可并行，第四个立即拒绝；归还后可再次准入", () => {
    const gate = createGate();
    const first = gate.tryPreview(1 * MIB);
    const second = gate.tryPreview(32 * MIB);
    const third = gate.tryPreview(32 * MIB);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(gate.tryPreview(1)).toBeNull();

    first!.release();
    expect(gate.tryPreview(1)).not.toBeNull();
  });

  it("中文件占两个额度，重型文件独占全部额度", () => {
    const gate = createGate();
    const medium = gate.tryPreview(33 * MIB);
    expect(medium).not.toBeNull();
    const small = gate.tryPreview(1);
    expect(small).not.toBeNull();
    expect(gate.tryPreview(1)).toBeNull();
    small!.release();
    medium!.release();

    const heavy = gate.tryPreview(129 * MIB);
    expect(heavy).not.toBeNull();
    expect(gate.tryPreview(1)).toBeNull();
  });

  it("Content-Length 缺失或非法按重型任务保守计权", () => {
    const gate = createGate();
    const missing = gate.tryPreview(undefined);
    expect(missing).not.toBeNull();
    expect(gate.tryPreview(1)).toBeNull();
    missing!.release();

    const invalid = gate.tryPreview("not-a-number");
    expect(invalid).not.toBeNull();
    expect(gate.tryPreview(-1)).toBeNull();
  });

  it("release 幂等，重复归还不会放大后续准入额度", () => {
    const gate = createGate();
    const first = gate.tryPreview(MIB)!;
    first.release();
    first.release();

    const leases = [gate.tryPreview(MIB), gate.tryPreview(MIB), gate.tryPreview(MIB)];
    expect(leases.every((lease) => lease !== null)).toBe(true);
    expect(gate.tryPreview(MIB)).toBeNull();
  });

  it("预算为 1 时所有大小都按单任务串行回退", () => {
    const gate = createGate(1, 1);
    const heavy = gate.tryPreview(IMPORT_MAX_TEST_BYTES);
    expect(heavy).not.toBeNull();
    expect(gate.tryPreview(1)).toBeNull();
    heavy!.release();
    expect(gate.tryPreview(IMPORT_MAX_TEST_BYTES)).not.toBeNull();
  });
});

describe("ImportAdmissionGate commit", () => {
  it("同一 previewId 防重入，且默认提交并发为 1", () => {
    const gate = createGate(3, 1);
    const first = gate.tryCommit("preview-a", 1 * MIB);
    expect(first).not.toBeNull();
    expect(gate.tryCommit("preview-a", 1 * MIB)).toBeNull();
    expect(gate.tryCommit("preview-b", 1 * MIB)).toBeNull();

    first!.release();
    first!.release();
    expect(gate.tryCommit("preview-a", 1 * MIB)).not.toBeNull();
  });

  it("提交并发上限可配置，不同票据按额度并行且同票据仍单飞", () => {
    const gate = createGate(3, 2);
    const first = gate.tryCommit("preview-a", 1 * MIB);
    const second = gate.tryCommit("preview-b", 1 * MIB);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.tryCommit("preview-a", 1 * MIB)).toBeNull();
    expect(gate.tryCommit("preview-c", 1 * MIB)).toBeNull();
    first!.release();
    expect(gate.tryCommit("preview-c", 1 * MIB)).not.toBeNull();
  });
});
