import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  AutomationRulePatchBodySchema,
  AutomationRuleTestBodySchema,
  AutomationRunListQuerySchema,
  z,
  type AutomationRulePatchBody,
  type AutomationRuleTestBody,
  type AutomationRuleTestResponse,
  type AutomationRuleView,
  type AutomationRuleListResponse,
  type AutomationRun,
  type AutomationRunListQuery,
  type AutomationRunListResponse,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { AutomationService } from "./automation.service.js";

/** 规则码按普通路径段校验；未知 / R01 / 非内置由 service 统一 404（不泄漏存在性）。 */
const ruleCodeParam = new ZodValidationPipe(z.string().min(1).max(32));
const runIdParam = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * 自动化规则管理接口（M5-06-1B · 契约 shared/src/modules/automation.ts）：
 * - 读：GET /rules、GET /rules/{code}、GET /runs、GET /runs/{id} —— automation.view；
 * - 写：PATCH /rules/{code}（乐观锁保存）、POST /rules/{code}/test（只读试运行）—— automation.manage；
 * - 管理动作不靠前端按钮隐藏：守卫 + service 双重判定，缺权限 403。
 */
@Controller("api/v1/automation")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get("rules")
  @RequirePermission("automation.view")
  listRules(@CurrentActorId() actorId: string): Promise<AutomationRuleListResponse> {
    return this.automation.listRules(actorId);
  }

  @Get("rules/:code")
  @RequirePermission("automation.view")
  getRule(
    @Param("code", ruleCodeParam) code: string,
    @CurrentActorId() actorId: string,
  ): Promise<AutomationRuleView> {
    return this.automation.getRule(actorId, code);
  }

  @Patch("rules/:code")
  @RequirePermission("automation.manage")
  patchRule(
    @Param("code", ruleCodeParam) code: string,
    @Body(new ZodValidationPipe(AutomationRulePatchBodySchema)) body: AutomationRulePatchBody,
    @CurrentActorId() actorId: string,
  ): Promise<AutomationRuleView> {
    return this.automation.patchRule(actorId, code, body);
  }

  @Post("rules/:code/test")
  @HttpCode(200)
  @RequirePermission("automation.manage")
  testRule(
    @Param("code", ruleCodeParam) code: string,
    @Body(new ZodValidationPipe(AutomationRuleTestBodySchema)) body: AutomationRuleTestBody,
    @CurrentActorId() actorId: string,
  ): Promise<AutomationRuleTestResponse> {
    return this.automation.testRule(actorId, code, body);
  }

  @Get("runs")
  @RequirePermission("automation.view")
  listRuns(
    @Query(new ZodValidationPipe(AutomationRunListQuerySchema)) query: AutomationRunListQuery,
    @CurrentActorId() actorId: string,
  ): Promise<AutomationRunListResponse> {
    return this.automation.listRuns(actorId, query);
  }

  @Get("runs/:id")
  @RequirePermission("automation.view")
  getRun(
    @Param("id", runIdParam) id: number,
    @CurrentActorId() actorId: string,
  ): Promise<AutomationRun> {
    return this.automation.getRun(actorId, id);
  }
}
