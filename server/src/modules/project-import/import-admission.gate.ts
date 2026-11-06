import { Injectable } from "@nestjs/common";
import { AppConfig } from "../../config/config.module.js";

const MIB = 1024 * 1024;
const LIGHT_IMPORT_MAX_BYTES = 32 * MIB;
const MEDIUM_IMPORT_MAX_BYTES = 128 * MIB;

/** 一次导入准入租约；release 幂等，成功 / 失败 / 取消路径都必须归还。 */
export interface ImportAdmissionLease {
  release(): void;
}

/**
 * 项目导入的进程内准入闸门（非阻塞）。
 *
 * - preview 按请求体大小计权：≤32 MiB = 1、≤128 MiB = 2、更大 / 长度未知 = 3；
 * - commit 按预览源文件大小计权，并用 previewId 单飞，防止同一票据重复进入事务；
 * - 额度不足立即返回 null（上层转 429），不排队占住请求；
 * - 这是单 API 进程内的资源护栏，不是跨实例分布式锁。
 */
@Injectable()
export class ImportAdmissionGate {
  private previewWeight = 0;
  private commitWeight = 0;
  private readonly activeCommitPreviews = new Set<string>();
  private readonly previewBudget: number;
  private readonly commitLimit: number;

  constructor(config: AppConfig) {
    this.previewBudget = config.env.IMPORT_CONCURRENCY_BUDGET;
    this.commitLimit = config.env.IMPORT_COMMIT_CONCURRENCY;
  }

  /** 在接收 multipart 前抢 preview 额度；Content-Length 缺失 / 非法按重型任务保守计权。 */
  tryPreview(contentLength: string | number | undefined): ImportAdmissionLease | null {
    const weight = this.effectiveWeight(parseByteCount(contentLength), this.previewBudget);
    if (this.previewWeight + weight > this.previewBudget) return null;
    this.previewWeight += weight;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.previewWeight -= weight;
      },
    };
  }

  /** 在 commit 完成票据校验后抢提交额度；同一 previewId 已有提交时立即拒绝。 */
  tryCommit(previewId: string, sourceBytes: number): ImportAdmissionLease | null {
    if (this.activeCommitPreviews.has(previewId)) return null;
    const weight = this.effectiveWeight(sourceBytes, this.commitLimit);
    if (this.commitWeight + weight > this.commitLimit) return null;
    this.activeCommitPreviews.add(previewId);
    this.commitWeight += weight;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeCommitPreviews.delete(previewId);
        this.commitWeight -= weight;
      },
    };
  }

  private effectiveWeight(bytes: number | undefined, limit: number): number {
    const raw = bytes === undefined ? 3 : bytes <= LIGHT_IMPORT_MAX_BYTES ? 1 : bytes <= MEDIUM_IMPORT_MAX_BYTES ? 2 : 3;
    return Math.min(raw, limit);
  }
}

function parseByteCount(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
