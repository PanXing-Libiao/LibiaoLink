import { describe, expect, it } from "vitest";
import type { CreateMaterialReissueBody, MaterialReissueSnapshot } from "@libiaolink/contracts";
import { ClockService } from "../src/common/clock/clock.service.js";
import { MaterialReissueService } from "../src/modules/file/material-reissue.service.js";
import type {
  ChangeRequestInsertInput,
  ChangeRequestRow,
  FileCompletePatch,
  FileInsertInput,
  FileLinkInsertInput,
  FileRow,
  FileVersionInsertInput,
  FileVersionRow,
} from "../src/modules/file/file.repository.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const NODE = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const FILE = "22222222-2222-4222-8222-222222222222";
const VERSION = "66666666-6666-4666-8666-666666666666";
const ACTOR = "ea6eff88-4b3e-4df1-9ce0-02ffb14fed69";
const NOW = new Date("2026-11-09T04:05:00.000Z");

class FakeRepository {
  changeInput: ChangeRequestInsertInput | null = null;
  fileInput: FileInsertInput | null = null;
  versionInput: FileVersionInsertInput | null = null;
  completePatch: FileCompletePatch | null = null;
  links: FileLinkInsertInput[] = [];
  changeRefs: Array<{ taskIds: string[]; changeRequestId: string }> = [];
  createdFile: FileRow | null = null;

  async findProjectReissueBrief(): Promise<unknown> {
    return { id: PROJECT, code: "LBGN23171-G1", name: "虹迪广州NIKE分拣改造项目", customer: "NIKE", status: "active", deletedAt: null };
  }

  async findTaskReissueBrief(): Promise<unknown> {
    return { id: TASK, projectId: PROJECT, stageKey: "assembly", nodeId: NODE, title: "分拣线安装", deletedAt: null };
  }

  async insertChangeRequest(input: ChangeRequestInsertInput): Promise<ChangeRequestRow> {
    this.changeInput = input;
    return {
      id: input.id,
      projectId: input.projectId,
      nodeId: input.nodeId,
      stageKey: input.stageKey,
      changeType: input.changeType,
      materialReissue: input.materialReissue,
      reason: input.reason,
      beforeSummary: input.beforeSummary,
      afterSummary: input.afterSummary,
      beforeSummaryFileIds: input.beforeSummaryFileIds,
      afterSummaryFileIds: input.afterSummaryFileIds,
      status: "applied",
      appliedBy: input.appliedBy,
      writerBy: null,
      appliedAt: input.appliedAt,
      createdAt: input.createdAt,
    };
  }

  async insertFile(input: FileInsertInput): Promise<FileRow> {
    this.fileInput = input;
    this.createdFile = {
      id: FILE,
      projectId: input.projectId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      docType: input.docType,
      name: input.name,
      status: input.status,
      currentVersionId: null,
      version: 0,
      createdBy: input.createdBy,
      createdAt: NOW,
      updatedAt: NOW,
      finalizedAt: null,
      finalizedBy: null,
      recycledAt: null,
      recycledBy: null,
      recycledFromStatus: null,
      purgeAfter: null,
    };
    return this.createdFile;
  }

  async insertVersion(input: FileVersionInsertInput): Promise<FileVersionRow> {
    this.versionInput = input;
    return {
      id: VERSION,
      fileId: input.fileId,
      seq: input.seq,
      objectKey: input.objectKey,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      mime: input.mime,
      uploadedBy: input.uploadedBy,
      uploadedAt: input.uploadedAt,
      changeRequestId: input.changeRequestId ?? null,
    };
  }

  async updateFileOnComplete(fileId: string, patch: FileCompletePatch): Promise<FileRow> {
    if (this.createdFile === null || this.createdFile.id !== fileId) throw new Error("missing file");
    this.completePatch = patch;
    return {
      ...this.createdFile,
      currentVersionId: patch.currentVersionId,
      version: patch.version,
      status: patch.status ?? this.createdFile.status,
      finalizedAt: patch.finalizedAt ?? null,
      finalizedBy: patch.finalizedBy ?? null,
      updatedAt: patch.updatedAt,
    };
  }

  async insertFileLinks(links: FileLinkInsertInput[]): Promise<void> {
    this.links.push(...links);
  }

  async appendTasksChangeRefs(taskIds: string[], changeRequestId: string): Promise<number> {
    this.changeRefs.push({ taskIds, changeRequestId });
    return taskIds.length;
  }
}

class FakePermissionService {
  canCalls: unknown[] = [];
  async assertProjectVisible() { return { member: true, projectManager: false, groupAccessLevel: null }; }
  async assertCan(_actorId: string, permission: string, context: unknown): Promise<void> {
    this.canCalls.push({ permission, context });
  }
}

class FakeAuditService {
  records: unknown[] = [];
  async record(_tx: unknown, input: unknown): Promise<void> {
    this.records.push(input);
  }
}

class FakeUserService {
  async getUser(): Promise<unknown> {
    return { displayName: "李四" };
  }
}

class FakeStorage {
  put: { objectKey: string; body: Buffer; contentType: string; metadata: Record<string, string> } | null = null;
  async headObject(): Promise<null> { return null; }
  async putObject(input: { objectKey: string; body: Buffer; contentType: string; metadata: Record<string, string> }): Promise<void> { this.put = input; }
  async purgeObject(): Promise<void> {}
}

describe("MaterialReissueService.create", () => {
  it("服务端自动补齐申请人 / 项目 / 任务快照，并同事务生成变更记录与 DOCX 项目文件", async () => {
    const repo = new FakeRepository();
    const permission = new FakePermissionService();
    const audit = new FakeAuditService();
    const users = new FakeUserService();
    const storage = new FakeStorage();
    const clock = new ClockService();
    clock.setSource(() => NOW);
    const outbox: unknown[] = [];
    const tx = { insert: () => ({ values: async (row: unknown) => { outbox.push(row); } }) };
    const database = { db: { transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx) } };
    const service = new MaterialReissueService(
      repo as never,
      database as never,
      permission as never,
      audit as never,
      users as never,
      storage as never,
      clock,
    );
    const body: CreateMaterialReissueBody = {
      emailTitle: "项目【补发申请】LBGN23171-G1 虹迪广州NIKE分拣改造项目项目/ 紧急（改）",
      customerName: "NIKE 中国",
      reason: "transport_damage",
      applicationDepartment: "after_sales",
      accepted: true,
      inWarranty: false,
      freeReissue: true,
      approved: "no",
      responsibleDepartment: "supplier",
      requiredOutDate: "2026-11-12",
      oldPartReturn: true,
      freightBearer: "libiao",
      recipient: "张三",
      phone: "13800000000",
      address: "广州市黄埔区测试路 1 号",
      description: "运输过程中外壳破损，需要补发替换。",
      materials: [{ materialCode: "M-001", materialName: "光电传感器", specification: "E3Z-D61", quantity: 2, unit: "个", remark: "" }],
      taskId: TASK,
    };

    const result = await service.create(PROJECT, body, ACTOR);

    const snapshot = repo.changeInput!.materialReissue as MaterialReissueSnapshot;
    expect(repo.changeInput).toMatchObject({
      projectId: PROJECT,
      nodeId: NODE,
      stageKey: "assembly",
      changeType: "material_reissue",
      appliedBy: ACTOR,
      reason: "物料变更补发：运输过程损坏（1 项）",
    });
    expect(snapshot).toMatchObject({
      taskId: TASK,
      taskTitle: "分拣线安装",
      projectCode: "LBGN23171-G1",
      projectName: "虹迪广州NIKE分拣改造项目",
      customerName: "NIKE 中国",
      emailTitle: "项目【补发申请】LBGN23171-G1 虹迪广州NIKE分拣改造项目项目/ 紧急（改）",
      applicantName: "李四",
    });
    expect(repo.fileInput).toMatchObject({ projectId: PROJECT, taskId: TASK, name: "补发申请-LBGN23171-G1-202611091205.docx", status: "final", docType: null });
    expect(repo.versionInput).toMatchObject({ seq: 1, changeRequestId: repo.changeInput!.id, uploadedBy: ACTOR, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(repo.completePatch).toMatchObject({ status: "final", finalizedAt: NOW, finalizedBy: ACTOR, version: 1 });
    expect(repo.links.map((link) => link.objectType)).toEqual(["project", "task", "change", "node"]);
    expect(repo.changeRefs).toEqual([{ taskIds: [TASK], changeRequestId: repo.changeInput!.id }]);
    expect(permission.canCalls).toHaveLength(1);
    expect(audit.records).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    expect(storage.put?.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(storage.put?.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(result.changeRequest).toMatchObject({ changeType: "material_reissue", appliedBy: ACTOR, fileId: FILE, versionId: VERSION, versionSeq: 1 });
    expect(result.file).toMatchObject({ id: FILE, status: "final", currentVersionId: VERSION });
  });
});
