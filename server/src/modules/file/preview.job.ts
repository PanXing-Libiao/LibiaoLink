import { PREVIEW_TARGETS } from "@libiaolink/contracts";

/** 预览任务按版本、管线版本和通道去重，不因客户端曾申报相同哈希而合并不同版本。
 * contentHash 为该版本的绑定信息；新键带 version 命名空间，不继承旧全局任务终态。
 */
export const PREVIEW_JOB_TOPIC = "preview.job";

/** 渲染通道（与契约 `PREVIEW_TARGETS` 同值；本模块内不引 zod，避免把契约运行时拖进消费路径）。 */
export type PreviewTarget = (typeof PREVIEW_TARGETS)[number];

export interface PreviewJobInput {
  projectId: string;
  fileId: string;
  versionId: string;
  contentHash: string;
  target: PreviewTarget;
  /** 触发来源（只进日志 / 排障，不参与任何判定）：`finalize` 定档预生成 / `read` 读取侧补投。 */
  trigger: string;
}

/** 消费侧解析后的任务（payload 里的 contentHash 只作排障参照，缓存键以库内版本行的 contentHash 为准）。 */
export interface PreviewJob {
  projectId: string;
  fileId: string;
  versionId: string;
  target: PreviewTarget;
}

/** 同一版本的同一管线 / 通道只投一次；不同版本拥有独立任务。 */
export function previewJobDedupeKey(input: {
  versionId: string;
  contentHash: string;
  pipelineVersion: string;
  target: PreviewTarget;
}): string {
  return (
    PREVIEW_JOB_TOPIC + ":version:" + input.versionId + ":" + input.contentHash.toLowerCase() + ":" + input.pipelineVersion + ":" + input.target
  );
}

export function buildPreviewJobPayload(input: PreviewJobInput): Record<string, unknown> {
  return {
    projectId: input.projectId,
    fileId: input.fileId,
    versionId: input.versionId,
    contentHash: input.contentHash.toLowerCase(),
    target: input.target,
    trigger: input.trigger,
  };
}

/** 载荷解析：字段缺失 / 类型不对 / 通道非法一律返回 null（消费侧按确定性失败处理，不猜、不兜底默认值）。 */
export function parsePreviewJob(payload: Record<string, unknown>): PreviewJob | null {
  const { projectId, fileId, versionId, target } = payload;
  if (typeof projectId !== "string" || projectId === "") return null;
  if (typeof fileId !== "string" || fileId === "") return null;
  if (typeof versionId !== "string" || versionId === "") return null;
  if (typeof target !== "string" || !PREVIEW_TARGETS.includes(target as PreviewTarget)) return null;
  return { projectId, fileId, versionId, target: target as PreviewTarget };
}
