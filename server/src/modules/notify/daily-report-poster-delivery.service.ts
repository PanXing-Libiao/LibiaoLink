import { Injectable, Logger } from "@nestjs/common";
import { ObjectStorage } from "../../storage/index.js";
import { renderDailyReportIssuePoster, renderDailyReportPoster } from "./daily-report.poster.js";
import type { DailyReportPosterData } from "./daily-report.poster.types.js";
import { WECOM_AIBOT_IMAGE_MAX_BYTES, WecomAibotClient } from "./wecom.aibot.js";

export type DailyReportPosterTarget =
  | { chattype: "group"; chatid: string; groupActivated?: boolean | null }
  | { chattype: "single"; userid: string; dmActivated?: boolean | null };

export interface DailyReportPosterDeliveryInput {
  data: DailyReportPosterData;
  target: DailyReportPosterTarget;
  sendDaily?: boolean;
  sendIssues?: boolean;
  /** 排障关联键（建议 msgid / 幂等键），不得传聊天正文。 */
  trace?: string;
}

function maskedTarget(target: DailyReportPosterTarget): string {
  const value = target.chattype === "group" ? target.chatid : target.userid;
  return "****" + value.slice(-4);
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * 日报查询海报投递（S4）：只消费 notify 自己的海报快照类型，不反向依赖 report-issue。
 * 同一调用最多两图：日报图后问题图；读取 / 渲染 / 10MB / 上传 / 发送任一失败只跳过对应图片。
 */
@Injectable()
export class DailyReportPosterDeliveryService {
  private readonly logger = new Logger(DailyReportPosterDeliveryService.name);

  constructor(
    private readonly storage: ObjectStorage,
    private readonly aibot: WecomAibotClient,
  ) {}

  async send(input: DailyReportPosterDeliveryInput): Promise<number> {
    const photos = [
      ...(input.sendDaily === false ? [] : input.data.photos),
      ...(input.sendIssues === true ? input.data.issues.flatMap((issue) => issue.photos) : []),
    ];
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
    const trace = input.trace ?? "report-query";
    if (unreadableAttachments > 0) {
      this.logger.warn("日报海报部分附件未读取，按缺图继续生成：" + trace + " · count=" + String(unreadableAttachments));
    }
    const images = new Map<string, Buffer>();
    for (const photo of photos) {
      const bytes = photo.objectKey === null ? undefined : objectBytes.get(photo.objectKey);
      if (bytes !== undefined) images.set(photo.fileId, bytes);
    }

    let attempts = 0;
    const projectCode = input.data.projectCode.replace(/[^A-Za-z0-9._-]+/gu, "-");
    const masked = maskedTarget(input.target);
    const sendOne = async (label: string, fileName: string, render: () => Promise<Buffer>): Promise<void> => {
      let content: Buffer;
      try {
        content = await render();
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

    if (input.sendDaily !== false) {
      await sendOne("日报海报", "DAILY-" + input.data.reportDate + "-" + projectCode + ".png", () =>
        renderDailyReportPoster(input.data, images),
      );
    }
    if (input.sendIssues === true && input.data.issues.length > 0) {
      await sendOne("现场问题专报", "ISSUE-" + input.data.reportDate + "-" + projectCode + ".png", () =>
        renderDailyReportIssuePoster(input.data, images),
      );
    }
    return attempts;
  }
}
