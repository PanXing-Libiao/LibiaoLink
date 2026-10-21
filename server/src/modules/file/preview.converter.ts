import { Injectable } from "@nestjs/common";
import { AppConfig } from "../../config/config.module.js";
import type { PreviewTarget } from "./preview.job.js";

/**
 * SVG 预览栅格化客户端（H1 · S4；接口契约见 deploy/svg-preview/README.md「2」）。
 *
 * 字节流进 / 字节流出：本客户端把源文件字节 POST 给沙箱、把产物字节读回来，
 * **不传对象键、不带 S3 凭证**（转换器不接触对象存储 —— 键由 worker 侧 `buildPreviewArtifactKey` 算）。
 * 只用 fetch（全局，零新依赖），超时用 `AbortSignal.timeout`（客户端比容器内 10 秒硬超时留余量）。
 */

/** 失败原因上限：与 `preview_artifacts.error` 的 CHECK（≤ 500）同值 —— D2-05 降级副行直接用这条消息。 */
const MESSAGE_MAX_LENGTH = 500;

/** 自检超时：/healthz 只读栅格化器自身与固定字体状态，不走转换，用不着等转换超时那么久。 */
const HEALTH_TIMEOUT_MS = 5_000;

/** 失败分类：可重试的（503 / 504 / 连接错误）退避重试；确定性的（400 / 413 / 415 / 422 / 501）重试不会好。 */
export type ConverterFailureKind = "retryable" | "deterministic";

export class ConverterError extends Error {
  constructor(
    readonly kind: ConverterFailureKind,
    readonly code: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message.length > MESSAGE_MAX_LENGTH ? message.slice(0, MESSAGE_MAX_LENGTH) : message);
    this.name = "ConverterError";
  }
}

export interface ConvertInput {
  bytes: Uint8Array;
  target: PreviewTarget;
  /** 原始文件名（进 `x-file-name`，URL 编码）：转换器据此判扩展名与产物命名。 */
  fileName: string;
  sourceMime: string | null;
  /** 两端对账用：转换器每个请求打一行 JSON 日志（含 requestId），排障时按它对齐 worker 侧记录。 */
  requestId: string;
}

export interface ConvertResult {
  bytes: Uint8Array;
  contentType: string | null;
  /** `passthrough` / `convert` / `rasterize` / `convert+rasterize`（转换器实际走的路径，只作留痕）。 */
  mode: string | null;
  durationMs: number | null;
  artifactName: string | null;
  pipelineVersion: string;
}

export interface ConverterHealth {
  /** HTTP 200 且 `ok:true`（固定字体与 resvg 自检可用）。 */
  ok: boolean;
  pipelineVersion: string | null;
  /** 转换器自报的管线版本与 `PREVIEW_PIPELINE_VERSION` 是否同一串（不同 = 缓存键会写错，必须拦下）。 */
  versionMatches: boolean;
  detail: string;
}

@Injectable()
export class PreviewConverter {
  constructor(private readonly config: AppConfig) {}

  get pipelineVersion(): string {
    return this.config.env.PREVIEW_PIPELINE_VERSION;
  }

  /** POST /convert：成功返回产物字节与响应头；失败一律抛 `ConverterError`（已分类）。 */
  async convert(input: ConvertInput): Promise<ConvertResult> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(input.bytes.byteLength),
      "x-preview-target": input.target,
      "x-file-name": encodeURIComponent(input.fileName),
      "x-request-id": input.requestId,
    };
    if (input.sourceMime !== null && input.sourceMime !== "") {
      headers["x-source-mime"] = input.sourceMime;
    }

    let response: Response;
    try {
      response = await fetch(this.url("/convert"), {
        method: "POST",
        headers,
        body: input.bytes,
        signal: AbortSignal.timeout(this.config.env.PREVIEW_CONVERT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ConverterError(
        "retryable",
        isTimeout(error) ? "CONVERT_TIMEOUT_LOCAL" : "CONVERT_UNREACHABLE",
        null,
        isTimeout(error)
          ? "预览转换器调用超时（客户端 " + this.config.env.PREVIEW_CONVERT_TIMEOUT_MS + " ms 未返回），已按可重试处理"
          : "预览转换器不可达：" + describe(error),
      );
    }

    if (!response.ok) {
      throw await this.failureOf(response);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const pipelineVersion = response.headers.get("x-pipeline-version") ?? "";
    if (pipelineVersion !== this.pipelineVersion) {
      // 版本不一致 = 产物是按另一条管线出的，写进本版本号的键就是「幽灵缓存」（deploy/svg-preview/README.md）。
      throw new ConverterError(
        "deterministic",
        "PIPELINE_VERSION_MISMATCH",
        response.status,
        "转换器管线版本（" + (pipelineVersion === "" ? "未标注" : pipelineVersion) + "）与本服务配置（" +
          this.pipelineVersion + "）不一致，已降级；请对账镜像标签与 PREVIEW_PIPELINE_VERSION",
      );
    }

    return {
      bytes,
      contentType: response.headers.get("content-type"),
      mode: response.headers.get("x-convert-mode"),
      durationMs: toNumber(response.headers.get("x-convert-duration-ms")),
      artifactName: decodeHeader(response.headers.get("x-artifact-name")),
      pipelineVersion,
    };
  }

  /** GET /healthz：容器健康检查与 worker 启动自检共用；本方法不抛错（不可达也返回结论）。 */
  async healthz(): Promise<ConverterHealth> {
    let response: Response;
    try {
      response = await fetch(this.url("/healthz"), {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        pipelineVersion: null,
        versionMatches: false,
        detail: "预览转换器不可达（" + this.config.env.PREVIEW_CONVERTER_URL + "）：" + describe(error),
      };
    }

    const body = await readJson(response);
    const pipelineVersion = typeof body?.pipelineVersion === "string" ? body.pipelineVersion : null;
    const ok = response.ok && body?.ok === true;
    const versionMatches = pipelineVersion === this.pipelineVersion;
    const reason = ok
      ? "预览转换器可用"
      : response.status === 503
        ? "预览转换器自检未通过（固定字体或 resvg 不可用）"
        : "预览转换器 /healthz 返回 HTTP " + response.status;
    return {
      ok,
      pipelineVersion,
      versionMatches,
      detail:
        reason +
        "；管线版本 " +
        (pipelineVersion === null ? "未标注" : pipelineVersion) +
        (versionMatches ? "（与配置一致）" : "（与配置 " + this.pipelineVersion + " 不一致）"),
    };
  }

  private async failureOf(response: Response): Promise<ConverterError> {
    const body = await readJson(response);
    const code = typeof body?.error === "string" && body.error !== "" ? body.error : "HTTP_" + String(response.status);
    const message =
      typeof body?.message === "string" && body.message !== ""
        ? body.message
        : "预览转换器返回 HTTP " + String(response.status);
    return new ConverterError(classify(response.status), code, response.status, message);
  }

  private url(path: string): string {
    return this.config.env.PREVIEW_CONVERTER_URL.replace(/\/+$/, "") + path;
  }
}

/** 503（SERVICE_BUSY / SERVICE_UNAVAILABLE）/ 504（CONVERT_TIMEOUT）/ 429 可重试；其余一律确定性失败。 */
function classify(status: number): ConverterFailureKind {
  return status === 429 || status === 503 || status === 504 ? "retryable" : "deterministic";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `x-artifact-name` 是 URL 编码的（可能含中文）；解不出来就原样留痕，不因为一个排障字段让整单失败。 */
function decodeHeader(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
