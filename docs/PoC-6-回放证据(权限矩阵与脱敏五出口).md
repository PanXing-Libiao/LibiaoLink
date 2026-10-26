# PoC-6 回放证据（权限矩阵与脱敏五出口）

> **2026-10-26 历史证据**：本文记录旧角色权限判定；对应脚本已删除，不能按当前代码复跑。当前权限口径以部门规则为准。

> 卡片：h6 · S6·PoC-6（主责 wmj，协办 px）｜验收口径见 团队分工.md §6 第 6 行：字段级 / 记录级 / 导出 / 搜索 / 通知五类出口自动化用例全绿。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-09-20 15:57:17 +08:00 |
| 目标 | http://127.0.0.1:3011 |
| 数据库 | postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink |
| 代码版本 | ee76d8f |
| 受限账号 | ea6eff88-4b3e-4df1-9ce0-02ffb14fed69 |
| 脚本（已删除） | server/scripts/poc6-replay.mjs |

## 断言明细

| PASS | S1 | 管理员会话可用（授权画像） | 
  - 期望：200 + dataScopes 含 all
  - 实际：200 {"roleCodes":["admin"],"dataScopes":["all"],"keys":24}
| PASS | S2 | 受限账号会话可用（全局位，项目位需项目上下文） | 
  - 期望：200 + 不含 all 数据范围
  - 实际：200 roleCodes=[] keys=0
| PASS | S3 | 受限账号无项目级写权限位（越权拒绝基准账号） | 
  - 期望：不含 project.create / project.update / project.delete / member.manage / node.advance / node.rollback / node.create / node.delete
  - 实际：无越权键位（keys=空）
  - 说明：账号 lisi（ea6eff88-4b3e-4df1-9ce0-02ffb14fed69）；如需指定其他最小权限账号用 --actor
| PASS | R1 | 建回放项目（管理员；项目经理 = 管理员本人） | 
  - 期望：201 + 返回项目 id
  - 实际：201 {"id":"e7900d39-bc4f-4720-9ba3-5d7a87195cab","stageKey":"presale","version":0}
| PASS | R2 | 记录级·对照：管理员（data_scope=all）列表中可见 | 
  - 期望：200 + q=编号命中 1 条
  - 实际：200 total=1 命中=1
| PASS | D1 | 记录级·列表裁剪：非名册账号看不到该项目 | 
  - 期望：200 + 命中 0 条
  - 实际：200 total=1 命中=0
| PASS | D2 | 记录级·详情：不可见 → 404（防 IDOR，不暴露存在性） | 
  - 期望：404 NOT_FOUND
  - 实际：404 {"code":"NOT_FOUND","message":"项目不存在或不可见","details":[],"traceId":"544895df-538f-44ea-852b-e48bfedd5a36"}
| PASS | D3 | 记录级·子资源同一谓词：tasks / flow / summary / members 全 404 | 
  - 期望：四项均 404
  - 实际：404 / 404 / 404 / 404
| PASS | D4 | 记录级优先于功能权限：不可见项目的写请求也是 404（不是 403） | 
  - 期望：404 NOT_FOUND
  - 实际：404 {"code":"NOT_FOUND","message":"项目不存在或不可见","details":[],"traceId":"b601c59d-40d6-4bfb-97b0-de13d25f0eeb"}
| PASS | R3 | 记录级·名册即来源：加入名册立即 200（不需等策略缓存 TTL） | 
  - 期望：200 + 同一项目 id
  - 实际：200 {"id":"e7900d39-bc4f-4720-9ba3-5d7a87195cab","name":"PoC-6 回放项目"}
| PASS | R4 | 记录级·列表与详情同一谓词：加入后列表可见（无两套口径） | 
  - 期望：命中 1 条
  - 实际：200 total=2 命中=1
| PASS | G4 | 成员平权·读：名册成员可读项目流程快照（阶段 + 节点） | 
  - 期望：200 + 阶段与节点非空
  - 实际：200 stages=9 nodes=19
| PASS | F1 | 功能权限·可见但无权限位 → 403（改项目（project.update）） | 
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：project.update","details":[],"traceId":"7eea3eb8-9ce9-4d32-adb4-6d7c139a7088"}
| PASS | F2 | 功能权限·可见但无权限位 → 403（管名册（member.manage）） | 
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：member.manage","details":[],"traceId":"18578f75-2946-46a5-9d4b-b20fa0b33fc7"}
| PASS | F3 | 功能权限·可见但无权限位 → 403（阶段推进（node.advance）） | 
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：node.advance","details":[],"traceId":"92071739-d483-44a7-8abd-98cd292ac8fc"}
| PASS | F4 | 功能权限·可见但无权限位 → 403（增补节点（node.create）） | 
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：node.create","details":[],"traceId":"1ed81e86-c6ef-4291-8c30-b27953909a80"}
| PASS | F5 | 功能权限·可见但无权限位 → 403（删项目（project.delete）） | 
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：project.delete","details":[],"traceId":"6c9714b1-6086-4197-98d7-0af8ab1e5b2f"}
| PASS | G1 | 准备：管理员建一条回放任务（随项目清理） | 
  - 期望：201 + 返回任务 id
  - 实际：201 {"id":"10a8bfb2-cf25-4e5c-89e3-978c6b09519b","version":0}
| PASS | G2 | 成员平权·任务进度：名册成员可更新进度（task.progress） | 
  - 期望：200 + progress=0.5
  - 实际：200 {"progress":0.5,"version":1}
| PASS | G3 | 成员平权·任务编辑：名册成员可改任务（task.update） | 
  - 期望：200 + note 写回
  - 实际：200 {"note":"PoC-6 回放：成员平权写备注","version":2}
| PASS | G5 | 成员平权·节点预检：/nodes/{id}/can-complete 放行（node.complete） | 
  - 期望：200 + canComplete 为布尔
  - 实际：200 {"canComplete":false,"missing":[{"docType":"技术协议","required":1,"present":0},{"docType":"合同","required":1,"present":0}]}
| PASS | X1 | 导出出口：管理员授权画像 = 契约枚举全量（project.export 在内的导出门控数据面） | 
  - 期望：含契约全部 24 键
  - 实际：admin keys=24 / 契约 24 / export=true
  - 说明：契约枚举取自 shared/generated/openapi.json（与 check:permission-matrix 同一来源）
| PASS | X2 | 字段级出口：受限账号键位是管理员键位的严格子集（联系方式等按角色裁剪） | 
  - 期望：actor keys 严格少于 admin 且无越集键位
  - 实际：actor=0 admin=24 越集=0
  - 说明：字段级投影（无权字段不返回 / 五出口同源）由 test/permission-matrix.test.ts 的策略层用例覆盖；联系方式键位 stakeholder.contact.view 在矩阵里只给管理员 / 项目经理 / 销售
| PASS | C1 | 收尾核对：回放数据与临时会话零残留 | 
  - 期望：projects / members / tasks / nodes / stages / outbox / sessions 全 0
  - 实际：{"projects":0,"members":0,"tasks":0,"nodes":0,"stages":0,"outbox":0,"sessions":0}
  - 说明：回放项目按 API 软删后硬删（沙箱不留调试数据）

## 汇总

- ✅ 全部断言通过（24 项）：记录级列表 / 详情 / 子资源统一 404、名册即刻可见、越权 403、成员平权 200、出口键位数据面成立、回放数据零残留。

## 验收对照（团队分工.md §6 第 6 行：五类出口自动化用例全绿）

- 「记录级」= D1 ~ D4 / R2 ~ R4：同一回放项目上，管理员可见、非名册账号在列表 / 详情 / tasks / flow / summary / members 上统一 404，加入名册后立即 200（列表与详情同一谓词）；不可见项目的写请求同为 404，不暴露存在性（ADR-011 不变量 3）。
- 「字段级」= X2 + 策略层用例：受限账号键位是管理员键位的严格子集；无权字段在策略层被裁掉（`test/permission-matrix.test.ts` 字段级 6 例：字段策略表 / 投影删字段 / 五出口同源）。干系人数据面随 j6，真机不造该实体。
- 「导出」= X1 + 策略层用例：管理员授权画像含契约枚举全量（含 `project.export`）；导出出口额外要求 `project.export`（策略层用例覆盖「无导出权 → 出口不放行」）。
- 「搜索」「通知」= 策略层用例：`planExit` 对 page / export / search / notify 四出口统一投影，`exitsConsistent` 断言五出口字段集一致（搜索 / 通知模块本身归 lan 线、尚未落地 —— 投影入口已就绪，模块落地后直接复用）。
- 「自动化用例全绿」= `cd server && node node_modules/vitest/vitest.mjs run`（`test/permission-matrix.test.ts` 34 例 + 全量 169 例 / 13 文件，随 `npm test` 常跑，不连库）。
- 复跑：已停用（脚本于 2026-10-26 删除）。

