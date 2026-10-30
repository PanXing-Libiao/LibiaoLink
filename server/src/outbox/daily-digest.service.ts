import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ClockService } from "../common/clock/clock.service.js";
import { JobsStore, type FixedCronJobOutcome } from "../db/jobs.store.js";
import { OUTBOX_ALERT_SINK, type OutboxAlertSink } from "./alert.js";
import {
  buildDailyDigest,
  DAILY_DIGEST_GRACE_MS,
  outboxDailyDigestHistoryFrom,
  outboxDailyDigestRegistrationRunAt,
  outboxDailyDigestWindow,
  OUTBOX_DAILY_DIGEST_CRON,
  OUTBOX_DAILY_DIGEST_DEDUPE_KEY,
  OUTBOX_DAILY_DIGEST_JOB_KIND,
} from "./daily-digest.js";
import { OutboxDailyDigestRepository } from "./daily-digest.repository.js";
import { OutboxAlertProbe } from "./probe.js";
import type { JobRunContext, JobRunResult, OutboxJobHandler } from "./scheduler.js";

const MAX_ATTEMPTS_PER_DAY = 3;

/**
 * 管理员日报任务（固定每天 08:00 · Asia/Shanghai）。
 *
 * 与普通调度生产者不同，本处理器不包在长事务里发企微消息：`transactional=false`，调度器只在发送后
 * 用一个短事务推进 jobs 水位。发送成功但水位提交失败时存在极小概率重复发送（至少一次语义）。
 */
@Injectable()
export class OutboxDailyDigestService implements OutboxJobHandler {
  readonly transactional = false;
  private readonly logger = new Logger(OutboxDailyDigestService.name);

  constructor(
    private readonly repository: OutboxDailyDigestRepository,
    private readonly jobs: JobsStore,
    private readonly clock: ClockService,
    @Inject(OUTBOX_ALERT_SINK) private readonly alerts: OutboxAlertSink,
    @Optional() private readonly probe?: OutboxAlertProbe,
  ) {}

  /** worker 启动时幂等注册；AUTOMATION_WIRING_ENABLED=false 也不会关闭管理员日报。 */
  async ensureScheduled(): Promise<FixedCronJobOutcome> {
    return this.jobs.ensureFixedCronJob({
      kind: OUTBOX_DAILY_DIGEST_JOB_KIND,
      dedupeKey: OUTBOX_DAILY_DIGEST_DEDUPE_KEY,
      cron: OUTBOX_DAILY_DIGEST_CRON,
      runAt: outboxDailyDigestRegistrationRunAt(this.clock.now()),
    });
  }

  async run(context: JobRunContext): Promise<JobRunResult> {
    const latestFire = context.fireTimes[context.fireTimes.length - 1];
    if (latestFire === undefined) {
      return { note: "日报触发窗口内无 08:00 时刻" };
    }

    const now = this.clock.now();
    if (now.getTime() < latestFire.getTime()) {
      return { note: "日报尚未到触发时刻" };
    }
    if (now.getTime() - latestFire.getTime() > DAILY_DIGEST_GRACE_MS) {
      this.logger.warn(
        "管理员日报超过 12:00 补发窗口，跳过本次（不会补发历史日报）：reportAt=" + latestFire.toISOString(),
      );
      return { note: "超过 12:00 补发窗口，跳过；次日 08:00 正常发送" };
    }

    try {
      const window = outboxDailyDigestWindow(latestFire);
      const data = await this.repository.load({
        historyFrom: outboxDailyDigestHistoryFrom(window.from),
        windowTo: window.to,
        reportAt: latestFire,
      });
      const report = buildDailyDigest({
        reportAt: latestFire,
        generatedAt: now,
        data,
        recoveries: this.probe?.drainDailyDigestRecoveries() ?? [],
      });
      const sent = await this.alerts.emitDigest(report);
      const historyNote =
        context.fireTimes.length > 1
          ? "；已省略 " + String(context.fireTimes.length - 1) + " 个更早窗口，仅发送最近一份日报"
          : "";
      return {
        note:
          (sent ? "管理员日报已送达企微告警群" : "管理员日报已回退结构化日志") + historyNote,
      };
    } catch (error) {
      if (context.job.attempts + 1 < MAX_ATTEMPTS_PER_DAY) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "管理员日报连续 " + String(MAX_ATTEMPTS_PER_DAY) + " 次生成失败，跳过当天并保留次日执行资格：" + detail,
      );
      return { note: "日报连续生成失败，已跳过当天并保留次日执行资格" };
    }
  }
}
