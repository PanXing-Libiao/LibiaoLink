// LibiaoLink · 种子 #7：蓝图（默认模板 · 项目类型覆盖随业务）
// 口径：ADR-019（按项目类型各一份 + default 兜底模板，版本化）；技术设计v0.2 §3.2（JSON schema）/ §3.3（首批节点清单）/ §3.4（校验）。
// 范围：只写 default 模板（project_type = default）的草稿 + 已发布版本 1；项目类型覆盖由管理员走 API（PUT / blueprint/publish）维护。
// 说明：节点清单为建议稿（v0.2 §3.3，业务后补全）——常量为可修订区，回执后更新重跑；库内已修订（草稿与种子不一致）时不覆盖，计数 kept。

export const name = "blueprint";
export const title = "蓝图（默认模板 + 版本 1 · ADR-019；种子 #7）";

export const DEFAULT_PROJECT_TYPE = "default";
export const DEFAULT_TEMPLATE_NAME = "默认流程模板（九阶段）";
export const DEFAULT_BLUEPRINT_VERSION = 1;
const SEED_UPDATED_AT = "2026-09-20T00:00:00.000Z";

/** 可修订常量区：九阶段 + 节点（key 稳定；seq 10/20/30 步长）。 */
export const DEFAULT_STAGES = [
  { key: "presale", name: "售前规划", seq: 10, nodes: [
    { key: "presale.requirement", name: "需求澄清与现场勘察", seq: 10, constraints: [] },
    { key: "presale.plan", name: "方案与报价", seq: 20, constraints: [] },
    { key: "presale.contract", name: "合同与技术协议评审", seq: 30, constraints: [
      { type: "required_doc", docType: "技术协议", minCount: 1 },
      { type: "required_doc", docType: "合同", minCount: 1 },
    ] },
  ] },
  { key: "design", name: "设计开发", seq: 20, nodes: [
    { key: "design.mech", name: "机械设计图纸", seq: 10, constraints: [
      { type: "required_doc", docType: "CAD图纸", minCount: 1 },
    ] },
    { key: "design.elec", name: "电气设计图纸", seq: 20, constraints: [
      { type: "required_doc", docType: "CAD图纸", minCount: 1 },
    ] },
    { key: "design.review", name: "设计评审", seq: 30, constraints: [
      { type: "required_doc", docType: "评审单", minCount: 1 },
    ] },
  ] },
  { key: "purchase", name: "加工采购", seq: 30, nodes: [
    { key: "purchase.equipment", name: "设备清单", seq: 10, constraints: [
      { type: "required_doc", docType: "设备清单", minCount: 1 },
    ] },
    { key: "purchase.material", name: "物料总清单", seq: 20, constraints: [
      { type: "required_doc", docType: "物料总清单", minCount: 1 },
    ] },
    { key: "purchase.order", name: "采购订单确认", seq: 30, constraints: [] },
  ] },
  { key: "assembly", name: "组装发货", seq: 40, nodes: [
    { key: "assembly.packing", name: "发货装箱单", seq: 10, constraints: [
      { type: "required_doc", docType: "发货装箱单", minCount: 1 },
    ] },
    { key: "assembly.arrival", name: "到货单", seq: 20, constraints: [
      { type: "required_doc", docType: "到货单", minCount: 1 },
    ] },
  ] },
  { key: "install", name: "硬件实施", seq: 50, nodes: [
    { key: "install.plan", name: "施工计划", seq: 10, constraints: [] },
    { key: "install.done", name: "安装完成证明", seq: 20, constraints: [
      { type: "required_doc", docType: "安装完成证明", minCount: 1 },
    ] },
  ] },
  { key: "deploy", name: "软件部署", seq: 60, nodes: [
    { key: "deploy.plan", name: "部署方案", seq: 10, constraints: [] },
    { key: "deploy.golive", name: "上线确认", seq: 20, constraints: [] },
  ] },
  { key: "trial", name: "试运行", seq: 70, nodes: [
    { key: "trial.record", name: "试运行记录", seq: 10, constraints: [] },
  ] },
  { key: "production", name: "投产阶段", seq: 80, nodes: [
    { key: "production.record", name: "投产运行记录", seq: 10, constraints: [] },
  ] },
  { key: "acceptance", name: "验收", seq: 90, nodes: [
    { key: "acceptance.apply", name: "验收申请", seq: 10, constraints: [] },
    { key: "acceptance.doc", name: "验收单", seq: 20, constraints: [
      { type: "required_doc", docType: "验收单", minCount: 1 },
    ] },
  ] },
];

/** 默认模板 payload（契约 BlueprintSchema；updatedAt 固定以保证种子幂等）。 */
export function buildDefaultBlueprint() {
  return {
    schemaVersion: 1,
    blueprintVersion: DEFAULT_BLUEPRINT_VERSION,
    name: DEFAULT_TEMPLATE_NAME,
    projectType: DEFAULT_PROJECT_TYPE,
    updatedAt: SEED_UPDATED_AT,
    stages: DEFAULT_STAGES,
  };
}

export async function run(client) {
  const payload = buildDefaultBlueprint();
  const found = await client.query(
    "select id, draft_payload, published_version from blueprints where project_type = $1",
    [DEFAULT_PROJECT_TYPE],
  );
  const row = found.rows[0];
  if (row === undefined) {
    const inserted = await client.query(
      "insert into blueprints (project_type, name, draft_payload, published_version) values ($1, $2, $3, $4) returning id",
      [DEFAULT_PROJECT_TYPE, DEFAULT_TEMPLATE_NAME, payload, DEFAULT_BLUEPRINT_VERSION],
    );
    const blueprintId = inserted.rows[0].id;
    await client.query(
      "insert into blueprint_versions (blueprint_id, blueprint_version, payload) values ($1, $2, $3)",
      [blueprintId, DEFAULT_BLUEPRINT_VERSION, payload],
    );
    return { inserted: 1, unchanged: 0, kept: 0 };
  }
  if (!sameJson(row.draft_payload, payload)) {
    return { inserted: 0, unchanged: 0, kept: 1 };
  }
  const versionRow = await client.query(
    "select id from blueprint_versions where blueprint_id = $1 and blueprint_version = $2",
    [row.id, DEFAULT_BLUEPRINT_VERSION],
  );
  if (versionRow.rows.length === 0) {
    await client.query(
      "insert into blueprint_versions (blueprint_id, blueprint_version, payload) values ($1, $2, $3)",
      [row.id, DEFAULT_BLUEPRINT_VERSION, payload],
    );
    return { inserted: 1, unchanged: 0, kept: 0 };
  }
  return { inserted: 0, unchanged: 1, kept: 0 };
}

/**
 * jsonb 归一化比较：PG 会按「键长 + 字节序」重排对象键，直接 JSON.stringify 会误判为「已修订」；
 * 因此先递归排序键再比较（幂等判定的唯一口径）。
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
