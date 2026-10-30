
import { Body, Controller, Headers, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { IncomingMessage } from "node:http";
import { IMPORT_MAX_FILE_BYTES, ProjectImportCommitBodySchema, z } from "@libiaolink/contracts";
import type { ProjectImportPreview, ProjectImportResult } from "@libiaolink/contracts";
import { readMultipartFile } from "../../common/http/multipart.js";
import { AppError } from "../../common/errors/app-error.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { CsrfGuard, CurrentActorId, SessionGuard } from "../identity/index.js";
import { ProjectAccessGuard, RequirePermission } from "../permission/index.js";
import { ProjectImportService } from "./project-import.service.js";
import type { ImportLocale } from "./project-import.service.js";

type ProjectImportCommitBody = z.infer<typeof ProjectImportCommitBodySchema>;

/**
 * 导入表导入接口（直连 API 导入 · 业务口径 2026-10-14）：项目空间「导入项目」按钮 → 大屏面板四步（选择 / 解析 / 确认 / 完成）
 * 走这两条接口；契约 shared/src/modules/imports.ts（前端 frontend/src/importApi.ts 已接线）。
 * - preview：multipart/form-data（字段 file；.xlsx / .xlsm，≤ 256 MB）—— **不用 Nest FileInterceptor / multer**
 *   （服务端无该依赖）：由 common/http/multipart.ts 直接收流到受控临时文件，ZIP 按偏移读盘解析，超限 / 非 multipart 400；
 * - commit：JSON（previewId + 落位确认）—— 单事务建项目并写入全量数据（预检失败 409 / 410 / 422 见契约错误码）。
 * 门禁：登录 + CSRF + project.create（与「新建项目」同权限位）；预览票据只认创建人本人（他人提交 403）。
 * 语言：按 Accept-Language 出提醒文案（zh 缺省 / en）—— 前端 apiFetch 已带该头。
 */
@Controller("api/v1/project-imports")
@UseGuards(SessionGuard, CsrfGuard, ProjectAccessGuard)
export class ProjectImportController {
  /** 200 MB 级导入只允许单实例并发，限制解析 / 图片处理的单实例峰值与临时盘占用。 */
  private importInFlight = false;

  constructor(private readonly imports: ProjectImportService) {}

  /** 解析预览（不写业务库）：返回票据（30 分钟）+ 落位建议 + 须手动导入清单 + 节点 / 账号清单 + 提醒。 */
  @Post("preview")
  @HttpCode(200)
  @RequirePermission("project.create")
  async preview(
    @Req() request: IncomingMessage,
    @Headers("content-type") contentType: string | undefined,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectImportPreview> {
    if (this.importInFlight) {
      throw new AppError("RATE_LIMITED", "导入任务正在处理中，请稍后重试");
    }
    this.importInFlight = true;
    try {
      const upload = await readMultipartFile(request, contentType ?? null, "file", IMPORT_MAX_FILE_BYTES);
      if (upload === null) {
        throw new AppError("IMPORT_FILE_INVALID", "缺少上传文件（multipart 字段 file）");
      }
      try {
        return await this.imports.preview({
          sourceFile: { path: upload.path, offset: upload.offset, sizeBytes: upload.sizeBytes },
          fileName: upload.fileName,
          actorId,
          locale: localeOf(acceptLanguage),
        });
      } finally {
        await upload.cleanup();
      }
    } finally {
      this.importInFlight = false;
    }
  }

  /** 确认导入（单事务）：建项目 + 蓝图快照 + 成员名册 + 任务 / 日报 / 问题 / 变更 / 图片；返回完成页数据。 */
  @Post("commit")
  @HttpCode(200)
  @RequirePermission("project.create")
  async commit(
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(ProjectImportCommitBodySchema)) body: ProjectImportCommitBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentActorId() actorId: string,
  ): Promise<ProjectImportResult> {
    if (this.importInFlight) {
      throw new AppError("RATE_LIMITED", "导入任务正在处理中，请稍后重试");
    }
    this.importInFlight = true;
    try {
      return await this.imports.commit(body, actorId, localeOf(acceptLanguage), clientGoneSignal(response));
    } finally {
      this.importInFlight = false;
    }
  }
}

/**
 * 写入取消信号（Push 321）：响应连接在写完之前断开（点「取消写入」/ 刷新 / 关页 / 断网）= 取消本次导入。
 * 服务端据此中止提交并单事务回滚；响应已正常写回时不触发。
 */
function clientGoneSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

/** Accept-Language → 提醒文案语言（zh 缺省；en / en-US 等一律 en）。 */
function localeOf(header: string | undefined): ImportLocale {
  if (header === undefined) return "zh";
  return header.toLowerCase().trim().startsWith("en") ? "en" : "zh";
}
