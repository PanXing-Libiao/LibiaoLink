// LibiaoLink · 种子 #9：任务模板（M3-05 余 · 第二段 · A1-16 / A1-17 · 2026-09-24）
// 口径来源：业务给定的九阶段模板清单（原写死在 frontend/src/data/templatePresets.ts 的 STAGE_TEMPLATE_PRESETS，Push 58~60 原型）；
//   M3-05 余第二段把模板落库（迁移 0033 · task_templates / task_template_nodes），本种子把同一份清单灌进库。
// 范围：九阶段共 10 套 —— 硬件实施两套（模板一 18 条长清单 / 模板二「格口 · 滑槽型」11 条），其余阶段各一套。
// 与节点库的关系：模板内节点按「同阶段 + 同名」解析 task_nodes.id（节点库种子 #8 已灌同源清单），
//   解析不到（业务改过名 / 删过节点）就跳过该条并在结果里计数 skippedNodes —— 不新建节点、不报错。
// 修订语义：幂等 —— 按 (stage_key, name) 存在即跳过，不覆盖库内改名 / 增删过的模板（管理端改过的不被种子回滚）、不删除。
//   删除模板 = 软删（DELETE /api/v1/task-templates/{id}）；删掉后再重跑本种子会把它插回来（与 task-nodes / dicts 同口径）。
// 时间戳：created_at 是面板顺序的依据（列表按 阶段 → created_at 倒序读，最新在最左），所以本种子**按清单顺序倒排** ——
//   清单里越靠前的模板 created_at 越大（now() 起，每套往前退 1 秒），这样业务清单第一套（「硬件实施模板一」）
//   仍在最左；界面新建的模板用 now()，天然排在种子之前（最左），与「＋ 新建模板」插到最左一致。

export const name = "task-templates";
export const title = "任务模板（九阶段 10 套 · A1-16 / A1-17）";

/** 可修订常量区：stageKey → 模板清单（nodes = 该模板的节点标题，顺序即模板内顺序）。 */
export const STAGE_TEMPLATE_SEED = [
  {
    stageKey: "presale",
    templates: [
      {
        name: "售前规划模板",
        nodes: ["布局定档", "技术协议定档", "合同签署", "项目启动"],
      },
    ],
  },
  {
    stageKey: "design",
    templates: [
      {
        name: "设计开发模板",
        nodes: ["规划设计", "机械设计", "软件开发", "硬件研发", "物料清单完整版"],
      },
    ],
  },
  {
    stageKey: "purchase",
    templates: [
      {
        name: "加工采购模板",
        nodes: ["订单录入", "采购", "到货入库"],
      },
    ],
  },
  {
    stageKey: "assembly",
    templates: [
      {
        name: "组装发货模板",
        nodes: ["生产", "质检", "包装", "运输", "清关", "送仓"],
      },
    ],
  },
  {
    stageKey: "install",
    templates: [
      {
        name: "硬件实施模板一",
        nodes: ["人员进场、场地检查、施工对接", "施工安全培训", "物料转运、清点分类", "货架组装", "货架检查", "挂件安装", "巷道导轨安装，铜丝镶嵌", "飞箱机器安装", "强弱电布线、接线，服务器机柜安装及理线", "工作站安装及定位弹线", "飞箱电控箱及AP安装", "货架条码黏贴", "接驳位弹线及魔毯黏贴，充电桩组装", "导航柱弹线及安装", "第一批空箱上架", "安全围栏安装及调试", "第二批空箱上架", "第三批空箱上架"],
      },
      {
        name: "硬件实施模板二",
        nodes: ["人员进场、场地检查、施工对接", "施工安全培训", "物料转运、清点分类", "桌面平台搭建、魔毯铺设", "站人台、扫描架、称及附属硬件安装", "格口滑槽（或挂包架）安装", "传感器、按钮盒安装理线", "强弱电布线", "扫码台及机柜理线", "防护围栏安装", "验收交付"],
      },
    ],
  },
  {
    stageKey: "deploy",
    templates: [
      {
        name: "软件部署模板",
        nodes: ["通电测试、参数设定", "RCS、WES软件部署调试，随机跑", "按钮盒注册、传感器调节", "与WMS联调"],
      },
    ],
  },
  {
    stageKey: "trial",
    templates: [
      {
        name: "试运行模板",
        nodes: ["小批量实物测试", "客户培训、上线"],
      },
    ],
  },
  {
    stageKey: "production",
    templates: [
      {
        name: "投产阶段模板",
        nodes: ["产能爬坡"],
      },
    ],
  },
  {
    stageKey: "acceptance",
    templates: [
      {
        name: "验收模板",
        nodes: ["验收交付"],
      },
    ],
  },
];

/**
 * 灌种子：按 (stage_key, name) 判存在 —— 已有模板整块跳过（不覆盖、不补节点）；新建模板时按节点标题解析 id，
 * 顺序落 seq = (下标 + 1) × 10（与节点库 / 模板接口的全量替换同口径）。
 */
export async function run(client) {
  const summary = { inserted: 0, unchanged: 0, skippedNodes: 0 };
  /** 已插入的套数（清单顺序计数）：用来把 created_at 按清单顺序倒排。 */
  let order = 0;
  for (const stage of STAGE_TEMPLATE_SEED) {
    for (const template of stage.templates) {
      const found = await client.query("select id from task_templates where stage_key = $1 and name = $2 and deleted_at is null", [stage.stageKey, template.name]);
      if (found.rows.length > 0) {
        summary.unchanged += 1;
        continue;
      }
      order += 1;
      const created = await client.query(
        "insert into task_templates (name, stage_key, created_at, updated_at) values ($1, $2, now() - make_interval(secs => $3), now() - make_interval(secs => $3)) returning id",
        [template.name, stage.stageKey, order],
      );
      const templateId = created.rows[0].id;
      for (let index = 0; index < template.nodes.length; index += 1) {
        const nodeTitle = template.nodes[index];
        const node = await client.query("select id from task_nodes where owner_template_id is null and stage_key = $1 and title = $2", [stage.stageKey, nodeTitle]);
        if (node.rows.length === 0) {
          summary.skippedNodes += 1;
          continue;
        }
        await client.query(
          "insert into task_template_nodes (template_id, node_id, seq) values ($1, $2, $3) on conflict (template_id, node_id) do nothing",
          [templateId, node.rows[0].id, (index + 1) * 10],
        );
      }
      summary.inserted += 1;
    }
  }
  return summary;
}
