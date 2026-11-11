import { Injectable, Logger } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import {
  applyMarkdownHardBreaks,
  DM_MARKDOWN_MAX_BYTES,
  DM_TRUNCATION_SUFFIX,
  GROUP_MARKDOWN_MAX_BYTES,
  GROUP_TRUNCATION_SUFFIX,
  maskChatid,
  maskUserid,
  DailyReportPosterDeliveryService,
  NotifyDmService,
  NotifyGroupService,
  truncateUtf8Bytes,
  WecomAibotClient,
  type AibotIncomingMessage,
  type AibotSendResult,
} from "../notify/index.js";
import { PermissionService } from "../permission/index.js";
import { ProjectGroupService, ProjectQueryService } from "../project/index.js";
import { ReportDigestService } from "../report-issue/index.js";
import { isReportQueryText, parseReportQuery } from "./report-query.parser.js";
import { toReportQueryPosterData } from "./report-query.poster.js";
import {
  buildAmbiguousProjectMessage,
  buildReportQueryText,
  REPORT_QUERY_DM_UNBOUND,
  REPORT_QUERY_GROUP_NOT_BOUND,
  REPORT_QUERY_GROUP_PROJECT_ONLY,
  REPORT_QUERY_HELP,
  REPORT_QUERY_ISSUE_UNAVAILABLE,
  REPORT_QUERY_PROJECT_UNAVAILABLE,
  REPORT_QUERY_UNAVAILABLE,
} from "./report-query.text.js";
import type { ReportQueryCommand } from "./report-query.types.js";

/** 查询级限流：同一发送人单聊 / 同一项目群 5 秒最多处理 1 次。 */
export const REPORT_QUERY_RATE_WINDOW_MS = 5_000;
/** 回调幂等：bot_id + msgid，10 分钟。 */
export const REPORT_QUERY_DEDUPE_TTL_MS = 10 * 60_000;
export const REPORT_QUERY_DEDUPE_CAPACITY = 1_000;
/** 限速键内存上限；过期键每轮清理，超出时淘汰最早项。 */
export const REPORT_QUERY_RATE_CAPACITY = 5_000;

const GROUP_CHATID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

interface ReplyState {
  replied: boolean;
}

/**
 * 企微智能机器人日报查询编排：命令路由、日期 / 项目解析、发送人身份、权限、
 * 同一快照文字回复与单篇海报、查询级限流与回调幂等。
 *
 * 本服务不写审计 / outbox / 站内信 / 群播报；问题内容仅在 issue.view 通过后输出。
 * 查询候选必须由 worker 在绑定码 / 群名命令之前分流到本服务。
 */
@Injectable()
export class ReportQueryService {
  private readonly logger = new Logger(ReportQueryService.name);
  private readonly processedCallbacks = new Map<string, number>();
  private readonly senderLastAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: ClockService,
    private readonly permissions: PermissionService,
    private readonly projects: ProjectQueryService,
    private readonly projectGroups: ProjectGroupService,
    private readonly digest: ReportDigestService,
    private readonly posterDelivery: DailyReportPosterDeliveryService,
    private readonly dmNotify: NotifyDmService,
    private readonly groupNotify: NotifyGroupService,
    private readonly aibot: WecomAibotClient,
  ) {}

  /** 查询候选：功能开关精确比较字符串 "true"；语法是否完整由 handle 回复帮助。 */
  accepts(incoming: AibotIncomingMessage): boolean {
    if (
      incoming.cmd !== "aibot_msg_callback" ||
      incoming.msgtype !== "text" ||
      incoming.text === null ||
      incoming.fromUserId === null ||
      !isReportQueryText(incoming.text)
    ) {
      return false;
    }
    if (incoming.chattype === "single") {
      return this.config.env.WECOM_REPORT_QUERY_DM_ENABLED === "true";
    }
    if (incoming.chattype === "group") {
      return (
        this.config.env.WECOM_REPORT_QUERY_GROUP_ENABLED === "true" &&
        incoming.chatid !== null &&
        GROUP_CHATID_PATTERN.test(incoming.chatid)
      );
    }
    return false;
  }

  async handle(incoming: AibotIncomingMessage): Promise<void> {
    if (!this.accepts(incoming)) return;
    const isGroup = incoming.chattype === "group";
    const fromUserId = incoming.fromUserId;
    const text = incoming.text;
    const chatid = incoming.chatid;
    if (fromUserId === null || text === null) return;
    if (isGroup && chatid === null) return;

    const replyState: ReplyState = { replied: false };
    try {
      if (isGroup) {
        await this.groupNotify.activateFromReportQuery(incoming);
      } else {
        const activated = await this.dmNotify.activateFromReportQuery(incoming);
        if (!activated) return;
      }

      if (!this.claimCallback(incoming)) return;
      if (!this.claimRateSlot(isGroup ? "group:" + chatid : "dm:" + fromUserId)) return;

      const parsed = parseReportQuery(text, { today: this.clock.today(), requireProject: !isGroup });
      if (!parsed.ok) {
        await this.respond(incoming, REPORT_QUERY_HELP, replyState);
        return;
      }

      if (isGroup) {
        await this.executeGroup(incoming, fromUserId, chatid!, parsed.command, replyState);
      } else {
        await this.executeDm(incoming, fromUserId, parsed.command, replyState);
      }
    } catch (error) {
      this.logger.error("日报查询处理失败：" + messageOf(error));
      if (!replyState.replied) {
        try {
          await this.respond(incoming, REPORT_QUERY_UNAVAILABLE, replyState);
        } catch (replyError) {
          this.logger.warn("日报查询失败兜底回复未送达：" + messageOf(replyError));
        }
      }
    }
  }

  private async executeGroup(
    incoming: AibotIncomingMessage,
    fromUserId: string,
    chatid: string,
    command: ReportQueryCommand,
    replyState: ReplyState,
  ): Promise<void> {
    const projectId = await this.projectGroups.projectIdByChatid(chatid);
    if (projectId === null) {
      await this.respond(incoming, REPORT_QUERY_GROUP_NOT_BOUND, replyState);
      return;
    }

    const actorId = await this.dmNotify.resolveReportQueryActor(fromUserId);
    if (actorId === null) {
      await this.respond(incoming, REPORT_QUERY_DM_UNBOUND, replyState);
      return;
    }

    if (
      command.projectReference !== null &&
      !(await this.projects.matchesBoundProject(projectId, command.projectReference))
    ) {
      await this.respond(incoming, REPORT_QUERY_GROUP_PROJECT_ONLY, replyState);
      return;
    }

    await this.deliver(incoming, actorId, projectId, command, replyState);
  }

  private async executeDm(
    incoming: AibotIncomingMessage,
    fromUserId: string,
    command: ReportQueryCommand,
    replyState: ReplyState,
  ): Promise<void> {
    const actorId = await this.dmNotify.resolveReportQueryActor(fromUserId);
    if (actorId === null) {
      await this.respond(incoming, REPORT_QUERY_DM_UNBOUND, replyState);
      return;
    }

    const reference = command.projectReference;
    if (reference === null) {
      await this.respond(incoming, REPORT_QUERY_HELP, replyState);
      return;
    }
    const lookup = await this.projects.lookup(actorId, reference);
    if (lookup.status === "ambiguous") {
      await this.respond(incoming, buildAmbiguousProjectMessage(reference, lookup.candidates), replyState);
      return;
    }
    if (lookup.status === "not_found") {
      await this.respond(incoming, REPORT_QUERY_PROJECT_UNAVAILABLE, replyState);
      return;
    }
    await this.deliver(incoming, actorId, lookup.project.id, command, replyState);
  }

  private async deliver(
    incoming: AibotIncomingMessage,
    actorId: string,
    projectId: string,
    command: ReportQueryCommand,
    replyState: ReplyState,
  ): Promise<void> {
    const access = await this.permissions.resolveProjectAccess(actorId, projectId);
    if (access === null || !(await this.permissions.can(actorId, "report.view", access))) {
      await this.respond(incoming, REPORT_QUERY_PROJECT_UNAVAILABLE, replyState);
      return;
    }

    const canViewIssues =
      command.topic === "reports" ? false : await this.permissions.can(actorId, "issue.view", access);
    if (command.topic === "issues" && !canViewIssues) {
      await this.respond(incoming, REPORT_QUERY_ISSUE_UNAVAILABLE, replyState);
      return;
    }

    const snapshot = await this.digest.getSnapshot(projectId, command.date);
    const maxBytes = incoming.chattype === "group" ? GROUP_MARKDOWN_MAX_BYTES : DM_MARKDOWN_MAX_BYTES;
    const content = buildReportQueryText({
      ...snapshot,
      topic: command.topic,
      canViewIssues,
      publicBaseUrl: this.config.env.PUBLIC_APP_BASE_URL,
      maxBytes,
    });
    await this.respond(incoming, content, replyState);

    if (!replyState.replied) return;
    const poster = toReportQueryPosterData(snapshot, {
      includeIssues: command.topic !== "reports" && canViewIssues,
    });
    if (poster === null) return;
    const sendDaily =
      command.topic !== "issues" &&
      (poster.kind === "single" || poster.data.reports.length >= 2);
    const sendIssues = command.topic !== "reports" && poster.data.issues.length > 0;
    if (!sendDaily && !sendIssues) return;

    const trace = incoming.msgid ?? "report-query";
    const fromUserId = incoming.fromUserId;
    const target =
      incoming.chattype === "group"
        ? incoming.chatid === null
          ? null
          : { chattype: "group" as const, chatid: incoming.chatid, groupActivated: true }
        : fromUserId === null
          ? null
          : { chattype: "single" as const, userid: fromUserId, dmActivated: true };
    if (target === null) return;

    try {
      await this.posterDelivery.send({
        ...poster,
        target,
        sendDaily,
        sendIssues,
        trace,
      });
    } catch (error) {
      this.logger.warn("日报查询海报发送异常，已保留文字回复：" + trace + " · " + errorName(error));
    }
  }

  /**
   * 文字发送：优先透传回调 req_id 被动回复；仅本地未就绪 / 本地限速且未发帧时降级为主动 markdown。
   * 已发帧或回执超时的失败不重发，避免重复消息。
   */
  private async respond(incoming: AibotIncomingMessage, content: string, replyState: ReplyState): Promise<void> {
    const isGroup = incoming.chattype === "group";
    const maxBytes = isGroup ? GROUP_MARKDOWN_MAX_BYTES : DM_MARKDOWN_MAX_BYTES;
    const suffix = isGroup ? GROUP_TRUNCATION_SUFFIX : DM_TRUNCATION_SUFFIX;
    const normalized = truncateUtf8Bytes(applyMarkdownHardBreaks(content), maxBytes, suffix).content;
    const fromUserId = incoming.fromUserId;
    if (fromUserId === null) return;

    if (incoming.reqId !== null) {
      let passive: AibotSendResult | null = null;
      try {
        passive = await this.aibot.replyToCallback({
          reqId: incoming.reqId,
          userid: fromUserId,
          chatid: isGroup ? incoming.chatid : null,
          content: normalized,
        });
      } catch (error) {
        this.logger.warn("日报查询被动回复异常，尝试主动发送：" + messageOf(error));
      }
      if (passive?.ok === true) {
        replyState.replied = true;
        return;
      }
      if (
        passive !== null &&
        !(passive.attempts === 0 && (passive.kind === "retryable" || passive.kind === "rate_limited"))
      ) {
        this.logger.warn(
          "日报查询被动回复未送达（不重发）：" +
            (isGroup ? "chatid " + maskChatid(incoming.chatid ?? "") : "userid " + maskUserid(fromUserId)) +
            " · kind=" +
            passive.kind +
            " · errcode=" +
            String(passive.errcode ?? "null"),
        );
        return;
      }
    }

    const active = isGroup
      ? incoming.chatid === null
        ? null
        : await this.aibot.sendGroupMarkdown({
            chatid: incoming.chatid,
            content: normalized,
            groupActivated: true,
          })
      : await this.aibot.sendUserMarkdown({ userid: fromUserId, content: normalized, dmActivated: true });
    if (active?.ok === true) {
      replyState.replied = true;
      return;
    }
    this.logger.warn(
      "日报查询主动回复未送达：" +
        (isGroup ? "chatid " + maskChatid(incoming.chatid ?? "") : "userid " + maskUserid(fromUserId)) +
        " · kind=" +
        (active?.kind ?? "no_target") +
        " · errcode=" +
        String(active?.errcode ?? "null"),
    );
  }

  /** bot_id + msgid 去重；无 msgid 的回调不参与内存幂等。 */
  private claimCallback(incoming: AibotIncomingMessage): boolean {
    const msgid = incoming.msgid?.trim() ?? "";
    if (msgid === "") return true;
    const now = this.clock.now().getTime();
    const key = this.config.env.WECOM_BOT_ID + "\u0000" + msgid;

    for (const [entry, at] of this.processedCallbacks) {
      if (now - at < REPORT_QUERY_DEDUPE_TTL_MS) break;
      this.processedCallbacks.delete(entry);
    }
    if (this.processedCallbacks.has(key)) return false;
    while (this.processedCallbacks.size >= REPORT_QUERY_DEDUPE_CAPACITY) {
      const oldest = this.processedCallbacks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.processedCallbacks.delete(oldest);
    }
    this.processedCallbacks.set(key, now);
    return true;
  }

  /** 同一发送人 / 群 5 秒窗口；键带 bot_id，避免多机器人串桶。 */
  private claimRateSlot(scope: string): boolean {
    const now = this.clock.now().getTime();
    for (const [key, at] of this.senderLastAt) {
      if (now - at >= REPORT_QUERY_RATE_WINDOW_MS) this.senderLastAt.delete(key);
    }
    const key = this.config.env.WECOM_BOT_ID + "\u0000" + scope;
    const last = this.senderLastAt.get(key);
    if (last !== undefined && now - last < REPORT_QUERY_RATE_WINDOW_MS) return false;
    while (this.senderLastAt.size >= REPORT_QUERY_RATE_CAPACITY) {
      const oldest = this.senderLastAt.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.senderLastAt.delete(oldest);
    }
    this.senderLastAt.set(key, now);
    return true;
  }
}
