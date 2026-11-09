import { createHash, randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  CreateMaterialReissueBodySchema,
  MATERIAL_REISSUE_REASON_OPTIONS,
  MaterialReissueResultSchema,
  z,
} from "@libiaolink/contracts";
import { AuditService } from "../admin/index.js";
import { AppError } from "../../common/errors/app-error.js";
import { ClockService } from "../../common/clock/clock.service.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutbox } from "../../db/outbox.js";
import { buildBlobObjectKey, ObjectStorage } from "../../storage/index.js";
import { UserService } from "../identity/index.js";
import { PermissionService } from "../permission/index.js";
import { FileRepository, type ChangeRequestRow, type FileLinkInsertInput, type FileRow, type FileVersionRow } from "./file.repository.js";
import { toChangeRequestView, toFileView, toVersionView } from "./file.service.js";
import {
  MATERIAL_REISSUE_DOCX_MIME,
  buildMaterialReissueDocx,
  materialReissueFileName,
} from "./material-reissue-document.js";

type CreateBody = z.infer<typeof CreateMaterialReissueBodySchema>;
type Result = z.infer<typeof MaterialReissueResultSchema>;

/**
 * 物料变更补发（2026-11-09 · 业务口径）：任务抽屉「变更申请」下拉的第二入口。
 * 一次提交 = 变更记录 + 自动生成的《补发/补货申请表》DOCX + 任务 change_refs 回写；
 * 申请人 / 时间由服务端自动写入，项目 / 客户 / 来源任务自动带入并固化快照。
 */
@Injectable()
export class MaterialReissueService {
  constructor(
    private readonly repository: FileRepository,
    private readonly database: DatabaseService,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
    private readonly users: UserService,
    private readonly storage: ObjectStorage,
    private readonly clock: ClockService,
  ) {}

  private readonly logger = new Logger(MaterialReissueService.name);

  async create(projectId: string, body: CreateBody, actorId: string): Promise<Result> {
    const access = await this.permission.assertProjectVisible(actorId, projectId);
    await this.permission.assertCan(actorId, "file.upload", {
      member: access.member,
      projectManager: access.projectManager,
      groupAccessLevel: access.groupAccessLevel,
    });
    const project = await this.repository.findProjectReissueBrief(projectId);
    if (project === null || project.deletedAt !== null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    if (project.status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止新增文件");
    }
    const task = await this.repository.findTaskReissueBrief(body.taskId);
    if (task === null || task.deletedAt !== null || task.projectId !== projectId) {
      throw new AppError("VALIDATION_FAILED", "来源任务不存在或不属于该项目", [
        { code: "invalid_task", message: "taskId 必须属于当前项目且未删除", path: "taskId" },
      ]);
    }
    validateOtherText(body);
    const applicant = await this.users.getUser(actorId);
    const at = this.clock.now();
    const reasonLabel = reasonText(body.reason, body.reasonOther);
    const snapshot = {
      ...body,
      reasonOther: body.reasonOther ?? undefined,
      applicationDepartmentOther: body.applicationDepartmentOther ?? undefined,
      responsibleDepartmentOther: body.responsibleDepartmentOther ?? undefined,
      taskId: task.id,
      taskTitle: task.title,
      projectCode: project.code,
      projectName: project.name,
      customerName: project.customer,
      applicantName: applicant.displayName,
    };
    const fileName = materialReissueFileName(snapshot, at);
    const bytes = buildMaterialReissueDocx(snapshot, at);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = buildBlobObjectKey({ projectId, contentHash, fileName });
    const objectExisted = (await this.storage.headObject(objectKey)) !== null;
    await this.storage.putObject({
      objectKey,
      body: bytes,
      contentType: MATERIAL_REISSUE_DOCX_MIME,
      metadata: {
        source: "libiaolink-material-reissue",
        projectId,
        taskId: task.id,
        contentHash,
      },
    });
    const changeId = randomUUID();
    let outcome: { changeRequest: ChangeRequestRow; file: FileRow; version: FileVersionRow };
    try {
      outcome = await this.database.db.transaction(async (tx) => {
        const change = await this.repository.insertChangeRequest(
          {
            id: changeId,
            projectId,
            nodeId: task.nodeId,
            stageKey: task.stageKey,
            changeType: "material_reissue",
            materialReissue: snapshot,
            reason: "物料变更补发：" + reasonLabel + "（" + String(body.materials.length) + " 项）",
            beforeSummary: null,
            afterSummary: "补发物料 " + String(body.materials.length) + " 项；要求出库 " + body.requiredOutDate,
            beforeSummaryFileIds: [],
            afterSummaryFileIds: [],
            appliedBy: actorId,
            appliedAt: at,
            createdAt: at,
          },
          tx,
        );
        const file = await this.repository.insertFile(
          {
            projectId,
            nodeId: task.nodeId,
            taskId: task.id,
            docType: null,
            name: fileName,
            status: "final",
            createdBy: actorId,
          },
          tx,
        );
        const version = await this.repository.insertVersion(
          {
            fileId: file.id,
            seq: 1,
            objectKey,
            sizeBytes: bytes.length,
            contentHash,
            mime: MATERIAL_REISSUE_DOCX_MIME,
            uploadedBy: actorId,
            uploadedAt: at,
            changeRequestId: change.id,
          },
          tx,
        );
        const updatedFile = await this.repository.updateFileOnComplete(
          file.id,
          {
            currentVersionId: version.id,
            version: 1,
            status: "final",
            finalizedAt: at,
            finalizedBy: actorId,
            updatedAt: at,
          },
          tx,
        );
        const links: FileLinkInsertInput[] = [
          { fileId: updatedFile.id, objectType: "project", objectId: projectId, createdBy: actorId, createdAt: at },
          { fileId: updatedFile.id, objectType: "task", objectId: task.id, createdBy: actorId, createdAt: at },
          { fileId: updatedFile.id, objectType: "change", objectId: change.id, createdBy: actorId, createdAt: at },
        ];
        if (task.nodeId !== null) {
          links.push({ fileId: updatedFile.id, objectType: "node", objectId: task.nodeId, createdBy: actorId, createdAt: at });
        }
        await this.repository.insertFileLinks(links, tx);
        await this.repository.appendTasksChangeRefs([task.id], change.id, tx);
        await this.audit.record(tx, {
          actorId,
          action: "create",
          objectType: "change",
          objectId: change.id,
          projectId,
          summary: "物料变更补发：" + reasonLabel + "（" + String(body.materials.length) + " 项）",
          metadata: {
            changeType: "material_reissue",
            taskId: task.id,
            fileId: updatedFile.id,
            versionId: version.id,
            reason: body.reason,
            materialCount: body.materials.length,
          },
        });
        await this.audit.record(tx, {
          actorId,
          action: "create",
          objectType: "file",
          objectId: updatedFile.id,
          projectId,
          summary: "生成补发申请： " + fileName,
          metadata: {
            uploadId: null,
            versionSeq: version.seq,
            objectKey,
            contentHash,
            sizeBytes: bytes.length,
            changeRequestId: change.id,
            generated: "material_reissue",
          },
        });
        await appendOutbox(tx, {
          topic: "file.version.created",
          dedupeKey: "file.version.created:" + version.id,
          payload: {
            projectId,
            fileId: updatedFile.id,
            versionId: version.id,
            seq: version.seq,
            objectKey,
            contentHash,
            sizeBytes: bytes.length,
            mime: MATERIAL_REISSUE_DOCX_MIME,
            actorId,
            at: at.toISOString(),
            generated: "material_reissue",
          },
        });
        await appendOutbox(tx, {
          topic: "change.applied",
          dedupeKey: "change.applied:" + change.id,
          payload: {
            projectId,
            changeRequestId: change.id,
            fileId: updatedFile.id,
            versionId: version.id,
            versionSeq: version.seq,
            nodeId: task.nodeId,
            stageKey: task.stageKey,
            reason: change.reason,
            taskId: task.id,
            changeType: "material_reissue",
            actorId,
            at: at.toISOString(),
          },
        });
        return { changeRequest: change, file: updatedFile, version };
      });
    } catch (error) {
      if (!objectExisted) {
        await this.storage.purgeObject(objectKey).catch((cleanupError: unknown) => {
          this.logger.warn("补发申请事务失败后清理对象失败：" + objectKey + "；" + String(cleanupError));
        });
      }
      throw error;
    }
    return {
      changeRequest: toChangeRequestView(outcome.changeRequest, outcome.file.id, outcome.version),
      file: toFileView(outcome.file),
      version: toVersionView(outcome.version),
    };
  }
}

function validateOtherText(body: CreateBody): void {
  const checks = [
    { value: body.reason, other: body.reasonOther, field: "reasonOther", label: "补发类别" },
    { value: body.applicationDepartment, other: body.applicationDepartmentOther, field: "applicationDepartmentOther", label: "申请部门" },
    { value: body.responsibleDepartment, other: body.responsibleDepartmentOther, field: "responsibleDepartmentOther", label: "责任归属部门" },
  ];
  for (const check of checks) {
    if (check.value === "other" && (check.other ?? "").trim() === "") {
      throw new AppError("VALIDATION_FAILED", check.label + "选择其他时须填写具体内容", [
        { code: "required", message: check.label + "其他内容必填", path: check.field },
      ]);
    }
  }
}

function reasonText(reason: string, reasonOther: string | undefined): string {
  const label = MATERIAL_REISSUE_REASON_OPTIONS.find((item) => item.value === reason)?.label ?? reason;
  return reason === "other" && reasonOther !== undefined && reasonOther !== "" ? label + "：" + reasonOther : label;
}
