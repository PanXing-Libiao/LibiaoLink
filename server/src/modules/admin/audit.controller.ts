import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AuditLogListQuerySchema, z } from "@libiaolink/contracts";
import type { AuditLogListQuery, AuditLogListResponse } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, SessionGuard } from "../identity/index.js";
import { GroupAccessGuard, ProjectAccessGuard, RequireAccessPage, RequirePermission } from "../permission/index.js";
import { AuditService } from "../audit/index.js";

/**
 * 审计接口（h7 · C7-04 服务端）：按对象（objectType + objectId）/ 操作人（actorId）/ 动作 / 结果 / 项目 / 时间区间检索，
 * 仅 audit.view（系统管理员）。页面与导出随 u12（px 线）；越权尝试用 result=denied 筛出（C7-03，告警随 M5 通知）。
 */
@Controller("api/v1/audit-logs")
@UseGuards(SessionGuard, CsrfGuard, GroupAccessGuard, ProjectAccessGuard)
@RequireAccessPage("audit")
export class AuditLogsController {
  constructor(private readonly audits: AuditService) {}

  /** 审计列表：occurredAt 降序（同毫秒按 id 降序）。 */
  @Get()
  @RequirePermission("audit.view")
  list(@Query(new ZodValidationPipe(AuditLogListQuerySchema)) query: AuditLogListQuery): Promise<AuditLogListResponse> {
    return this.audits.list(query);
  }
}
