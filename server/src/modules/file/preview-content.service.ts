import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { ObjectStorage, StorageError } from "../../storage/index.js";
import { FileRepository } from "./file.repository.js";
import { safePreviewContentType } from "./file-mime.js";
import { absoluteDocServerApiUrl, verifyPullToken } from "./onlyoffice.jwt.js";

/**
 * 受控预览内容端点（S3 · 安全定稿 §3.2 / §3.3 · ADR-030）：
 * `GET /api/v1/files/{id}/versions/{versionId}/preview-content` —— **交给在线查看器拉取的原文件字节流**，
 * 不是用户下载口（用户下载链独立不动：`download-url` 预签名 + `file.download` + download 审计）。
 *
 * 鉴权（服务间，非用户会话）：`Authorization: Bearer <JWT>`，三条校验（签名 / `payload.url` 逐字绑定 / exp）——
 * 任一不过 → **统一 401**（不区分原因、无重定向、无回退预签名；原因只进诊断日志，C3）。
 * 404 同形（文件 / 版本不存在、已回收、对象缺失统一文案，不泄露存在性）；存储 / 依赖故障 fail-closed：
 * 存储不可用 → 503、存储返回异常 → 502；不重定向到任何预签名地址（R1 不变量）。
 * 响应头（§3.2 / H1 · S2）：200 + 服务端裁决后的 `Content-Type` + `Content-Length` + 安全 `Content-Disposition` +
 * `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`。
 * 诊断日志（§3.3 / D2）：成功与失败逐条结构化记录（fileId / versionId / 耗时 / 401 原因分类）——
 * 「监控接告警出口（M5）前以日志计数替代」401 计数可观测。
 */
@Injectable()
export class PreviewContentService {
  private readonly logger = new Logger(PreviewContentService.name);

  constructor(
    private readonly repository: FileRepository,
    private readonly storage: ObjectStorage,
    private readonly config: AppConfig,
  ) {}

  /** 校验 → 装载 → 读对象 → 直写字节流响应。 */
  async serve(input: {
    fileId: string;
    versionId: string;
    originalUrl: string;
    authorization: string | null;
    response: Response;
  }): Promise<void> {
    const startedAt = Date.now();

    // ① 鉴权先于任何库 / 存储访问（无效凭证不触达业务面）。C1：绑定 URL = 配置基址 + 原始请求 path/query（不信任 Host 头）。
    const check = verifyPullToken({
      token: bearerOf(input.authorization),
      secret: this.config.env.ONLYOFFICE_JWT_SECRET,
      expectedUrl: absoluteDocServerApiUrl(this.config.env.ONLYOFFICE_DOCSERVER_API_BASE_URL, input.originalUrl),
      nowSeconds: Math.floor(Date.now() / 1000),
      clockToleranceSeconds: this.config.env.ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS,
    });
    if (!check.ok) {
      // 401 计数可观测（D2）：逐条 warn，reason 仅内部记录（C3：响应侧统一文案不区分原因）。
      this.logger.warn(
        "preview-content 401：reason=" + check.reason + " file=" + input.fileId + " version=" + input.versionId,
      );
      throw new AppError("AUTH_REQUIRED", "预览凭证无效或已过期");
    }

    // ② 404 同形（不存在 / 已回收 / 状态不可读 —— 不泄露存在性）。
    const file = await this.repository.findFileById(input.fileId);
    if (file === null || file.status === "recycled" || file.recycledAt !== null) {
      throw this.notFound(input, "file_missing_or_recycled");
    }
    const version = await this.repository.findVersionById(file.id, input.versionId);
    if (version === null) {
      throw this.notFound(input, "version_missing");
    }

    // ③ 服务端凭据直读对象（不签发预签名地址；对象缺失按「不可读」404 同形）。
    let object: Awaited<ReturnType<ObjectStorage["getObjectStream"]>>;
    try {
      object = await this.storage.getObjectStream(version.objectKey);
    } catch (error) {
      if (error instanceof StorageError && error.code === "unavailable") {
        this.logger.error("preview-content 503：存储不可用 file=" + file.id + " version=" + version.id);
        throw new ServiceUnavailableException("对象存储暂不可用，请稍后重试（fail closed）");
      }
      if (error instanceof StorageError) {
        this.logger.error(
          "preview-content 502：存储返回异常（" + error.code + "）file=" + file.id + " version=" + version.id,
        );
        throw new BadGatewayException("对象存储返回异常响应（fail closed）");
      }
      throw error;
    }
    if (object === null) {
      throw this.notFound(input, "object_missing");
    }

    // ④ 有界流式直写（无重定向、无回退预签名）：不再把整份原文件读入 API 堆内存。
    // 对象流由 S3 SDK 直接产出，pipeline 负责背压；客户端断开时随流销毁，避免泄漏。
    const responseType = safePreviewContentType(version.mime);
    input.response.setHeader("Content-Type", responseType.contentType);
    input.response.setHeader("Content-Length", object.sizeBytes);
    input.response.setHeader("Content-Disposition", responseType.disposition);
    input.response.setHeader("Cache-Control", "no-store");
    input.response.setHeader("X-Content-Type-Options", "nosniff");
    input.response.status(200);
    try {
      await pipeline(object.stream, input.response);
    } catch (error) {
      // 响应头已发送后无法再改成 502；主动销毁连接让查看器看到截断，而不是把不完整文件当成功。
      this.logger.warn(
        "preview-content 传输中断：file=" + file.id + " version=" + version.id + " error=" + messageOf(error),
      );
      if (!input.response.destroyed) {
        input.response.destroy(error instanceof Error ? error : undefined);
      }
      return;
    }
    this.logger.log(
      "preview-content 200：file=" +
        file.id +
        " version=" +
        version.id +
        " bytes=" +
        object.sizeBytes +
        " ms=" +
        (Date.now() - startedAt),
    );
  }

  /** 404 单点构造（同形文案 + 诊断日志）。 */
  private notFound(input: { fileId: string; versionId: string }, reason: string): AppError {
    this.logger.warn(
      "preview-content 404：reason=" + reason + " file=" + input.fileId + " version=" + input.versionId,
    );
    return new AppError("NOT_FOUND", "文件或版本不存在或不可用");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `Authorization: Bearer <JWT>` 提取（大小写不敏感；形状不符 → null）。 */
function bearerOf(authorization: string | null): string | null {
  if (authorization === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match === null ? null : match[1]!;
}
