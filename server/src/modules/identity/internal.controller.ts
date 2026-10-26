import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { z } from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CasdoorDirectorySource } from "./casdoor-directory.source.js";
import { InternalTokenGuard } from "./internal-token.guard.js";
import type { InternalUserActionResponse } from "./internal-user.service.js";
import { InternalUserService } from "./internal-user.service.js";
import { OrgSyncService, type OrgSyncReport } from "./org-sync.service.js";

/** 离职回收入参：name 为准、email 兜底，至少一个（docs/开发者接入注意事项(SSO接入标准).md 第五部分）。 */
const InternalUserActionBodySchema = z.object({
  name: z.string().min(1).optional(),
  email: z.email().optional(),
});

type InternalUserActionBody = z.infer<typeof InternalUserActionBodySchema>;

/** 组织同步手动触发入参：默认 report（只报告不执行缺失禁用），运维显式传 disable 才执行。 */
const OrgSyncRunBodySchema = z.object({
  missingUserPolicy: z.enum(["report", "disable"]).default("report"),
});

type OrgSyncRunBody = z.infer<typeof OrgSyncRunBodySchema>;

/** 离职回收 API（X-Internal-Token 鉴权；幂等；disable / delete 踢在线会话）。 */
@Controller("internal/users")
@UseGuards(InternalTokenGuard)
export class InternalUsersController {
  constructor(private readonly users: InternalUserService) {}

  @Post("disable")
  @HttpCode(200)
  disable(@Body(new ZodValidationPipe(InternalUserActionBodySchema)) body: InternalUserActionBody): Promise<InternalUserActionResponse> {
    return this.users.execute("disable", toActionInput(body));
  }

  @Post("enable")
  @HttpCode(200)
  enable(@Body(new ZodValidationPipe(InternalUserActionBodySchema)) body: InternalUserActionBody): Promise<InternalUserActionResponse> {
    return this.users.execute("enable", toActionInput(body));
  }

  @Post("delete")
  @HttpCode(200)
  remove(@Body(new ZodValidationPipe(InternalUserActionBodySchema)) body: InternalUserActionBody): Promise<InternalUserActionResponse> {
    return this.users.execute("delete", toActionInput(body));
  }
}

/** 目录同步作业入口（h1 · D1-02）：保留为运维手动补偿；常态由 worker 启动即自动同步并周期轮询，前端不提供同步按钮。 */
@Controller("internal/org-sync")
@UseGuards(InternalTokenGuard)
export class InternalOrgSyncController {
  constructor(
    private readonly source: CasdoorDirectorySource,
    private readonly orgSync: OrgSyncService,
  ) {}

  @Post("run")
  @HttpCode(200)
  async run(@Body(new ZodValidationPipe(OrgSyncRunBodySchema)) body: OrgSyncRunBody): Promise<{ ok: true; report: OrgSyncReport }> {
    const snapshot = await this.source.pull();
    const report = await this.orgSync.applySnapshot(snapshot, { missingUserPolicy: body.missingUserPolicy });
    return { ok: true, report };
  }
}

function toActionInput(body: InternalUserActionBody): { name: string | null; email: string | null } {
  return { name: body.name ?? null, email: body.email ?? null };
}
