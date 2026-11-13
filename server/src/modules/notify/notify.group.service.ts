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
import {
  NotifyGroupMessagePayloadSchema,
  STAKEHOLDER_COMPANY_TYPE_NAMES,
  type NotifyDeliveryTopic,
  type NotifyGroupMessagePayload,
} from "@libiaolink/contracts";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import { ObjectStorage } from "../../storage/index.js";
import type { OutboxClaimedRow } from "../../db/outbox.store.js";
import type { OutboxHandleOutcome } from "../../outbox/handler.js";
import {
  inferNotifyRuleCode,
  NotifyDeliveryArchiveRepository,
  type NotifyDeliveryMessageRow,
} from "./notify.delivery-archive.repository.js";
import { NotifyGroupRepository, type GroupStakeholderRow } from "./notify.group.repository.js";
import type { ActorAuthorization } from "../identity/index.js";
import { can, canSeeField, PermissionService } from "../permission/index.js";
import {
  projectGroupDeliverability,
  ProjectGroupDeliveryAlertService,
} from "./project-group-delivery-alert.service.js";
import { NotifyService } from "./notify.service.js";
import type { AibotIncomingMessage, AibotSendResult } from "./wecom.aibot.js";
import { aibotImageMimeFromFileName, WecomAibotClient } from "./wecom.aibot.js";
import { renderDailyReportIssuePoster, renderDailyReportPoster } from "./daily-report.poster.js";
import { renderR06Poster } from "./r06.poster.js";
import { renderMaterialReissuePoster } from "./material-reissue.poster.js";
import { renderStageCompletePoster } from "./stage-complete.poster.js";
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
    stageKey: value.stageKey ?? null,
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

/** 群内干系人查询提示。 */
export const GROUP_STAKEHOLDER_COMMAND_HINT = "请发送「@机器人 干系人」查看本项目干系人。";

/** 未绑定项目的群回执。 */
export const GROUP_STAKEHOLDER_UNBOUND_HINT = "当前群尚未绑定项目，请到「企微绑定」页完成绑定后再查询干系人。";

/** 单条群消息最多展示的干系人行数（超出时保留最近更新，避免触达 markdown 字节上限）。 */
export const GROUP_STAKEHOLDER_MAX_ROWS = 50;

/** 群内查询者身份：绑定本地账号且具备项目/干系人权限时才返回联系方式等敏感字段。 */
export type GroupStakeholderViewer =
  | { kind: "authorized"; authorization: ActorAuthorization }
  | { kind: "restricted" }
  | { kind: "anonymous" };

/**
 * 解析群内干系人命令：严格匹配「@机器人 干系人」。
 * 裸 @机器人、未 @ 的关键词、其他命令变体与普通群聊均返回 false（不回复）。
 */
export function parseGroupStakeholderCommand(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  let text = raw.trim();
  if (text === "") {
    return false;
  }
  let hadMention = false;
  for (;;) {
    const next = text.replace(/^(?:<@[^>]+>|@\S+)\s+/u, "").trim();
    if (next === text) {
      break;
    }
    hadMention = true;
    text = next;
  }
  if (!hadMention || text === "") {
    return false;
  }
  return text === "干系人";
}

/** 表格单元格：空白 → —；折叠换行，转义反斜杠与竖线，防止破表。 */
function markdownCell(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  if (normalized === "") {
    return "—";
  }
  return normalized.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|");
}

/**
 * 群内干系人 markdown：列名 / 顺序 / 缺省值照系统「干系人」页；默认最近更新在前。
 * 字段级权限同源（canSeeField）：无权或未绑定平台账号时，受保护字段以 — 占位并附说明。
 */
export function renderGroupStakeholdersMarkdown(input: {
  projectName: string;
  rows: readonly GroupStakeholderRow[];
  viewer: GroupStakeholderViewer;
}): string {
  const title = "**" + input.projectName.replace(/\|/gu, "\\|") + " · 干系人**";
  if (input.rows.length === 0) {
    return title + "\n\n该项目暂无干系人。";
  }
  const authorization = input.viewer.kind === "authorized" ? input.viewer.authorization : null;
  const visible = (field: string): boolean =>
    authorization !== null && canSeeField(authorization, "stakeholder", field);
  const lines = [
    title,
    "",
    "| 干系人姓名 | 电话 / WhatsApp | 微信 | 邮箱 Email | 职务 / 责任板块 | 所属公司 | 填写者 | 干系人角色 |",
    "|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|",
  ];
  const limit = Math.min(input.rows.length, GROUP_STAKEHOLDER_MAX_ROWS);
  for (const row of input.rows.slice(0, limit)) {
    const companyType =
      STAKEHOLDER_COMPANY_TYPE_NAMES[row.companyType as keyof typeof STAKEHOLDER_COMPANY_TYPE_NAMES] ??
      row.companyType;
    const companyName = visible("company") ? (row.company ?? "").trim() : "";
    const companyCell = companyName === "" ? companyType : companyType + " / " + companyName;
    lines.push(
      "| " +
        markdownCell(row.name) +
        " | " +
        (visible("phone") ? markdownCell(row.phone) : "—") +
        " | " +
        (visible("wechat") ? markdownCell(row.wechat) : "—") +
        " | " +
        (visible("email") ? markdownCell(row.email) : "—") +
        " | " +
        (visible("title") ? markdownCell(row.title) : "—") +
        " | " +
        markdownCell(companyCell) +
        " | " +
        markdownCell(row.createdByName) +
        " | " +
        markdownCell(row.role) +
        " |",
    );
  }
  const notes: string[] = [];
  if (input.rows.length > limit) {
    notes.push("仅显示最近更新的 " + String(limit) + " 位（共 " + String(input.rows.length) + " 位）。");
  }
  if (input.viewer.kind === "anonymous") {
    notes.push("未识别到你的平台账号，联系方式与商务字段已隐藏；请先在平台「设置 → 企业微信绑定」完成绑定。");
  } else if (input.viewer.kind === "restricted") {
    notes.push("当前企微账号未关联到有权查看本项目的平台账号，联系方式与商务字段已隐藏；请确认平台账号的项目权限。");
  } else if (["phone", "wechat", "email", "title", "company"].some((field) => !visible(field))) {
    notes.push("部分字段因权限不足已隐藏（联系方式需「干系人联系方式查看」，职务 / 公司需「干系人查看」）。");
  }
  const content = lines.join("\n") + (notes.length === 0 ? "" : "\n\n" + notes.join(" "));
  return truncateGroupMarkdown(content).content;
}

/** 回调可选群名归一：trim + 最多 64 个 Unicode 字符；空 → null。 */
function normalizeGroupName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  return Array.from(trimmed).slice(0, GROUP_NAME_MAX_CHARS).join("");
}

/** 降级站内信类型：A02 / R06 / 阶段完成为播报（摘要群发 / 喜报 / 里程碑），其余群播报按提醒。 */
function degradeTypeOf(templateCode: string | null): "broadcast" | "reminder" {
  return templateCode !== null && /^(A02|R06|A08|STAGE_COMPLETE)/.test(templateCode) ? "broadcast" : "reminder";
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
    private readonly archive: NotifyDeliveryArchiveRepository,
    private readonly aibot: WecomAibotClient,
    private readonly notify: NotifyService,
    private readonly clock: ClockService,
    private readonly config: AppConfig,
    private readonly storage: ObjectStorage,
    private readonly deliveryAlerts: ProjectGroupDeliveryAlertService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * 日报查询专用群会话激活（S3）：只做合法群回调过滤、候选群登记与 activated_at 置位，
   * 不解析 / 不执行群名命令。查询编排先调用本方法，再读取群绑定项目与发送人身份。
   */
  async activateFromReportQuery(incoming: AibotIncomingMessage): Promise<void> {
    if (
      incoming.cmd !== "aibot_msg_callback" ||
      incoming.chattype !== "group" ||
      incoming.chatid === null ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(incoming.chatid)
    ) {
      return;
    }
    const at = this.clock.now();
    const row = await this.repository.findGroupByChatid(incoming.chatid);
    if (row === null) {
      await this.repository.observeCandidate(
        { chatid: incoming.chatid, name: normalizeGroupName(incoming.chatName) },
        at,
      );
      this.logger.log("群查询回调已登记候选群：" + maskChatid(incoming.chatid));
      return;
    }
    if (row.activatedAt === null) {
      const activated = await this.repository.activateByChatid(incoming.chatid, at);
      if (activated !== null) {
        this.logger.log("群会话已激活（查询回调）：" + maskChatid(incoming.chatid) + " · project=" + activated.projectId);
      }
    }
  }

  /**
   * 群消息回调 ingest（长连接 onMessage 接线）：只处理群聊消息回调（cmd=aibot_msg_callback / chattype=group /
   * 合法 chatid）。已绑定群 → 会话激活置位（幂等）；未绑定群 → 写入候选表供设置页自动发现，绑定后删除候选行。
   * 群名命令（@机器人 发「群名 XXX」/「群名：XXX」/「设置群名 XXX」）只更新展示名，不做绑定授权；
   * 群内「@机器人 + 干系人」类命令按当前绑定项目返回 markdown 表格（敏感字段按查询者权限裁剪）。
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
    const nameCommand = incoming.msgtype === "text" ? parseGroupNameCommand(incoming.text) : null;
    const stakeholderCommand =
      nameCommand === null && incoming.msgtype === "text" ? parseGroupStakeholderCommand(incoming.text) : false;
    const row = await this.repository.findGroupByChatid(incoming.chatid);
    if (row === null) {
      const name = nameCommand?.kind === "set" ? nameCommand.name : normalizeGroupName(incoming.chatName);
      await this.repository.observeCandidate({ chatid: incoming.chatid, name }, at);
      this.logger.log("群回调已登记候选群：" + maskChatid(incoming.chatid));
      if (nameCommand !== null) {
        await this.replyNameCommand(incoming, nameCommand, false);
      } else if (stakeholderCommand) {
        await this.replyCallbackText(incoming, GROUP_STAKEHOLDER_UNBOUND_HINT, "干系人命令");
      }
      return;
    }
    if (row.activatedAt === null) {
      const activated = await this.repository.activateByChatid(incoming.chatid, at);
      if (activated !== null) {
        this.logger.log("群会话已激活：" + maskChatid(incoming.chatid) + " · project=" + activated.projectId);
      }
    }
    if (nameCommand?.kind === "set") {
      const updated = await this.repository.setGroupName(incoming.chatid, nameCommand.name, at);
      if (updated !== null) {
        this.logger.log("群名已更新：" + maskChatid(incoming.chatid));
      }
    }
    if (nameCommand !== null) {
      await this.replyNameCommand(incoming, nameCommand, true);
    } else if (stakeholderCommand) {
      await this.replyStakeholdersCommand(incoming, row.projectId);
    }
  }

  /** 群名命令回执（被动回复，尽力而为；失败不影响名称落库）。 */
  private async replyNameCommand(
    incoming: AibotIncomingMessage,
    command: GroupNameCommand,
    bound: boolean,
  ): Promise<void> {
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
    await this.replyCallbackText(incoming, content, "群名命令");
  }

  /** 会话内文本回执（被动回复，尽力而为；失败不影响主流程）。 */
  private async replyCallbackText(incoming: AibotIncomingMessage, content: string, label: string): Promise<void> {
    if (incoming.reqId === null || incoming.fromUserId === null || incoming.chatid === null) {
      return;
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
          label + "回执未送达：" + maskChatid(incoming.chatid) + describeWecomFailure(result.errcode, result.errmsg),
        );
      }
    } catch {
      this.logger.warn(label + "回执异常：" + maskChatid(incoming.chatid));
    }
  }

  /** 群内干系人查询：项目名 → 干系人 → 查询者权限 → markdown 表格（主动群消息，确保表格按 markdown 渲染）。 */
  private async replyStakeholdersCommand(incoming: AibotIncomingMessage, projectId: string): Promise<void> {
    if (incoming.chatid === null) {
      return;
    }
    const projectName = await this.repository.findProjectName(projectId);
    if (projectName === null) {
      await this.sendGroupQueryMarkdown(
        incoming.chatid,
        "**干系人**\n\n项目不存在或已归档，无法查询干系人。",
      );
      return;
    }
    let rows: GroupStakeholderRow[];
    try {
      rows = await this.repository.listProjectStakeholders(projectId);
    } catch {
      this.logger.warn("干系人查询读取失败：project=" + projectId + " · " + maskChatid(incoming.chatid));
      await this.sendGroupQueryMarkdown(
        incoming.chatid,
        "**" + projectName + " · 干系人**\n\n干系人信息读取失败，请稍后重试。",
      );
      return;
    }
    const viewer =
      rows.length === 0
        ? ({ kind: "anonymous" } as const)
        : await this.resolveGroupStakeholderViewer(projectId, incoming.fromUserId);
    const content = renderGroupStakeholdersMarkdown({ projectName, rows, viewer });
    await this.sendGroupQueryMarkdown(incoming.chatid, content);
  }

  /**
   * 查询者身份：企微 from.userid 先按当前机器人绑定行映射到库内用户，再校验项目可见性与 stakeholder.view。
   * 未绑定 / 无项目权限不是错误 —— 降级为公共字段表格，敏感字段一律不出现。
   */
  private async resolveGroupStakeholderViewer(
    projectId: string,
    wecomUserid: string | null,
  ): Promise<GroupStakeholderViewer> {
    if (wecomUserid === null) {
      return { kind: "anonymous" };
    }
    const botId = this.config.env.WECOM_BOT_ID;
    if (botId === "") {
      return { kind: "anonymous" };
    }
    try {
      const actorId = await this.repository.findBoundLocalUserId(botId, wecomUserid);
      if (actorId === null) {
        return { kind: "anonymous" };
      }
      const access = await this.permissions.resolveProjectAccess(actorId, projectId);
      if (access === null) {
        return { kind: "restricted" };
      }
      const authorization = await this.permissions.getAuthorization(actorId);
      if (!can(authorization, "stakeholder.view")) {
        return { kind: "restricted" };
      }
      return { kind: "authorized", authorization };
    } catch {
      this.logger.warn("干系人查询权限解析失败：project=" + projectId);
      return { kind: "restricted" };
    }
  }

  /** 群查询 markdown 发送（回调已激活会话；字节截断与失败留痕同群播报口径）。 */
  private async sendGroupQueryMarkdown(chatid: string, content: string): Promise<void> {
    const safe = truncateGroupMarkdown(content);
    if (safe.truncated) {
      this.logger.warn("干系人查询内容超字节上限已截断：" + maskChatid(chatid));
    }
    try {
      const result = await this.aibot.sendGroupMarkdown({
        chatid,
        content: safe.content,
        groupActivated: true,
      });
      if (!result.ok) {
        this.logger.warn(
          "干系人查询回执未送达：" + maskChatid(chatid) + describeWecomFailure(result.errcode, result.errmsg),
        );
      }
    } catch {
      this.logger.warn("干系人查询回执异常：" + maskChatid(chatid));
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
    let archived: NotifyDeliveryMessageRow;
    try {
      archived = await this.archive.ensureMessage({
        outboxId: row.id,
        sourceDedupeKey: row.dedupeKey,
        topic: row.topic as NotifyDeliveryTopic,
        channel: "wecom_group",
        recipientId: null,
        recipientLabel: "project:" + message.projectId,
        title: message.title,
        body: message.body,
        templateCode: message.templateCode ?? null,
        ruleCode: inferNotifyRuleCode(row.dedupeKey),
        refType: message.refType ?? null,
        refId: message.refId ?? null,
        payload: { ...message },
        metadata: {},
      });
    } catch (archiveError) {
      const detail = archiveError instanceof Error ? archiveError.message : String(archiveError);
      this.logger.error("群播报归档失败（不发送，交 outbox 重试）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: "群播报归档失败：" + detail };
    }
    if (archived.lastState === "sent") {
      this.logger.log("群播报已发送归档，重复消费幂等跳过：" + row.dedupeKey);
      return { outcome: "done" };
    }
    const terminalDead = archived.lastState === "dead";
    const binding = await this.repository.findGroupByProject(message.projectId);
    if (binding === null) {
      // 无绑定：notify_deliveries.target NOT NULL 无值可落 —— 不写尝试行，消息级归档置 dead + 日志（差异登记②）；
      // 专用即时告警按项目 + 原因去重；通用 outbox.dead 仅进日报，避免同一故障双报。
      // 降级（B4）= 项目经理站内信（正文含原文）。
      const error = "群未绑定（project " + message.projectId + "）：" + row.dedupeKey;
      if (!terminalDead) {
        await this.archive.markState({ messageId: archived.id, state: "dead", at: this.clock.now(), error });
      }
      const projectName = (await this.repository.findProjectName(message.projectId)) ?? "项目名称未登记";
      this.deliveryAlerts.reportUnavailable(message.projectId, projectName, "unbound");
      this.logger.warn(
        "群未绑定（确定性失败转 dead）：outbox#" + row.id + " · project=" + message.projectId + " · " + row.dedupeKey,
      );
      return await this.deadWithDegrade(row, message, terminalDead ? (archived.lastError ?? error) : error, "digest");
    }
    const masked = maskChatid(binding.chatid);
    // 停用是历史兼容态：保留既有 dead + 降级路径，但不并入「项目群不可投递」专用告警。
    if (!binding.enabled) {
      const error = "群绑定已停用（chatid " + masked + "）";
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_group",
          target: binding.chatid,
          recipientLabel: "project:" + message.projectId + " · " + masked,
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      this.logger.warn("群绑定已停用（确定性失败转 dead）：outbox#" + row.id + " · chatid " + masked);
      return await this.deadWithDegrade(
        row,
        message,
        terminalDead ? (archived.lastError ?? error) : error + "：" + row.dedupeKey,
      );
    }
    const deliverability = projectGroupDeliverability({
      bound: true,
      activated: binding.activatedAt !== null,
    });
    if (!deliverability.deliverable) {
      const error = "已绑定，但机器人尚未激活（chatid " + masked + "）";
      if (!terminalDead) {
        await this.archive.recordAttempt({
          messageId: archived.id,
          outboxId: row.id,
          channel: "wecom_group",
          target: binding.chatid,
          recipientLabel: "project:" + message.projectId + " · " + masked,
          state: "dead",
          attempts: 0,
          error,
          sentAt: null,
          at: this.clock.now(),
        });
      }
      const projectName = (await this.repository.findProjectName(message.projectId)) ?? "项目名称未登记";
      this.deliveryAlerts.reportUnavailable(message.projectId, projectName, "not_activated");
      this.logger.warn("项目群已绑定但机器人未激活（确定性失败转 dead）：outbox#" + row.id + " · chatid " + masked);
      return await this.deadWithDegrade(
        row,
        message,
        terminalDead ? (archived.lastError ?? error) : error + "：" + row.dedupeKey,
        "digest",
      );
    }
    if (terminalDead) {
      const error = archived.lastError ?? "群播报已终态失败：" + row.dedupeKey;
      this.logger.warn("群播报已归档为 dead，重复消费不再外发、仅重试降级：" + row.dedupeKey);
      return await this.deadWithDegrade(row, message, error);
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
      const rocketAttempts = await this.sendR06Rockets({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      const posterAttempts = await this.sendR06Poster({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      const dailyReportPosterAttempts = await this.sendDailyReportPoster({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      const stagePosterAttempts = await this.sendStageCompletePoster({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      const materialReissuePosterAttempts = await this.sendMaterialReissuePoster({
        message,
        chatid: binding.chatid,
        groupActivated: binding.activatedAt !== null,
        masked,
        dedupeKey: row.dedupeKey,
      });
      const sentAt = this.clock.now();
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_group",
        target: binding.chatid,
        recipientLabel: "project:" + message.projectId + " · " + masked,
        state: "sent",
        attempts: result.attempts + rocketAttempts + posterAttempts + dailyReportPosterAttempts + stagePosterAttempts + materialReissuePosterAttempts,
        error: null,
        sentAt,
        at: sentAt,
      });
      this.logger.log("群播报已受理：" + row.dedupeKey + " · chatid " + masked + (truncated ? "（截断发送）" : ""));
      this.deliveryAlerts.reportAvailable(message.projectId);
      return { outcome: "done" };
    }

    const error = describeAibotFailure(result);
    if (result.kind === "rate_limited") {
      const availableAt = result.retryAt ?? new Date(this.clock.now().getTime() + 60_000);
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_group",
        target: binding.chatid,
        recipientLabel: "project:" + message.projectId + " · " + masked,
        state: "deferred",
        attempts: result.attempts,
        error,
        sentAt: null,
        at: this.clock.now(),
      });
      return { outcome: "deferred", availableAt, error: error };
    }
    if (result.kind === "retryable") {
      await this.archive.recordAttempt({
        messageId: archived.id,
        outboxId: row.id,
        channel: "wecom_group",
        target: binding.chatid,
        recipientLabel: "project:" + message.projectId + " · " + masked,
        state: "failed",
        attempts: result.attempts,
        error,
        sentAt: null,
        at: this.clock.now(),
      });
      return { outcome: "retry", error };
    }
    // permanent（含 846607 未激活分支）：不重试；降级 B4（项目经理站内信 + 管理员告警群留痕）。
    await this.archive.recordAttempt({
      messageId: archived.id,
      outboxId: row.id,
      channel: "wecom_group",
      target: binding.chatid,
      recipientLabel: "project:" + message.projectId + " · " + masked,
      state: "dead",
      attempts: result.attempts,
      error,
      sentAt: null,
      at: this.clock.now(),
    });
    this.logger.warn("群播报确定性失败（转 dead）：" + row.dedupeKey + " · chatid " + masked + " —— " + error);
    return await this.deadWithDegrade(row, message, error);
  }

  /**
   * 日报群同步：文字「日报已送达」及其项目日报纯文字深链送达后，依次追加日报海报与现场问题专报（有问题时）。
   * 两张图均为 1440px 宽、按内容动态增高；正文与图片不省略，任一图片失败只留日志，不重发文字。
   */
  private async sendDailyReportPoster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    const reportId = input.message.refId;
    if (input.message.templateCode !== "DAILY_REPORT_GROUP" || reportId === null || reportId === undefined) {
      return 0;
    }
    let data: Awaited<ReturnType<NotifyGroupRepository["findDailyReportPosterData"]>>;
    try {
      data = await this.repository.findDailyReportPosterData(input.message.projectId, reportId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("日报海报数据读取失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    if (data === null) {
      this.logger.warn("日报海报数据不存在，已跳过图片（文字已发送）：" + input.dedupeKey);
      return 0;
    }
    if (data.state === "draft") {
      this.logger.warn("草稿日报不生成群海报，已跳过图片（文字已发送）：" + input.dedupeKey);
      return 0;
    }

    // 终稿口径：现场图与问题图全部进入海报；同一 objectKey 只读取一次，单张坏图仅影响自身片位。
    const photos = [...data.photos, ...data.issues.flatMap((issue) => issue.photos)];
    const objectKeys = [
      ...new Set(photos.map((photo) => photo.objectKey).filter((key): key is string => key !== null)),
    ];
    const objectBytes = new Map<string, Buffer>();
    await Promise.all(
      objectKeys.map(async (objectKey) => {
        try {
          const object = await this.storage.getObject(objectKey);
          if (object !== null) {
            objectBytes.set(objectKey, Buffer.from(object.bytes));
          }
        } catch {
          // 单张附件读取失败只影响该片位；海报其余文字 / 图片继续生成。
        }
      }),
    );
    const images = new Map<string, Buffer>();
    for (const photo of photos) {
      const bytes = photo.objectKey === null ? undefined : objectBytes.get(photo.objectKey);
      if (bytes !== undefined) {
        images.set(photo.fileId, bytes);
      }
    }

    let attempts = 0;
    const projectCode = data.projectCode.replace(/[^A-Za-z0-9._-]+/gu, "-");
    const sendPoster = async (
      label: string,
      fileName: string,
      render: () => Promise<Buffer>,
    ): Promise<void> => {
      let content: Buffer;
      try {
        content = await render();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(label + "生成失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
        return;
      }
      const result = await this.aibot.sendGroupImage({
        chatid: input.chatid,
        content,
        fileName,
        mime: "image/png",
        groupActivated: input.groupActivated,
      });
      attempts += result.attempts;
      if (!result.ok) {
        this.logger.warn(
          label +
            "未送达（文字已发送）：" +
            input.dedupeKey +
            " · chatid " +
            input.masked +
            " —— " +
            describeAibotFailure(result),
        );
        return;
      }
      this.logger.log(label + "已送达：" + input.dedupeKey + " · chatid " + input.masked);
    };

    await sendPoster(
      "日报海报",
      "DAILY-" + data.reportDate + "-" + projectCode + ".png",
      () => renderDailyReportPoster(data, images),
    );
    if (data.issues.length > 0) {
      await sendPoster(
        "现场问题专报",
        "ISSUE-" + data.reportDate + "-" + projectCode + ".png",
        () => renderDailyReportIssuePoster(data, images),
      );
    }
    return attempts;
  }

  /**
   * 大阶段完成海报：文字通知送达后追加 1280×720 PNG。
   * 只认 STAGE_COMPLETE_GROUP + stageKey；数据读取 / 绘制 / 发送任一失败只留日志，不重发已送达文字。
   */
  private async sendStageCompletePoster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    if (input.message.templateCode !== "STAGE_COMPLETE_GROUP" || input.message.stageKey === null || input.message.stageKey === undefined) {
      return 0;
    }
    let data: Awaited<ReturnType<NotifyGroupRepository["findStageCompletePosterData"]>>;
    try {
      data = await this.repository.findStageCompletePosterData(
        input.message.projectId,
        input.message.stageKey,
        this.clock.now(),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("阶段完成海报数据读取失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    if (data === null) {
      this.logger.warn("阶段完成海报数据不存在，已跳过图片（文字已发送）：" + input.dedupeKey);
      return 0;
    }

    let content: Buffer;
    try {
      content = await renderStageCompletePoster(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("阶段完成海报生成失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    const projectCode = data.projectCode.replace(/[^A-Za-z0-9._-]+/gu, "-");
    const result = await this.aibot.sendGroupImage({
      chatid: input.chatid,
      content,
      fileName: "STAGE-" + projectCode + "-" + data.stageKey + ".png",
      mime: "image/png",
      groupActivated: input.groupActivated,
    });
    if (!result.ok) {
      this.logger.warn(
        "阶段完成海报未送达（文字已发送）：" +
          input.dedupeKey +
          " · chatid " +
          input.masked +
          " —— " +
          describeAibotFailure(result),
      );
      return result.attempts;
    }
    this.logger.log("阶段完成海报已送达：" + input.dedupeKey + " · chatid " + input.masked);
    return result.attempts;
  }

  /**
   * 物料变更补发图片：文字送达后按变更快照生成整张补发/补货申请表 PNG。
   * 只认 MATERIAL_REISSUE_GROUP + refId（change_requests.id）；数据读取 / 绘制 / 发送失败只留日志，
   * 不重发已送达文字，也不回滚补发提交（业务提交与 group 通知由 outbox 解耦）。
   */
  private async sendMaterialReissuePoster(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    const changeId = input.message.refId;
    if (input.message.templateCode !== "MATERIAL_REISSUE_GROUP" || changeId === null || changeId === undefined) {
      return 0;
    }
    let data: Awaited<ReturnType<NotifyGroupRepository["findMaterialReissuePosterData"]>>;
    try {
      data = await this.repository.findMaterialReissuePosterData(input.message.projectId, changeId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("补发申请图片数据读取失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    if (data === null) {
      this.logger.warn("补发申请图片数据不存在，已跳过图片（文字已发送）：" + input.dedupeKey);
      return 0;
    }
    let content: Buffer;
    try {
      content = await renderMaterialReissuePoster(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("补发申请图片生成失败，已跳过图片（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    const projectCode = data.snapshot.projectCode.replace(/[^A-Za-z0-9._-]+/gu, "-");
    const result = await this.aibot.sendGroupImage({
      chatid: input.chatid,
      content,
      fileName: "MATERIAL-" + projectCode + "-" + changeId.slice(0, 8) + ".png",
      mime: "image/png",
      groupActivated: input.groupActivated,
    });
    if (!result.ok) {
      this.logger.warn(
        "补发申请图片未送达（文字已发送）：" +
          input.dedupeKey +
          " · chatid " +
          input.masked +
          " —— " +
          describeAibotFailure(result),
      );
      return result.attempts;
    }
    this.logger.log("补发申请图片已送达：" + input.dedupeKey + " · chatid " + input.masked);
    return result.attempts;
  }

  /**
   * R06 火箭前缀：项目已完成且全部任务完成、全部按期时，依次发 240×288 → 640×768；
   * 其余情况改发 200×200 兜底火箭。火箭属增强项：单张失败只留日志，继续尝试后续图片与喜报海报。
   */
  private async sendR06Rockets(input: {
    message: NotifyGroupMessagePayload;
    chatid: string;
    groupActivated: boolean;
    masked: string;
    dedupeKey: string;
  }): Promise<number> {
    if (input.message.templateCode !== "R06_GROUP") {
      return 0;
    }
    const onTimeCandidates = [
      {
        path: (this.config.env.WECOM_R06_ROCKET_240_IMAGE_PATH ?? "").trim(),
        label: "火箭 GIF（240×288）",
      },
      {
        path: (this.config.env.WECOM_R06_ROCKET_640_IMAGE_PATH ?? "").trim(),
        label: "火箭 GIF（640×768）",
      },
    ];
    const fallbackPath = (this.config.env.WECOM_R06_ROCKET_FALLBACK_IMAGE_PATH ?? "").trim();
    if (onTimeCandidates.every((item) => item.path === "") && fallbackPath === "") {
      return 0;
    }
    let eligible: boolean;
    try {
      eligible = await this.repository.isProjectCompletedWithAllTasksOnTime(
        input.message.projectId,
        this.clock.now(),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("R06 火箭发送条件读取失败，已跳过（文字已发送）：" + input.dedupeKey + " —— " + detail);
      return 0;
    }
    if (!eligible) {
      if (fallbackPath === "") {
        return 0;
      }
      return await this.sendConfiguredR06Image(input, fallbackPath, "兜底火箭 GIF（200×200）");
    }
    let attempts = 0;
    for (const item of onTimeCandidates) {
      if (item.path === "") {
        continue;
      }
      attempts += await this.sendConfiguredR06Image(input, item.path, item.label);
    }
    return attempts;
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
      content = await renderR06Poster(
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

  /** 配置图读取 + 单次发送；格式 / 读取失败 = 0（不抛错）。 */
  private async sendConfiguredR06Image(
    input: {
      chatid: string;
      groupActivated: boolean;
      masked: string;
      dedupeKey: string;
    },
    configured: string,
    sourceLabel: string,
  ): Promise<number> {
    const fileName = basename(configured);
    const mime = aibotImageMimeFromFileName(fileName);
    if (mime === null) {
      this.logger.warn("R06 " + sourceLabel + "格式不支持（仅 PNG / JPG / GIF），已跳过：" + fileName);
      return 0;
    }
    let content: Buffer;
    try {
      content = await readFile(resolve(configured));
    } catch {
      this.logger.warn("R06 " + sourceLabel + "读取失败，已跳过（文字已发送）：" + fileName);
      return 0;
    }
    return await this.deliverR06Image(input, content, fileName, mime, sourceLabel);
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
    return await this.sendConfiguredR06Image(input, configured, "静态回退图");
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
    deadAlert: "immediate" | "digest" = "immediate",
  ): Promise<OutboxHandleOutcome> {
    const managerId = await this.repository.findProjectManagerId(message.projectId);
    if (managerId === null) {
      this.logger.warn("群失败降级：项目经理解析不到（跳过站内信）：" + row.dedupeKey + " · project=" + message.projectId);
      return deadAlert === "digest" ? { outcome: "dead", error, deadAlert } : { outcome: "dead", error };
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
      return deadAlert === "digest" ? { outcome: "dead", error, deadAlert } : { outcome: "dead", error };
    } catch (degradeError) {
      const detail = degradeError instanceof Error ? degradeError.message : String(degradeError);
      this.logger.error("群失败降级站内信失败（按可重试收敛）：" + row.dedupeKey + " —— " + detail);
      return { outcome: "retry", error: error + " / 降级站内信失败：" + detail };
    }
  }
}
