import { Injectable, Logger } from "@nestjs/common";
import { ClockService } from "../../common/clock/clock.service.js";
import { AppConfig } from "../../config/config.module.js";
import { describeWecomFailure } from "./wecom.errors.js";
import { WecomAibotClient } from "./wecom.aibot.js";

/** 项目群不可投递原因：未绑定 / 已绑定但机器人尚未激活。 */
export type ProjectGroupUnavailableReason = "unbound" | "not_activated";

/** 项目群可投递判定（纯函数）：绑定存在 + 已激活 = 可投递；停用仍按既有路径处理，不并入本告警。 */
export type ProjectGroupDeliverability =
  | { deliverable: true }
  | { deliverable: false; reason: ProjectGroupUnavailableReason };

export interface ProjectGroupDeliveryBinding {
  bound: boolean;
  activated: boolean;
}

export function projectGroupDeliverability(binding: ProjectGroupDeliveryBinding | null): ProjectGroupDeliverability {
  if (binding === null || !binding.bound) {
    return { deliverable: false, reason: "unbound" };
  }
  if (!binding.activated) {
    return { deliverable: false, reason: "not_activated" };
  }
  return { deliverable: true };
}

/** 项目群设置读面 → 统一可投递判定。 */
export function projectGroupBindingDeliverability(binding: {
  bound: boolean;
  activated: boolean;
}): ProjectGroupDeliverability {
  return projectGroupDeliverability({
    bound: binding.bound,
    activated: binding.activated,
  });
}

export function projectGroupUnavailableReasonText(reason: ProjectGroupUnavailableReason): string {
  return reason === "unbound" ? "项目群未绑定" : "已绑定，但机器人尚未激活";
}

export function projectGroupUnavailableAction(reason: ProjectGroupUnavailableReason): string {
  return reason === "unbound"
    ? "请在项目设置中完成项目群绑定"
    : "请在项目群内 @LibiaoLink 发送一条消息完成激活";
}

/** 管理员告警正文：只展示项目名与可执行处置，不暴露项目 UUID / chatid / outbox 行号。 */
export function composeProjectGroupUnavailableAlert(
  projectName: string,
  reason: ProjectGroupUnavailableReason,
): string {
  const name = projectName.trim() === "" ? "项目名称未登记" : projectName.trim();
  return (
    "【LibiaoLink 告警】\n" +
    "项目群不可投递：" +
    name +
    "\n原因：" +
    projectGroupUnavailableReasonText(reason) +
    "\n影响：项目日报、任务提醒无法发送到项目群" +
    "\n处置：" +
    projectGroupUnavailableAction(reason)
  );
}

export interface ProjectGroupDeliveryAlertPort {
  reportUnavailable(projectId: string, projectName: string, reason: ProjectGroupUnavailableReason): void;
  reportAvailable(projectId: string): void;
}

export interface ProjectGroupDeliveryRecovery {
  code: "notify.project_group.recovered";
  message: string;
  at: string;
}

interface UnavailableState {
  reason: ProjectGroupUnavailableReason;
  projectName: string;
  alertedAt: Date;
}

/**
 * 项目群不可投递告警（worker 侧）：
 * - 同一项目同一原因只即时发送一次；原因变化时再发一次；
 * - 恢复不即时发送，转入下一次 outbox 日报；
 * - 告警发送失败只写结构化日志，不影响原消息的 dead / 降级处理。
 *
 * 状态为 worker 进程内建；重启后若同一故障仍有投递，会重新发送一次。与现有 outbox 告警门禁同口径。
 */
@Injectable()
export class ProjectGroupDeliveryAlertService implements ProjectGroupDeliveryAlertPort {
  private readonly logger = new Logger(ProjectGroupDeliveryAlertService.name);
  private readonly unavailable = new Map<string, UnavailableState>();
  private readonly recoveries: ProjectGroupDeliveryRecovery[] = [];

  constructor(
    private readonly aibot: WecomAibotClient,
    private readonly config: AppConfig,
    private readonly clock: ClockService,
  ) {}

  reportUnavailable(projectId: string, projectName: string, reason: ProjectGroupUnavailableReason): void {
    const normalizedName = projectName.trim() === "" ? "项目名称未登记" : projectName.trim();
    const previous = this.unavailable.get(projectId);
    if (previous !== undefined && previous.reason === reason) {
      if (previous.projectName !== normalizedName) {
        previous.projectName = normalizedName;
      }
      this.logger.debug(
        JSON.stringify({
          event: "notify.project_group.unavailable_deduped",
          projectId,
          reason,
        }),
      );
      return;
    }
    const at = this.clock.now();
    this.unavailable.set(projectId, { reason, projectName: normalizedName, alertedAt: at });
    this.logger.warn(
      JSON.stringify({
        event: "notify.project_group.unavailable",
        projectId,
        projectName: normalizedName,
        reason,
        reasonChanged: previous !== undefined,
        at: at.toISOString(),
      }),
    );
    void this.send(projectId, normalizedName, reason);
  }

  reportAvailable(projectId: string): void {
    const previous = this.unavailable.get(projectId);
    if (previous === undefined) {
      return;
    }
    this.unavailable.delete(projectId);
    const at = this.clock.now();
    this.recoveries.push({
      code: "notify.project_group.recovered",
      message:
        "项目群恢复可投递：" +
        previous.projectName +
        "（原因为" +
        projectGroupUnavailableReasonText(previous.reason) +
        "）",
      at: at.toISOString(),
    });
    this.logger.log(
      JSON.stringify({
        event: "notify.project_group.recovered",
        projectId,
        projectName: previous.projectName,
        reason: previous.reason,
        at: at.toISOString(),
      }),
    );
  }

  drainRecoveries(): ProjectGroupDeliveryRecovery[] {
    const result = [...this.recoveries];
    this.recoveries.length = 0;
    return result;
  }

  private async send(projectId: string, projectName: string, reason: ProjectGroupUnavailableReason): Promise<void> {
    const chatid = this.config.env.OUTBOX_ALERT_WECOM_CHATID;
    if (chatid === "" || this.config.env.WECOM_BOT_ID === "" || this.config.env.WECOM_BOT_SECRET === "") {
      this.logger.warn(
        JSON.stringify({
          event: "notify.project_group.alert_not_sent",
          projectId,
          reason,
          cause: "alert_group_or_bot_not_configured",
        }),
      );
      return;
    }
    try {
      const result = await this.aibot.sendGroupMarkdown({
        chatid,
        content: composeProjectGroupUnavailableAlert(projectName, reason),
        groupActivated: true,
      });
      if (result.ok) {
        this.logger.log(
          JSON.stringify({ event: "notify.project_group.alert_sent", projectId, reason }),
        );
        return;
      }
      this.logger.warn(
        JSON.stringify({
          event: "notify.project_group.alert_not_sent",
          projectId,
          reason,
          failureKind: result.kind,
          errcode: result.errcode,
          error: describeWecomFailure(result.errcode, result.errmsg),
        }),
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: "notify.project_group.alert_not_sent",
          projectId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
