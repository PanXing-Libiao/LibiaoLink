import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ProjectSummarySchema,
  TaskBatchBodySchema,
  TaskBatchResponseSchema,
  TaskCanCompleteResponseSchema,
  TaskCompleteBodySchema,
  TaskCompleteResponseSchema,
  TaskCreateBodySchema,
  TaskCreateFromTemplateBodySchema,
  TaskCreateFromTemplateResponseSchema,
  TaskDeleteResponseSchema,
  TaskDetailSchema,
  TaskFinalizeBodySchema,
  TaskUnfinalizeBodySchema,
  TaskListItemSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskLockedFieldsAdjustBodySchema,
  TaskProgressUpdateBodySchema,
  TaskSchema,
  TaskUpdateBodySchema,
  UuidSchema,
  z,
} from "@libiaolink/contracts";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { TranslateService } from "../translate/index.js";
import { TaskService } from "./task.service.js";

type TaskListQuery = z.infer<typeof TaskListQuerySchema>;
type TaskCreateBody = z.infer<typeof TaskCreateBodySchema>;
type TaskCreateFromTemplateBody = z.infer<typeof TaskCreateFromTemplateBodySchema>;
type TaskUpdateBody = z.infer<typeof TaskUpdateBodySchema>;
type TaskProgressUpdateBody = z.infer<typeof TaskProgressUpdateBodySchema>;
type TaskCompleteBody = z.infer<typeof TaskCompleteBodySchema>;
type TaskFinalizeBody = z.infer<typeof TaskFinalizeBodySchema>;
type TaskUnfinalizeBody = z.infer<typeof TaskUnfinalizeBodySchema>;
type TaskBatchBody = z.infer<typeof TaskBatchBodySchema>;
type TaskLockedFieldsAdjustBody = z.infer<typeof TaskLockedFieldsAdjustBodySchema>;

const uuidParam = new ZodValidationPipe(UuidSchema);

/**
 * 任务接口（h4 · S6·task）：契约 shared/src/modules/tasks.ts。
 * summary 挂 /projects/{id}/summary（项目总览四格，数据来源为任务派生；M3 契约已入、随本卡落地）。
 * 读要求登录 + 记录级可见（非成员 404，h6）；写接口按矩阵键判定（成员平权项在 PROJECT_MEMBER_IMPLIED_KEYS）；
 * 「手工创建仅管理员」仍是 TaskService 内的业务口径。
 */
@Controller("api/v1/projects")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly translate: TranslateService,
  ) {}

  /**
   * 保存即后台翻译（§6.16 ㉕ · 2026-10-13 业务口径「当用户写项目进展描述时直接后台翻译」）：
   * 把任务的手打文本（中文标题 / 进展描述备注）丢给译文库预热 —— 不同步、不阻塞保存响应、失败静默重试。
   * 已有英文名（titleEn 非空）或纯英文 / 数字文本在服务侧按 CJK 过滤跳过（translate.warmup）。
   */
  private warmupTaskText(items: ReadonlyArray<{ title: string; titleEn: string | null; note: string | null }>): void {
    const texts: string[] = [];
    for (const item of items) {
      if (item.titleEn === null || item.titleEn === "") {
        texts.push(item.title);
      }
      if (item.note !== null && item.note !== "") {
        texts.push(item.note);
      }
    }
    this.translate.warmup(texts);
  }

  /** 项目总览四格：最慢阶段 / 最新阶段 / 逾期 / 已完成 / 总数（汇总卡；2026-09-24 起原 currentStage 下线）。 */
  @Get(":id/summary")
  summary(@Param("id", uuidParam) id: string): Promise<z.infer<typeof ProjectSummarySchema>> {
    return this.tasks.summary(id);
  }

  /** 任务列表：分页 + 阶段 / 负责人 / 展示态筛选 + 关键字 + 白名单排序（TaskListItem 随行摘要）。 */
  @Get(":id/tasks")
  list(
    @Param("id", uuidParam) id: string,
    @Query(new ZodValidationPipe(TaskListQuerySchema)) query: TaskListQuery,
  ): Promise<z.infer<typeof TaskListResponseSchema>> {
    return this.tasks.list(id, query);
  }

  /** 任务详情：抽屉全字段 + 文件清单。 */
  @Get(":id/tasks/:taskId")
  detail(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
  ): Promise<z.infer<typeof TaskDetailSchema>> {
    return this.tasks.detail(id, taskId);
  }

  /** 创建任务：从任务节点生成（判重 409 TASK_ALREADY_EXISTS）或手工创建（仅管理员）。 */
  @Post(":id/tasks")
  @RequirePermission("task.create")
  async create(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(TaskCreateBodySchema)) body: TaskCreateBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskSchema>> {
    const task = await this.tasks.create(id, body, actorId);
    this.warmupTaskText([task]);
    return task;
  }

  /**
   * 从任务模板批量生成任务（A1-16「批量生成节点任务」· 模板实例化 · 契约 Push 62 已入 paths）：
   * 阶段取模板阶段、描述取节点库现值；同一项目已存在的节点默认跳过（skipped），skipExisting=false 时 409。
   */
  @Post(":id/tasks/from-template")
  @RequirePermission("task.create")
  async createFromTemplate(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(TaskCreateFromTemplateBodySchema)) body: TaskCreateFromTemplateBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskCreateFromTemplateResponseSchema>> {
    const result = await this.tasks.createFromTemplate(id, body, actorId);
    this.warmupTaskText(result.created);
    return result;
  }

  /**
   * 批量操作（M3-04 · A1-08）：批量指派 / 改状态（含批量完成）/ 改期 / 重要度 / 人数 / 备注。
   * 声明在 :taskId 之前（避免 batch 被当作任务 id 命中）；整体 200 + failures[] 部分失败清单。
   */
  @Patch(":id/tasks/batch")
  @RequirePermission("task.update")
  async batch(
    @Param("id", uuidParam) id: string,
    @Body(new ZodValidationPipe(TaskBatchBodySchema)) body: TaskBatchBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskBatchResponseSchema>> {
    const result = await this.tasks.batch(id, body, actorId);
    this.warmupTaskText(result.succeeded);
    return result;
  }

  /** 编辑任务（乐观锁；status 基础三态同事务联动进度 / 完成日期；任务描述 / 成果文件锁定不在本接口）。 */
  @Patch(":id/tasks/:taskId")
  @RequirePermission("task.update")
  async update(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskUpdateBodySchema)) body: TaskUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskSchema>> {
    const task = await this.tasks.update(id, taskId, body, actorId);
    this.warmupTaskText([task]);
    return task;
  }

  /**
   * 删除任务（M3-05 · A25 · 系统功能书 A1-01 修订）：软删 —— 不物理删行；列表 / 看板 / 甘特图 / 详情 / 完成门禁一律不可见 + 写留痕。
   * 重复删除与已删任务上的任何写操作 = 统一 404（记录级 404 语义，不新增错误码）；归档项目 409 PROJECT_ARCHIVED。
   */
  @Delete(":id/tasks/:taskId")
  @RequirePermission("task.update")
  remove(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskDeleteResponseSchema>> {
    return this.tasks.remove(id, taskId, actorId);
  }

  /**
   * 锁定字段例外调整（M3-05 · A1-17 / C9-07 · Push 153）：任务描述 / 输出成果文件生成后锁定；
   * 确需修正时仅系统管理员可执行，原因必填并留痕（服务端 assertAdmin 复核，非管理员 403）。
   */
  @Patch(":id/tasks/:taskId/locked-fields")
  @RequirePermission("task.update")
  async adjustLockedFields(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskLockedFieldsAdjustBodySchema)) body: TaskLockedFieldsAdjustBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskSchema>> {
    const task = await this.tasks.adjustLockedFields(id, taskId, body, actorId);
    this.warmupTaskText([task]);
    return task;
  }

  /** 完成预检（M3-03）：门禁缺件与放行提示（UI 置灰依据；服务端仍在事务内强校验）。 */
  @Get(":id/tasks/:taskId/can-complete")
  canComplete(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
  ): Promise<z.infer<typeof TaskCanCompleteResponseSchema>> {
    return this.tasks.canComplete(id, taskId);
  }

  /** 完成提交（M3-03 · A4-20）：事务内门禁；缺件 422 TASK_REQUIRED_DOC_MISSING（拒绝留痕）；未定档放行 + warning 并触发 R02。 */
  @Post(":id/tasks/:taskId/complete")
  @HttpCode(200)
  @RequirePermission("task.progress")
  async complete(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskCompleteBodySchema)) body: TaskCompleteBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskCompleteResponseSchema>> {
    const result = await this.tasks.complete(id, taskId, body, actorId);
    this.warmupTaskText([result.task]);
    return result;
  }

  /**
   * 任务定档（Push 252 · 抽屉头部「定档」开关 + 二次确认）：未定档 → 置位锁定（此后写口全 409 TASK_FINALIZED）；
   * 已定档 → 幂等原样返回（不重复写、不递增版本）。
   */
  @Post(":id/tasks/:taskId/finalize")
  @HttpCode(200)
  @RequirePermission("task.update")
  finalize(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskFinalizeBodySchema)) body: TaskFinalizeBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskSchema>> {
    return this.tasks.finalize(id, taskId, body, actorId);
  }

  /**
   * 任务取消定档（Push 260 · 业务口径「把现在的定档改成 再次点击取消定档吧」）：抽屉「已」开关再次点击 → 二次确认后调用；
   * 已定档 → 清位重新开放修改（留痕「取消定档」，文件修改仍走变更）；未定档 → 幂等原样返回。
   */
  @Post(":id/tasks/:taskId/unfinalize")
  @HttpCode(200)
  @RequirePermission("task.update")
  unfinalize(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskUnfinalizeBodySchema)) body: TaskUnfinalizeBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskSchema>> {
    return this.tasks.unfinalize(id, taskId, body, actorId);
  }

  /** 更新四格进度（联动状态与完成日期；progress<1 清完成日期 —— 清除的唯一方式）。 */
  @Patch(":id/tasks/:taskId/progress")
  @RequirePermission("task.progress")
  updateProgress(
    @Param("id", uuidParam) id: string,
    @Param("taskId", uuidParam) taskId: string,
    @Body(new ZodValidationPipe(TaskProgressUpdateBodySchema)) body: TaskProgressUpdateBody,
    @CurrentActorId() actorId: string,
  ): Promise<z.infer<typeof TaskListItemSchema>> {
    return this.tasks.updateProgress(id, taskId, body, actorId);
  }
}
