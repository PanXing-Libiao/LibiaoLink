// 种子注册表：按执行顺序导出（database/seeds/README.md §执行约定：dicts → roles → 蓝图 → …）。
// 追加规则：新种子模块追加到数组末尾；runner（scripts/seed.mjs）逐个独立事务执行，重复执行零变更。
import * as dicts from "./dicts.mjs";
import * as roles from "./roles.mjs";
import * as rolePermissions from "./role-permissions.mjs";
import * as blueprint from "./blueprint.mjs";
import * as taskNodes from "./task-nodes.mjs";
import * as taskTemplates from "./task-templates.mjs";
import * as demoProjects from "./demo-projects.mjs";
import * as automationRules from "./automation-rules.mjs";

// 末尾的 demo-projects 是**可选种子**（optional = true）：默认不执行，--only=demo-projects / --with-optional 显式执行。
export const SEEDS = [dicts, roles, rolePermissions, blueprint, taskNodes, taskTemplates, automationRules, demoProjects];
