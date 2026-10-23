import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import { buildPreviewArtifactKey, ObjectStorage, versionFileName } from "../../storage/index.js";
import { FileRepository } from "./file.repository.js";
import { normalizeMime, SVG_MIME } from "./file-mime.js";
import { ConverterError, PreviewConverter, type ConverterHealth } from "./preview.converter.js";
import {
  inspectPreviewPng,
  sha256Hex,
  SVG_PREVIEW_MAX_SOURCE_BYTES,
  type PreviewPngInfo,
} from "./preview.integrity.js";
import { parsePreviewJob } from "./preview.job.js";
import { PreviewRepository, type PreviewArtifactKey } from "./preview.repository.js";
import { isSvgFile } from "./preview.targets.js";

/**
 * 预览转换队列（M4-05c）：消费 outbox `preview.job` → 调转换沙箱 → 产物回对象存储 → 更新 preview_artifacts。
 *
 * 切片边界（Push 160 定案）：本服务只做**消费与分类**；领取、重试退避与 dead 落库 / 告警统一在 S7-1 的
 * OutboxDispatcher（`consume` 返回 done / retry / dead，`onDead` 负责终态降级留痕），**不含规则 / 通知编排**。
 * 缓存、任务与对象键均按版本隔离；仅同一版本的同一管线 / 通道可复用。
 *
 * 失败处置（deploy/svg-preview/README.md 错误面）：可重试（503 / 504 / 连接错误 / 存储抖动）返回 retry，由 dispatcher 按
 * `PREVIEW_CONVERT_BACKOFF_MS` 指数退避、到 `PREVIEW_CONVERT_MAX_ATTEMPTS` 次写 failed + outbox dead；
 * 确定性失败（400 / 413 / 415 / 422 / 501 / 管线版本不一致 / 超大文件）返回 dead + deadAlert=digest，
 * 一次即降级（D2-05「请下载查看」），不推企微即时告警，只写结构化日志并进入日报。
 */

/** structured 一期不启用（ADR-007：xlsx 走 pdf）；投了也不调转换器，直接按确定性失败降级。 */
const STRUCTURED_NOT_SUPPORTED = "structured 通道一期未启用（ADR-007：xlsx 走 pdf 通道），已降级「请下载查看」";

@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    private readonly repository: FileRepository,
    private readonly previews: PreviewRepository,
    private readonly storage: ObjectStorage,
    private readonly converter: PreviewConverter,
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {}

  /** 本实例期望的转换管线版本（进版本缓存键；与镜像标签同值，deploy/svg-preview/README.md）。 */
  get pipelineVersion(): string {
    return this.config.env.PREVIEW_PIPELINE_VERSION;
  }

  /** worker 启动自检：转换器可达性 + 管线版本比对（只告警不阻断启动，见 entry/worker.ts）。 */
  checkConverter(): Promise<ConverterHealth> {
    return this.converter.healthz();
  }

  /**
   * 单条消费（OutboxDispatcher 调用）：任何异常都收敛成 retry / dead 分类，不外抛
   * （dispatcher 有兜底，但这里分类更准：确定性失败一次即降级，可重试失败走退避）。
   */
  async consume(row: OutboxClaimedRow): Promise<OutboxHandleOutcome> {
    const job = parsePreviewJob(row.payload);
    if (job === null) {
      this.logger.warn("预览任务载荷非法，转 dead：outbox#" + row.id + "（" + row.dedupeKey + "）");
      return {
        outcome: "dead",
        error: "预览任务载荷非法（缺 projectId / fileId / versionId / target）：" + row.dedupeKey,
        deadAlert: "digest",
      };
    }

    const file = await this.repository.findFileById(job.fileId);
    const version = file === null ? null : await this.repository.findVersionById(job.fileId, job.versionId);
    if (file === null || version === null) {
      // 源版本已不存在（彻底删除 / 回收站到期清理 / 历史数据）：任务已无意义 —— 重试与 dead 都只会留噪音。
      this.logger.warn("预览任务跳过（源文件或版本已不存在）：file=" + job.fileId + " version=" + job.versionId);
      return { outcome: "done" };
    }

    // 缓存键以**库内版本行的 contentHash** 为准（payload 里那份只作排障参照，不参与构造）。
    const key: PreviewArtifactKey = {
      versionId: version.id,
      contentHash: version.contentHash,
      pipelineVersion: this.pipelineVersion,
      target: job.target,
    };
    const channelName = versionFileName(file.name, version.objectKey);
    const isSvgImageJob = job.target === "image" && isSvgFile({ fileName: channelName, mime: version.mime });

    try {
      const existing = await this.previews.findByKey(key);
      if (existing !== null && existing.status !== "not_ready") {
        // ready = 同版本缓存已转成，直接复用；failed = 缓存态失败，等 pipeline_version 递增才失效（不做原地重试）。
        this.logger.log("预览任务命中既有产物（" + existing.status + "），复用不重转：" + row.dedupeKey);
        return { outcome: "done" };
      }

      const artifact = existing ?? (await this.previews.ensureRequested({ fileId: job.fileId, ...key }));
      if (artifact.status !== "not_ready") {
        // 并发窗口：另一实例（或上一轮）刚把这一行转成了。
        return { outcome: "done" };
      }

      if (job.target === "structured") {
        throw new ConverterError("deterministic", "UNSUPPORTED_TARGET", null, STRUCTURED_NOT_SUPPORTED);
      }
      if (job.target === "image" && !isSvgImageJob) {
        throw new ConverterError(
          "deterministic",
          "UNSUPPORTED_SOURCE",
          null,
          "image 通道当前只接受 MIME / 扩展名一致的 SVG 源文件，已降级「请下载查看」",
        );
      }

      const configuredLimitBytes = this.config.env.PREVIEW_CONVERT_MAX_SOURCE_MB * 1024 * 1024;
      const sourceLimitBytes = isSvgImageJob
        ? Math.min(configuredLimitBytes, SVG_PREVIEW_MAX_SOURCE_BYTES)
        : configuredLimitBytes;
      if (version.sizeBytes > sourceLimitBytes) {
        throw new ConverterError(
          "deterministic",
          "SOURCE_TOO_LARGE",
          null,
          "源文件 " + megabytes(version.sizeBytes) + " 超过预览转换上限 " + megabytes(sourceLimitBytes) + "，已降级「请下载查看」",
        );
      }

      const source = await this.storage.getObject(version.objectKey);
      if (source === null) {
        // 存储侧短时不可见 / 对象缺失：按可重试处理，交给退避与到顶兜底（不立刻判死）。
        throw new ConverterError("retryable", "SOURCE_OBJECT_MISSING", null, "源对象不存在（objectKey=" + version.objectKey + "）");
      }
      if (source.bytes.byteLength > sourceLimitBytes) {
        throw new ConverterError(
          "deterministic",
          "SOURCE_TOO_LARGE",
          null,
          "源对象实际大小超过预览转换上限 " + megabytes(sourceLimitBytes) + "，已降级「请下载查看」",
        );
      }
      if (isSvgImageJob && sha256Hex(source.bytes) !== version.contentHash.toLowerCase()) {
        throw new ConverterError(
          "deterministic",
          "SOURCE_HASH_MISMATCH",
          null,
          "SVG 源对象 SHA-256 与版本记录不一致，已降级「请下载查看」",
        );
      }

      const requestId = randomUUID();
      const converted = await this.converter.convert({
        bytes: source.bytes,
        target: job.target,
        fileName: channelName,
        sourceMime: isSvgImageJob ? SVG_MIME : version.mime,
        requestId,
      });
      let png: PreviewPngInfo | null = null;
      if (isSvgImageJob) {
        if (normalizeMime(converted.contentType) !== "image/png") {
          throw new ConverterError(
            "deterministic",
            "PNG_CONTENT_TYPE_MISMATCH",
            null,
            "SVG 栅格化服务返回的 Content-Type 不是 image/png，已降级「请下载查看」",
          );
        }
        if ((converted.mode ?? "").trim().toLowerCase() !== "rasterize") {
          throw new ConverterError(
            "deterministic",
            "CONVERT_MODE_MISMATCH",
            null,
            "SVG 栅格化服务未声明 rasterize 模式，已降级「请下载查看」",
          );
        }
        const pngCheck = inspectPreviewPng(converted.bytes);
        if (!pngCheck.ok) {
          throw new ConverterError("deterministic", "PNG_INVALID", null, pngCheck.reason);
        }
        png = pngCheck.info;
      }

      const objectKey = buildPreviewArtifactKey(key);
      const generatedAt = this.clock.now();
      await this.storage.putObject({
        objectKey,
        body: converted.bytes,
        contentType: png === null ? converted.contentType : "image/png",
        metadata: {
          "preview-pipeline-version": key.pipelineVersion,
          "preview-target": key.target,
          "preview-content-hash": key.contentHash,
          "preview-source-version": version.id,
          "preview-mode": converted.mode ?? "unknown",
          "preview-request-id": requestId,
          ...(png === null ? {} : { "preview-png-width": String(png.width), "preview-png-height": String(png.height) }),
        },
      });
      await this.previews.markReady(key, { objectKey, generatedAt });
      this.logger.log(
        "预览产物就绪：" + channelName + "（target=" + key.target + " / " + converted.bytes.byteLength + " 字节 / " +
          (converted.durationMs === null ? "耗时未标注" : converted.durationMs + " ms") + " / 键 " + objectKey + "）",
      );
      return { outcome: "done" };
    } catch (error) {
      return this.classifyFailure(file.name, error);
    }
  }

  /**
   * 终态 dead 留痕（dispatcher 在写 dead 前调用）：把产物行置 failed（D2-05 降级「请下载查看」）。
   * 到顶与确定性失败都走这里（由 dispatcher 统一判定）；本钩子失败只记日志，不阻塞 dead 落库。
   */
  async onDead(row: OutboxClaimedRow, error: string): Promise<void> {
    const job = parsePreviewJob(row.payload);
    if (job === null) {
      return;
    }
    const version = await this.repository.findVersionById(job.fileId, job.versionId).catch(() => null);
    if (version === null) {
      return;
    }
    try {
      await this.previews.markFailed(
        { versionId: version.id, contentHash: version.contentHash, pipelineVersion: this.pipelineVersion, target: job.target },
        { error, updatedAt: this.clock.now() },
      );
    } catch (markError) {
      this.logger.error("预览失败态写入失败（outbox 已转 dead）：file=" + job.fileId + " —— " + messageOf(markError));
    }
  }

  /** 失败分类：可重试 → retry（dispatcher 按策略退避 / 到顶）；确定性 → dead（一次即降级，告警仅进日报）。 */
  private classifyFailure(fileName: string, error: unknown): OutboxHandleOutcome {
    const message = messageOf(error);
    const retryable = !(error instanceof ConverterError) || error.kind === "retryable";
    if (retryable) {
      this.logger.warn("预览转换失败（待重试）：" + fileName + " —— " + message);
      return { outcome: "retry", error: message };
    }
    this.logger.error("预览转换放弃（确定性失败，仅记录并进入日报）：" + fileName + " —— " + message);
    return { outcome: "dead", error: message, deadAlert: "digest" };
  }
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 500 ? raw.slice(0, 500) : raw;
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
