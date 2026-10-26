# PoC-7 回放证据（字典 C9 与审计留痕 C7）

> **2026-10-26 历史证据**：本文记录旧角色权限判定；对应脚本已删除，不能按当前代码复跑。当前权限口径以部门规则为准。

> 卡片：h7 · S6·admin（主责 wmj，协办 lan）｜验收口径见 团队分工.md §6：字典唯一口径 + 审计留痕（谁 / 何时 / 对什么 / 从什么改成什么），越权留痕按对象与操作人可检索。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-09-23 17:51:39 +08:00 |
| 目标 | http://127.0.0.1:3001 |
| 数据库 | postgres://libiaolink_migrator@127.0.0.1:5433/libiaolink |
| 代码版本 | 2a9a09c |
| 管理员账号 | 02e76fdb-821a-4c62-9f38-3ec8d5189550 |
| 受限账号 | a1423de5-4774-457f-a93c-268261f954b5 |
| 回放字典条目 | region / POC7-20260923095138 |
| 脚本（已删除） | server/scripts/poc7-replay.mjs |

## 断言明细

| PASS | S1 | 管理员会话（dict.manage / audit.view 基准账号） |
  - 期望：200 + 键位含 dict.manage 与 audit.view
  - 实际：200 {"roleCodes":["admin","project_manager"],"hasDict":true,"hasAudit":true}
  - 说明：账号 吴孟杰（02e76fdb-821a-4c62-9f38-3ec8d5189550）
| PASS | S2 | 受限账号会话（越权拒绝基准账号） |
  - 期望：200 + 不含 dict.manage / audit.view
  - 实际：200 {"roleCodes":[],"keys":0}
  - 说明：账号 poc7-actor-20260923095121（a1423de5-4774-457f-a93c-268261f954b5）；--actor 可指定
| PASS | D1 | 默认下发只回启用项（前端启动拉一次） |
  - 期望：200 + region 字典非空且全部 enabled=true
  - 实际：200 {"types":["region","projectType"],"regionItems":10,"allEnabled":true}
| PASS | D2 | 读 = 登录即可：受限账号可读默认下发 |
  - 期望：200 + region 非空
  - 实际：200 types=2
| PASS | D3 | 管理口径：includeDisabled 无 dict.manage → 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"查看停用字典项需要 dict.manage","details":[],"traceId":"a0a51376-26a6-4f22-8f0a-bec5a8e5fb9e"}
| PASS | D3b | 越权留痕（C7-03）：403 写 result=denied 行 |
  - 期望：denied 行数 0 → 1
  - 实际：实际 1
  - 说明：检索口径：actorId + result=denied（写审计为异步补写，最多等 3s）
| PASS | D4 | 管理口径：管理员 includeDisabled=true 返回全集 |
  - 期望：200 + 条数 ≥ 默认下发（10）
  - 实际：200 regionItems=18 {"items":[{"type":"region","items":[{"code":"华东","name":"华东","sort":10,"enabled":false,"usageCount":0,"metadata":{}},{"c…
  - 说明：兼容参数：Push 173 起删除 = 物理删行，一期不再产生停用项，故两者相等（历史停用行见 D10b）
| PASS | D5 | 未知字典类型 → 404 NOT_FOUND |
  - 期望：404 NOT_FOUND
  - 实际：404 {"code":"NOT_FOUND","message":"未知字典类型：priority","details":[],"traceId":"328987a6-e17b-4a98-b82b-82fd84403914"}
| PASS | D5b | 噪声边界：普通读 404 不产生 denied 行（shouldRecordDenied） |
  - 期望：管理员 denied 行数不变（0）
  - 实际：实际 0
  - 说明：404 只记写请求与项目域路径（server/src/common/audit/audit-path.ts）
| PASS | D6 | 新增条目（dict.manage）：响应是更新后的整个字典（前端替换缓存） |
  - 期望：201 + 含 POC7-20260923095138（enabled=true）
  - 实际：201 {"type":"region","hit":{"code":"POC7-20260923095138","name":"PoC-7 回放区","sort":999,"enabled":true,"usageCount":0,"metadata":{}},"items":19}
| PASS | A1 | 按对象检索命中新增留痕（谁 / 何时 / 对什么 / 从什么改成什么） |
  - 期望：action=create + actorId=02e76fdb-821a-4c62-9f38-3ec8d5189550 + result=succeeded + changes 含 code
  - 实际：行数=1 {"action":"create","actor_id":"02e76fdb-821a-4c62-9f38-3ec8d5189550","actor_name":"吴孟杰","result":"succeeded","entry":"api","changes":[{"to":"POC7-20260923095138","from":null,"field":"code"},{"to":"PoC-7 回放区","from":null,"field":"name"},{"to":999,"from":null,"f…
  - 说明：等价 API：GET /api/v1/audit-logs?objectType=dict_item&objectId=region:POC7-20260923095138
| PASS | D7 | 同类型内码唯一：重复新增 409 DICT_ITEM_EXISTS |
  - 期望：409 DICT_ITEM_EXISTS
  - 实际：409 {"code":"DICT_ITEM_EXISTS","message":"该字典已存在同码条目：region/POC7-20260923095138","details":[],"traceId":"39c44db1-68aa-4943-9771-bff65c9036ab"}
| PASS | D8 | region 新增 = 登录即可（Push 168：地区是全站共享的公共标签）：受限账号可新增 |
  - 期望：201 + 含 POC7-20260923095138-X
  - 实际：201 {"code":"POC7-20260923095138-X","name":"受限账号新增区","sort":1000,"enabled":true,"usageCount":0,"metadata":{}}
| PASS | D8b | projectType 新增 = 仅管理员：受限账号 403 FORBIDDEN |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"新增该字典条目需要 dict.manage","details":[],"traceId":"7a914294-c5f3-4861-a154-d8b214d8fa41"}
| PASS | D8c | 越权写留痕：denied 行 +1（objectRefOfUrl → dict_item / projectType） |
  - 期望：denied 行数 ≥ 2
  - 实际：实际 2
  - 说明：POST /dicts/projectType/items（items 是结构段，对象 id 取 type）
| PASS | D11 | 写 = 仅管理员：受限账号删除 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：dict.manage","details":[],"traceId":"6d66651d-4f62-4b6b-bdde-5c1dab85ae39"}
| PASS | D11b | 越权行与成功写同对象 id（可直接按对象检索同一条目） |
  - 期望：≥1 行（objectId=region:POC7-20260923095138）
  - 实际：实际 1
  - 说明：objectRefOfUrl 对字典取 type[:code] 且路径段先解码
| PASS | D9 | 删除条目 = 物理删行（Push 173）：DELETE 200 + 响应不含该条目 |
  - 期望：200 + POC7-20260923095138 不在响应的 region 条目里
  - 实际：200 {"type":"region","stillListed":false,"items":19}
| PASS | D9b | 物理删除：库里 dict_items 无该行（不是 enabled=false） |
  - 期望：行数 0
  - 实际：实际 0
  - 说明：直读库表（api 角色 DELETE 权限来自 0013；无物理删除的旧口径见 database/migrations/0030_dict_item_hard_delete.sql）
| PASS | D10 | 删除后默认下发不含该条目 |
  - 期望：默认下发不含 POC7-20260923095138
  - 实际：含 POC7-20260923095138 = false
| PASS | D10b | 管理端全集（includeDisabled=true）也不含该条目：删除无残留、无停用位 |
  - 期望：管理端全集不含 POC7-20260923095138
  - 实际：含 POC7-20260923095138 = false
  - 说明：Push 173：删除 = 物理删行；includeDisabled 降级为兼容参数
| PASS | A2 | 按对象检索命中删除留痕：action=delete + 字段级 from → null（删除前快照） |
  - 期望：action=delete + changes 含 {code, POC7-20260923095138, null} 与 {name, 原名, null}
  - 实际：{"action":"delete","actor":"02e76fdb-821a-4c62-9f38-3ec8d5189550","codeChange":{"to":null,"from":"POC7-20260923095138","field":"code"},"nameChange":{"to":null,"from":"PoC-7 回放区","field":"name"}}
| PASS | D12 | 删除无记忆：同码可重新新增（不 409），按本次参数落库 |
  - 期望：201 + POC7-20260923095138（name=重建后、sort=1001）
  - 实际：201 {"code":"POC7-20260923095138","name":"PoC-7 回放区（重建）","sort":1001,"enabled":true,"usageCount":0,"metadata":{}}
| PASS | D13 | 下发条目带 usageCount（引用守卫的输入）= 未删除项目引用数 |
  - 期望：被引用地区的 usageCount 与库内计数一致、且存在 usageCount=0 的条目
  - 实际：{"used":{"code":"英国","api":2,"db":2},"unused":"美国"}
  - 说明：只数 deleted_at is null 的项目（软删项目不在卡片里）
| PASS | D14 | 引用守卫：被项目卡片引用的地区删除 → 409 DICT_ITEM_IN_USE（不删行、不写审计） |
  - 期望：409 DICT_ITEM_IN_USE + 库里仍有该行（1 → 1）+ 审计行数不变（1）+ 下发仍在；被引用地区 = 英国
  - 实际：409 {"code":"DICT_ITEM_IN_USE","message":"该地区正被 2 个项目使用，不能删除：英国（region/英国）","details":[],"traceId":"a80bb0f8-f015-4ccd-85b3-90e5e01e1508"}；行数 1 → 1、审计 1 → 1、下发仍在 = true
  - 说明：服务端在事务内判定（count > 0 即抛错，不 touchType、不落审计）；前端同款判定已把删除位置灰
| PASS | A3 | 审计接口·按对象检索（objectType + objectId） |
  - 期望：200 + total ≥ 2（create + delete）
  - 实际：200 total=4 ["create","delete","deny","create"]
| PASS | A4 | 审计接口·按人检索 + 越权筛法（actorId + result=denied） |
  - 期望：200 + total ≥ 2（includeDisabled 403 + 写 403）且全为该账号 denied
  - 实际：200 total=3 ["deny@region:POC7-20260923095138","deny@projectType","deny@dicts"]
| PASS | A5 | 审计接口仅 audit.view：受限账号 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：audit.view","details":[],"traceId":"baac2147-0de8-4aed-b105-43b097492269"}
| PASS | C1 | 收尾核对：回放数据与临时会话零残留 |
  - 期望：dict_items / audit_logs（对象 + 操作人）/ sessions 全 0
  - 实际：{"dictItems":0,"auditObjects":0,"auditActors":0,"sessions":0}
  - 说明：字典条目与本次审计行用 migrator 连接硬删（api 角色对 audit_logs 无 UPDATE / DELETE）

## 汇总

- ✅ 全部断言通过（29 项）：默认只下发启用项、管理口径 403、新增 201 / 删除 200（物理删行 + 删除无记忆）且同码 409、未知类型 404 无噪声、审计按对象与按人检索命中、越权 403 落 denied 行、审计接口仅 audit.view、回放数据零残留。

## 验收对照（团队分工.md §6 · h7）

- 「字典（C9）唯一口径」= D1 ~ D12：下发只含启用项、includeDisabled 需 dict.manage（403，兼容参数）、新增条目 201 / 删除条目 200（**物理删行**：库表无该行、默认下发与管理端全集都不含）且响应即更新后的整个字典、同码 409 `DICT_ITEM_EXISTS`、未知类型 404、删除无记忆（同码可重建为全新条目）。
- 「引用守卫（A3 · Push 174）」= D13 / D14：下发条目带 `usageCount`（= 未删除项目引用数，与库内计数一致；无引用为 0）；被项目卡片引用的地区删除 → **409 `DICT_ITEM_IN_USE`**（不删行、不写审计、下发仍在）—— 卡片在用就不给删。
- 「审计留痕（谁 / 何时 / 对什么 / 从什么改成什么）」= A1 / A2：dict_item 对象上的 create（changes 含 code）/ delete（字段级 `code / name / sort / enabled / metadata → null`：删除前快照）两行，actorId 为管理员、entry=api、result=succeeded；写入与业务同事务（读库直证）。
- 「按对象与操作人可检索」= A3 / A4 + D11b：`GET /api/v1/audit-logs?objectType=dict_item&objectId=region:<code>` 命中 create + delete；`actorId=<受限账号>&result=denied` 命中全部越权行；越权行对象 id 与成功写同形（type[:code]）。
- 「越权留痕（C7-03）」= D3 / D3b / D8b / D8c / D11 / A5：403 一律记 denied（含 includeDisabled 越权读、projectType 新增越权、删除越权）；普通读 404（未知类型）不写噪声行（D5b）。
- 项目 / 任务 / 节点与阶段推进的写路径留痕由单测覆盖（`server/test/project-crud.test.ts` / `task-service.test.ts` / `flow-gate-rejection.test.ts` 的 FakeAuditService 断言 record 入参）；真机不造项目数据（回放脚本只跑字典与审计域）。
- 「自动化用例全绿」= `cd server && node node_modules/vitest/vitest.mjs run`（`test/admin-audit.test.ts` 21 例 + 全量 484 例 / 32 文件，随 `npm test` 常跑，不连库）与 `node scripts/check-db-schema.mjs` / `check-permission-matrix.mjs`。
- 复跑：已停用（脚本于 2026-10-26 删除）。

