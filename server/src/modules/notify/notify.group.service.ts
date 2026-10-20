/**
 * 群播报投递消费（M5-03-2 接线段 · outbox 主题 notify.group）。
 *
 * 一次消费 = 读绑定 → 组装 markdown → 长连接推送（aibot_send_msg）→ 三分类收敛 + 投递留痕：
 *   ok                              → done（sent 行，attempts = 实际帧数）；
 *   rate_limited（本地桶 / 846607 超频）→ deferred（deferred 行；availableAt = retryAt ?? now+60s；不消耗重试次数）；
 *   retryable（断连 / 未订阅 / 回执超时）→ retry（failed 行）；
 *   permanent（853000 / 846601 / 45002 / 846607 未激活）→ dead（dead 行）+ C5-04 降级（B4 定案 · M5-03-3：
 *     项目经理站内信；管理员告警群留痕由 outbox 死信告警自动承担 —— 出口 = 企微告警群）；
 *   无绑定                          → dead（不写投递行 —— target NOT NULL 无值可落；差异登记②）；
 *   绑定停用（enabled=false）        → dead（dead 行，target=chatid）；上述两类同样走 B4 降级。
 *
 * 超长口径（B5 定案）：内容按 UTF-8 字节截断（≤ 20000 字节，留 20480 官方上限余量），尾部省略 + warn 留痕。
 * markdown 组装：title === null ? body : `**title**\n\nbody`。
 * 安全：chatid 只进库（notify_deliveries.target）与限速桶摘要；日志 / outbox error 一律掩码（末 4 位）。
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { NotifyGroupMessagePayloadSchema, type NotifyGroupMessagePayload } from "@libiaolink/contracts";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import { NotifyGroupRepository } from "./notify.group.repository.js";
import { NotifyService } from "./notify.service.js";
import type { AibotIncomingMessage, AibotSendResult } from "./wecom.aibot.js";
import { aibotImageMimeFromFileName, WecomAibotClient } from "./wecom.aibot.js";
import { renderR06Poster } from "./r06.poster.js";
import { describeWecomFailure } from "./wecom.errors.js";
import { applyMarkdownHardBreaks, truncateUtf8Bytes } from "./wecom.text.js";

/** 群 markdown 字节上限（官方口径 20480；取 20000 留余量 —— B5 定案「投递层按字节截断留痕」）。 */
export const GROUP_MARKDOWN_MAX_BYTES = 20_000;

/** 截断省略后缀（尾部省略口径）。 */
export const GROUP_TRUNCATION_SUFFIX = "\n\n…（内容过长，已截断）";

/** 降级站内信前缀（C5-04 · B4 定案：群失败 → 项目经理站内信；正文保留原文）。 */
export const GROUP_DEGRADE_PREFIX = "【项目群播报未送达，已降级为站内信】\n\n";

/** chatid 掩码（日志 / outbox error 口径：只回末 4 位，全文只落库）。 */
export function maskChatid(chatid: string): string {
  return "****" + chatid.slice(-4);
}

/** 载荷解析：契约校验 + 空白归一；非法载荷 → null（消费侧转 dead —— 重试不会变合法）。 */
export function parseGroupMessage(raw: Record<string, unknown>): NotifyGroupMessagePayload | null {
  const parsed = NotifyGroupMessagePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.data;
  const trimOrNull = (text: string | null | undefined): string | null => {
    if (text === null || text === undefined) {
      return null;
    }
    const trimmed = text.trim();
    return trimmed === "" ? null : trimmed;
  };
  return {
    projectId: value.projectId,
    title: trimOrNull(value.title),
    body: value.body.trim(),
    refType: trimOrNull(value.refType),
    refId: value.refId ?? null,
    templateCode: trimOrNull(value.templateCode),
  };
}

/** markdown 组装：无标题（R03_GROUP 一类）只发正文；有标题加粗 + 空行分隔。 */
export function composeGroupMarkdown(message: Pick<NotifyGroupMessagePayload, "title" | "body">): string {
  const content = message.title === null ? message.body : "**" + message.title + "**\n\n" + message.body;
  return applyMarkdownHardBreaks(content);
}

/** UTF-8 字节截断（不劈开多字节字符）：未超长原样返回；超长截到 maxBytes - 后缀，尾部拼省略标记。 */
export function truncateGroupMarkdown(content: string, maxBytes: number = GROUP_MARKDOWN_MAX_BYTES): {
  content: string;
  truncated: boolean;
} {
  return truncateUtf8Bytes(content, maxBytes, GROUP_TRUNCATION_SUFFIX);
}

/** 群名命令最大字符数（与候选 / 绑定表 name 的 64 字符口径一致）。 */
const GROUP_NAME_MAX_CHARS = 64;

/** 群名命令提示（空名 / 未带名称时回复）。 */
export const GROUP_NAME_COMMAND_HINT = "请发送「群名 项目群名称」设置群名（最多 64 个字符）。";

export type GroupNameCommand =
  | { kind: "set"; name: string }
  | { kind: "invalid"; reason: "missing" | "too_long" };

/**
 * 解析群内 @机器人 的群名命令：支持「群名 XXX」「群名：XXX」「群名称 XXX」「设置群名 XXX」；
 * 允许前置 @机器人 / <@userid> 提及。非命令返回 null（普通群聊不回复、不改名）。
 */
export function parseGroupNameCommand(raw: string | null): GroupNameCommand | null {
  if (raw === null) {
    return null;
  }
  let text = raw.trim();
  for (;;) {
    const next = text.replace(/^(?:<@[^>]+>|@\S+)\s+/u, "");
    if (next === text) {
      break;
    }
    text = next;
  }
  if (/^(?:设置)?群名(?:称)?\s*$/u.test(text)) {
    return { kind: "invalid", reason: "missing" };
  }
  const match = /^(?:设置)?群名(?:称)?(?:\s*[:：]\s*|\s+)([\s\S]*)$/u.exec(text);
  if (match === null) {
    return null;
  }
  const name = (match[1] ?? "").trim();
  if (name === "") {
    return { kind: "invalid", reason: "missing" };
  }
  if (Array.from(name).length > GROUP_NAME_MAX_CHARS) {
    return { kind: "invalid", reason: "too_long" };
  }
  return { kind: "set", name };
}

/** 回调可选群名归一：trim + 最多 64 个 Unicode 字符；空 → null。 */
function normalizeGroupName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  return Array.from(trimmed).slice(0, GROUP_NAME_MAX_CHARS).join("");
}

/** 降级站内信类型：A02 / R06 为播报（摘要群发 / 喜报），其余群播报按提醒。 */
function degradeTypeOf(templateCode: string | null): "broadcast" | "reminder" {
  return templateCode !== null && /^(A02|R06|A08)/.test(templateCode) ? "broadcast" : "reminder";
}

/** 失败描述（核心语义：errcode + 白话标签 / errmsg 概要；不含 kind / state 内部态与企微机器尾巴；不含 chatid 明文）。 */
function describeAibotFailure(result: Extract<AibotSendResult, { ok: false }>): string {
  return "群播报未送达" + describeWecomFailure(result.errcode, result.errmsg);
}

/**
 * 群播报消费服务（worker 注册表）：handler 只做业务与分类，outbox 回写统一由 dispatcher 收敛；
 * 任何异常都不外抛（dispatcher 按可重试兜底，与 NotifyService.consume 同口径）。
 */
@Injectable()
export class NotifyGroupService {
  private readonly logger = new Logger(NotifyGroupService.name);

  constructor(
    private readonly repository: NotifyGroupRepository,
    private readonly aibot: WecomAibotClient,
    private readonly notify: NotifyService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
  ) {}

  /**
   * 群消息回调 ingest（长连接 onMessage 接线）：只处理群聊消息回调（cmd=aibot_msg_callback / chattype=group /
   * 合法 chatid）。已绑定群 → 会话激活置位（幂等）；未绑定群 → 写入候选表供设置页自动发现，绑定后删除候选行。
   * 群名命令（@机器人 发「群名 XXX」/「群名：XXX」/「设置群名 XXX」）只更新展示名，不做绑定授权；
   * 绑定仍由设置页按 project.update 权限完成。事件回调、单聊、缺 chatid 或非法 chatid 一律忽略。
   */
  async activateFromCallback(incoming: AibotIncomingMessage): Promise<void> {
    if (
      incoming.cmd !== "aibot_msg_callback" ||
      incoming.chattype !== "group" ||
      incoming.chatid === null ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(incoming.chatid)
    ) {
      return;
    }
    const at = this.clock.now();
    const command = incoming.msgtype === "text" ? parseGroupNameCommand(incoming.text) : null;
    const row = await this.repository.findGroupByChatid(incoming.chatid);
    if (row === null) {
      const name = command?.kind === "set" ? command.name : normalizeGroupName(incoming.chatName);
      await this.repository.observeCandidate({ chatid: incoming.chatid, name }, at);
      this.logger.log("群回调已登记候选群：" + maskChatid(incoming.chatid));
      if (command !== null) {
        await this.replyNameCommand(incoming, command, false);
      }
      return;
    }
    if (row.activatedAt === null) {
      const activated = await this.repository.activateByChatid(incoming.chatid, at);
      if (activated !== null) {
        this.logger.log("群会话已激活：" + maskChatid(incoming.chatid) + " · project=" + activated.projectId);
      }
    }
    if (command?.kind === "set") {
      const updated = await this.repository.setGroupName(incoming.chatid, command.name, at);
      if (updated !== null) {
        this.logger.log("群名已更新：" + maskChatid(incoming.chatid));
      }
    }
    if (command !== null) {
      await this.replyNameCommand(incoming, command, true);
    }
  }

  /** 群名命令回执（被动回复，尽力而为；失败不影响名称落库）。 */
  private async replyNameCommand(
    incoming: AibotIncomingMessage,
    command: GroupNameCommand,
    bound: boolean,
  ): Promise<void> {
    if (incoming.reqId === null || incoming.fromUserId === null || incoming.chatid === null) {
      return;
    }
    let content: string;
    if (command.kind === "set") {
      content = bound
        ? "群名已更新：" + command.name
        : "群名已记录：" + command.name + "。请到「企微绑定」页选择该项目群完成绑定。";
    } else if (command.reason === "too_long") {
      content = "群名最多 64 个字符。请重新发送「群名 项目群名称」。";
    } else {
      content = GROUP_NAME_COMMAND_HINT;
    }
    try {
      const result = await this.aibot.replyToCallback({
        reqId: incoming.reqId,
        userid: incoming.fromUserId,
        chatid: incoming.chatid,
        content,
      });
      if (!result.ok) {
        this.logger.warn(
          "群名命令回执未送达：" + maskChatid(incoming.chatid) + describeWecomFailure(result.errcode, result.errmsg),
        );
      }
    } catch {
      this.logger.warn("群名命令回执异常：" + maskChatid(incoming.chatid));
    }
  }

  async consume(row: OutboxClaimedRow): Promise<OutboxHandleOutcome> {
    const message = parseGroupMessage(row.payload);
    if (message === null) {
      this.logger.warn("群播报载荷非法，转 dead：outbox#" + row.id + "（" + row.dedupeKey + "）");
      return {
        outcome: "dead",
        error: "群播报载荷非法（缺 projectId / body 或超长）：" + row.dedupeKey,
      };
    }
    const binding = await this.repository.findGroupByProject(message.projectId);
    if (binding === null) {
      // 无绑定：notify_deliveries.target NOT NULL 无值可落 —— 不写投递行，dead + 日志（差异登记②）；
      // 运营可见性由 outbox 死信告警承担（项目群绑定维护 = M5-07 前端入口 / PUT 接口）；
      // 降级（B4）= 项目经理站内信（正文含原文）。
      this.logger.warn(
        "群未绑定（确定性失败转 dead）：outbox#" + row.id + " · project=" + message.projectId + " · " + row.dedupeKey,
      );
      return await this.deadWithDegrade(row, message, "群未绑定（project " + message.projectId + "）：" + row.dedupeKey);
    }
    const masked = maskChatid(binding.chatid);
    if (!binding.enabled) {
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: binding.chatid,
        state: "dead",
        attempts: 0,
        error: "群绑定已停用（chatid " + masked + "）",
        sentAt: null,
      });
      this.logger.warn("群绑定已停用（确定性失败转 dead）：outbox#" + row.id + " · chatid " + masked);
      return await this.deadWithDegrade(row, message, "群绑定已停用（chatid " + masked + "）：" + row.dedupeKey);
    }

    const composed = composeGroupMarkdown(message);
    const { content, truncated } = truncateGroupMarkdown(composed);
    if (truncated) {
      this.logger.warn(
        "群播报超字节上限已截断（" +
          String(Buffer.byteLength(composed, "utf8")) +
          " → " +
          String(Buffer.byteLength(content, "utf8")) +
          " 字节）：outbox#" +
          row.id +
          " · chatid " +
          masked,
      );
    }

    const result = await this.aibot.sendGroupMarkdown({
      chatid: binding.chatid,
      content,
      groupActivated: binding.activatedAt !== null,
    });

    if (result.ok) {
      const imageAttempts = await this.sendR06Poster({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: binding.chatid,
        state: "sent",
        attempts: result.attempts + imageAttempts,
        error: null,
        sentAt: this.clock.now(),
      });
      this.logger.log("群播报已受理：" + row.dedupeKey + " · chatid " + masked + (truncated ? "（截断发送）" : ""));
      return { outcome: "done" };
    }

    const error = describeAibotFailure(result);
    if (result.kind === "rate_limited") {
      const availableAt = result.retryAt ?? new Date(this.clock.now().getTime() + 60_000);
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: binding.chatid,
        state: "deferred",
        attempts: result.attempts,
        error,
        sentAt: null,
      });
      return { outcome: "deferred", availableAt, error: error };
    }
    if (result.kind === "retryable") {
      await this.repository.insertDelivery({
        outboxId: row.id,
        target: binding.chatid,
        state: "failed",
        attempts: result.attempts,
        error,
        sentAt: null,
      });
      return { outcome: "retry", error };
    }
    // permanent（含 846607 未激活分支）：不重试；降级 B4（项目经理站内信 + 管理员告警群留痕）。
    await this.repository.insertDelivery({
      outboxId: row.id,
      target: binding.chatid,
      state: "dead",
      attempts: result.attempts,
      error,
      sentAt: null,
    });
    this.logger.warn("群播报确定性失败（转 dead）：" + row.dedupeKey + " · chatid " + masked + " —— " + error);
    return await this.deadWithDegrade(row, message, error);
  }

  /**
   * R06 喜报图：仅当 templateCode = R06_GROUP。默认按项目真实数据动态生成 A 方案姓名墙 PNG；
   * 动态读取 / 绘制失败时回退 WECOM_R06_IMAGE_PATH（全部任务按时交付时优先 WECOM_R06_ON_TIME_IMAGE_PATH）。
   * 图片在文字已送达后追加；图片生成 / 发送失败只留日志，不影响已送达文字。
   */
  private async sendR06Poster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    if (input.message.templateCode !== "R06_GROUP") {
      return 0;
    }
    if (this.config.env.WECOM_R06_DYNAMIC_POSTER !== "false") {
      const dynamicAttempts = await this.sendDynamicR06Poster(input);
      if (dynamicAttempts !== null) {
        return dynamicAttempts;
      }
    }
    return await this.sendStaticR06Poster(input);
  }

  /** 动态海报：数据 / 字体 / 绘制任一失败 = null（调用方回退静态图）；已发出的发送帧数原样返回。 */
  private async sendDynamicR06Poster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number | null> {
    let content: Buffer;
    let fileName: string;
    try {
      const data = await this.repository.findR06PosterData(input.message.projectId);
      if (data === null) {
        this.logger.warn("R06 动态海报数据缺失，回退静态图（文字已发送）：" + input.dedupeKey);
        return null;
      }
      content = renderR06Poster(
        { ...data, completedAt: this.clock.now() },
        {
          sans: (this.config.env.WECOM_R06_FONT_SANS_PATH ?? "").trim(),
          sansBold: (this.config.env.WECOM_R06_FONT_SANS_BOLD_PATH ?? "").trim(),
          serif: (this.config.env.WECOM_R06_FONT_SERIF_PATH ?? "").trim(),
        },
      );
      fileName = "R06-" + data.projectCode + ".png";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("R06 动态海报生成失败，回退静态图（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return null;
    }
    return await this.deliverR06Image(input, content, fileName, "image/png", "动态海报");
  }

  /** 静态回退图：原口径保持不变；无配置 / 格式不支持 / 读取失败 = 0。 */
  private async sendStaticR06Poster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    const defaultImagePath = (this.config.env.WECOM_R06_IMAGE_PATH ?? "").trim();
    const onTimeImagePath = (this.config.env.WECOM_R06_ON_TIME_IMAGE_PATH ?? "").trim();
    if (defaultImagePath === "" && onTimeImagePath === "") {
      return 0;
    }
    let allOnTime = false;
    if (onTimeImagePath !== "") {
      try {
        allOnTime = await this.repository.areProjectTasksAllOnTime(input.message.projectId, this.clock.now());
      } catch {
        this.logger.warn("R06 按时交付判定读取失败，回退默认喜报图：" + input.dedupeKey);
      }
    }
    const configured = allOnTime ? onTimeImagePath : defaultImagePath;
    if (configured === "") {
      return 0;
    }
    const fileName = basename(configured);
    const mime = aibotImageMimeFromFileName(fileName);
    if (mime === null) {
      this.logger.warn("R06 喜报图片格式不支持（仅 PNG / JPG / GIF），已跳过：" + fileName);
      return 0;
    }
    let content: Buffer;
    try {
      content = await readFile(resolve(configured));
    } catch {
      this.logger.warn("R06 喜报图片读取失败，已跳过（文字已发送）：" + fileName);
      return 0;
    }
    return await this.deliverR06Image(input, content, fileName, mime, "静态回退图");
  }

  /** 单次 R06 图片发送与留痕；失败不抛错、不触发二次发送。 */
  private async deliverR06Image(
    input: {
      chatid: string;
      groupActivated: boolean;
      masked: string;
      dedupeKey: string;
    },
    content: Buffer,
    fileName: string,
    mime: string,
    sourceLabel: string,
  ): Promise<number> {
    const result = await this.aibot.sendGroupImage({
      chatid: input.chatid,
      content,
      fileName,
      mime,
      groupActivated: input.groupActivated,
    });
    if (!result.ok) {
      this.logger.warn(
        "R06 " +
          sourceLabel +
          "未送达（文字已发送）：" +
          input.dedupeKey +
          " · chatid " +
          input.masked +
          " —— " +
          describeAibotFailure(result),
      );
      return result.attempts;
    }
    this.logger.log("R06 " + sourceLabel + "已送达：" + input.dedupeKey + " · chatid " + input.masked);
    return result.attempts;
  }

  /**
   * 群失败降级（C5-04 / B4 定案）：项目经理站内信 —— 经 NotifyService.deliverInboxCopy 走同一落行 / 合并 /
   * 免打扰 / 实时流口径；幂等键 = 来源 dedupeKey + ":c504"。管理员告警群留痕由 outbox 死信告警自动承担
   * （dispatcher → OUTBOX_ALERT_SINK，M5-03-3 起 = 企微告警群）。降级写库失败 → retry 收敛（有界重试，
   * 不静默丢消息）；PM 解析不到（项目软删 / 不存在）→ 跳过站内信（仍 dead + 死信告警）。
   */
  private async deadWithDegrade(
    row: OutboxClaimedRow,
    message: NotifyGroupMessagePayload,
    error: string,
  ): Promise<OutboxHandleOutcome> {
    const managerId = await this.repository.findProjectManagerId(message.projectId);
    if (managerId === null) {
      this.logger.warn("群失败降级：项目经理解析不到（跳过站内信）：" + row.dedupeKey + " · project=" + message.projectId);
      return { outcome: "dead", error };
    }
    try {
      await this.notify.deliverInboxCopy(
        {
          recipientId: managerId,
          type: degradeTypeOf(message.templateCode ?? null),
          title: message.title ?? "项目群播报",
          body: GROUP_DEGRADE_PREFIX + message.body,
          refType: message.refType,
          refId: message.refId,
          templateCode: message.templateCode,
          mergeKey: null,
        },
        row.topic,
        row.dedupeKey + ":c504",
      );
      this.logger.warn("群失败已降级项目经理站内信（manager " + managerId + "）：" + row.dedupeKey + " —— " + error);
      return { outcome: "dead", error };
    } catch (degradeError) {
      const detail = degradeError instanceof Error ? degradeError.message : String(degradeError);
      this.logger.error("群失败降级站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
    }
  }
}
