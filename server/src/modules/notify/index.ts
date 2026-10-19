/** notify 模块唯一公开出口（api / worker 组合根与 outbox 注册表使用）。 */
export { NotifyModule } from "./notify.module.js";
export {
  composeGroupMarkdown,
  GROUP_DEGRADE_PREFIX,
  GROUP_MARKDOWN_MAX_BYTES,
  GROUP_TRUNCATION_SUFFIX,
  maskChatid,
  NotifyGroupService,
  parseGroupMessage,
  truncateGroupMarkdown,
} from "./notify.group.service.js";
export { NotifyGroupRepository } from "./notify.group.repository.js";
export {
  APP_DEGRADE_PREFIX,
  APP_TEXT_MAX_BYTES,
  APP_TRUNCATION_SUFFIX,
  composeAppText,
  maskUserid,
  NotifyAppService,
  truncateAppText,
} from "./notify.app.service.js";
export { NotifyAppRepository } from "./notify.app.repository.js";
export type { NotifyAppDeliveryInsert, WecomAppContact } from "./notify.app.repository.js";
export {
  composeDmMarkdown,
  DM_BINDING_CODE_MAX_PER_WINDOW,
  DM_BINDING_CODE_WINDOW_MS,
  DM_BINDING_CODE_PATTERN,
  DM_BINDING_CODE_TTL_MS,
  DM_BINDING_DEGRADE_PREFIX,
  DM_BINDING_REPLY_BOUND,
  DM_BINDING_REPLY_INVALID,
  DM_DEGRADE_PREFIX,
  DM_MARKDOWN_MAX_BYTES,
  DM_TRUNCATION_SUFFIX,
  extractBindingCode,
  NotifyDmService,
  truncateDmMarkdown,
} from "./notify.dm.service.js";
export { NotifyDmRepository } from "./notify.dm.repository.js";
export type {
  DmActivationRow,
  DmBindingCodeRow,
  DmBindingRow,
  NotifyDmDeliveryInsert,
  WecomDmContact,
} from "./notify.dm.repository.js";
export { PgRateWindowStore } from "./wecom.rate.pg.js";
export { NotifyService } from "./notify.service.js";
export type { NotifyFlushStats, NotifySnoozeFlushStats } from "./notify.service.js";
export { NOTIFY_GROUP_TOPIC, NOTIFY_MESSAGE_TOPIC } from "./notify.constants.js";
export {
  channelOfNotifyPayload,
  formatClockMinute,
  isDeliverableChannel,
  isWithinQuiet,
  mergeKeyOf,
  nextDayWindowStart,
  parseClockMinute,
  parseNotifyMessage,
  parseQuietHours,
  planDelivery,
  quietEndAfter,
  shanghaiDayStart,
  shanghaiMinuteOfDay,
} from "./notify.delivery.js";
export { truncateUtf8Bytes } from "./wecom.text.js";
export type { DeliveryDecision, QuietHours } from "./notify.delivery.js";
export {
  classifyWecomErrcode,
  classifyWecomHttpStatus,
  describeNetworkError,
  WECOM_APP_TOKEN_ERRCODES,
  WECOM_CHANNELS,
} from "./wecom.errors.js";
export type { WecomChannel, WecomFailureKind } from "./wecom.errors.js";
export { chatBucketId, InMemoryRateWindowStore, userBucketId, WECOM_APP_BUCKET_ID, WecomRateLimiter } from "./wecom.rate.js";
export type {
  RateWindowStore,
  WecomRateDecision,
  WecomRateKind,
  WecomRateWindowSpec,
  WecomRateWindowState,
} from "./wecom.rate.js";
export { WecomTokenError, WecomTokenManager } from "./wecom.token.js";
export type { WecomTokenInfo } from "./wecom.token.js";
export { createWecomClientFromEnv, WecomClient } from "./wecom.client.js";
export type { WecomClientOptions, WecomRuntime, WecomRuntimeOverrides, WecomSendResult } from "./wecom.client.js";
export { createWecomAibotClientFromEnv, createWsSocketFactory, WecomAibotClient } from "./wecom.aibot.js";
export type {
  AibotIncomingMessage,
  AibotSendResult,
  AibotSocket,
  AibotSocketFactory,
  WecomAibotOverrides,
  WecomAibotStats,
} from "./wecom.aibot.js";
