// LibiaoLink · 种子 #6b：功能权限矩阵（role_permissions 条目；h6 · PoC-6）
// 口径：技术设计v0.2 §4.1（六角色「关键能力 / 限制」列）+ ADR-011；权限键唯一来源 = shared/src/modules/permissions.ts（PERMISSION_KEYS）。
// 范围：只写 role_permissions（角色码 → 权限位）；角色行本身由种子 #6a（roles.mjs）维护，本种子依赖它先执行。
// 修订语义：以本文件为准 —— 新增键插入、**移除键删除**（权限是安全面，吊销必须能生效；role_permissions 是角色模板、非业务数据）。
// 依赖校验：角色码缺失即抛错（提示先跑 #6a），不隐式建角色。

export const name = "role-permissions";
export const title = "功能权限矩阵（一期六角色 · v0.2 §4.1）";

/** 可修订常量区：每条键的授权依据写在角色注释里；调整后重跑本脚本（第二次零变更）。 */
export const MATRIX = [
  {
    // 系统管理员：v0.2 §4.1「字典与蓝图、审计、备份恢复、运维」—— 一期口径为全量权限位。
    // h7 起新增 dict.manage（字典维护，C9-02 变更留痕）与 audit.view（审计检索，C7-04）；
    // h8 起新增 calendar.manage（工作日历维护 D5-01 与顺延配置 D5-02）；管理面 UI 随 u12（px 线）。
    // M6 起新增日报 / 问题四键（report.view / report.fill / issue.view / issue.manage，A3 与 §4.1）。
    // M7-04 起新增 project.archive（归档端点，ADR-027，仅项目经理 / 管理员）。
    // M5-06 起新增 automation.view / automation.manage / notify.record.view / notify.resend（仅管理员；admin 全量 36 键）。
    roleCode: "admin",
    keys: [
      "project.view",
      "project.create",
      "project.update",
      "project.delete",
      "project.archive",
      "project.export",
      "member.view",
      "member.manage",
      "task.view",
      "task.create",
      "task.update",
      "task.progress",
      "report.view",
      "report.fill",
      "issue.view",
      "issue.manage",
      "node.view",
      "node.create",
      "node.delete",
      "node.complete",
      "node.advance",
      "node.rollback",
      "blueprint.view",
      "blueprint.manage",
      "dict.manage",
      "file.upload",
      "file.download",
      "stakeholder.view",
      "stakeholder.manage",
      "stakeholder.contact.view",
      "audit.view",
      "calendar.manage",
      "automation.view",
      "automation.manage",
      "notify.record.view",
      "notify.resend",
    ],
  },
  {
    // 项目经理：「建项目 / 导入蓝图、成员、节点增删、定档、变更」；限制「不可越项目范围」由项目上下文（manager_id / 名册）保证。
    // M7-04 起新增 project.archive（归档，ADR-027：门禁 + 清单 + 只读保护）。
    // 不含 blueprint.manage：蓝图维护仅管理员（ADR-019 / ADR-020）。
    roleCode: "project_manager",
    keys: [
      "project.view",
      "project.create",
      "project.update",
      "project.delete",
      "project.archive",
      "project.export",
      "member.view",
      "member.manage",
      "task.view",
      "task.create",
      "task.update",
      "task.progress",
      "node.view",
      "node.create",
      "node.delete",
      "node.complete",
      "node.advance",
      "node.rollback",
      "blueprint.view",
      "file.upload",
      "file.download",
      "stakeholder.view",
      "stakeholder.manage",
      "stakeholder.contact.view",
    ],
  },
  {
    // 任务负责人：「我的任务、上传文件、发起变更、完成节点」；限制「干系人隐私字段按字段权限隐藏」→ 不含 stakeholder.contact.view。
    // 阶段推进 / 回退仍按 ADR-023 走项目级判定（项目经理），不在本角色。
    roleCode: "task_owner",
    keys: [
      "project.view",
      "task.view",
      "task.update",
      "task.progress",
      "node.view",
      "node.complete",
      "file.upload",
      "file.download",
      "stakeholder.view",
    ],
  },
  {
    // 项目成员：「查看、上传、日报、问题」；限制「删除 / 导出受操作级权限限制」→ 不含 project.delete / project.export。
    roleCode: "project_member",
    keys: ["project.view", "task.view", "node.view", "file.upload", "file.download", "stakeholder.view"],
  },
  {
    // 销售（录入）：「干系人新增 / 编辑」；限制「仅干系人模块」→ 无项目 / 任务权限（其在项目上的可见性来自名册，记录级兜底）。
    roleCode: "sales",
    keys: ["stakeholder.view", "stakeholder.manage", "stakeholder.contact.view"],
  },
  {
    // 只读：「查看与受控导出」；限制「无写操作」→ 只给读与导出键，联系方式字段不给（按授权，随 C3-06 临时授权）。
    roleCode: "viewer",
    keys: ["project.view", "project.export", "task.view", "node.view", "file.download", "stakeholder.view"],
  },
];

export async function run(client) {
  const found = await client.query("select id, code from roles");
  const idByCode = new Map(found.rows.map((row) => [row.code, row.id]));
  const summary = { inserted: 0, deleted: 0, unchanged: 0 };
  for (const entry of MATRIX) {
    const roleId = idByCode.get(entry.roleCode);
    if (roleId === undefined) {
      throw new Error("角色不存在：" + entry.roleCode + "（请先执行种子 #6a roles.mjs）");
    }
    const current = await client.query("select permission from role_permissions where role_id = $1", [roleId]);
    const currentKeys = new Set(current.rows.map((row) => row.permission));
    const target = new Set(entry.keys);
    for (const permission of target) {
      if (currentKeys.has(permission)) {
        summary.unchanged += 1;
        continue;
      }
      await client.query("insert into role_permissions (role_id, permission) values ($1, $2)", [roleId, permission]);
      summary.inserted += 1;
    }
    const stale = [...currentKeys].filter((permission) => !target.has(permission));
    if (stale.length > 0) {
      await client.query("delete from role_permissions where role_id = $1 and permission = any($2::text[])", [roleId, stale]);
      summary.deleted += stale.length;
    }
  }
  return summary;
}
