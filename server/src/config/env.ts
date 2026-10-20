import { z } from "@libiaolink/contracts";

/** 环境变量契约：唯一入口是 loadEnv()，缺失 / 非法即启动失败（fail fast）。 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // ---- 认证与会话（ADR-010；g6 会话后端化） ----
    CASDOOR_ISSUER: z.string().min(1).default("http://localhost:8000"),
    CASDOOR_CLIENT_ID: z.string().default(""),
    CASDOOR_CLIENT_SECRET: z.string().default(""),
    CASDOOR_REDIRECT_URI: z.string().min(1).default("http://localhost:3000/auth/callback"),
    CASDOOR_SCOPE: z.string().min(1).default("openid profile email"),
    /** 目录同步 owner（Casdoor 组织名；本地沙箱 libiaorobot，公司环境 libiaorobot.com）。 */
    CASDOOR_ORG_NAME: z.string().default(""),
    /** 会话空闲超时（分钟）：接入标准「企业内部系统」档为 30；0 仅测试用（立即超时）。 */
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).default(30),
    /** 会话 Cookie Secure 属性：auto = 仅 production 开启（本地 http 调试不受影响）。 */
    SESSION_COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
    /** 内部作业接口凭证（请求头 X-Internal-Token；docs/开发者接入注意事项(SSO接入标准).md 第五部分）。 */
    INTERNAL_SYNC_TOKEN: z.string().default(""),
    /**
     * 权限判定开关（一期口径「我们当前这个系统就不要考虑权限」，2026-09-23 业务已定）：
     * `false`（默认）= **不判权限** —— 授权画像一律等效管理员（数据范围 all + 契约全量权限位 + admin 角色码），
     * 功能权限 / 记录级可见性 / 字段级投影 / 角色内硬检查全部放开；`true` = 按 ADR-011 判定（二期打开）。
     * 只影响**裁定**，不动数据：用户偏好（常用筛选 / 醒目模式 / 任务表列显隐）仍按账号各存一行（user_preferences）。
     */
    PERMISSION_ENFORCED: z.enum(["true", "false"]).default("false"),
    // ---- 对象存储（ADR-006：S3 协议抽象 + 一期 MinIO 单节点；本地沙箱见 deploy/minio/） ----
    S3_ENDPOINT: z.string().min(1).default("http://127.0.0.1:9000"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ACCESS_KEY: z.string().default(""),
    S3_SECRET_KEY: z.string().default(""),
    S3_BUCKET: z.string().min(1).default("libiaolink"),
    /** 寻址方式：auto = 非 AWS 端点走 path-style（MinIO / SeaweedFS 必需），AWS 走 virtual-host。 */
    S3_FORCE_PATH_STYLE: z.enum(["auto", "true", "false"]).default("auto"),
    /** 分片预签名 URL 有效期（秒）：单个分片的直传窗口（浏览器直传，api 不代理流量）。 */
    S3_PART_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(900),
    /** 下载预签名 URL 有效期（秒）：ADR-006 要求短时签名，禁止匿名读取。 */
    S3_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    /** 单文件大小上限（MB）；上传管道（M4-01）据此返回 400 VALIDATION_FAILED。 */
    UPLOAD_MAX_SIZE_MB: z.coerce.number().int().min(1).max(102400).default(2048),
    /** 上传会话有效期（小时）：过期不可续传，需重新发起（契约 UploadSession.expiresAt）。 */
    UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** 回收站保留期（天）：移入回收站时写 `files.purge_after = recycled_at + 保留期`（A4-12，默认 30）。 */
    FILE_RECYCLE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    // ---- 预览转换沙箱（M4-05c · ADR-007：converter 落点 deploy/preview/，接口契约见其 README「五」） ----
    /** 转换器基址：dev = 本机哑中继 `127.0.0.1:9900`；生产 = worker 与 converter 同处 internal 网络的内部地址。 */
    PREVIEW_CONVERTER_URL: z.string().min(1).default("http://127.0.0.1:9900"),
    /** 转换管线版本（进预览产物三元组缓存键）：与镜像标签同值，换镜像必须一并递增（deploy/preview/README「四」）。 */
    PREVIEW_PIPELINE_VERSION: z.string().min(1).default("1.0.0"),
    /** 客户端超时（毫秒）：比容器内硬超时（60000）留余量 —— 才拿得到 504 CONVERT_TIMEOUT 而不是被客户端掐断的裸超时。 */
    PREVIEW_CONVERT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(90000),
    /** 可重试失败的最大尝试次数（含首次）：到顶写产物 failed + outbox dead（D2-05 降级「请下载」）。 */
    PREVIEW_CONVERT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    /** 重试退避基数（毫秒）：第 n 次失败后等 min(基数 × 2^(n-1), 30 分钟)。 */
    PREVIEW_CONVERT_BACKOFF_MS: z.coerce.number().int().min(1000).max(600000).default(15000),
    /** 直接降级「仅下载」的源文件上限（MB）：转换峰值内存约为源文件数倍，别把沙箱配额打满（deploy/preview「七」）。 */
    PREVIEW_CONVERT_MAX_SOURCE_MB: z.coerce.number().int().min(1).max(512).default(100),
    /** 预览地址短时签名有效期（秒）：D2-04 短时签名 + 禁匿名；越长越接近「把产物地址变成长期免鉴权入口」。 */
    PREVIEW_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    /** 预览转换队列开关（worker）：`false` = 只投递不消费（排障 / 压测用）。 */
    PREVIEW_JOB_ENABLED: z.enum(["true", "false"]).default("true"),
    // ---- 翻译通道（§6.16 ㉕ ㉖ · Push 301 / 309：手打内容英译落库；provider 可插拔 —— 本地引擎 / OpenAI 兼容 API） ----
    /** 内网翻译引擎基址（LibreTranslate 兼容 POST /translate；provider=local 时使用；本机验证形态 = HY-MT1.5-1.8B 薄壳 5008）。 */
    TRANSLATE_ORIGIN: z.string().min(1).default("http://127.0.0.1:5008"),
    /** 引擎调用超时（毫秒）：超时 / 失败按 500 INTERNAL 返回（前端既有通道静默降级跳过）。 */
    TRANSLATE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
    /** 翻译通道形态：`local` = 本地 / 内网引擎（TRANSLATE_ORIGIN）；`openai` = OpenAI 兼容 API（TRANSLATE_API_*，如公司 New API 网关 https://newapi.libiaorobot.com/v1）。 */
    TRANSLATE_PROVIDER: z.enum(["local", "openai"]).default("local"),
    /** OpenAI 兼容 API 基址（含 /v1）；provider=openai 时必填（缺失按 INTERNAL 静默降级）。 */
    TRANSLATE_API_BASE_URL: z.string().default(""),
    /** 翻译 API 模型名（如 deepseek-v4-flash-vision-exp）；provider=openai 时必填。 */
    TRANSLATE_API_MODEL: z.string().default(""),
    /** 备用 API 模型（Push 310）：主模型失败时改调（如 deepseek 断流 → gemini-3.8-flash）；留空 = 不接力。 */
    TRANSLATE_API_MODEL_FALLBACK: z.string().default(""),
    /** 翻译 API Key（由 secrets/translate_api_key 经入口注入，不进仓库 / 不进 .env）；网关无鉴权时可留空。 */
    TRANSLATE_API_KEY: z.string().default(""),
    /** 兜底引擎基址（可选）：主通道失败时改调该 LibreTranslate 兼容端点（「本地引擎方案保留」接线位；留空 = 不兜底）。 */
    TRANSLATE_FALLBACK_ORIGIN: z.string().default(""),
    // ---- ONLYOFFICE 查看器（S3 · ADR-030：Office / 文本族预览改由 ONLYOFFICE 查看器承接；受控端点鉴权 = 与 DocServer 共享密钥） ----
    /** DocServer 浏览器侧基址：查看器配置 `docServerUrl` 下发（前端据此加载 api.js）；dev 沙箱 = deploy/onlyoffice 的 127.0.0.1:8001。 */
    ONLYOFFICE_DOCSERVER_URL: z.string().min(1).default("http://127.0.0.1:8001"),
    /**
     * 「DocServer 视角」API 基址（安全定稿 C1）：受控端点绝对 URL（配置签发）与 token `payload.url` 绑定校验
     * **共用的唯一配置源** —— 同源生成、不信任 Host 头；容器部署 = DocServer 可达的 API 内网地址（如 http://api:3000）。
     */
    ONLYOFFICE_DOCSERVER_API_BASE_URL: z.string().min(1).default("http://127.0.0.1:3000"),
    /** 与 DocServer `JWT_SECRET` 同值（查看器配置签发 + 受控端点 Bearer 自验）；生产必填（启动即校验）、空值下受控端点一律 401（fail closed）。 */
    ONLYOFFICE_JWT_SECRET: z.string().default(""),
    /** 查看器配置 token TTL（秒）：S8-2 定案 900s（契约不含该字段，服务端配置下发）。 */
    ONLYOFFICE_JWT_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
    /** 受控端点签名校验的时钟漂移容差（秒；N2 附条件 C5：≤60s 且配置化）。 */
    ONLYOFFICE_JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(60),
    // ---- Outbox 领取器（M4-05c：领取 + 消费 + 重试 + dead；不含规则 / 通知编排） ----
    /** 领取轮询周期（毫秒）。 */
    OUTBOX_POLL_MS: z.coerce.number().int().min(200).max(600000).default(5000),
    /** 每主题单轮领取条数上限：单条最长占满客户端超时（90s），默认 2 与转换器沙箱并发 2 对齐。 */
    OUTBOX_BATCH_LIMIT: z.coerce.number().int().min(1).max(50).default(2),
    /** 领取后超过该时长未回写视为 worker 崩溃遗留、可重新领取（毫秒；必须 > 该主题单条最长耗时）。 */
    OUTBOX_STALE_MS: z.coerce.number().int().min(60000).max(86400000).default(600000),
    // ---- Outbox 运行时（S7-1：重试 / 死信 / 告警 / done 行保留） ----
    /** 通用主题重试上限（含首次）：preview.job 仍走 PREVIEW_CONVERT_MAX_ATTEMPTS。 */
    OUTBOX_DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** 通用主题退避基数（毫秒）：第 n 次失败后等 base * 2^(n-1)，封顶 OUTBOX_DEFAULT_BACKOFF_MAX_MS。 */
    OUTBOX_DEFAULT_BACKOFF_BASE_MS: z.coerce.number().int().min(1000).max(3600000).default(15000),
    OUTBOX_DEFAULT_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).max(86400000).default(1800000),
    /** 告警探针周期（毫秒）：积压 / 最老待领取年龄 / 近期新增死信；死信单条即时告警不依赖本周期。 */
    OUTBOX_ALERT_INTERVAL_MS: z.coerce.number().int().min(10000).max(3600000).default(300000),
    /** 持续超阈值告警的复报冷却（毫秒）：积压 / 最老待领取 / 未消费主题；回到阈值内发一次恢复。 */
    OUTBOX_ALERT_REPEAT_MS: z.coerce.number().int().min(60000).max(604800000).default(21600000),
    /** 待领取积压条数阈值（> 即告警）。 */
    OUTBOX_ALERT_BACKLOG_MAX: z.coerce.number().int().min(1).max(1000000).default(1000),
    /** 最老待领取消息年龄阈值（毫秒）。 */
    OUTBOX_ALERT_OLDEST_MS: z.coerce.number().int().min(60000).max(86400000).default(900000),
    /** 近期死信条数阈值（>= 即告警）：默认 1 = 窗口内出现任何死信都告警。 */
    OUTBOX_ALERT_DEAD_RECENT_MAX: z.coerce.number().int().min(1).max(100000).default(1),
    /** 死信「近期」窗口（毫秒）。 */
    OUTBOX_ALERT_DEAD_WINDOW_MS: z.coerce.number().int().min(60000).max(86400000).default(3600000),
    /** 消费进度窗口（毫秒）：窗口内无 done 行才视为「无进展」，用于过滤正常排空。 */
    OUTBOX_ALERT_PROGRESS_WINDOW_MS: z.coerce.number().int().min(60000).max(3600000).default(900000),
    /** 连续无进展的探针轮数：达到后把积压 / 最老等待合并升级为 outbox.queue_stalled。 */
    OUTBOX_ALERT_STALL_PROBES: z.coerce.number().int().min(1).max(60).default(3),
    /** outbox 日报间隔（毫秒）：恢复通知与死信汇总只在日报出现；默认 24h。 */
    OUTBOX_ALERT_DIGEST_INTERVAL_MS: z.coerce.number().int().min(3600000).max(604800000).default(86400000),
    /** 管理员告警群 chatid（企微智能机器人；空 = 告警仅回退结构化日志 —— OUTBOX_ALERT_SINK 出口选择）。 */
    OUTBOX_ALERT_WECOM_CHATID: z.string().default(""),
    /** done 行保留期（天；ADR-005 约 90 天）。 */
    OUTBOX_DONE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** 单批删除条数（清理循环每批上限）。 */
    OUTBOX_RETENTION_BATCH: z.coerce.number().int().min(10).max(10000).default(1000),
    /** done 行清理周期（毫秒）。 */
    OUTBOX_RETENTION_INTERVAL_MS: z.coerce.number().int().min(60000).max(86400000).default(21600000),
    /** 领取者标识（进 outbox_events.locked_by）：缺省 host:pid。 */
    WORKER_ID: z.string().max(128).default(""),
    // ---- 通知投递（S7-4 · j1 / M5-04 首刀：站内信投递 / 合并 / 免打扰 / 每人每日上限） ----
    /** 站内信投递开关（worker）：`false` = `notify.message` 只投递不消费（排障 / 压测用，与 preview 同形的排障态）。 */
    NOTIFY_DELIVERY_ENABLED: z.enum(["true", "false"]).default("true"),
    /** 延迟投递 flush 周期（毫秒）：免打扰 / 每日上限排队的行按 `deliver_at` 到期重排（不走 outbox 重试语义）。 */
    NOTIFY_FLUSH_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    /** 单轮 flush 条数上限。 */
    NOTIFY_FLUSH_BATCH: z.coerce.number().int().min(1).max(500).default(50),
    /** 合并窗口（毫秒）：同人 + 同合并键、窗口内未读主行合并为一条；0 = 不合并（个人偏好可覆盖）。 */
    NOTIFY_MERGE_WINDOW_MS: z.coerce.number().int().min(0).max(86400000).default(1800000),
    /** 缺省免打扰时段（`HH:MM-HH:MM`，Asia/Shanghai，允许跨零点）；空串 = 免打扰关闭（个人偏好可覆盖）。 */
    NOTIFY_QUIET_HOURS: z
      .string()
      .regex(/^$|^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .default("22:00-08:00"),
    /** 缺省每人每日投递上限（0 = 不限）：超限消息排到次日投递窗口起点（个人偏好可覆盖）。 */
    NOTIFY_DAILY_LIMIT: z.coerce.number().int().min(0).max(1000).default(200),
    /** 次日投递窗口起点（分钟，Asia/Shanghai；480 = 08:00）：每日上限溢出 / 静默后补发的落点。 */
    NOTIFY_DAILY_WINDOW_START_MINUTE: z.coerce.number().int().min(0).max(1439).default(480),
    // ---- SSE 实时流（S8-3 · M5-04-1：notification / unread 事件推送 · Push 211） ----
    /** 每用户最大并发 SSE 连接数（超出拒新 = 429；定案 §三-4 缺省 3）。 */
    NOTIFY_STREAM_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(3),
    /** SSE 心跳注释行周期（毫秒；`: ping`，不入契约；定案 §三-4 缺省 25s）。 */
    NOTIFY_STREAM_HEARTBEAT_MS: z.coerce.number().int().min(100).max(3600000).default(25000),
    /** SSE 轮询兜底周期（毫秒；0 = 关 —— LISTEN/NOTIFY 为主案，本档弱实时仅补 unread 角标快照）。 */
    NOTIFY_STREAM_POLL_MS: z.coerce.number().int().min(0).max(3600000).default(0),
    // ---- 稍后提醒到点触发（S8-3 · M5-04-2：C5-05 设置 / 取消 / 记录读面 + 触发循环 · Push 212） ----
    /** 稍后提醒到点扫描周期（毫秒）：worker 常驻循环按 `snooze_until` 到期重提醒（免打扰顺延、不消耗每日上限）。 */
    NOTIFY_SNOOZE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    /** 单轮稍后提醒扫描条数上限。 */
    NOTIFY_SNOOZE_BATCH: z.coerce.number().int().min(1).max(500).default(50),
    // ---- 企微通道（M5-03-1 · S8-1：客户端内核 · token 单飞 / 限速桶 / 错误码分类） ----
    /** 企微 API 基址：联调 / stub 回放可替换；生产 = https://qyapi.weixin.qq.com。 */
    WECOM_BASE_URL: z.string().min(1).default("https://qyapi.weixin.qq.com"),
    /** 自建应用 CorpID / AgentId / Secret（Secret 属凭据，只走密钥渠道，真实值不落仓库；生产必填校验随 M5-03-3 接线启用）。 */
    WECOM_CORP_ID: z.string().default(""),
    WECOM_AGENT_ID: z.coerce.number().int().min(0).default(0),
    WECOM_APP_SECRET: z.string().default(""),
    /** 单次 HTTP 超时（毫秒）：gettoken / message/send 共用。 */
    WECOM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
    /** token 提前刷新余量（毫秒）：过期前多久主动重取（token_invalid 另走失效重取一次）。 */
    WECOM_TOKEN_SAFETY_MS: z.coerce.number().int().min(0).max(3600000).default(300000),
    /** 自建应用限速窗口（毫秒）+ 窗口内上限（0 = 未启用；待 A5 实测回填）。 */
    WECOM_RATE_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    WECOM_RATE_LIMIT_APP: z.coerce.number().int().min(0).max(1000000).default(0),
    // ---- 企微智能机器人长连接（M5-03-2 · P5 定案：群通道唯一发送面 · webhook 面已退役） ----
    /** 长连接地址（联调 / stub 回放可替换；生产 = wss://openws.work.weixin.qq.com）。 */
    WECOM_BOT_WS_URL: z.string().min(1).default("wss://openws.work.weixin.qq.com"),
    /** 智能机器人 BotID / Secret（Secret 属凭据，只走密钥渠道；生产必填校验随接线刀启用）。 */
    WECOM_BOT_ID: z.string().default(""),
    WECOM_BOT_SECRET: z.string().default(""),
    /**
     * 机器人诊断开关（设置页「机器人诊断」块）：auto = 仅 NODE_ENV !== production 时开启；true = 强制开启；
     * false = 关闭。开启时 GET /api/v1/wecom-dm-binding/diagnostics 回 bot_id / secret 原文（仅本地联调用）。
     */
    WECOM_BOT_DIAGNOSTICS: z.enum(["auto", "true", "false"]).default("auto"),
    /** 心跳周期（毫秒）：连续 2 个周期无 pong → 判失联重连。 */
    WECOM_BOT_PING_INTERVAL_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
    /** 单帧回执超时（毫秒）：订阅 / 推送共用。 */
    WECOM_BOT_ACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
    /** 重连退避下限 / 上限（毫秒）：指数退避封顶。 */
    WECOM_BOT_RECONNECT_MIN_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    WECOM_BOT_RECONNECT_MAX_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    /** 按会话限速（Spike 实测口径：30 条/分钟 + 1000 条/小时；0 = 未启用）。 */
    WECOM_BOT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(1000000).default(30),
    WECOM_BOT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).max(10000000).default(1000),
    /** R06 动态海报开关：true = 按项目真实数据生成姓名墙 PNG；生成失败回退下方静态图。 */
    WECOM_R06_DYNAMIC_POSTER: z.enum(["true", "false"]).default("true"),
    /** R06 动态海报字体（可选）：空 = 使用服务端资产思源宋体（SemiBold / Bold，随仓库发布）；可指向其它已授权字体。 */
    WECOM_R06_FONT_SANS_PATH: z.string().default(""),
    WECOM_R06_FONT_SANS_BOLD_PATH: z.string().default(""),
    WECOM_R06_FONT_SERIF_PATH: z.string().default(""),
    /** R06 验收交付默认喜报图（可选）：动态海报关闭 / 生成失败时使用；空 = 不追加图片；建议绝对路径，支持 PNG / JPG / GIF（≤10MB）。 */
    WECOM_R06_IMAGE_PATH: z.string().default(""),
    /** R06 全部任务按时交付喜报图（可选）：空 = 回退 WECOM_R06_IMAGE_PATH。 */
    WECOM_R06_ON_TIME_IMAGE_PATH: z.string().default(""),
    // ---- 调度器（S7-3 · i11 / M5-02：cron 领取 + last_run_at 补发 + 单活 advisory lock · ADR-005） ----
    /** 单轮 tick 领取条数上限（到期任务按 run_at 序领取，逐条串行执行）。 */
    OUTBOX_SCHEDULER_BATCH_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    /** 调度任务失败最大尝试次数（含首次）：到顶置 jobs.status = failed（人工复位后继续）。 */
    OUTBOX_SCHEDULER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    /** 补发跨度上限（天）：重启 / 停机错过的窗口超此跨度只记 skipped 留痕（契约 OUTBOX_SCHEDULER.catchupMaxDays 建议值落 env）。 */
    OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /** 单轮 tick 最多处理的补发窗口数（水位护栏）：触顶时 last_run_at 停在最后处理的窗口、run_at=now 下一轮顺延（契约 OUTBOX_SCHEDULER.maxWindowsPerTick 建议值落 env）。 */
    OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: z.coerce.number().int().min(1).max(1000).default(20),
    // ---- 规则接线（S7·outbox · S7-4 规则接线段：automation 规则 → notify.message 生产） ----
    /** 规则接线总开关：关 = 不注册规则事件消费者与 automation-schedule.job（事件积压可见 · 排障态）。 */
    AUTOMATION_WIRING_ENABLED: z
      .enum(["true", "false"])
      .default("true"),
    /** R06 项目完成喜报开关：true = 在默认启用集之外纳入 R06（项目编辑保存「已完成」时触发）。 */
    AUTOMATION_R06_ENABLED: z.enum(["true", "false"]).default("false"),
    /**
     * 冷启动保护阈值（毫秒）：事件行创建时刻距今超此阈值 → 不评估主体、逐规则登记 `event_too_old`（消费掉不产消息）。
     * 用途：接线前积压的历史事件（重启 / 停机 / 首次上线）不补发业务通知；缺省 6 小时。
     */
    AUTOMATION_EVENT_MAX_AGE_MS: z.coerce.number().int().min(0).default(21600000),
  })
  .superRefine((value, context) => {
    // S3 单次 CopyObject 上限 5 GiB（ADR-006：complete 时 `…/staging/{sessionId}` → 契约键走一次复制，
    // 见 src/storage/part-plan.ts 的 SINGLE_COPY_MAX_BYTES）。放开这个上限必须先补 UploadPartCopy。
    if (value.UPLOAD_MAX_SIZE_MB * 1024 * 1024 > 5 * 1024 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "UPLOAD_MAX_SIZE_MB 不得超过 5120（S3 单次 CopyObject 上限 5 GiB；放开需先补分片复制）",
        path: ["UPLOAD_MAX_SIZE_MB"],
      });
    }
    // PREVIEW_PIPELINE_VERSION 进对象键（storage/object-key.ts 的片段白名单同口径）：非法字符会在构造键时抛错，
    // 提前到启动期拦下（fail fast）；「与镜像标签同值」的规则见 deploy/preview/README「四」。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.PREVIEW_PIPELINE_VERSION)) {
      context.addIssue({
        code: "custom",
        message: "PREVIEW_PIPELINE_VERSION 只允许字母 / 数字 / . _ -（首字符须为字母或数字，最长 64）",
        path: ["PREVIEW_PIPELINE_VERSION"],
      });
    }
    if (value.OUTBOX_STALE_MS < value.PREVIEW_CONVERT_TIMEOUT_MS) {
      context.addIssue({
        code: "custom",
        message: "OUTBOX_STALE_MS 必须 >= PREVIEW_CONVERT_TIMEOUT_MS，否则正在转换的行会被当成崩溃遗留重复领取",
        path: ["OUTBOX_STALE_MS"],
      });
    }
    if (value.OUTBOX_DEFAULT_BACKOFF_BASE_MS > value.OUTBOX_DEFAULT_BACKOFF_MAX_MS) {
      context.addIssue({
        code: "custom",
        message: "OUTBOX_DEFAULT_BACKOFF_BASE_MS 必须 <= OUTBOX_DEFAULT_BACKOFF_MAX_MS",
        path: ["OUTBOX_DEFAULT_BACKOFF_MAX_MS"],
      });
    }
    if (value.NOTIFY_QUIET_HOURS !== "") {
      const [quietFrom, quietTo] = value.NOTIFY_QUIET_HOURS.split("-");
      if (quietFrom === quietTo) {
        context.addIssue({
          code: "custom",
          message: "NOTIFY_QUIET_HOURS 的开始与结束不能相同（要关闭免打扰请设为空串）",
          path: ["NOTIFY_QUIET_HOURS"],
        });
      }
    }
    if (value.NODE_ENV !== "production") {
      return;
    }
    if (value.CASDOOR_CLIENT_ID === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 CASDOOR_CLIENT_ID", path: ["CASDOOR_CLIENT_ID"] });
    }
    if (value.CASDOOR_CLIENT_SECRET === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 CASDOOR_CLIENT_SECRET", path: ["CASDOOR_CLIENT_SECRET"] });
    }
    if (value.CASDOOR_ORG_NAME === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 CASDOOR_ORG_NAME", path: ["CASDOOR_ORG_NAME"] });
    }
    if (value.INTERNAL_SYNC_TOKEN === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 INTERNAL_SYNC_TOKEN", path: ["INTERNAL_SYNC_TOKEN"] });
    }
    if (value.S3_ACCESS_KEY === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 S3_ACCESS_KEY", path: ["S3_ACCESS_KEY"] });
    }
    if (value.S3_SECRET_KEY === "") {
      context.addIssue({ code: "custom", message: "生产环境必须配置 S3_SECRET_KEY", path: ["S3_SECRET_KEY"] });
    }
    if (value.ONLYOFFICE_JWT_SECRET === "") {
      context.addIssue({
        code: "custom",
        message: "生产环境必须配置 ONLYOFFICE_JWT_SECRET（与 DocServer JWT_SECRET 同值）",
        path: ["ONLYOFFICE_JWT_SECRET"],
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.join(".") || "(root)") + "：" + issue.message)
      .join("；");
    throw new Error("环境变量校验失败 —— " + detail);
  }
  return parsed.data;
}
