import { Injectable, Logger } from "@nestjs/common";
import { ObjectStorage } from "../../storage/index.js";
import {
  renderDailyReportDigestPoster,
  renderDailyReportIssueDigestPoster,
  renderDailyReportIssuePoster,
  renderDailyReportPoster,
} from "./daily-report.poster.js";
import { DAILY_REPORT_POSTER_MAX_THUMBNAILS } from "./daily-report.poster.constants.js";
import type {
  DailyReportDigestPosterData,
  DailyReportPosterData,
  DailyReportPosterPhoto,
} from "./daily-report.poster.types.js";
import { WECOM_AIBOT_IMAGE_MAX_BYTES, WecomAibotClient } from "./wecom.aibot.js";

export type DailyReportPosterTarget =
  | { chattype: "group"; chatid: string; groupActivated?: boolean | null }
  | { chattype: "single"; userid: string; dmActivated?: boolean | null };

export type DailyReportPosterPayload =
  | { kind: "single"; data: DailyReportPosterData }
  | { kind: "digest"; data: DailyReportDigestPosterData };

export type DailyReportPosterDeliveryInput = DailyReportPosterPayload & {
  target: DailyReportPosterTarget;
  sendDaily?: boolean;
  sendIssues?: boolean;
  /** 排障关联键（建议 msgid / 幂等键），不得传聊天正文。 */
  trace?: string;
};

/** 进程内海报渲染闸门：同时只渲染 1 张，等待位最多 2 个。 */
export const DAILY_REPORT_POSTER_RENDER_CONCURRENCY = 1;
export const DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT = 2;

interface PosterRenderJob {
  run: () => Promise<Buffer>;
  resolve: (content: Buffer) => void;
  reject: (error: unknown) => void;
}

class PosterRenderQueueFullError extends Error {
  constructor() {
    super("poster render queue full");
    this.name = "PosterRenderQueueFullError";
  }
}

function maskedTarget(target: DailyReportPosterTarget): string {
  const value = target.chattype === "group" ? target.chatid : target.userid;
  return "****" + value.slice(-4);
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function digestReportThumbnails(data: DailyReportDigestPosterData): DailyReportPosterPhoto[] {
  const selected: DailyReportPosterPhoto[] = [];
  for (const report of data.reports) {
    const photo = report.photos[0];
    if (photo === undefined) continue;
    selected.push(photo);
  }
  return selected;
}

function digestIssueThumbnails(data: DailyReportDigestPosterData): DailyReportPosterPhoto[] {
  const selected: DailyReportPosterPhoto[] = [];
  for (const issue of data.issues) {
    const photo = issue.photos[0];
    if (photo === undefined) continue;
    selected.push(photo);
  }
  return selected;
}

function digestDailyIsSendable(data: DailyReportDigestPosterData): boolean {
  return data.reports.length >= 2;
}

function digestIssueIsSendable(data: DailyReportDigestPosterData): boolean {
  return data.issues.length > 0;
}

function uniquePhotos(photos: readonly DailyReportPosterPhoto[]): DailyReportPosterPhoto[] {
  const seen = new Set<string>();
  return photos.filter((photo) => {
    if (seen.has(photo.fileId)) return false;
    seen.add(photo.fileId);
    return true;
  });
}

/**
 * 日报查询海报投递：只消费 notify 自己的海报快照类型，不反向依赖 report-issue。
 * 单篇复用现有日报 / 问题专报；多篇与 0 篇问题走合集渲染器。一次最多两张逻辑图，
 * 附件读取 / 渲染 / 10MB / 上传 / 发送任一失败只跳过对应图片，文字回复不受影响。
 */
@Injectable()
export class DailyReportPosterDeliveryService {
  private readonly logger = new Logger(DailyReportPosterDeliveryService.name);
  private activeRenders = 0;
  private readonly renderQueue: PosterRenderJob[] = [];

  constructor(
    private readonly storage: ObjectStorage,
    private readonly aibot: WecomAibotClient,
  ) {}

  async send(input: DailyReportPosterDeliveryInput): Promise<number> {
    const trace = input.trace ?? "report-query";
    const dailyRequested =
      input.sendDaily !== false &&
      (input.kind === "single" || digestDailyIsSendable(input.data));
    const issuesRequested =
      input.sendIssues === true &&
      (input.kind === "single"
        ? input.data.issues.length > 0
        : digestIssueIsSendable(input.data));
    const digestDailyPhotos = input.kind === "digest" ? digestReportThumbnails(input.data) : [];
    const digestIssuePhotos = input.kind === "digest" ? digestIssueThumbnails(input.data) : [];
    const dailyOverLimit =
      input.kind === "digest" &&
      dailyRequested &&
      digestDailyPhotos.length > DAILY_REPORT_POSTER_MAX_THUMBNAILS;
    const issuesOverLimit =
      input.kind === "digest" &&
      issuesRequested &&
      digestIssuePhotos.length > DAILY_REPORT_POSTER_MAX_THUMBNAILS;
    if (dailyOverLimit) {
      this.logger.warn(
        "日报合集附件超过数量上限，已回退文字与深链：" +
          trace +
          " · count=" +
          String(digestDailyPhotos.length) +
          " · limit=" +
          String(DAILY_REPORT_POSTER_MAX_THUMBNAILS),
      );
    }
    if (issuesOverLimit) {
      this.logger.warn(
        "问题合集附件超过数量上限，已回退文字与深链：" +
          trace +
          " · count=" +
          String(digestIssuePhotos.length) +
          " · limit=" +
          String(DAILY_REPORT_POSTER_MAX_THUMBNAILS),
      );
    }
    const includeDaily = dailyRequested && !dailyOverLimit;
    const includeIssues = issuesRequested && !issuesOverLimit;
    if (!includeDaily && !includeIssues) return 0;

    const dailyPhotos = includeDaily
      ? input.kind === "single"
        ? input.data.photos
        : digestDailyPhotos
      : [];
    const issuePhotos = includeIssues
      ? input.kind === "single"
        ? input.data.issues.flatMap((issue) => issue.photos)
        : digestIssuePhotos
      : [];
    const photos = uniquePhotos([...dailyPhotos, ...issuePhotos]);
    const objectKeys = [
      ...new Set(photos.map((photo) => photo.objectKey).filter((key): key is string => key !== null)),
    ];
    const objectBytes = new Map<string, Buffer>();
    let unreadableAttachments = 0;
    await Promise.all(
      objectKeys.map(async (objectKey) => {
        try {
          const object = await this.storage.getObject(objectKey);
          if (object === null) {
            unreadableAttachments += 1;
          } else {
            objectBytes.set(objectKey, Buffer.from(object.bytes));
          }
        } catch {
          // 单张附件失败只影响自身片位；海报文字与其余图片继续生成。
          unreadableAttachments += 1;
        }
      }),
    );
    if (unreadableAttachments > 0) {
      this.logger.warn("日报海报部分附件未读取，按缺图继续生成：" + trace + " · count=" + String(unreadableAttachments));
    }
    const imagesFor = (selected: readonly DailyReportPosterPhoto[]): Map<string, Buffer> => {
      const images = new Map<string, Buffer>();
      for (const photo of selected) {
        const bytes = photo.objectKey === null ? undefined : objectBytes.get(photo.objectKey);
        if (bytes !== undefined) images.set(photo.fileId, bytes);
      }
      return images;
    };
    const singleImages = input.kind === "single" ? imagesFor(photos) : null;
    const dailyImages = singleImages ?? imagesFor(dailyPhotos);
    const issueImages = singleImages ?? imagesFor(issuePhotos);

    let attempts = 0;
    const projectCode = getProjectCode(input);
    const masked = maskedTarget(input.target);
    const sendOne = async (label: string, fileName: string, render: () => Promise<Buffer>): Promise<void> => {
      let content: Buffer;
      try {
        content = await this.enqueueRender(render);
      } catch (error) {
        this.logger.warn(label + "生成失败，已跳过图片：" + trace + " · " + errorLabel(error));
        return;
      }
      if (content.length > WECOM_AIBOT_IMAGE_MAX_BYTES) {
        this.logger.warn(label + "超过 10MB，已跳过图片：" + trace);
        return;
      }

      let result;
      try {
        result =
          input.target.chattype === "group"
            ? await this.aibot.sendGroupImage({
                chatid: input.target.chatid,
                content,
                fileName,
                mime: "image/png",
                groupActivated: input.target.groupActivated ?? null,
              })
            : await this.aibot.sendUserImage({
                userid: input.target.userid,
                content,
                fileName,
                mime: "image/png",
                dmActivated: input.target.dmActivated ?? null,
              });
      } catch (error) {
        this.logger.warn(label + "发送异常，已跳过图片：" + trace + " · " + masked + " · " + errorLabel(error));
        return;
      }
      attempts += result.attempts;
      if (!result.ok) {
        this.logger.warn(
          label + "未送达，已跳过图片：" + trace + " · " + masked + " · kind=" + result.kind + " · errcode=" + String(result.errcode ?? "null"),
        );
        return;
      }
      this.logger.log(label + "已送达：" + trace + " · " + masked);
    };

    if (includeDaily) {
      if (input.kind === "single") {
        await sendOne("日报海报", "DAILY-" + input.data.reportDate + "-" + projectCode + ".png", () =>
          renderDailyReportPoster(input.data, dailyImages),
        );
      } else {
        await sendOne("日报合集海报", "DAILY-DIGEST-" + input.data.reportDate + "-" + projectCode + ".png", () =>
          renderDailyReportDigestPoster(input.data, dailyImages),
        );
      }
    }
    if (includeIssues) {
      if (input.kind === "single") {
        await sendOne("现场问题专报", "ISSUE-" + input.data.reportDate + "-" + projectCode + ".png", () =>
          renderDailyReportIssuePoster(input.data, issueImages),
        );
      } else {
        await sendOne("问题合集海报", "ISSUE-DIGEST-" + input.data.reportDate + "-" + projectCode + ".png", () =>
          renderDailyReportIssueDigestPoster(input.data, issueImages),
        );
      }
    }
    return attempts;
  }

  private enqueueRender(render: () => Promise<Buffer>): Promise<Buffer> {
    if (
      this.activeRenders >= DAILY_REPORT_POSTER_RENDER_CONCURRENCY &&
      this.renderQueue.length >= DAILY_REPORT_POSTER_RENDER_QUEUE_LIMIT
    ) {
      return Promise.reject(new PosterRenderQueueFullError());
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.renderQueue.push({ run: render, resolve, reject });
      void this.drainRenderQueue();
    });
  }

  private async drainRenderQueue(): Promise<void> {
    if (this.activeRenders >= DAILY_REPORT_POSTER_RENDER_CONCURRENCY) return;
    const job = this.renderQueue.shift();
    if (job === undefined) return;
    this.activeRenders += 1;
    try {
      job.resolve(await job.run());
    } catch (error) {
      job.reject(error);
    } finally {
      this.activeRenders -= 1;
      if (this.renderQueue.length > 0) void this.drainRenderQueue();
    }
  }
}

function getProjectCode(input: DailyReportPosterPayload): string {
  return input.data.projectCode.replace(/[^A-Za-z0-9._-]+/gu, "-");
}
