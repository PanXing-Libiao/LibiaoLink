# PoC-2 回放证据（企微通道：免登可用 / 应用消息送达 / 群通道送达 / 限速实测）

> 卡片：i6 · S8·M5-03（PoC-2 · 主责 lan，评审 wmj / px）｜验收口径 = `docs/M5-03-实施方案(企微通道).md` §一 目标四条 + §八 验证与验收；依赖先决见 `docs/M5-03-外部依赖清单(企微通道).md`。
> 状态：**真机段已回填（Push 228 · 2026-10-13）** —— M5-03-1 ~ M5-03-3 的 stub / 回放证据已随各刀 CI 落地；**真机实测（群通道）T2 ~ T5 + T4R（重拉恢复）全通过**（T1 单聊面因范围调整暂缓）—— 断言明细见 §二、落痕见 §五；**T5 反向发现（告警复报）修复已随 Push 229 落地**（见 §二 T5+ 行）；**T5 复报收敛真机复验完成（Push 231 · 2026-10-13 14:28 ~ 14:51 · T5R / T5R2）**：告警群仅 1 条 + 探针 5 轮零复报 + 重拉恢复送达 —— 见 §二 T5R / T5R2 行；**M5-03 收口（Push 232 · 2026-10-13）：本证据随方案收口归档** —— 群通道范围全部闭环；单聊面（T1）挂起（随重启另测）；**单聊面重启（aibot · Push 240 · 2026-10-15）：DM-1 ~ DM-4 本机真机全过**（未激活 846607 → dead + 降级（B6 终稿）/ 激活后送达 / 重启持久 / 限速 deferred + 断连 retryable）+ 幂等复放 + **P5 限速实测（单聊窗口 = 30 条/分钟）** —— 单聊 aibot 断言见 §二 DM 行、落痕见 §六；**绑定码链路（BC-1 ~ BC-4 · 2026-10-16 · 部署等价执行 · 本机真机）全过**（含空库迁移演练 54 件无漂移）—— 断言见 §二 BC 行（口径件 §12）、落痕见 §七。
> `docs/` 属 px 线：本文件由 lan 代记，**请 px 复核**（先例：`docs/PoC-4-回放证据(Outbox投递语义).md` 等 12 份 `docs/PoC-*` 证据）。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-10-13 11:12 ~ 11:36（+08:00 · 本机真机段）+ 14:28 ~ 14:51（+08:00 · T5 复报收敛复验 · Push 231）+ 2026-10-15 13:57 ~ 14:16（+08:00 · 单聊 aibot 真机段 · Push 240） |
| 环境 | 真企微环境（智能机器人长连接 · 真机器人）+ 本机 Windows / Docker Desktop + PG `libiaolink-pg` @ `127.0.0.1:55432`（worker 真机消费）；测试群 A（`wrsu…aKSg`）+ 告警群（`wrsu…9vww`）—— 掩码口径；单聊段（2026-10-15）= 同一真企微环境 + 未激活测试账号（userid 掩码 `wosu…bmUw` · 32 字符）+ 告警群（`wrsu…9vww`） |
| 数据库 | 群段（2026-10-13）= 迁移至 `0046` 无漂移；单聊段（2026-10-15 · Push 240）= 迁移至 `0053` 无漂移（单聊激活表 `0048` 已落 · 真机段未改 schema） |
| 代码版本 | 真机段 = `lan` @ `35f5ef1`（Push 227 · PR #322 时点 `dist` 构建；真机段零代码改动）；复验段（T5R / T5R2）= Push 230 时点构建（含 Push 229 修复 + Push 230 文案 · `lan` @ `b81b724`）；单聊段（Push 240）= `lan` @ `dcfa901` 时点 `dist` 构建（2026-10-15 13:54 · 含 Push 235 ~ 239 全部落地 —— 契约 / 迁移 / 实现 / 接线 / B6 终稿；真机段零代码改动） |
| 脚本（stub / 回放段） | `m5-03-1-wecom-stub-replay.mjs`（21 断言）/ `m5-03-2-aibot-stub-replay.mjs`（20 断言）/ `m5-03-2-group-replay.mjs`（28 断言）/ `m5-03-3-app-replay.mjs`（29 断言）/ `s7-4-automation-wiring-replay.mjs`（23 断言）；真机段 = `server/dist/entry/worker.js` 真实消费（证据 = §五 落痕 + 群内目视）；单聊段（Push 240）= 同一 worker 真实消费 + 仓外探针（`dm-capture` / `dm-evi` / `dm-burst` · 证据 = §六 落痕 + 企微目视） |
| 口径 | 三分类（permanent / retryable / rate_limited）+ token 特例；群通道 = 智能机器人 + `chatid`（P5 定案 2026-10-12）；限速 = 群通道按会话 30 条/分钟 + 1000 条/小时（env 默认值 · T3 实证判定链；A5 应用面随单聊面暂缓）；告警出口 = 智能机器人告警群（失败 / 未配置回退结构化日志；真机段实测成功 · T5） |

## 一、验收四条对照（§一 目标 → 证据）

| # | 验收目标 | 现状 | 证据 |
|---|---|---|---|
| ① | 免登可用（SSO 已具备） | 已具备（引用 `docs/实测报告(SSO接入验证).md` 与正式环境 Provider 事实） | 不随本回放（引用既有实测报告） |
| ② | 企微应用消息送达记录 | **已改口径重启（2026-10-14 项目组决定：单聊推送改走智能机器人（aibot）· 自建应用保留备用 · ADR-033）→ 单聊 aibot 真机通过（2026-10-15 · DM-2 / DM-3）** | §二 DM-2 / DM-3 行 + §六 落痕；应用消息 stub 侧 = `m5-03-3-app-replay.mjs`（备用通道保留） |
| ③ | 群通道送达记录（智能机器人 + chatid） | **已真机通过**（T2 / T3 / T4 / T4R：绑定 → 送达 → 移出死信 → 重拉恢复全链路） | §二 T2 ~ T4R + §五 落痕；stub / Spike 侧 = `m5-03-2-aibot-stub-replay.mjs` / `m5-03-2-group-replay.mjs` + §五 5.3A（2026-10-10 ~ 10-13） |
| ④ | 限速配置实测不超限 | **已真机通过**（T3 群 + DM-4a 单聊：窗口满额 → 延期重排 → 窗口翻转自动送达；`deferred` 不消耗重试；**P5 单聊 burst 实测 30 条/分**） | §二 T3 / DM-4a / P5 行 + §五 / §六 落痕；Spike 已实测 846607 触发 / 恢复窗口（实施方案 §五 5.3A） |

## 二、断言明细（真机实测逐行转写 · 群段已回填 2026-10-13 / 单聊 aibot 段 2026-10-15）

| 结果 | 编号 | 断言 | 期望 | 实际 |
|---|---|---|---|---|
| 范围外 | T1 | 应用消息：真实企微送达（A1 / A2 / A3） | errcode=0 + 接收端可见 | 2026-10-13 范围调整：单聊面暂缓 → 2026-10-14 项目组决定单聊推送改走智能机器人（aibot）· 自建应用保留备用（ADR-033）—— 应用消息面不恢复实测（D6 回退时再启用）；单聊面替代实测 = DM-1 ~ DM-4（aibot · 本表下方） |
| 通过 | T2 | 群通道：绑定 → 推送全链路（B1） | errcode=0 + 群内可见 | 2026-10-13 11:15：绑定（`chatid` 32 字符 · 掩码 `wrsu…aKSg`）→ outbox `#8998` → 受理成功（errcode=0）→ `deliveries#2 sent`；**群内可见（用户确认）**；注：首次消费撞长连接建立中 → 重试 1 次后成功（`attempts=1`） |
| 通过 | T3 | 限速：窗口内不触发 846607；触发后延期重排（B1） | 无超限丢消息；`deferred` 不消耗重试 | 2026-10-13 11:22：预置分钟窗口满额（count=30）→ 第 31 次拒 → 延期重排至 03:23:00Z（`attempts=0` · `deliveries#3 deferred`）；11:23:00 窗口翻转 → 11:23:01 自动送达（`#8999 done` · `deliveries#4 sent` · 新窗口 count=1）；**群内可见（用户确认）** |
| 通过 | T4 | 失败面：移出群 93001 → dead + 降级（B4）+ 告警 | 站内信 + 告警群留痕 | 2026-10-13 11:33：用户移出机器人 → outbox `#9000` → `errcode=93001 not allow send msg in room`（permanent）→ dead（无重试退避）；降级站内信 `notifications#33`（项目经理 · unread · 「【项目群播报未送达，已降级为站内信】」前缀 + 原文）；死信告警即时推送（见 T5） |
| 通过 | T4R | 移出后重拉恢复（追加项 · §九 风险 ④ 链路闭环） | 重拉免激活 + 推送恢复 | 2026-10-13 11:36：用户重拉机器人 → outbox `#9001` → 受理成功（errcode=0 · 0 重试）→ `deliveries#6 sent`（11:36:16）；**群内可见（用户确认）** |
| 通过 | T5 | 告警出口：告警群推送 / 未配置或失败回退日志（B2） | 推送成功；回退可用 | 2026-10-13 11:33：告警群收到 `【LibiaoLink 告警】outbox.dead`（用户确认）；日志「告警已推企微告警群：outbox.dead · chatid ****9vww」；回退路径群段未触发（由实现 + 单测承担）；**单聊段副观察（2026-10-15 · DM-4b）：回退路径真实触发 1 次**（恢复真连接重启瞬间探针告警撞「长连接未就绪」→ `WecomAlertSink` 回退结构化日志 · 见 §六） |
| 通过 | T5R | **复报收敛复验**：移出群后死信告警「即时 1 条 + 探针零复报」 | 告警群只收 1 条；窗口内不复报 | 2026-10-13 14:28：移出机器人 → outbox `#9060` → `93001`（permanent）→ dead（attempts=1 · `last_error`=「群播报未送达（errcode=93001：机器人已被移出群）」· **新文案**）+ 降级 `notifications#43`；告警群即时 1 条（**用户确认**）；探针 5 轮（14:30 / 14:35 / 14:40 / 14:45 / 14:50）**零复报** —— 14:30 轮命中同族抑制（仅日志），其后按水位线静默过滤；修复前同一死信共推 4 条 |
| 通过 | T5R2 | 复验收尾：重拉恢复推送 | errcode=0 + 群内可见 | 2026-10-13 14:51：用户重拉机器人 → outbox `#9061` → 受理成功（errcode=0 · attempts=0）→ `deliveries#8 sent`；**群内可见（用户确认）**；死信 `#9060` 保持 dead（不自动清 —— 人工处置口径） |
| 通过 | DM-1 | 单聊：未激活推送 → 846607 → dead + 降级（C5-04）+ 告警 | dead + 站内信（B6 前缀）+ 告警群 1 条 | 2026-10-15 14:01（+08:00）：`enter_chat` 捕获 userid（掩码 `wosu…bmUw`；仅打开不发言 ≠ 激活）→ outbox `#9104 dead`（attempts=1）· `deliveries#15 dead`（wecom_aibot）→ 降级 `notifications#53`（`:c504` · **B6 终稿前缀真实落库**）+ 告警群推送 1 条（用户确认） |
| 通过 | DM-1R | 幂等复放：同事件重放 → 站内信不重发 + 告警窗口内抑制 | 不重发 / 不重复告警 | 2026-10-15 14:02：重放同事件（状态回退重醒 · available_at 06:02:05Z）→ 再 dead（`#9104` 终态 06:02:10Z）· `deliveries#16 dead`（每次失败一行留痕）→ **站内信未重发**（`:c504` 唯一键命中 · `notifications` 计数保持 1）→ 告警抑制（日志「告警抑制（outbox.dead · 族 outbox.dead，窗口内已推）」）—— 告警群仍仅 1 条（用户确认） |
| 通过 | DM-2 | 单聊：激活后推送送达 | errcode=0 + 企微可见 | 2026-10-15 14:06：用户向机器人发消息（06:06:01.759Z）→ 激活行 `#5`（user_id 反查命中）→ outbox `#9106 done` · `deliveries#17 sent`（06:06:46.086Z）；**企微可见（用户确认）** |
| 通过 | DM-3 | 单聊：worker 重启后激活态持久 → 送达 | 表命中 + errcode=0 | 2026-10-15 14:07：停 worker → 重启（长连接重订阅）→ outbox `#9107 done` · `deliveries#18 sent`（06:07:26.563Z）；**企微可见（用户确认）** |
| 通过 | DM-4a | 单聊限速：窗口满额 → deferred（不消耗重试）→ 窗口翻转自动送达 | deferred 重排 + 自动送达 | 2026-10-15 14:08：预置 `single:c35d5d826006:w60000` count=30 → 第 31 次拒（31/30）→ `deliveries#19 deferred`（attempts=0 · available_at 06:09:00Z）→ 窗口翻转自动送达 `#9108 done` · `deliveries#20 sent`（06:09:01.901Z）；**企微可见（用户确认）** |
| 通过 | DM-4b | 单聊断连窗口：长连接未就绪 → retryable → 重连后排定重试自动送达 | retry 收敛；不丢事件、不误报成功 | 2026-10-15 14:09：以不可达 `WECOM_BOT_WS_URL=ws://127.0.0.1:9/` 重启模拟断连 → `#9109` 两次失败（`deliveries#21/#22 failed` · backoff 15s / 30s）→ 恢复真连接重启 → 排定重试自动送达 `#9109 done`（attempts=2）· `deliveries#23 sent`（06:10:29.779Z）；无死信、无降级、零丢失；**企微可见（用户确认）** |
| 通过 | P5 | 单聊限速边界实测（burst 直发 · 绕过本地桶） | 窗口值实测 → 是否拆独立 env | 2026-10-15 14:15：40 条计划（gap 250ms）→ 前 30 条 errcode=0 · **第 31 条起 846607**（连续 3 次拒绝提前终止）→ **单聊窗口 = 30 条/分钟**（与本地窗口值对齐 · 暂不拆独立 env）；汇总 = 仓外 `dm-burst.summary.json`（delivered 30 / refused846607 3 / firstFailIndex 31） |

## 三、依赖先决（阻塞真机段 · 见依赖清单）

- A1 应用凭据 / A2 可信 IP / A5 频率配额 —— **作废（2026-10-14 单聊面重启改走 aibot：长连接出网，无应用消息 API / 白名单 / 配额前置）**；A3 改「机器人启用范围」口径 —— **本机真机段已用测试账号完成（2026-10-15 · DM-1 ~ DM-4）；生产 rollout 前确认覆盖接收人（测试机复证随群先例 · 正式上线前 · 不阻塞）**。
- B1 测试群（机器人进群 + 激活 + `chatid` 落库）/ B2 管理员告警群 —— **B1 接入方式已定案（2026-10-12）· 测试群可复用；B2 已落实（2026-10-13：告警群 + 机器人激活 · `chatid` 已提供）**；**B6 单聊激活指引话术 —— 已提供（终稿 2026-10-15）· DM-1 降级站内信真实落库（见 §六）**。
- C2 密钥注入渠道 / C3 真机落点（测试环境到企微 API 可达性）—— **本机已具备（2026-10-13 真机段实证：`server/.env` 注入 · git 忽略；长连接 + 实发成功）；生产注入随部署方案**；**单聊段（2026-10-15）复用同注入 / 同可达性（无新增依赖项）**。

## 四、复跑（stub / 回放段 · 本机 / CI）

```bash
cd server && node scripts/m5-03-1-wecom-stub-replay.mjs
cd server && node scripts/m5-03-2-aibot-stub-replay.mjs
cd server && node --env-file-if-exists=.env scripts/m5-03-2-group-replay.mjs
cd server && node scripts/m5-03-3-app-replay.mjs
cd server && node --env-file-if-exists=.env scripts/s7-4-automation-wiring-replay.mjs
```

退出码 0 = 断言全过（可当门禁）。

## 五、落痕（本机 PG · 2026-10-13 真机段）

| 编号 | 落痕（outbox / notify_deliveries / notifications） |
|---|---|
| T2 | `outbox #8998 done`（attempts=1 —— 首次消费撞长连接建立中 · 重试 1 次后成功）；`notify_deliveries #2 wecom_group sent`（03:15:45Z）；群内可见（用户确认） |
| T3 | `notify_rate_counters` 预置 `group:c87de8b66fd5:w60000` @03:22Z count=30 → `outbox #8999` 首轮 `deferred`（attempts=0 · available_at=03:23:00Z · 日志「延期重排（不消耗重试次数，至 2026-10-13T03:23:00.000Z）」）→ 窗口翻转自动重试 → `#8999 done`（attempts=0）；`deliveries #3 deferred` / `#4 sent`（03:23:01Z）；新窗口 count 重置 = 1；群内可见（用户确认） |
| T4 | `outbox #9000 dead`（errcode=93001 permanent · 日志「群播报确定性失败（转 dead）」）；`deliveries #5 dead`；降级 `notifications #33`（type=reminder · source_dedupe_key=`M5-03-PoC2:T4:2026-10-13:c504` · unread）；告警日志「告警已推企微告警群：outbox.dead · chatid ****9vww」 |
| T4R | `outbox #9001 done`（attempts=0）；`deliveries #6 sent`（03:36:16Z）；群内可见（用户确认） |
| T5 | 告警群收到 `【LibiaoLink 告警】outbox.dead`（用户确认） |
| T5+（同场发现 · 非计划项） | 探针路径复报实证：`outbox.dead_letter` ×3 —— 11:37:45 / 11:42:45 / 11:47:45（每 5 分钟一轮 · 同一死信 `#9000`）；成因 = 探针状态口径 + 抑制窗口（5 分钟）恰等于探针周期（5 分钟）竞态穿透 + 即时 / 探针 code 分离；已登记方案 §九；**修复已落地（Push 229）**：探针死信水位线 + 抑制窗口 15 分钟 + 死信同族抑制 |
| T5R | `outbox #9060 dead`（attempts=1 · 新文案 `last_error`）；`deliveries #7 dead`（wecom_group · 测试群）；降级 `notifications #43`（`source_dedupe_key=M5-03-PoC2:T5R:2026-10-13:c504`）；告警日志「告警已推企微告警群：outbox.dead · chatid ****9vww」（14:28:05）+ 抑制日志 1 条（14:30:04 · `outbox.dead_letter` · 族 `outbox.dead`）；其后 4 轮探针（14:35 ~ 14:50）零输出 —— 复报收敛（修复前共 4 条） |
| T5R2 | `outbox #9061 done`（attempts=0）；`deliveries #8 sent`（06:51:27Z）；群内可见（用户确认） |

> 运行时口径：worker = `server/dist/entry/worker.js`（`server/.env` 注入 · git 忽略 · 真机段零代码改动）；限速桶键 = `group:<chatBucketId>:w60000` / `:w3600000`（`chatBucketId` = sha256(chatid) 前 12 位 —— 计数键 / 日志不含 chatid 明文）；chatid 一律掩码（`wrsu…aKSg` / `wrsu…9vww`）。
> 告警文案：T4 / T5 / T5+ 样本为修复当日原文（含企微 errmsg 机器尾巴 / detail JSON）；文案已于 **Push 230** 收敛为核心语义口径（`code + message` · 见方案 §九 / §十）；**T5R 复验（2026-10-13 14:28）起按新文案实证** —— `outbox 死信：notify.group#9060（M5-03-PoC2:T5R:2026-10-13）—— 群播报未送达（errcode=93001：机器人已被移出群）`（用户确认收到）。

## 六、落痕（单聊 aibot · 2026-10-15 真机段）

| 编号 | 落痕（outbox / notify_deliveries / notifications / 激活表） |
|---|---|
| 账号获捕 | 仓外探针 `dm-capture`：`enter_chat`（chattype=single）回调捕获 userid（32 字符 · 掩码 `wosu…bmUw`）；**仅打开不发言 = 不激活**（DM-1 846607 实证） |
| DM-1 | `outbox #9104 dead`（attempts=1 · last_error=「单聊消息未送达（errcode=846607：会话未激活或发送超频）」）；`deliveries #15 dead`（channel=wecom_aibot · target=`wosu…bmUw`）；降级 `notifications #53`（type=reminder · status=unread · merged_count=1 · `source_dedupe_key=M5-03-PoC2:DM1:2026-10-15:c504` · 正文 =「【企微未送达，已转站内信】/ 当前机器人未激活，请私发任意消息给机器人即可激活。/ ……」（**B6 终稿真实落库**））；告警日志「告警已推企微告警群：outbox.dead · chatid ****9vww」（06:01:46Z） |
| 幂等复放（DM-1R） | 同事件重放（`dedupe_key` 状态回退重醒 · available_at 06:02:05Z）→ 再 dead（`#9104` 终态 06:02:10Z · attempts=1）→ `deliveries #16 dead`（每次失败一行留痕 —— 0046 语义）→ **站内信未重发**（`:c504` 唯一键命中 · `notifications` 计数保持 1）→ **告警抑制**（日志「告警抑制（outbox.dead · 族 outbox.dead，窗口内已推）」）—— 告警群仅 1 条（用户确认） |
| DM-2 | 用户向机器人发消息（06:06:01.759Z）→ 激活 `wecom_aibot_dm_activations #5`（user_id 反查命中）→ `outbox #9106 done`（attempts=0）· `deliveries #17 sent`（06:06:46.086Z）；企微可见（用户确认） |
| DM-3 | 停 worker → 重启（长连接重订阅）→ 激活态持久 → `outbox #9107 done` · `deliveries #18 sent`（06:07:26.563Z）；企微可见（用户确认） |
| DM-4a | `notify_rate_counters` 预置 `single:c35d5d826006:w60000` @06:08Z count=30（桶键 = `single:` + sha256(userid) 前 12 位）→ 第 31 次拒（31/30）→ `outbox #9108` 首轮 `deferred`（attempts=0 · available_at 06:09:00Z · 日志「延期重排（不消耗重试次数，至 2026-10-15T06:09:00.000Z）」）→ 窗口翻转自动送达 → `#9108 done` · `deliveries #19 deferred` / `#20 sent`（06:09:01.901Z）；企微可见（用户确认） |
| DM-4b | **做法如实记录**：停 worker → 以不可达 `WECOM_BOT_WS_URL=ws://127.0.0.1:9/` 重启模拟断连 → `#9109` 派发时 state≠subscribed → retryable「长连接未就绪」→ 2 次失败（`deliveries #21 failed` / `#22 failed` · backoff 15s / 30s）→ 恢复真连接重启 → 排定重试自动送达 `#9109 done`（attempts=2）· `deliveries #23 sent`（06:10:29.779Z）；无死信、无降级、零丢失；**副观察**：恢复瞬间探针告警撞「长连接未就绪」→ `WecomAlertSink` 回退结构化日志 1 条（告警回退路径真实触发） |
| P5（burst 探针） | raw 帧直发（仓外 `dm-burst.mjs` · 绕过本地限速桶）：40 条计划（gap 250ms · 06:15:30Z 起）→ 前 30 条 errcode=0 · **第 31 条起 846607**（连续 3 次拒绝提前终止）→ **单聊窗口实测 = 30 条/分钟**（与本地窗口值 30 条/分 + 1000 条/时对齐 · 暂不拆 `WECOM_BOT_DM_*` env）；汇总 = `dm-burst.summary.json`（delivered 30 / refused846607 3 / firstFailIndex 31 / sentWindowApprox 30） |

> 运行时口径（单聊段 · Push 240）：worker = `server/dist/entry/worker.js`（`server/.env` 注入 · 凭据仓外 · git 忽略）；**本刀零代码 / 契约 / 迁移改动**（纯证据回填 + 收口）；userid 一律掩码（`wosu…bmUw` · 32 字符）；限速桶键 = `single:<digest12>`（digest = sha256(userid) 前 12 位 —— 计数键 / 日志不含 userid 明文）。
> P6 核（同场 · 2026-10-15）：单聊「用户移除 / 屏蔽」未触发独立错误码 —— 未收录码一律 retryable 兜底（有界收敛 → dead + 告警；DM-4b 实证 retryable 路径）+ 846607 按激活态分流（未命中激活表 = permanent）与 `wecom.errors.ts` 现状一致（无代码改动 —— 详见单聊执行计划 §8 v1.7）。
> 与群段关系：§五 = 2026-10-13 群通道真机段落痕；本节 = 2026-10-15 单聊 aibot 真机段落痕（同一证据文件续记）。测试机复证：单聊侧与群先例（B1 各群推广）合并 · 正式上线前执行（2026-10-15 口径）。

## 七、落痕（绑定码链路 BC-1 ~ BC-4 · 2026-10-16 · 部署等价执行 · 本机真机）

> **执行时点口径（2026-10-16 · 项目组）**：部署刀仍暂缓 → 先做「部署等价执行」：本机 api（3001）+ 本机 worker（`server/dist/entry/worker.js` · 真企微**新机器人**长连接）+ 真 PG（`0055`）把部署后要跑的断言先拿到；服务器复跑随部署刀（口径件 §12）。

| 编号 | 落痕（`outbox_events` / `notify_deliveries` / `notifications` / 绑定表 / worker 日志） |
|---|---|
| 前置 | 本机库水位 `0055`（`schema_migrations` 54 件，无漂移）；**空库全量演练**：新建空库 → `node scripts/migrate.mjs` 54 件全过（`0055` 3 ms）→ 复跑「已执行 54 个迁移，无漂移」；`check:db-schema` 通过（52 表 / 510 列 / 161 索引唯一 / 168 CHECK 与 Drizzle 一致）；演练库用毕即删。worker 日志「企微智能机器人长连接已启动（群 + 单聊通道：订阅 + 心跳 + 会话激活 ingest）」 |
| BC-1 | 系统内取码（`POST /api/v1/wecom-dm-binding/codes` · 真会话）→ 码 `927252`（`expiresInSeconds=600` · 库内 `pending`）→ 企微侧对**新机器人**单聊发码 → worker 日志「单聊绑定成功（绑定行 = bot_id + userid 掩码）：userid ****Wkig · user_id 904f6153…」；库内码行 `status=used` · `used_at` 非空 · `used_wecom_userid` 32 字符（末 4 位 `Wkig`）；绑定行 `#35` = `bot_id`（`WECOM_BOT_ID` 原文）+ `wecom_userid`（密文）+ `bound_at=2026-10-16 07:39:15.419Z`（非空） |
| BC-2 | 绑定后触发单聊推送（`notify.message` · `channel=wecom_aibot` · 收件人 = 绑定用户）→ `outbox #9204 done`（attempts=0）· `notify_deliveries #44 sent`（`channel=wecom_aibot` · `target` 末 4 位 = 绑定行密文 `Wkig` · `sent_at=2026-10-16 07:40:47.224Z`）—— 发送地址 = 绑定行密文 `open_userid`（**不再用 `users.username` 明文**）；**未产生降级站内信**（该用户站内信仅 BC-4 一条 = 换机器人后预期） |
| BC-3 | 未绑定用户（`px-replay`）触发 → `outbox #9203 dead`（attempts=1 · `收件人未绑定企业微信（无可投递地址）`）· `notify_deliveries #43 dead`（**attempts=0 = 未发帧** · 同因）· 降级 `notifications #79`（`source_dedupe_key=M5-03-5:BC3:2026-10-16:001:c504` · 前缀 = D4 终稿「当前用户未绑定企业微信，请前往设置补绑」）；worker 日志「单聊消息收件人未绑定企微（确定性失败转 dead · 不发帧）」+「单聊消息失败已降级站内信」+ 死信告警（告警群通道 `rate_limited` → 回退结构化日志：回退路径真实触发） |
| BC-4 | **换机器人**（`WECOM_BOT_ID` / `WECOM_BOT_SECRET` 换另一对重启 worker · 口径 §8「env 变化即新机器人」）→ 同用户再触发 → `outbox #9205 dead`（attempts=1）· `notify_deliveries #45 dead`（`target=user:<uuid>` = **无地址** · attempts=0 = 未发帧）· 降级 `notifications #80`（D4 终稿前缀）—— **不出现 846607 → `deferred` 空转**（R6 闭环：旧机器人激活行遗留导致的反复重排不复现）；跑毕恢复真凭据重启（长连接复起） |

- 与 BC-3 对照：BC-4 的差异只在「该用户有绑定行、但 `bot_id` 不匹配」→ 与 BC-3 同收口（permanent + `dead` + D4 降级），证实寻址口径按 `bot_id` 维度成立。
- 数据面：绑定表 1 行（`bound_at` 非空）；BC-3 / BC-4 降级站内信各 1 行（保留为落痕）；`outbox_events` / `notify_deliveries` 行保留（只读留痕）。

**§七 追加（2026-10-16 · 本地回归修复刀 Push 253）**：用户回执后拖出「部署仍暂缓」，转本地回归 —— 前端真机（真浏览器 + 真 PG + 真 api）报障三处，均在本机复现并修复：① 绑定成功后设置页仍显示「未绑定」（服务端读面实测正确 → 前端补轮询 / 重读 / 手动刷新）；② 点「复制」恒失败（`http://<局域网IP>` 下 `navigator.clipboard === undefined` → 补 `execCommand` 回退）；③ 取码 3 次后被罚 2000+ 秒（频率口径修订 **3 次 / 小时 → 5 次 / 10 分钟**，429 倒计时改「N 分 N 秒」）。回归证据 = `frontend/scripts/ui-wecom-binding-e2e.mjs` **44 / 44 全过 + 零残留**（真浏览器 + 真 PG + 真 api；含非安全上下文复制通道与绑定态自动刷新两项新断言）+ server `m5-03-5-dm-replay` **PASS 54 / FAIL 0**。**服务器部署仍暂缓**（项目组 2026-10-16）—— 本节 BC-1 ~ BC-4 仍为**本机 api / worker** 落痕，服务器复跑随部署刀。
- **用户回执（2026-10-16 · 已收到）**：BC-1 会话内回执「绑定成功」与 BC-2 送达的**企微可见性** = 用户侧确认可见 —— BC-1 ~ BC-4 真机项闭环。<br>未覆盖：服务器侧执行（迁移 `0055` / `dist` 重传 / 凭据回填 / 重启）仍暂缓，部署后按口径件 §12 复跑本组四项。
- **§七 追加（2026-10-16 · 绑定三问题修复刀 Push 254）**：PR #443 合并后用户真机报三问题，均在本机复现并修复 —— ① **绑定后设置页仍显示「未绑定」**：根因 = 服务端 `ingestCallback` 见「该企微号已绑定」即短路回「已绑定」、不读用户当前所发之码（现场：企微号 `wosu…Wkig` 早挂在老测试账号 `user_id=904f6153-9fbb-46bf-a417-3b1efc9bbab6` 名下 · 绑定行 `#35`；新账号取码后发码恒走短路 → 码 `#44` / `927252` 永不消费）→ **删短路 + 以「码持有者」为准**（跨用户换绑 + `recordRebind` 写 `audit_logs`；同一码重复投递 = 幂等回「绑定成功」）；② **取码罚时 1 小时过长** → **D3 修订：罚时窗口 10 分钟 → 3 分钟 + TTL 10 分钟 → 5 分钟**；③ **刷新后绑定码 / 罚时丢失、失效无提示** → 读面回填 `bindingCode` + `retryAt` + 前端刷新保留 + 码失效提示「绑定码已失效，请重新获取」。回归证据 = `frontend/scripts/ui-wecom-binding-e2e.mjs` **46 / 46 全过 + 零残留**（含刷新后绑定码仍在 / 刷新后罚时倒计时仍在两项新断言）+ server `m5-03-5-dm-replay` **PASS 58 / FAIL 0** + `vitest` 74 文件 / 1120 例。**服务器部署仍暂缓**（项目组 2026-10-16）。
