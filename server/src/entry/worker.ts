import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { OUTBOX_SCHEDULER } from "@libiaolink/contracts";
import { loadEnv } from "../config/env.js";
import { DatabaseService } from "../db/database.service.js";
import { FileService, PreviewService, RECYCLE_SWEEP_BATCH as FILE_RECYCLE_SWEEP_BATCH } from "../modules/file/index.js";
import { PROJECT_RECYCLE_SWEEP_BATCH, ProjectService } from "../modules/project/index.js";
import { IMPORT_PREVIEW_SWEEP_INTERVAL_MS, ProjectImportService } from "../modules/project-import/index.js";
import { NotifyDmService, NotifyGroupService, NotifyService, WecomAibotClient } from "../modules/notify/index.js";
import { JobScheduler, OutboxAlertProbe, OutboxDispatcher, OutboxRetention } from "../outbox/index.js";
import { WorkerModule } from "../worker.module.js";

const HEARTBEAT_MS = 60_000;
/** 上传会话过期清理周期（M4-01）：10 分钟一轮，启动即跑一次；失败只记日志不退出。 */
const UPLOAD_SWEEP_INTERVAL_MS = 10 * 60_000;
/** 文件 / 项目回收站到期清理周期：24 小时一轮，启动即各跑一次；每轮内按批 drain，单条失败只记日志并在下轮重试。 */
const RECYCLE_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const database = app.get(DatabaseService);
  const files = app.get(FileService);
  const previews = app.get(PreviewService);
  const projectImports = app.get(ProjectImportService);
  const projects = app.get(ProjectService);
  const notify = app.get(NotifyService);
  const groupNotify = app.get(NotifyGroupService);
  const dmNotify = app.get(NotifyDmService);
  const dispatcher = app.get(OutboxDispatcher);
  const alerts = app.get(OutboxAlertProbe);
  const retention = app.get(OutboxRetention);
  const scheduler = app.get(JobScheduler);
  const aibot = app.get(WecomAibotClient);

  if (process.argv.includes("--health-check")) {
    try {
      await database.ping();
      logger.log("worker 健康检查通过：PG 连通（一次性检查，不启动常驻循环）");
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error("worker 健康检查失败：" + (error instanceof Error ? error.message : String(error)));
      await app.close();
      process.exit(1);
    }
  }

  logger.log(
    "worker 已启动（上传会话过期清理 / 文件回收站到期清理 / 项目回收站 30 天到期清理 / 导入表票据过期清理 / Outbox 运行时：已注册主题领取消费（含无业务订阅主题的 drain-only 收敛）· 未消费主题 / 积压 / 死信告警 · done 行保留期清理 · 调度 tick（每分钟：cron 领取 + last_run_at 补发 + 单活锁；注册表为空 = 只存不跑）· 通知延迟投递排空（免打扰 / 每日上限）· 稍后提醒到点触发（C5-05））",
  );
  const heartbeat = setInterval(() => logger.log("worker heartbeat"), HEARTBEAT_MS);

  const sweepUploads = async (): Promise<void> => {
    try {
      const result = await files.sweepExpiredSessions();
      if (result.scanned > 0) {
        logger.log("上传会话过期清理：扫描 " + result.scanned + " 个 / 清理 " + result.expired + " 个");
      }
    } catch (error) {
      logger.error("上传会话过期清理失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };
  const sweep = setInterval(() => void sweepUploads(), UPLOAD_SWEEP_INTERVAL_MS);
  void sweepUploads();

  // 导入表票据过期清理（Push 325 · 风险⑤）：10 分钟一轮，启动即跑一次；先删源对象，再置 expired。
  const sweepImportPreviews = async (): Promise<void> => {
    try {
      const result = await projectImports.sweepExpiredPreviews();
      if (result.scanned > 0) {
        logger.log("导入表票据过期清理：扫描 " + result.scanned + " 个 / 过期 " + result.expired + " 个");
      }
    } catch (error) {
      logger.error("导入表票据过期清理失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };
  const importPreviewSweep = setInterval(() => void sweepImportPreviews(), IMPORT_PREVIEW_SWEEP_INTERVAL_MS);
  void sweepImportPreviews();

  const sweepRecycled = async (): Promise<void> => {
    try {
      let scanned = 0;
      let purged = 0;
      for (;;) {
        const result = await files.sweepExpiredRecycled(FILE_RECYCLE_SWEEP_BATCH);
        scanned += result.scanned;
        purged += result.purged;
        // 单轮内 drain：满批且仍有进展就继续；无进展（整批失败）留到下一天重试，避免死循环。
        if (result.scanned < FILE_RECYCLE_SWEEP_BATCH || result.purged === 0) break;
      }
      if (scanned > 0) {
        logger.log("文件回收站到期清理：扫描 " + scanned + " 个 / 彻底删除 " + purged + " 个");
      }
    } catch (error) {
      logger.error("文件回收站到期清理失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };
  const sweepProjectRecycled = async (): Promise<void> => {
    try {
      let scanned = 0;
      let purged = 0;
      for (;;) {
        const result = await projects.sweepExpiredRecycled(PROJECT_RECYCLE_SWEEP_BATCH);
        scanned += result.scanned;
        purged += result.purged;
        if (result.scanned < PROJECT_RECYCLE_SWEEP_BATCH || result.purged === 0) break;
      }
      if (scanned > 0) {
        logger.log("项目回收站到期清理：扫描 " + scanned + " 个 / 彻底删除 " + purged + " 个");
      }
    } catch (error) {
      logger.error("项目回收站到期清理失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };
  const runRecycleSweeps = async (): Promise<void> => {
    await sweepRecycled();
    await sweepProjectRecycled();
  };
  const recycleSweep = setInterval(() => void runRecycleSweeps(), RECYCLE_SWEEP_INTERVAL_MS);
  void runRecycleSweeps();

  // 预览转换器启动自检（M4-05c）：可达性 + 管线版本比对（不一致只会让任务按确定性失败降级，绝不写错缓存键 ——
  // 「换镜像必须递增 PREVIEW_PIPELINE_VERSION」，deploy/svg-preview/README.md）。
  // 关闭时预览不入消费注册表（OutboxModule）：preview.job 只投递不消费，属排障态。
  if (env.PREVIEW_JOB_ENABLED === "true") {
    const health = await previews.checkConverter();
    if (health.ok && health.versionMatches) {
      logger.log("预览转换器自检通过：" + health.detail);
    } else {
      logger.warn("预览转换器自检未通过（预览任务会降级为 failed，不影响其它任务）：" + health.detail);
    }
  } else {
    logger.warn("预览转换队列已关闭（PREVIEW_JOB_ENABLED=false）：preview.job 只投递不消费");
  }

  // 首轮告警探针的订阅门（2026-10-19）：WECOM 通道启用时 = waitForSubscribed 的 Promise；未启用 = null（立即探）。
  let botReady: Promise<boolean> | null = null;

  // 企微机器人通道长连接（M5-03-2 接线段 · P5 定案；M5-03-5-4 接线段扩单聊）：凭据齐备才启动 —— 订阅 +
  // 30s 心跳 + 自动重连；回调 ingest 分流 = 单聊 enter_chat 欢迎语、单聊消息（chattype=single → 单聊激活）
  // 与群（群会话激活置位）—— 主动推送前置（846607 双语义切分依据）。群未配置 = 「只存不投」（与
  // OutboxModule 注册表门控同口径）；
  // 单聊未配置 = 投递行按未就绪 retry 收敛（bounded）；api 进程同模块但从不 start()（构造无副作用）。
  if (env.NOTIFY_DELIVERY_ENABLED === "true" && env.WECOM_BOT_ID !== "" && env.WECOM_BOT_SECRET !== "") {
    aibot.onMessage((message) => {
      // 分流（M5-03-5-4；单聊面 M5-03-5-6 扩绑定码；Push 261 扩欢迎语）：单聊 enter_chat → 欢迎语
      // （不激活、不绑定）；其余单聊消息 → 单聊 ingest（激活登记 + 绑定码命中）；群聊 → 群 ingest。
      // 两侧 ingest 各自带过滤防御（cmd / chattype / 合法性），入参同形 —— 互不牵连。
      const ingest =
        message.chattype === "single"
          ? message.cmd === "aibot_event_callback" && message.eventType === "enter_chat"
            ? dmNotify.replyWelcomeToEnterChat(message)
            : dmNotify.ingestCallback(message)
          : groupNotify.activateFromCallback(message);
      void ingest.catch((error) => {
        logger.warn("回调 ingest 失败（忽略本次；待下次回调或人工核查）：" + messageOf(error));
      });
    });
    aibot.start();
    // 有界等待订阅：正常 1 秒内完成；失败 / 无网 10 秒后放行首轮探针（回退日志口径不变）。
    botReady = aibot.waitForSubscribed(10_000);
    logger.log("企微智能机器人长连接已启动（群 + 单聊通道：订阅 + 心跳 + 会话激活 ingest）");
  } else {
    logger.warn("企微机器人通道未启动（WECOM_BOT_ID / WECOM_BOT_SECRET 未配置或通知投递关闭）：notify.group 只存不投；wecom_aibot 投递行按未就绪重试收敛（有界重试，不静默成功）");
  }

  // Outbox 分派（S7-1）：一轮 = 按注册主题各领一批（每主题 OUTBOX_BATCH_LIMIT 条，SKIP LOCKED）后串行收敛；
  // 单条预览最长占满客户端超时（默认 90s），用 draining 闸门避免上一轮没跑完就叠加下一轮。
  let draining = false;
  const drainOutbox = async (): Promise<void> => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      const stats = await dispatcher.drainOnce();
      if (stats.claimed > 0) {
        logger.log(
          "outbox 分派：领取 " + stats.claimed + " / done " + stats.done + " / 重试 " + stats.retried + " / 延期 " +
            stats.deferred + " / 死信 " + stats.dead,
        );
      }
    } catch (error) {
      logger.error("outbox 分派失败：" + messageOf(error));
    } finally {
      draining = false;
    }
  };
  const outboxPoll = setInterval(() => void drainOutbox(), env.OUTBOX_POLL_MS);
  void drainOutbox();

  // 调度器（S7-3 · i11 / M5-02）：每分钟 tick（契约 OUTBOX_SCHEDULER.tickMs）——单活 advisory lock 选主，
  // 领取到期 jobs（SKIP LOCKED），窗口 (last_run_at, now] 按应执行清单补发；无生产者注册的 kind = 只存不跑。
  // 与分派循环同用 draining 闸门思路：上一 tick 未跑完不叠加（单条任务可能触发多条产出）。
  let scheduling = false;
  const tickScheduler = async (): Promise<void> => {
    if (scheduling) {
      return;
    }
    scheduling = true;
    try {
      const stats = await scheduler.tickOnce();
      if (stats.claimed > 0 || stats.failed > 0) {
        logger.log(
          "调度 tick：领取 " + stats.claimed + " / 执行 " + stats.executed + " / 失败 " + stats.failed + " / 产出 " +
            stats.produced,
        );
      }
    } catch (error) {
      logger.error("调度 tick 失败：" + messageOf(error));
    } finally {
      scheduling = false;
    }
  };
  const schedulerTick = setInterval(() => void tickScheduler(), OUTBOX_SCHEDULER.tickMs);
  void tickScheduler();

  // 通知延迟投递排空（S7-4 · C2-09）：免打扰静默 / 每日上限排队的行按 deliver_at 到期重排（合并 / 投递 / 再排期）。
  // 与 outbox 重试分离（重试 = 消费失败退避；本循环 = 投递窗口静默），同用 draining 闸门避免上一轮叠加。
  let flushing = false;
  const flushNotify = async (): Promise<void> => {
    if (flushing) {
      return;
    }
    flushing = true;
    try {
      const stats = await notify.flushDue();
      if (stats.scanned > 0) {
        logger.log(
          "通知延迟投递：扫描 " + stats.scanned + " / 投递 " + stats.delivered + " / 合并 " + stats.merged + " / 再排期 " +
            stats.postponed,
        );
      }
    } catch (error) {
      logger.error("通知延迟投递排空失败：" + messageOf(error));
    } finally {
      flushing = false;
    }
  };
  const notifyFlush = setInterval(() => void flushNotify(), env.NOTIFY_FLUSH_INTERVAL_MS);
  void flushNotify();

  // 稍后提醒到点触发（S8-3 · M5-04-2 · C5-05）：与通知延迟投递并列、语义独立 —— 到点置回 unread +
  // 推 notification / unread 事件（handled 行照提醒）；落免打扰时段顺延到时段结束；不消耗每日上限。
  // 同用 draining 闸门避免上一轮叠加。
  let snoozing = false;
  const flushSnoozes = async (): Promise<void> => {
    if (snoozing) {
      return;
    }
    snoozing = true;
    try {
      const stats = await notify.flushSnoozes();
      if (stats.scanned > 0) {
        logger.log(
          "稍后提醒触发：扫描 " + stats.scanned + " / 触发 " + stats.triggered + " / 顺延 " + stats.deferred,
        );
      }
    } catch (error) {
      logger.error("稍后提醒触发扫描失败：" + messageOf(error));
    } finally {
      snoozing = false;
    }
  };
  const snoozeSweep = setInterval(() => void flushSnoozes(), env.NOTIFY_SNOOZE_SWEEP_INTERVAL_MS);
  void flushSnoozes();

  // 可执行即时告警（ADR-005）：队列停滞 / 未消费主题；积压与最老等待只在连续无进度时合并升级。
  const probeAlerts = async (): Promise<void> => {
    try {
      await alerts.probeOnce();
    } catch (error) {
      logger.error("outbox 告警探针失败：" + messageOf(error));
    }
  };
  const alertProbe = setInterval(() => void probeAlerts(), env.OUTBOX_ALERT_INTERVAL_MS);
  // 首轮探针等企微长连接订阅完成（启动竞态修复）：start() 后立即探测必然拿到 state=connecting →
  // 告警「发送失败（kind=retryable）」回退日志。未启用企微 = 立即探测；等待有界（10 秒），超时照常探测。
  void (async () => {
    if (botReady !== null && !(await botReady)) {
      logger.warn("企微长连接 10 秒内未完成订阅：首轮告警探针照常执行（发送失败回退结构化日志）");
    }
    await probeAlerts();
  })();

  // outbox 日报：恢复通知、死信窗口汇总与当前队列快照；没有内容时只写日志，不推群。
  let digesting = false;
  const flushDigest = async (): Promise<void> => {
    if (digesting) {
      return;
    }
    digesting = true;
    try {
      await alerts.digestOnce();
    } catch (error) {
      logger.error("outbox 日报生成失败：" + messageOf(error));
    } finally {
      digesting = false;
    }
  };
  const alertDigest = setInterval(() => void flushDigest(), env.OUTBOX_ALERT_DIGEST_INTERVAL_MS);

  // done 行保留期清理（ADR-005 约 90 天）：分批删除，内容与条数由 OutboxRetention 自记日志。
  const sweepOutbox = async (): Promise<void> => {
    try {
      await retention.sweepOnce();
    } catch (error) {
      logger.error("outbox done 行清理失败：" + messageOf(error));
    }
  };
  const retentionSweep = setInterval(() => void sweepOutbox(), env.OUTBOX_RETENTION_INTERVAL_MS);
  void sweepOutbox();

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(heartbeat);
    clearInterval(sweep);
    clearInterval(recycleSweep);
    clearInterval(importPreviewSweep);
    clearInterval(outboxPoll);
    clearInterval(schedulerTick);
    clearInterval(notifyFlush);
    clearInterval(snoozeSweep);
    clearInterval(alertProbe);
    clearInterval(alertDigest);
    clearInterval(retentionSweep);
    aibot.stop();
    logger.log("worker 收到 " + signal + "，正在退出");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await bootstrap();
