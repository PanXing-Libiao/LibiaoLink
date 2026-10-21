/**
 * 「词频图」口径（Push 353 · 业务口径 2026-10-16「现在做这个词频图 根据变更原因的词频拼成这个图」+
 * 「词频图中修饰词不纳入 只保留核心词纳入词频图」+「还是和之前做的地方和效果一样」）：
 * 仪表盘第五个视图 —— 变更原因核心词词云（components/HubDashWordCloud.tsx）+ 点最中间那枚词只读「数据详情」
 * （components/HubDashWordDetail.tsx）；统计在服务端 GET /api/v1/dashboard/change-words 聚合，
 * 取数在 dashboardApi.ts 的 fetchDashboardChangeWords（懒加载：首次切到「词频图」才拉 —— 与「问题」视图同一套）；
 * 点词明细再按选中项目懒取。统计文本 = change_requests.reason 原文
 * （导入行是「内容描述；原因：原因」拼装文本，两段都计入 —— 业务参考图的词（供应商 / 55 / mm 等）横跨两段）。
 *
 * 分词口径（改规则只改这里；业务口径「修饰词不纳入 只保留核心词」）：
 * - 核心词 = 下方 CHANGE_CORE_WORDS 词表（业务名词 / 动作词；覆盖业务参考图里的 供应商 / 货架 / 立柱 / 尺寸 /
 *   规划图 / 设计 / 客户 / 机械 / 要求 / 不符 / 增加 / 原因 等）；最长匹配优先（「规划图」不会被切成「规划」+「图」）。
 * - 修饰词（的 / 与 / 上 / 在 / 等 / 及 / 了 这些连接与虚词）不在词表里 —— 天然不纳入；单字不成词（至少 2 字）。
 *   复合词（客户原因 / 供应商原因 / 机械原因）刻意不收：拆成「客户」+「原因」这类两个核心词，与业务参考图同口径。
 * - 占位符（导入表占位 x / xxx 与「（内容待补）/（原因待补）」标记）在分词前剔掉（不是业务内容，不进词频）。
 * - 数字：连续数字单独成词，只保留 2 位及以上的（55 / 47 / 50 进词频；1 / 2 这类编号噪声不进）；
 *   单位 mm / cm 单独成词（与业务参考图一致）。
 * - 一条变更里同一个词出现几次计几次（词频 = 出现次数，不是命中条数）。
 *
 * 展示口径（HubDashWordCloud，落位参照开源 d3-cloud / wordcloud2.js 的画布像素蒙版方案）：一条出现 = 一枚词，
 * 词频最高的词落画布正中、字号随频次单调（中低频词也撑得起词团形状），同词重复枚数字号逐枚递减补缝、
 * 颜色按词固定、词团边缘渐隐；canvas 1200 x 596 与其他视图同款；悬停任意词出浮层卡（词 + 词频），
 * 点某词的主枚开只读「数据详情」—— 每词主枚可点、重复小枚不可点（「全部项目」混合来源谁都不可点）。
 */

/** 词频图的取数输入行（fileApi.ts 的 ApiChangeRequest 满足）。 */
export type ChangeWordRowLike = {
  readonly reason: string;
};

/** 一枚核心词（word = 词面，count = 词频）。 */
export type ChangeWord = {
  readonly word: string;
  readonly count: number;
};

/** 一份核心词词频（全部项目 / 某项目各一份；统计由服务端 /dashboard/change-words 下发）。 */
export type DashboardChangeWords = {
  /** 核心词（按词频降序、同频按词面排序 —— 字号映射与配色都吃这个顺序）。 */
  readonly words: readonly ChangeWord[];
  /** 变更条数（0 = 图上空态「暂无变更记录」）。 */
  readonly totalChanges: number;
};

/**
 * 核心词表（业务口径「只保留核心词」；最长匹配优先 —— 词表内相互包含没关系，扫描按最长命中）。
 * 增词只改这里一处：新业务名词补进来即进词频；修饰词永远不进词表。
 */
export const CHANGE_CORE_WORDS: readonly string[] = (
  "客户 甲方 业主 需求 要求 反馈 投诉 供应商 厂家 供货 采购 质检 来料 " +
  "物料 材料 钢材 铝材 钣金 立柱 横梁 货架 托盘 输送线 传送带 机械 电气 电机 传感器 相机 镜头 料箱 飞箱 机器人 软件 硬件 网络 环境 " +
  "结构 支架 护栏 场地 地面 尺寸 规格 型号 数量 颜色 材质 表面 工艺 加工 喷涂 焊接 打磨 装配 安装 拼装 螺栓 螺丝 " +
  "孔位 开孔 打孔 槽位 卡扣 定位 间隙 公差 高度 宽度 长度 厚度 直径 重量 承重 负载 速度 节拍 精度 角度 位置 " +
  "布局 排列 顺序 方向 编号 标签 铭牌 二维码 设计 图纸 规划图 规划 方案 建模 模型 仿真 设计图 施工图 装配图 零件图 " +
  "参数 说明 文档 文件 清单 表单 表格 报告 日报 记录 内容 描述 摘要 备注 项目 任务 阶段 节点 进度 计划 排期 工期 " +
  "交期 时间 日期 现场 实施 调试 验收 发货 到货 物流 运输 装箱 包装 清关 报关 海运 空运 快递 订单 合同 协议 报价 " +
  "价格 成本 预算 费用 付款 发票 质量 品质 缺陷 故障 异常 问题 风险 标准 规范 流程 规则 权限 版本 变更 修改 调整 " +
  "优化 完善 补充 增补 增加 新增 减少 删除 取消 替换 更换 更新 升级 修复 更正 变化 延迟 排产 录入 签收 格式 纠正 返工 返修 重做 补做 遗漏 缺失 " +
  "缺少 错误 失误 偏差 误差 不符 一致 不一致 冲突 矛盾 重复 冗余 待定 原因 结果 影响 建议 意见 确认 审批 审核 沟通 " +
  "协调 配合 支持 售前 组装 部署 试运行 生产"
).split(" ");

/** 单位词（单独成词，小写匹配）：与业务参考图的 mm 一致；cm 顺带。 */
const CHANGE_UNIT_WORDS: readonly string[] = ["mm", "cm"];

const CORE_WORD_SET: ReadonlySet<string> = new Set(CHANGE_CORE_WORDS);

/** 词表最长词长（最长匹配的扫描起点）。 */
const MAX_CORE_WORD_LENGTH: number = CHANGE_CORE_WORDS.reduce((max, word) => Math.max(max, word.length), 0);

/** 占位符标记（导入表占位 / 待补标记）：分词前剔掉，不参与词频。 */
const PLACEHOLDER_TEXTS: readonly string[] = ["（内容待补）", "(内容待补)", "（原因待补）", "(原因待补)"];

/** 是否是数字字符（直接查码点，少一层转义）。 */
function isDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

/**
 * 变更原因 → 核心词序列（出现即计入；修饰词 / 占位符天然不命中）。
 * 逐字符扫描：数字（2 位及以上）→ 单位（mm / cm）→ 核心词最长匹配 → 都不命中就跳过 1 个字符。
 */
export function tokenizeChangeReason(reason: string): string[] {
  let text = reason.toLowerCase();
  for (const placeholder of PLACEHOLDER_TEXTS) {
    text = text.split(placeholder).join(" ");
  }
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (isDigitAt(text, index)) {
      let end = index;
      while (end < text.length && isDigitAt(text, end)) {
        end += 1;
      }
      const digits = text.slice(index, end);
      if (digits.length >= 2) {
        tokens.push(digits);
      }
      index = end;
      continue;
    }
    const unit = CHANGE_UNIT_WORDS.find((word) => text.startsWith(word, index));
    if (unit !== undefined) {
      tokens.push(unit);
      index += unit.length;
      continue;
    }
    let matched: string | null = null;
    const maxLength = Math.min(MAX_CORE_WORD_LENGTH, text.length - index);
    for (let length = maxLength; length >= 2; length -= 1) {
      const candidate = text.slice(index, index + length);
      if (CORE_WORD_SET.has(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (matched !== null) {
      tokens.push(matched);
      index += matched.length;
      continue;
    }
    index += 1;
  }
  return tokens;
}

/** 全量变更 → 核心词词频（按词频降序、同频按词面排序；纯函数，取数见 dashboardApi.ts）。 */
export function buildDashboardChangeWords(rows: readonly ChangeWordRowLike[]): DashboardChangeWords {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const token of tokenizeChangeReason(row.reason)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const words = Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : left.word > right.word ? 1 : 0));
  return { words, totalChanges: rows.length };
}

/** 变更是否命中该词 —— 点词打开的「数据详情」按它筛（与词频同一套分词，词频与命中口径一致）。 */
export function isChangeWordHit(reason: string, word: string): boolean {
  return tokenizeChangeReason(reason).includes(word);
}

/** 「内容描述 / 原因」拆分标记：应用内提交「；变更原因：」/ 导入拼装「；原因：」，另兼容半角冒号与英文界面标记。 */
const CHANGE_REASON_MARKERS: readonly string[] = ["；变更原因：", "；原因：", "；变更原因:", "；原因:", "; change reason: ", "; reason: "];

/** 变更原因原文 → 「变更内容描述 / 变更原因」两列（无标记 = 全文即内容描述、原因空 —— 与变更管理弹窗同口径）。 */
export function splitChangeReasonColumns(reason: string): { readonly content: string; readonly cause: string } {
  for (const marker of CHANGE_REASON_MARKERS) {
    const at = reason.indexOf(marker);
    if (at >= 0) {
      return { content: reason.slice(0, at), cause: reason.slice(at + marker.length) };
    }
  }
  return { content: reason, cause: "" };
}
