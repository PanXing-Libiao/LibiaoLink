// LibiaoLink · 种子 #8：任务节点库（M3-05 余 · A1-16 / A1-17 · 2026-09-24）
// 口径来源：业务给定的九阶段节点清单（原写死在 frontend/src/data/templatePresets.ts，Push 60 原型）；
//   M3-05 余把节点池落库（迁移 0032 · task_nodes），本种子把同一份清单灌进库 —— seq 按清单顺序 10/20/30…。
// 范围：九阶段共 52 条。硬件实施 = 模板一 18 条 + 模板二（格口 / 滑槽型）新增的 8 条；软件部署 = 业务给的 4 条清单
//   （与前端 stageNodesOf(阶段) 同口径 —— 模板页左列与「项目总览 → 添加任务」卡片看的是这份数据）。
// 修订语义：幂等 —— 按 (stage_key, title) 存在即跳过，不覆盖库内改名 / 排序（管理端改过的不被种子回滚）、不删除。
//   删除 = 物理删行（管理端 `DELETE /api/v1/task-nodes/{id}`）；**注意**：删掉种子里的某条后再重跑本种子会把它插回来
//   （与 dicts 同口径 —— 播种是一次性动作，不做删除记忆）。

export const name = "task-nodes";
export const title = "任务节点库（九阶段 52 条 · A1-16 / A1-17）";

/** 可修订常量区：stageKey → 节点清单（数组顺序 = 模板页展示顺序，落库为 seq 10/20/30…）。 */
export const STAGE_NODE_SEED = [
  {
    stageKey: "presale",
    nodes: [
      { title: "布局定档", titleEn: "Layout scheduling" },
      { title: "技术协议定档", titleEn: "Technical agreement finalization" },
      { title: "合同签署", titleEn: "Contract signing" },
      { title: "项目启动", titleEn: "Project Startup" },
    ],
  },
  {
    stageKey: "design",
    nodes: [
      { title: "规划设计", titleEn: "planning design" },
      { title: "机械设计", titleEn: "Mechanical design" },
      { title: "软件开发", titleEn: "Software" },
      { title: "硬件研发", titleEn: "Hardware R&D" },
      { title: "物料清单完整版", titleEn: null },
    ],
  },
  {
    stageKey: "purchase",
    nodes: [
      { title: "订单录入", titleEn: "Order entry" },
      { title: "采购", titleEn: "Procurement" },
      { title: "到货入库", titleEn: "Goods arrival and warehousing" },
    ],
  },
  {
    stageKey: "assembly",
    nodes: [
      { title: "生产", titleEn: "Production" },
      { title: "质检", titleEn: "Quality inspection" },
      { title: "包装", titleEn: "Packing" },
      { title: "运输", titleEn: "Transportation" },
      { title: "清关", titleEn: "Customs clearance" },
      { title: "送仓", titleEn: "Deliver to warehouse" },
    ],
  },
  {
    stageKey: "install",
    nodes: [
      { title: "人员进场、场地检查、施工对接", titleEn: "Personnel entry, site inspection, construction docking" },
      { title: "施工安全培训", titleEn: "Construction Safety Training" },
      { title: "物料转运、清点分类", titleEn: "Material transfer, inventory and classification" },
      { title: "货架组装", titleEn: "Shelf Assembly" },
      { title: "货架检查", titleEn: "Shelf inspection" },
      { title: "挂件安装", titleEn: "Pendant Installation" },
      { title: "巷道导轨安装，铜丝镶嵌", titleEn: "Tunnel rail installation, copper wire inlay" },
      { title: "飞箱机器安装", titleEn: "Air Robot installed" },
      { title: "强弱电布线、接线，服务器机柜安装及理线", titleEn: "Power and weak current wiring and connectionsServer cabinet installation and cable management" },
      { title: "工作站安装及定位弹线", titleEn: "Workstation Installation and Positioning Chalk Line" },
      { title: "飞箱电控箱及AP安装", titleEn: "AirRobot electric control cabinet and AP installation" },
      { title: "货架条码黏贴", titleEn: "Shelf barcode labeling" },
      { title: "接驳位弹线及魔毯黏贴，充电桩组装", titleEn: "Docking position marking and magic carpet sticking, charging pile assembly" },
      { title: "导航柱弹线及安装", titleEn: "Guide post marking and installation" },
      { title: "第一批空箱上架", titleEn: "The first batch of empty boxes is on the shelves" },
      { title: "安全围栏安装及调试", titleEn: "Safety Fence Installation and Commissioning" },
      { title: "第二批空箱上架", titleEn: "The second batch of empty boxes is on the shelves" },
      { title: "第三批空箱上架", titleEn: "The third batch of empty boxes is on the shelves" },
      { title: "桌面平台搭建、魔毯铺设", titleEn: "Installation of the platform and carpet" },
      { title: "站人台、扫描架、称及附属硬件安装", titleEn: "Installation of the scanning frame, scale and auxiliary hardware" },
      { title: "格口滑槽（或挂包架）安装", titleEn: "Installation of the compartment chute (or bag rack)" },
      { title: "传感器、按钮盒安装理线", titleEn: "Installation of the sensors and control boxes, cabling" },
      { title: "强弱电布线", titleEn: "Network and electric wiring" },
      { title: "扫码台及机柜理线", titleEn: "Induction stations and cabinets cabling" },
      { title: "防护围栏安装", titleEn: "Installation of Safety Barriers" },
      { title: "验收交付", titleEn: "Acceptance" },
    ],
  },
  {
    stageKey: "deploy",
    nodes: [
      { title: "通电测试、参数设定", titleEn: "Power-on test and parameter setting" },
      { title: "RCS、WES软件部署调试，随机跑", titleEn: "RCS, WES software deployment and commissioning, random run" },
      { title: "按钮盒注册、传感器调节", titleEn: "Control boxes registration, sensor adjustment" },
      { title: "与WMS联调", titleEn: "Combined with WMS" },
    ],
  },
  {
    stageKey: "trial",
    nodes: [
      { title: "小批量实物测试", titleEn: "Small batch of physical test" },
      { title: "客户培训、上线", titleEn: "Customer training, go alive" },
    ],
  },
  {
    stageKey: "production",
    nodes: [
      { title: "产能爬坡", titleEn: "Capacity climbing" },
    ],
  },
  {
    stageKey: "acceptance",
    nodes: [
      { title: "验收交付", titleEn: "Acceptance" },
    ],
  },
];

export async function run(client) {
  const summary = { inserted: 0, unchanged: 0 };
  for (const stage of STAGE_NODE_SEED) {
    for (let index = 0; index < stage.nodes.length; index += 1) {
      const node = stage.nodes[index];
      const found = await client.query("select id from task_nodes where owner_template_id is null and stage_key = $1 and title = $2", [stage.stageKey, node.title]);
      if (found.rows.length > 0) {
        summary.unchanged += 1;
        continue;
      }
      await client.query(
        "insert into task_nodes (stage_key, seq, title, title_en, created_at, updated_at) values ($1, $2, $3, $4, now(), now())",
        [stage.stageKey, (index + 1) * 10, node.title, node.titleEn],
      );
      summary.inserted += 1;
    }
  }
  return summary;
}
