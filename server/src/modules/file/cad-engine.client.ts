import { Injectable, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { CadJobSchema, CadJobCreateResponseSchema, z, type CadNameCodepage } from "@libiaolink/contracts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AppConfig } from "../../config/config.module.js";
import { AppError } from "../../common/errors/app-error.js";
import { CAD_ENGINE_VERSION } from "./cad-release.js";
export { CAD_ENGINE_VERSION } from "./cad-release.js";

const BRIDGE = fileURLToPath(new URL("../../../cad-engine/bridge.py", import.meta.url));
const FileResultSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), artifactBytes: z.number().optional() });
export type CadJob = z.infer<typeof CadJobSchema>;

/** Private stdio adapter. No source URLs or credentials enter the CAD process. */
@Injectable()
export class CadEngineClient implements OnModuleDestroy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private actualRoot: string | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean { return Boolean(this.config.env.CAD_ENGINE_PYTHON); }
  get root(): string { return this.actualRoot ?? resolve(this.config.env.CAD_CACHE_DIR || "var/cad"); }
  get inputLimit(): number { return (this.config.env.CAD_MAX_INPUT_MIB ?? 64) * 1024 * 1024; }

  private async start(): Promise<void> {
    if (this.child !== null) return;
    if (this.starting !== null) return this.starting;
    this.starting = (async () => {
      if (!this.enabled) throw new ServiceUnavailableException("CAD 转换服务未启用，请下载原文件查看");
      try {
        const release = JSON.parse(readFileSync(resolve(dirname(BRIDGE), "source.json"), "utf8")) as { sourceCommit: string; stepRelease: string };
        if ("step-" + release.stepRelease + "/" + release.sourceCommit + "/gateway-1" !== CAD_ENGINE_VERSION) throw new Error("CAD release mismatch");
      } catch { throw new ServiceUnavailableException("CAD 运行文件未就绪，请下载原文件查看"); }
      await mkdir(resolve(this.root, "incoming"), { recursive: true, mode: 0o700 });
      this.actualRoot = await realpath(this.root);
      const child = spawn(this.config.env.CAD_ENGINE_PYTHON, ["-u", BRIDGE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          CAD_GATEWAY_ROOT: this.root,
          CAD_STEP_MAX_INPUT_MIB: String(this.config.env.CAD_MAX_INPUT_MIB ?? 64),
          CAD_STEP_MESHER_PYTHON: this.config.env.CAD_MESHER_PYTHON || "",
        },
      });
      this.child = child;
      child.stdin.on("error", () => { if (this.child === child) this.fail(); });
      // Native output is kept out of responses and credentials never enter env.
      child.stderr.on("data", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line) as { id?: string; result?: unknown; error?: { code?: string; message?: string } };
          const waiter = value.id === undefined ? undefined : this.pending.get(value.id);
          if (waiter === undefined) return;
          clearTimeout(waiter.timer); this.pending.delete(value.id!);
          if (value.error !== undefined) {
            waiter.reject(value.error.code === "not-found" ? new AppError("NOT_FOUND", "模型资源不存在或不可访问")
              : new ServiceUnavailableException(value.error.message || "CAD 转换服务暂不可用"));
          } else waiter.resolve(value.result);
        } catch { this.fail(); child.kill("SIGTERM"); }
      });
      const ended = () => { if (this.child === child) { this.fail(); this.child = null; } };
      child.once("error", ended);
      child.once("exit", ended);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  private fail(): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new ServiceUnavailableException("CAD 转换服务已停止，请重试或下载原文件")); }
    this.pending.clear();
  }

  private async request(action: string, input: Record<string, unknown>): Promise<unknown> {
    await this.start();
    if (this.pending.size >= 64) throw new ServiceUnavailableException("CAD 请求过多，请稍后重试");
    const id = randomUUID();
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ServiceUnavailableException("CAD 服务响应超时，请重试")); }, 90_000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, action, ...input }) + "\n", (error) => {
        if (error !== null && error !== undefined) { clearTimeout(timer); this.pending.delete(id); reject(new ServiceUnavailableException("CAD 服务暂不可用")); }
      });
    });
  }

  async lookup(input: { name: string; sourceSHA256: string; sourceByteLength: number; namespace: string; cacheScope: string; nameCodepage: CadNameCodepage }): Promise<z.infer<typeof CadJobCreateResponseSchema> | null> {
    return CadJobCreateResponseSchema.nullable().parse(await this.request("lookup", input));
  }
  async submit(input: { path: string; name: string; sourceSHA256: string; sourceByteLength: number; namespace: string; cacheScope: string; nameCodepage: CadNameCodepage }): Promise<z.infer<typeof CadJobCreateResponseSchema>> {
    return CadJobCreateResponseSchema.parse(await this.request("submit", input));
  }
  async status(input: { jobId: string; namespace: string }): Promise<CadJob> { return CadJobSchema.parse(await this.request("status", input)); }
  async cancel(input: { jobId: string; namespace: string }): Promise<CadJob> { return CadJobSchema.parse(await this.request("cancel", input)); }
  async file(action: "manifest" | "buffer", input: { jobId: string; namespace: string; lease?: string; sha256?: string }): Promise<z.infer<typeof FileResultSchema>> {
    const file = FileResultSchema.parse(await this.request(action, input));
    const path = relative(this.root, file.path);
    if (isAbsolute(path) || path.startsWith("..")) throw new ServiceUnavailableException("模型资源不可用");
    return file;
  }
  async release(input: { jobId: string; namespace: string; lease: string }): Promise<void> { await this.request("release", input); }
  async onModuleDestroy(): Promise<void> {
    const child = this.child;
    this.fail();
    if (child === null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 8_000);
      child.once("exit", () => { clearTimeout(timer); done(); });
      child.kill("SIGTERM");
    });
  }
}
