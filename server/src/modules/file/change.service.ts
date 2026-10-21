import { Injectable } from "@nestjs/common";
import {
  ChangeRequestDetailSchema,
  ChangeRequestListResponseSchema,
  ChangeRequestSchema,
  z,
} from "@libiaolink/contracts";
import { AuditService } from "../admin/index.js";
import { AppError } from "../../common/errors/app-error.js";
import { PermissionService } from "../permission/index.js";
import { parseChangeListFilter, parseChangeListSort, type ChangeRequestListQueryInput } from "./change.query.js";
import { FileRepository, type ChangeRequestJoinedRow } from "./file.repository.js";
import { toChangeRequestView, toFileView, toVersionView } from "./file.service.js";

type ChangeRequestView = z.infer<typeof ChangeRequestSchema>;
type ChangeListResponse = z.infer<typeof ChangeRequestListResponseSchema>;
type ChangeDetail = z.infer<typeof ChangeRequestDetailSchema>;

/**
 * 变更记录读面（S7·file · M4-04 读面 · A4-15）：变更记录列表 / 详情。
 *
 * 写入面（申请即通过）在 FileService（上传管道 complete / 定档后回溯）；本服务只读：
 * `change_requests` 一行 → 按 `file_versions.change_request_id` 反查变更后文件 / 版本（一期一变更一版本）。
 * Push 319：导入表导入的变更没有变更后文件（源文件在微盘）→ 读面宽容 fileId / versionId 为空，详情 file / version 给 null。
 * 可见性：列表由 ProjectAccessGuard 按路径项目判定；详情路径不含项目，服务层按变更所属项目判定
 * （非成员 404，防 IDOR —— 与 file 模块读面同一口径）。视图映射复用写入面的 toChangeRequestView，
 * 避免「写面 / 读面」两处字段口径漂移。
 */
@Injectable()
export class ChangeService {
  constructor(
    private readonly repository: FileRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /** GET /projects/{id}/change-requests：变更记录列表（阶段 / 节点 / 文件 / 申请人筛选 + 关键字 + 排序 + 分页）。 */
  async listProjectChanges(projectId: string, query: ChangeRequestListQueryInput): Promise<ChangeListResponse> {
    const filter = parseChangeListFilter(projectId, query);
    const sorts = parseChangeListSort(query.sort);
    const offset = (query.page - 1) * query.limit;
    const { items, total } = await this.repository.listChangeRequests(projectId, filter, sorts, query.limit, offset);
    return { items: items.map(toChangeListView), page: query.page, limit: query.limit, total };
  }

  /** GET /change-requests/{id}：变更详情（含变更后文件与版本；导入遗留变更 = null）；不存在 / 不可见一律 404。 */
  async getChange(changeRequestId: string, actorId: string): Promise<ChangeDetail> {
    const row = await this.repository.findChangeRequestJoinedById(changeRequestId);
    if (row === null) throw new AppError("NOT_FOUND", "变更记录不存在");
    await this.permission.assertProjectVisible(actorId, row.projectId);
    const fileId = row.fileId;
    const versionId = row.versionId;
    // Push 319：导入变更没有「变更后文件」（fileId / versionId 为空）→ file / version 给 null（前端标「待补」）；
    // 有 fileId 却取不到文件 / 版本 = 数据不一致（500，维持原口径）。
    const file = fileId === null ? null : await this.repository.findFileById(fileId);
    const version = fileId === null || versionId === null ? null : await this.repository.findVersionById(fileId, versionId);
    if ((fileId === null) !== (versionId === null) || (fileId !== null && (file === null || version === null))) {
      throw new AppError("INTERNAL", "变更记录的变更后文件 / 版本缺失（数据不一致）");
    }
    return {
      ...toChangeListView(row),
      file: file === null ? null : toFileView(file),
      version: version === null ? null : toVersionView(version),
      filePreviousName: await this.previousFileName(changeRequestId),
    };
  }

  /** 「变更前文件名称」（Push 256 · 业务口径「变更后文件的名字后后缀要用变更选择的」）：变更完成时若更名，
   *  审计（objectType=change / objectId=本次变更）的 changes 记有 { field: "name", from, to } —— 读面按需回捞 from。
   *  未更名 / 无审计（历史数据）= null；不新增 DDL（变更更名不落 change_requests 列）。 */
  private async previousFileName(changeRequestId: string): Promise<string | null> {
    const page = await this.audit.list({ objectType: "change", objectId: changeRequestId, action: "create", page: 1, limit: 10 });
    for (const item of page.items) {
      const entries = item.changes ?? [];
      for (const entry of entries) {
        if (entry.field === "name" && typeof entry.from === "string" && entry.from !== "") {
          return entry.from;
        }
      }
    }
    return null;
  }
}

/** 读面行 → 契约视图：复用写入面的映射（同一份字段口径）。 */
function toChangeListView(row: ChangeRequestJoinedRow): ChangeRequestView {
  const version = row.versionId === null || row.versionSeq === null ? null : { id: row.versionId, seq: row.versionSeq };
  return toChangeRequestView(row, row.fileId, version);
}
