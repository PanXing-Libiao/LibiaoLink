import { Injectable, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { CadJobSchema, CadJobCreateResponseSchema, z, type CadNameCodepage } from "@libiaolink/contracts";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { AppConfig } from "../../config/config.module.js";
import type { Env } from "../../config/env.js";
import { AppError } from "../../common/errors/app-error.js";
import { CAD_ENGINE_VERSION } from "./cad-release.js";
export { CAD_ENGINE_VERSION } from "./cad-release.js";

const JSON_LIMIT = 64 * 1024;
const RESOURCE_LIMIT = 256 * 1024 * 1024;
type Identity = { name: string; sourceSHA256: string; sourceByteLength: number; namespace: string; cacheScope: string; nameCodepage: CadNameCodepage };
export type CadJob = z.infer<typeof CadJobSchema>;
export type CadResource = { stream: Readable; bytes: number; artifactBytes?: number };

/** Private protocol detail: the sandbox explicitly rejected a queue/storage/lease quota. */
export class CadEngineBusyError extends ServiceUnavailableException {
  constructor() { super("CAD 转换服务繁忙，请稍后重试或下载原文件"); }
}

export function cadEngineConfigured(env: Pick<Env, "CAD_ENGINE_SOCKET" | "CAD_ENGINE_URL">): boolean {
  return Boolean(env.CAD_ENGINE_SOCKET || env.CAD_ENGINE_URL);
}

/** Byte-only transport to the sandbox. The API never starts Python or reads CAD paths. */
@Injectable()
export class CadEngineClient implements OnModuleDestroy {
  private readonly requests = new Set<ClientRequest>();
  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean { return cadEngineConfigured(this.config.env); }
  get inputLimit(): number { return (this.config.env.CAD_MAX_INPUT_MIB ?? 64) * 1024 * 1024; }

  private open(action: string, input: Record<string, unknown>, source?: Uint8Array): Promise<IncomingMessage> {
    if (!this.enabled) throw new ServiceUnavailableException("CAD 转换服务未启用，请下载原文件查看");
    if (this.requests.size >= 64) throw new ServiceUnavailableException("CAD 请求过多，请稍后重试");
    const socketPath = this.config.env.CAD_ENGINE_SOCKET;
    let target: URL | undefined;
    if (socketPath) {
      if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new ServiceUnavailableException("CAD 服务配置不可用");
    } else {
      try { target = new URL(this.config.env.CAD_ENGINE_URL); } catch { throw new ServiceUnavailableException("CAD 服务配置不可用"); }
      if (this.config.env.NODE_ENV === "production" || target.protocol !== "http:" || target.hostname !== "127.0.0.1"
        || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
        throw new ServiceUnavailableException("CAD 服务配置不可用");
      }
    }
    const metadata = Buffer.from(JSON.stringify({ action, ...input }));
    if (metadata.byteLength > 6 * 1024 || (source !== undefined && (source.byteLength === 0 || source.byteLength > this.inputLimit))) {
      throw new ServiceUnavailableException("CAD 请求超过处理限制");
    }
    const body = source ?? metadata;
    return new Promise((resolve, reject) => {
      const call = request({
        ...(socketPath ? { socketPath } : { hostname: target!.hostname, port: target!.port }),
        path: source === undefined ? "/rpc" : "/submit", method: "POST", agent: false,
        headers: { "Content-Type": source === undefined ? "application/json" : "application/octet-stream",
          "Content-Length": body.byteLength, ...(source === undefined ? {} : { "X-CAD-Request": metadata.toString("base64url") }) },
      });
      this.requests.add(call);
      const timer = setTimeout(() => call.destroy(new Error("CAD deadline exceeded")), 90_000);
      call.once("close", () => { clearTimeout(timer); this.requests.delete(call); });
      call.once("error", () => reject(new ServiceUnavailableException("CAD 转换服务暂不可用，请重试或下载原文件")));
      call.once("response", (response) => {
        if (response.headers["x-cad-engine-version"] !== CAD_ENGINE_VERSION || response.statusCode !== 200) {
          if (response.headers["x-cad-engine-version"] === CAD_ENGINE_VERSION && response.statusCode === 503) {
            void this.readJson(response).then((packet) => {
              reject(z.object({ code: z.literal("busy") }).safeParse(packet).success ? new CadEngineBusyError()
                : new ServiceUnavailableException("CAD 转换服务暂不可用，请重试或下载原文件"));
            }, (error: unknown) => reject(error));
            return;
          }
          response.destroy();
          reject(response.statusCode === 404 ? new AppError("NOT_FOUND", "模型资源不存在或不可访问")
            : new ServiceUnavailableException("CAD 转换服务暂不可用，请重试或下载原文件"));
        } else resolve(response);
      });
      call.end(body);
    });
  }

  private async json(action: string, input: Record<string, unknown>, source?: Uint8Array): Promise<unknown> {
    return this.readJson(await this.open(action, input, source));
  }

  private async readJson(response: IncomingMessage): Promise<unknown> {
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of response) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > JSON_LIMIT) throw new Error("CAD response too large");
        chunks.push(data);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      response.destroy();
      throw new ServiceUnavailableException("CAD 服务响应不可用，请重试或下载原文件");
    }
  }

  async lookup(input: Identity): Promise<z.infer<typeof CadJobCreateResponseSchema> | null> {
    return CadJobCreateResponseSchema.nullable().parse(await this.json("lookup", input));
  }
  async submit(input: Identity & { bytes: Uint8Array }): Promise<z.infer<typeof CadJobCreateResponseSchema>> {
    const { bytes, ...identity } = input;
    return CadJobCreateResponseSchema.parse(await this.json("submit", identity, bytes));
  }
  async status(input: { jobId: string; namespace: string }): Promise<CadJob> { return CadJobSchema.parse(await this.json("status", input)); }
  async cancel(input: { jobId: string; namespace: string }): Promise<CadJob> { return CadJobSchema.parse(await this.json("cancel", input)); }
  async file(action: "manifest" | "buffer", input: { jobId: string; namespace: string; lease?: string; sha256?: string }): Promise<CadResource> {
    const stream = await this.open(action, input);
    const length = stream.headers["content-length"], artifact = stream.headers["x-cad-artifact-bytes"];
    if (typeof length !== "string" || !/^\d+$/.test(length) || Number(length) > RESOURCE_LIMIT
      || (artifact !== undefined && (typeof artifact !== "string" || !/^\d+$/.test(artifact) || Number(artifact) > 512 * 1024 * 1024))) {
      stream.destroy(); throw new ServiceUnavailableException("模型资源超过处理限制");
    }
    return { stream, bytes: Number(length), ...(artifact === undefined ? {} : { artifactBytes: Number(artifact) }) };
  }
  async release(input: { jobId: string; namespace: string; lease: string; retire?: boolean }): Promise<void> { await this.json("release", input); }
  async onModuleDestroy(): Promise<void> { for (const call of this.requests) call.destroy(); }
}
