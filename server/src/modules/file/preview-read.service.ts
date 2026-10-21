import { Injectable, Logger } from "@nestjs/common";
import { FilePreviewResponseSchema, z } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { AppConfig } from "../../config/config.module.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutboxIfAbsent } from "../../db/outbox.js";
import { contentDisposition, ObjectStorage, versionFileName } from "../../storage/index.js";
import { UserService } from "../identity/index.js";
import { PermissionService } from "../permission/index.js";
import { FileRepository, type FileRow, type FileVersionRow } from "./file.repository.js";
import { buildPreviewContentUrl, signHs256Jwt } from "./onlyoffice.jwt.js";
import { buildPreviewJobPayload, PREVIEW_JOB_TOPIC, previewJobDedupeKey, type PreviewTarget } from "./preview.job.js";
import { PreviewRepository, type PreviewArtifactKey, type PreviewArtifactRow } from "./preview.repository.js";
import { isCadPreviewPending, isRasterImageFile, previewTargetsFor, viewerChannelFor, type ViewerChannel } from "./preview.targets.js";
import { CAD_ENGINE_VERSION } from "./cad-engine.client.js";
import { canonicalMimeForExtension, OCTET_STREAM_MIME } from "./file-mime.js";

type FilePreviewResponse = z.infer<typeof FilePreviewResponseSchema>;

/** 查看器权限段（固定只读；S8-2 契约 / 首关 PoC 口径）。
 * **Push 258 错层修正**：必须嵌进 document 签发 —— ONLYOFFICE api.js 只认 document.permissions（发顶层会被忽略、
 * 按默认值渲染）；token 载荷与前端组装配置须逐字一致，否则 DocServer 拒 -20。
 * **download 保持可见（业务口径「原本的下载不要隐藏」）**：图标原样保留、不再隐藏，点击由浮层透明命中层原位接管 →
 * 我方 download-url 原文件链 + download 审计；print 维持关闭（只读口径，业务未提）。 */

const VIEWER_PERMISSIONS = {
  edit: false,
  download: true,
  print: false,
  comment: false,
  chat: false,
  fillForms: false,
  protect: true,
};

/**
 * 预览读 API（M4-05 读面 · `GET /files/{id}/preview` · 契约 shared/src/modules/files.ts）。
 *
 * 就绪通道（S6-前置 图片直签 + 查看器通道；H1 S4 起 SVG PNG 产物通道恢复投递，见下）：
 * - **安全位图直签**（H1 S2）：`isRasterImageFile` → 原对象**短时签名直出**（D2-04：对象存储禁匿名读取）——
 *   status=ready、target=image、`pipelineVersion` / `generatedAt` 空（无产物语义）；不查 / 不落产物行、
 *   不投转换任务、不经栅格化器（字节 = 原对象）。
 * - **查看器通道**（S3 · ADR-030；PDF 2026-10-08 并入）：Office / 文本族 / PDF → `viewer` 非空、`target` / `url` 空，
 *   与产物通道互斥（契约 FilePreviewResponse.viewer）；不走产物表、不投递转换任务，就绪即签发只读查看器配置。
 *
 * **产物通道三态（M4-05d · H1 S4 起 SVG 可达）**：SVG 恢复 `target=image` 的 PNG 产物投递；图片仍走原对象直签，
 * 其余类型按查看器 / 降级处理。structured 二期启用投递时复用同一段：
 * - `ready`：三元组命中产物 → 短时签名地址；
 * - `not_ready`：**同事务**登记产物行（首次）+ 幂等补投 `preview.job`（去重键 = 三元组）→ 前端轮询；
 * - `failed`：返回 `preview_artifacts.error`（≤ 500 字）供前端降级「请下载查看」（D2-05），**不原地重试**
 *   （缓存态：管线修复靠 `PREVIEW_PIPELINE_VERSION` 递增失效）。
 *
 * 读取侧的**终态降级**（不落表、不投任务）：
 * - 文件尚无版本（未完成过上传）：`failed` + 「尚无版本」；
 * - CAD（ADR-035）：启用运行环境时 STEP 返回独立查看入口，其余保留提示与原文件下载；
 * - 判不出渲染通道（如 `.zip`）：`failed` + 「暂不支持在线预览」。
 * 返回 `failed` 而不是 `not_ready`，是为了让前端**轮询有终点**（契约：前端轮询至 ready / failed）。
 *
 * 权限 = 项目可见即可（Push 160 定案，同文件详情 / 版本链：不可见 / 不存在统一 404，防 IDOR）；
 * 版本 404：`versionId` 给定但不属于该文件 / 不存在（A4-06「任意历史版本可预览」，缺省 = 当前版本）。
 * **审计（Push 283 · 2026-10-12 起）**：预览**不写审计**（业务口径「操作日志中不需要记录预览的动作」—— 缩略图等
 * 高频预览不再刷屏操作日志）；原「图片直签 / 查看器 / 产物通道各写一条 `action = preview`」口径撤销，
 * `audit_logs.action = preview` 值保留供历史行回读 / 筛选（本模块不再产生新行）。
 */
@Injectable()
export class PreviewReadService {
  private readonly logger = new Logger(PreviewReadService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FileRepository,
    private readonly previews: PreviewRepository,
    private readonly storage: ObjectStorage,
    private readonly permission: PermissionService,
    private readonly users: UserService,
    private readonly config: AppConfig,
  ) {}

  /** `GET /files/{id}/preview`：文件可见性 → 目标版本 → 通道判定（SVG 产物 / 图片直签 / 查看器 / 降级）。 */
  async getPreview(fileId: string, versionId: string | null, actorId: string): Promise<FilePreviewResponse> {
    const file = await this.loadVisibleFile(fileId, actorId);
    const version = await this.resolveVersion(file, versionId);
    if (version === null) {
      return this.degrade(file.id, null, "文件尚无任何版本（未完成过上传），请下载查看");
    }

    // Push 256（业务口径「变更后文件的名字后后缀要用变更选择的 不然都不能预览」）：通道判定的文件名取**该版本**
    // 的真实名称 —— 主名取当前文件名、扩展名取版本对象键（落库时定下的扩展名）。变更更名（.xls → .pptx）后，
    // 新版本按新扩展名判通道（否则 ONLYOFFICE 报 -85「扩展名不一致」）；历史版本仍按各自旧扩展名判通道
    //（否则历史的 xls 内容会被当成 pptx）。
    const channelName = versionFileName(file.name, version.objectKey);

    // ADR-035：旧解析器已删除。先按版本扩展名拦截，避免误报 image/Office MIME 再签出原 CAD。
    if (isCadPreviewPending({ fileName: channelName })) {
      if (this.config.env.CAD_ENGINE_PYTHON && /\.(step|stp)$/i.test(channelName)) {
        return {
          fileId: file.id, versionId: version.id, status: "ready", target: null,
          viewer: { kind: "cad", fileId: file.id, versionId: version.id, sourceSHA256: version.contentHash, engineVersion: CAD_ENGINE_VERSION },
          url: null, expiresAt: null, pipelineVersion: null, generatedAt: null, reason: null,
        };
      }
      return this.degrade(file.id, version.id, "CAD 在线预览正在升级，暂不可用，请下载原文件查看");
    }

    // H1 · S2：SVG 永远先走目标产物通道，绝不落入下面的原对象直签分支。
    const targets = previewTargetsFor({ fileName: channelName, mime: version.mime });
    if (targets.length > 0) {
      // 缓存键 = 三元组（内容哈希 + 管线版本 + 通道）；同一内容可有多个通道，逐个查已有产物。
      const pipelineVersion = this.config.env.PREVIEW_PIPELINE_VERSION;
      const keys: PreviewArtifactKey[] = targets.map((target) => ({
        contentHash: version.contentHash,
        pipelineVersion,
        target,
      }));
      const rows: (PreviewArtifactRow | null)[] = [];
      for (const key of keys) {
        rows.push(await this.previews.findByKey(key));
      }

      const readyIndex = rows.findIndex((row) => row !== null && row.status === "ready");
      if (readyIndex >= 0) {
        return this.serveReady(file, version, keys[readyIndex]!, rows[readyIndex]!);
      }

      const failed = rows.filter((row): row is PreviewArtifactRow => row !== null && row.status === "failed");
      if (failed.length === rows.length) {
        return {
          fileId: file.id,
          versionId: version.id,
          status: "failed",
          target: null,
          viewer: null,
          url: null,
          expiresAt: null,
          pipelineVersion,
          reason: failed[0]!.error ?? "预览转换失败，请下载查看",
          generatedAt: null,
        };
      }

      await this.dispatch(file, version, keys, rows);
      return {
        fileId: file.id,
        versionId: version.id,
        status: "not_ready",
        target: null,
        viewer: null,
        url: null,
        expiresAt: null,
        pipelineVersion,
        reason: null,
        generatedAt: null,
      };
    }

    // 只有扩展名与规范 MIME 完全匹配的安全位图才允许原对象直签。
    if (isRasterImageFile({ fileName: channelName, mime: version.mime })) {
      return this.serveRasterImageDirect(file, version, channelName);
    }

    // Office / 文本族 / PDF → ONLYOFFICE 查看器通道。HTML / HTM 已从查看器族移除：
    // 主动内容不得通过应用源以可执行文档类型返回。
    const viewerChannel = viewerChannelFor({ fileName: channelName, mime: version.mime });
    if (viewerChannel !== null) {
      return this.serveViewer(file, version, viewerChannel, actorId);
    }
    return this.degrade(file.id, version.id, "该文件类型暂不支持在线预览，请下载查看");
  }

  /** 文件装载（读路径）：不存在 / 不可见 → 404（同文件详情 / 版本链口径）。 */
  private async loadVisibleFile(fileId: string, actorId: string): Promise<FileRow> {
    const file = await this.repository.findFileById(fileId);
    if (file === null) {
      throw new AppError("NOT_FOUND", "文件不存在");
    }
    await this.permission.assertProjectVisible(actorId, file.projectId);
    return file;
  }

  /** 目标版本：查询参数缺省 = 当前版本；给出但不属于该文件 / 不存在 → 404；文件无版本 → null。 */
  private async resolveVersion(file: FileRow, versionId: string | null): Promise<FileVersionRow | null> {
    const wanted = versionId ?? file.currentVersionId;
    if (wanted === null) {
      return null;
    }
    const version = await this.repository.findVersionById(file.id, wanted);
    if (version === null) {
      throw new AppError("NOT_FOUND", versionId === null ? "文件当前版本不存在" : "版本不存在或不属于该文件");
    }
    return version;
  }

  /** ready：短时签名（Push 283 起不写审计 —— 操作日志不记录预览动作）。 */
  private async serveReady(
    file: FileRow,
    version: FileVersionRow,
    key: PreviewArtifactKey,
    row: PreviewArtifactRow,
  ): Promise<FilePreviewResponse> {
    if (row.objectKey === null) {
      // 库侧 CHECK（ck_preview_artifacts_ready_pair）保证 ready ⇔ object_key，这里只做不变量兜底。
      throw new AppError("INTERNAL", "预览产物登记不完整（ready 行缺 object_key），请重新生成");
    }
    // 产物类型必须由服务端按 target 强制，不能沿用对象存储中的历史 Content-Type。
    const responseType =
      key.target === "image" ? "image/png" : key.target === "pdf" ? "application/pdf" : OCTET_STREAM_MIME;
    const responseDisposition = contentDisposition(
      key.target === "image" ? "preview.png" : "preview.pdf",
      responseType === OCTET_STREAM_MIME ? "attachment" : "inline",
    );
    const signed = await this.storage.signDownloadUrl({
      objectKey: row.objectKey,
      expiresInSeconds: this.config.env.PREVIEW_URL_TTL_SECONDS,
      responseContentType: responseType,
      responseContentDisposition: responseDisposition,
    });
    return {
      fileId: file.id,
      versionId: version.id,
      status: "ready",
      target: key.target,
      viewer: null,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      pipelineVersion: key.pipelineVersion,
      reason: null,
      generatedAt: row.generatedAt === null ? null : row.generatedAt.toISOString(),
    };
  }

  /**
   * 安全位图直签 ready：原对象短时签名 —— 对齐产物通道 ready 的响应形状（契约不变）：
   * status=ready、target=image、url=短时签名；响应强制精确图片 MIME + inline，
   * 不依赖原对象在存储中的类型元数据（H1 · S2）。
   * `pipelineVersion` / `generatedAt` 空（无产物语义 —— 直签不生成产物）；**不写审计**（Push 283 起操作日志
   * 不记录预览动作 —— 原 D2-07「签发即写一条 preview」撤销）。
   */
  private async serveRasterImageDirect(
    file: FileRow,
    version: FileVersionRow,
    channelName: string,
  ): Promise<FilePreviewResponse> {
    const responseType = canonicalMimeForExtension(channelName);
    if (responseType === null) {
      return this.degrade(file.id, version.id, "该文件类型暂不支持在线预览，请下载查看");
    }
    const signed = await this.storage.signDownloadUrl({
      objectKey: version.objectKey,
      expiresInSeconds: this.config.env.PREVIEW_URL_TTL_SECONDS,
      responseContentType: responseType,
      responseContentDisposition: contentDisposition(versionFileName(file.name, version.objectKey), "inline"),
    });
    return {
      fileId: file.id,
      versionId: version.id,
      status: "ready",
      target: "image",
      viewer: null,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      pipelineVersion: null,
      reason: null,
      generatedAt: null,
    };
  }

  /**
   * 查看器通道 ready（S3 · ADR-030 / S8-2 定案）：签发只读查看器配置（含 token），**不写审计**（Push 283 起操作日志
   * `target` / `url` / `expiresAt` / `pipelineVersion` / `generatedAt` 全空（查看器不产产物、不占缓存三元组）；
   * `document.url` = 受控端点绝对 URL（C1：与校验侧同源生成、不信任 Host 头；不含任何存储凭证）；
   * `document.key` = 内容哈希（同内容同 key —— DocServer 侧会话 / 缓存复用）。
   */
  private async serveViewer(
    file: FileRow,
    version: FileVersionRow,
    channel: ViewerChannel,
    actorId: string,
  ): Promise<FilePreviewResponse> {
    const secret = this.config.env.ONLYOFFICE_JWT_SECRET;
    if (secret === "") {
      // 安全定稿 §3.6：缺密钥 fail closed —— 不签发无签名配置（查看器打不开，胜过形同虚设的 token）。
      throw new AppError("INTERNAL", "ONLYOFFICE_JWT_SECRET 未配置，无法签发查看器配置（fail closed）");
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const document = {
      title: file.name,
      url: buildPreviewContentUrl(this.config.env.ONLYOFFICE_DOCSERVER_API_BASE_URL, file.id, version.id),
      fileType: channel.fileType,
      key: version.contentHash,
      // Push 258 错层修正：权限段嵌 document（ONLYOFFICE 只认该位置；token 与响应体同源，逐字一致）。
      permissions: { ...VIEWER_PERMISSIONS },
    };
    const editorConfig = {
      mode: "view" as const,
      lang: "zh-CN",
      user: { id: actorId, name: await this.displayNameOf(actorId) },
    };
    // token 载荷 = documentType / document（含 permissions）/ editorConfig 逐字签发（S8-2 · Push 258 修订）
    // + iat / exp（TTL = ONLYOFFICE_JWT_TTL_SECONDS，契约不含该字段）。
    const token = signHs256Jwt(
      {
        documentType: channel.documentType,
        document,
        editorConfig,
        iat: issuedAt,
        exp: issuedAt + this.config.env.ONLYOFFICE_JWT_TTL_SECONDS,
      },
      secret,
    );
    return {
      fileId: file.id,
      versionId: version.id,
      status: "ready",
      target: null,
      viewer: {
        kind: "onlyoffice",
        docServerUrl: this.config.env.ONLYOFFICE_DOCSERVER_URL,
        documentType: channel.documentType,
        document,
        editorConfig,
        token,
      },
      url: null,
      expiresAt: null,
      pipelineVersion: null,
      reason: null,
      generatedAt: null,
    };
  }

  /** 查看器会话展示名：取不到（账号已删 / 未同步）退化 actorId —— 展示用，不参与鉴权。 */
  private async displayNameOf(actorId: string): Promise<string> {
    try {
      const user = await this.users.getUser(actorId);
      return user.displayName === "" ? actorId : user.displayName;
    } catch {
      return actorId;
    }
  }

  /**
   * 未就绪：同事务「登记产物行（首次）+ 幂等补投任务」。
   * - 已有 `not_ready` 行：只补投（登记不重复写）；
   * - 无行：先登记 `not_ready`（读面首次请求即登记，定档未预生成的通道靠这里补上）；
   * - `failed` 行：跳过（缓存态失败不原地重试，等管线版本递增）；
   * - `ready` 行：不会走到这里（上游已返回）。
   * 补投唤醒（Push 226 续）：补投一律连 `done` 的历史投递一并唤醒 —— 走到这里 = 产物行 `not_ready`：
   * 若同三元组的投递记录已 done，要么产物行是删除后重新登记（缓存无从复用），要么旧投递被源缺失跳过，
   * 都说明「done 的记录背后没有可复用产物」，必须重新转一次；重投后记录转 pending / processing，后续读取不再重复投。
   */
  private async dispatch(
    file: FileRow,
    version: FileVersionRow,
    keys: readonly PreviewArtifactKey[],
    rows: readonly (PreviewArtifactRow | null)[],
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        const existing = rows[index] ?? null;
        if (existing !== null && existing.status !== "not_ready") {
          continue;
        }
        if (existing === null) {
          await this.previews.ensureRequested({ fileId: file.id, versionId: version.id, ...key }, tx);
        }
        await appendOutboxIfAbsent(
          tx,
          {
            topic: PREVIEW_JOB_TOPIC,
            dedupeKey: previewJobDedupeKey(key),
            payload: buildPreviewJobPayload({
              projectId: file.projectId,
              fileId: file.id,
              versionId: version.id,
              contentHash: version.contentHash,
              target: key.target,
              trigger: "read",
            }),
          },
          // 补投一律唤醒 done（Push 226 续）：产物 not_ready + 历史投递 done = 没有可复用产物
          // （产物行被彻底删除后同内容重传 / 旧投递被源缺失跳过）—— 不唤醒会永远停在 not_ready。
          { reviveDone: true },
        );
      }
    });
    this.logger.log(
      "预览未就绪（已幂等补投）：" + file.name + " / version=" + version.id + " / pipeline=" + keys[0]!.pipelineVersion,
    );
  }

  /** 读取侧终态降级（D2-05）：判定与投递都不做，直接给前端一个可落地的「请下载」状态。 */
  private degrade(fileId: string, versionId: string | null, reason: string): FilePreviewResponse {
    return {
      fileId,
      versionId,
      status: "failed",
      target: null,
      viewer: null,
      url: null,
      expiresAt: null,
      pipelineVersion: null,
      reason,
      generatedAt: null,
    };
  }
}
