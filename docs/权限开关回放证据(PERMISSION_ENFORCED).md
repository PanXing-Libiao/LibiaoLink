# 权限开关回放证据（PERMISSION_ENFORCED · 一期「不判权限」）

> **历史证据 · 开关已于 2026-10-26 移除**：本文记录旧角色权限开关的两态回放，仅用于追溯当时的实现；对应环境变量、运行分支和 `server/scripts/permission-switch-replay.mjs` 已删除，不能按当前代码复跑。当前权限口径以部门规则为准。

> 口径：业务 2026-09-23「我们当前这个系统就不要考虑权限」；落点 = `RoleService.getActorAuthorization()`（唯一注入点）。

| 项 | 值 |
|---|---|
| 回放时间 | 2026-09-23 23:19:36 +08:00 |
| A 站（不判权限 · 默认） | http://127.0.0.1:3012 |
| B 站（按 ADR-011 判定） | http://127.0.0.1:3013 |
| 数据库 | postgresql://libiaolink_migrator@127.0.0.1:5433/libiaolink |
| 代码版本 | d7c1e2e（HEAD）+ 本刀工作区改动（`server/src/config/env.ts` / `server/src/modules/identity/role.service.ts`；本地 `npm run build` 后回放） |
| 回放账号（临时清空角色 → 用完恢复） | 1a05b27f-9451-4760-9f08-1dbd9bb06547 |
| 脚本 | server/scripts/permission-switch-replay.mjs |

## 断言明细

| PASS | S1 | 两个 api 都在跑（A = 默认口径 / B = 按 ADR-011 判定） |
  - 期望：200 / 200
  - 实际：200 / 200
  - 说明：A=http://127.0.0.1:3012，B=http://127.0.0.1:3013
| PASS | S2 | 管理员基准画像（全量权限位的对账基准） |
  - 期望：200 + 键位含 audit.view / dict.manage / stakeholder.contact.view
  - 实际：200 {"keys":31,"hasAudit":true,"hasDict":true}
  - 说明：账号 02e76fdb-821a-4c62-9f38-3ec8d5189550
| PASS | A1 | A 站（PERMISSION_ENFORCED=false）：零角色账号画像 = 等效管理员 |
  - 期望：200 + roleCodes=[admin] + dataScopes=[all] + 全量权限位
  - 实际：200 {"roleCodes":["admin"],"dataScopes":["all"],"keys":31}
| PASS | A2 | A 站：audit.view 读面放行（原本零角色 → 403） |
  - 期望：200
  - 实际：200 {"items":[{"id":247,"occurredAt":"2026-09-23T09:50:21.286Z","actorId":"02e76fdb-821a-4c62-9f38-3ec8d5189550","actorName"…
| PASS | A3 | A 站：stakeholder.view 读面放行 |
  - 期望：200
  - 实际：200 {"items":[],"page":1,"limit":1,"total":0}
| PASS | A4 | A 站：dict.manage 管理口径放行（includeDisabled） |
  - 期望：200
  - 实际：200 {"types":2}
| PASS | A5 | A 站：项目列表不裁剪（记录级 = all，total 与管理员一致） |
  - 期望：total 均为 2
  - 实际：管理员 2 / 零角色 2
| PASS | B1 | B 站（PERMISSION_ENFORCED=true）：同一账号画像为空（非等效管理员） |
  - 期望：200 + 不含 admin / all / audit.view
  - 实际：200 {"roleCodes":[],"dataScopes":[],"keys":0}
| PASS | B2 | B 站：audit.view 读面 403（C7-03 越权留痕口径） |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：audit.view","details":[],"traceId":"c66242e9-e76b-4290-9268-02359c4e0bdb"}
| PASS | B3 | B 站：stakeholder.view 读面 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"无权限：stakeholder.view","details":[],"traceId":"54f0489e-e8b1-4822-ab18-31d530a8b0db"}
| PASS | B4 | B 站：dict.manage 管理口径 403 |
  - 期望：403 FORBIDDEN
  - 实际：403 {"code":"FORBIDDEN","message":"查看停用字典项需要 dict.manage","details":[],"traceId":"92bd0239-04a3-4b92-9ff1-02b513e98393"}
| PASS | B5 | B 站：项目列表按名册 / 责任人裁剪（total = 库内可见数） |
  - 期望：total = 库内 1
  - 实际：接口 1（库内 1）
  - 说明：名册为空时总数为 0 也是通过 —— 关键是「界面口径回到 ADR-011」
| PASS | C1 | 用户偏好不随开关变化（两站同账号读数一致） |
  - 期望：两站均 200 且响应一致
  - 实际：200 / 200 一致=true
| PASS | D1 | 回放账号角色绑定原样恢复（零残留） |
  - 期望：["admin","project_manager"]
  - 实际：["admin","project_manager"]
| PASS | Z1 | 临时会话清理（零残留） |
  - 期望：0 行；实际：0 行

## 汇总

- ✅ 全部断言通过（15 项）：开关两侧行为对照成立，角色绑定与临时会话零残留。

## 复跑

- A 站：`PORT=3012 node --env-file-if-exists=.env dist/entry/api.js`（`PERMISSION_ENFORCED` 缺省 = false）
- B 站：`PORT=3013 PERMISSION_ENFORCED=true node --env-file-if-exists=.env dist/entry/api.js`
- 回放：`cd server && node scripts/permission-switch-replay.mjs --out ../docs/权限开关回放证据(PERMISSION_ENFORCED).md`

