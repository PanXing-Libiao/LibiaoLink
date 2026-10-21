/**
 * 项目总览导出（PDF）——业务口径 2026-10-09：「按钮 用于导出项目总览的数据 导出要美观给客户看的 间距也要合适 先考虑 pdf 格式吧」。
 *
 * 口径（详见 `前端功能需求.md` §6.16）：
 * - 导出内容 = 当前项目的项目总览：项目信息 + 汇总统计 + 九阶段进度 + 任务明细（分组 / 行序同「项目总览」任务表）；
 * - 数据准备（阶段分组 / 计数 / 文本与进度口径）收敛在 `overviewExportShared.ts`；
 * - 产物 = PDF：**不引第三方库**（jsPDF / html2canvas 一律不加），走浏览器打印 —— 本模块生成一份自包含的
 *   A4 横版报告 HTML（紧凑单行版式，见 REPORT_STYLE 注），塞进离屏 iframe 调 print()，用户在系统打印窗口里选「另存为 PDF」；文字矢量输出、
 *   中文字体使用自托管 Noto Sans SC Variable（思源黑体同源，OFL-1.1），客户可检索 / 可缩放，比截图拼 PDF 清晰、体积也小；
 * - 配色与状态口径和页面同源：五个状态色签取 `components/TaskBoard.tsx` 的 STATUS_TAG_CLASS 同色（100 档底 +
 *   700 / 800 档字）；整体进度算法同同文件的 ProjectSummary（已完成 / 总数，四舍五入）；
 * - 数据只用调用方已取到的页面数据（project / tasks / summary），导出不额外发请求、不写库、不产生审计。
 * - 2026-10-10 追订（业务口径「暂时先不做页面双语吧 先导出pdf双语 图一 pdf导出 不需要框起来的三行 然后增加预计施工人数」）：
 *   ① 明细表撤「按时交付 / 输出成果文件 / 实际完成」三列、补「预计所需施工人数」（同页面 headcount 口径）；
 *   ② 报告固定文案 / 表头 / 状态签 / 阶段名 / 进度档位补英文小字（中英双语）—— 任务英文名用自带 titleEn，人名 / 编号 / 日期 / 进展描述等数据不翻译。
 *   ③ 抬头改版（业务口径「只保留项目经理 然后最上方导出logo用我这个svg 项目总览报告改成项目进度报告 顶格只保留logo 下方再显示标题」）：
 *      报告名改「项目进度报告 Project Progress Report」；顶部 logo 独占一行（36px 高，改用业务提供的 `public/libiao-logo.svg`，不动站内 logo），
 *      标题与生成时间下移到 logo 下方一行（标题居左、生成时间居右）；项目信息标签只保留「项目经理」（撤状态 / 当前阶段 / 创建时间 / 最近更新四枚）。
 *   ④ 抬头去生成时间（业务 2026-10-10 追加：「生成时间 Generated at …这个也不需要」）：头部右侧撤掉生成时间，logo 下方仅保留标题（左对齐）；生成时间只留在页脚自动生成说明一句里。
 *   ⑤ 抬头只留 logo（业务 2026-10-10 再追加：「这个也不需要了 顶部只保留logo」）：撤抬头标题行（.head__meta / .head__title 及其英文小字规则整条删除），头部只剩 logo；浏览器 <title> 仍为「项目进度报告 Project Progress Report」（另存 PDF 的窗口标题 / 文件名可读）。
 *   ⑥ 项目名后缀（业务 2026-10-10 追加：「后面中心点 加进度报告四个字」）：hero 里的项目名后拼「 · 进度报告」——只加中文四个字，不配英文小字（数据值本不翻译）。
 *   ⑦ hero 左右对调（业务 2026-10-10 追加「左右顺序换一下」）：整体进度块（大号百分比 / 进度条 / 最慢·最新阶段）换到左、项目信息块（编号 / 名称 / 标签）换到右；文本对齐镜像（进度块左对齐、信息块右对齐 + 标签行末端对齐）。
 *   ⑧ 进度列放宽不折行（业务 2026-10-10 追加「右侧空间很大英文不必换行」）：hero 进度列 170 / 190px → 240px —— 实测现有数据两行自然宽 214px、九阶段名最坏（硬件实施 Hardware Implementation / 加工采购 Processing & Procurement）231px，240px 内单行放得下。
 *   ⑨ 标题置顶（业务 2026-10-10 追加「中文标题放在最上方」）：hero 信息块内「项目名 · 进度报告」大标题提到最上，项目编号行下移到标题之下（名称 margin 0、编号行补 2px 上距）。
 *   ⑩ 明细不截断（业务 2026-10-10 追加「这种英文不应该省略 表格宽度可以加宽 不强制在一页展示」）：描述列副行（英文名 + 进展）撤字符截断（原 40 / 56 字）与单行 ellipsis、改自然换行；描述列 29% → 31%（经理 / 负责人列各让 1%）；不再一页优先，页数随内容。
 *   ⑪ 英文小字不重复阿拉伯数字（业务 2026-10-10 追加「然后导出的阿拉伯数字是不需要翻译的」）：分组头英文收成 completed、任务明细 note 英文去掉条数、整体进度英文去掉（已完成 X / Y）、页脚英文去掉生成时间、超量截断提示英文去掉条数 —— 数字属数据、语言无关，只保留在中文主文案一处。
 *   ⑫ 进展描述单列（业务 2026-10-10 追加「项目进展描述单例一列吧 然后需要翻译」）：任务描述副行只留英文名；「项目进展描述 Progress Description」独立成列（第 3 列），列数 9 → 10、列宽重排（3 / 20 / 17 / 8 / 8 / 8.5 / 7.5 / 7.5 / 8 / 12.5 %）、分组头 colspan 同步；列内中文原文 + 英文小字译文（⑬ 追订接线）。
 *   ⑬ 进展描述译文接线（业务 2026-10-10「现在导出没有接入翻译」）：导出前把该列去重非空文本经 translateApi.ts
 *      （POST /api/v1/translate，契约对齐翻译服务 /translate）翻成英文、补在中文原文下方小字；通道不通静默降级为只出中文
 *      （导出照常、不报错）；开发环境代理见 vite.config.ts（TRANSLATE_ORIGIN），生产由后端按同契约实现 —— 见 §6.16 ⑯。
 *      **2026-10-13 追订（§6.16 ㉑）：译文改为「写进展描述时后台预热」（translateApi.ts 会话缓存 + prefetchZhToEn），
 *      导出命中缓存即取、仅未预热条目现场翻（通道不通仍静默降级只出中文）。**
 *   ⑭ 抬头英译 + 页脚删除（业务 2026-10-10「图一也要翻译 最后的结尾也不需要」）：hero 项目名下方补英译小字
 *      （项目名经翻译通道 + 固定后缀 · Progress Report；通道不通则不出英文行）；整条页脚（品牌行 + 自动生成落款）删除 ——
 *      正文之后不再有落款行。
 *   ⑮ 序号列表头去「#」（业务 2026-10-10「这个#号删除」）：表头首格留空，行号照常出（1…N）。
 *   ⑯ 阶段进度说明去前缀（业务 2026-10-10「按项目总览的九个这个前半段字删除」）：说明句改为「施工阶段统计完成情况」（英文小字不动）。
 */
import notoSansScCss from "@fontsource-variable/noto-sans-sc/index.css?inline";
import { type ProjectTask, type TaskStatus } from "./data/tasks";
import { stageNameOf } from "./taskApi";
import { translateZhToEn } from "./translateApi";
import { getLocale, textOf } from "./i18n";
import { projectManagerText } from "./types";
import {
  STAGE_NAMES,
  countsOf,
  dateText,
  groupedByStage,
  ownersText,
  progressLabel,
  progressPct,
  type OverviewExportInput,
  type StageGroup,
} from "./overviewExportShared";

export type { OverviewExportInput } from "./overviewExportShared";

/** 无译文时的缺省映射（静默降级：导出保持中文原文；容错口径见 translateApi.ts）。 */
const EMPTY_TRANSLATIONS: ReadonlyMap<string, string> = new Map();

/** 五个状态色（与页面色签同源；bar = 明细行进度条的填充色）。 */
type StatusTint = { text: string; bg: string; bar: string };

const STATUS_TINT: Record<TaskStatus, StatusTint> = {
  已完成: { text: "#047857", bg: "#d1fae5", bar: "#10b981" },
  提前完成: { text: "#a21caf", bg: "#fae8ff", bar: "#d946ef" },
  进行中: { text: "#b45309", bg: "#fef3c7", bar: "#f59e0b" },
  待开始: { text: "#0369a1", bg: "#e0f2fe", bar: "#0ea5e9" },
  已延期: { text: "#be123c", bg: "#ffe4e6", bar: "#f43f5e" },
};

/** 打印用离屏 iframe 的 id（再点一次导出先撤掉上一枚，避免多份报告叠着打）。 */
const PRINT_FRAME_ID = "overview-export-print-frame";

/**
 * 中英双语词典（2026-10-10 业务口径「暂时先不做页面双语吧 先导出 pdf 双语」）——
 * 报告的固定文案 / 枚举值出中英对照：中文为主、英文小一号浅灰小字（.en）；
 * 数据值（任务名、人名、编号、日期、进展描述）不翻译，任务英文名用任务自带的 titleEn（描述列副行）。
 */
const EN_STAGE: Record<string, string> = {
  售前规划: "Presales Planning",
  设计开发: "Design & Development",
  加工采购: "Processing & Procurement",
  组装发货: "Assembly & Shipping",
  硬件实施: "Hardware Implementation",
  软件部署: "Software Deployment",
  试运行: "Trial Run",
  生产阶段: "Production",
  验收: "Acceptance",
  临时任务: "Temporary Tasks",
  项目总览: "Project Overview",
};

/** 任务五态英文（进度档位里的「已完成」不在此表，见 EN_PROGRESS_LABEL）。 */
const EN_STATUS: Record<TaskStatus, string> = {
  已完成: "Completed",
  提前完成: "Ahead of Schedule",
  进行中: "In Progress",
  待开始: "Not Started",
  已延期: "Overdue",
};

/** 进度四格档位英文（与 data/tasks.ts 的 PROGRESS_LABELS 一一对应）。 */
const EN_PROGRESS_LABEL: Record<string, string> = {
  未开始: "Not Started",
  刚开工: "Just Started",
  完成一半: "Halfway",
  快完成了: "Nearly Done",
  已完成: "Completed",
};

/** 英文小字（lang 标 en，供读屏 / 检索识别第二语言）。 */
function enText(value: string): string {
  return `<span class="en" lang="en">${escapeHtml(value)}</span>`;
}

/** 中文 + 英文小字（词典查不到英文时只出中文，不吞信息）。 */
function bilingual(zh: string, english: string | undefined): string {
  return escapeHtml(zh) + (english === undefined || english === "" ? "" : " " + enText(english));
}

/** 阶段 / 分组名双语（契约九阶段与「临时任务」查词典；历史脏值只出中文）。 */
function stageZhEn(name: string): string {
  return bilingual(name, EN_STAGE[name]);
}

/** 阶段文案的英文：九阶段查词典；「全部完成 / —」两个非阶段文案单独对照。 */
function stageEnOf(text: string): string {
  if (text === "全部完成") {
    return "All Completed";
  }
  return text === "—" ? "" : (EN_STAGE[text] ?? "");
}

/** HTML 文本转义（任务名 / 负责人 / 项目名都是用户输入，一律转义后再拼进报告）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\u0027/g, "&#39;");
}

/** 预计所需施工人数：页面同口径（未填 / ≤0 出「—」，否则「N 人」）。 */
function headcountText(task: ProjectTask): string {
  return task.headcount > 0 ? String(task.headcount) + " 人" : `<span class="dim">—</span>`;
}

/** 百分比文本：总数 0 时出「—」，避免 0 / 0 的假百分比。 */
function percentText(part: number, whole: number): string {
  return whole === 0 ? "—" : String(Math.round((part / whole) * 100)) + "%";
}

/** 横条进度条（报告里唯一一种进度呈现：阶段进度 / 明细行进度共用）。 */
function barHtml(pct: number, color: string, extraClass: string): string {
  return '<div class="bar ' + extraClass + '"><span style="width: ' + String(pct) + "%; background: " + color + '"></span></div>';
}

/** 汇总统计条里的一格（色点 + 数值 + 中英标签（占比）横排 —— 比卡片矮一半，给竖版一页让版面）。 */
function statHtml(label: string, english: string, value: string, hint: string, dot: string): string {
  return (
    `<span class="stat">` +
    `<span class="stat__dot" style="background: ${dot}"></span>` +
    `<span class="stat__value">${value}</span>` +
    bilingual(label, english) +
    (hint === "" ? "" : "（" + hint + "）") +
    `</span>`
  );
}

/** 阶段进度格（九阶段按 5 列网格排、末行 4 格；「临时任务」有任务时才补一格，见调用方过滤）。空阶段出「暂无任务 / No tasks」，不出 0 / 0 的假百分比。 */
function stageCellHtml(group: StageGroup): string {
  const pct = group.total === 0 ? 0 : Math.round((group.done / group.total) * 100);
  const fill = group.total === 0 ? "#d4d4d8" : pct === 100 ? "#10b981" : "#18181b";
  const countText =
    group.total === 0 ? bilingual("暂无任务", "No tasks") : String(group.done) + " / " + String(group.total) + " · " + String(pct) + "%";
  return (
    `<div class="stage">` +
    `<div class="stage__head"><span class="stage__name">${stageZhEn(group.name)}</span>` +
    `<span class="stage__count">${countText}</span></div>` +
    barHtml(pct, fill, "bar--stage") +
    `</div>`
  );
}

/**
 * 任务明细一行（列序 = 表头 colgroup 的顺序）。
 * 2026-10-09 追订（业务口径「紧急重要程度不需要展示 然后输出成果文件需要 项目经理也需要」）：
 * 撤「紧急重要度」列，补「项目经理」（项目级字段、逐行同值）与「输出成果文件」（deliverableTypes）。
 * 2026-10-10 追订（业务口径「pdf 导出 不需要框起来的三行 然后增加预计施工人数」+「先导出 pdf 双语」）：
 * ① 撤「是否按时交付 / 输出成果文件 / 实际完成」三列，补「预计所需施工人数」（同页面 headcount 口径）；
 * ② 状态签 / 进度档位等固定文案补英文小字；任务英文名用自带 titleEn，人名 / 编号 / 日期等数据不翻译。
 * ③ 「项目进展描述」独立成列（任务描述之后，第 3 列；2026-10-10 业务口径「项目进展描述单例一列吧 然后需要翻译」）：任务描述副行只留英文名；列数 9 → 10、列宽重排、分组头 colspan 同步；列内中文原文 + 英文小字译文（⑬ 追订接线）。
 */
function taskRowHtml(index: number, task: ProjectTask, managerText: string, translationMap: ReadonlyMap<string, string>): string {
  const tint = STATUS_TINT[task.status];
  // 全量展示：英文名与进展描述并成一行小字，不再按字符截断（业务 2026-10-10「这种英文不应该省略 表格宽度可以加宽 不强制在一页展示」）
  const subBits: string[] = [];
  if (task.titleEn !== "") {
    subBits.push(escapeHtml(task.titleEn));
  }
  const subHtml = subBits.length === 0 ? "" : `<span class="task__sub">${subBits.join(" · ")}</span>`;
  const noteEn = task.note === "" ? "" : (translationMap.get(task.note) ?? "");
  const noteHtml = task.note === ""
    ? `<span class="dim">—</span>`
    : escapeHtml(task.note) + (noteEn === "" ? "" : `<span class="en" lang="en">${escapeHtml(noteEn)}</span>`);
  const progressZh = progressLabel(task.progress);
  return (
    `<tr>` +
    `<td class="num center">${String(index)}</td>` +
    `<td class="task"><span class="task__title">${escapeHtml(task.title)}</span>${subHtml}</td>` +
    `<td class="pnote">${noteHtml}</td>` +
    `<td class="managers"><span class="one-line">${escapeHtml(managerText)}</span></td>` +
    `<td class="owners"><span class="one-line">${escapeHtml(ownersText(task))}</span></td>` +
    `<td class="center"><span class="chip" style="color: ${tint.text}; background: ${tint.bg}">${bilingual(task.status, EN_STATUS[task.status])}</span></td>` +
    `<td class="num center">${dateText(task.startDate)}</td>` +
    `<td class="num center">${dateText(task.dueDate)}</td>` +
    `<td class="num center">${headcountText(task)}</td>` +
    `<td class="progress">${barHtml(progressPct(task.progress), tint.bar, "bar--row")}<span class="progress__label">${bilingual(progressZh, EN_PROGRESS_LABEL[progressZh])}</span></td>` +
    `</tr>`
  );
}

/** 一个阶段分组 = 一条分组头 + 组内全部任务行（tbody 分组：表头 thead 每页由浏览器自动重复）。 */
function groupSectionHtml(counter: { value: number }, group: StageGroup, managerText: string, translationMap: ReadonlyMap<string, string>): string {
  const rows = group.tasks
    .map((task) => {
      counter.value += 1;
      return taskRowHtml(counter.value, task, managerText, translationMap);
    })
    .join("");
  const countText = String(group.done) + " / " + String(group.total) + " 完成 · " + enText("completed");
  return (
    `<tbody class="grp">` +
    `<tr class="grp__head"><td colspan="10">` +
    `<span class="grp__name">${stageZhEn(group.name)}</span>` +
    `<span class="grp__count">${countText}</span>` +
    `</td></tr>` +
    rows +
    `</tbody>`
  );
}

/** 报告的打印样式（自包含在 iframe 文档里：不依赖站内 Tailwind，也不反向影响站内样式）。 */
const REPORT_STYLE = `
  ${notoSansScCss}
  /* 2026-10-09 追订（先按「纸张竖着了 尽可能在一页展示」改竖版，再按「还是之前的横屏吧」回 **A4 横版**）：
     保留这轮的紧凑结构 —— 统计卡收成一条统计条、阶段进度 5 列网格、明细行英文名与进展描述并成一行小字并按
     列宽单行截断（nowrap + ellipsis），列宽按横版加宽后的单行内容重排（描述 / 交付物列更宽、日期列更窄）；
     字号 / 内边距回到横版舒适档。横版高度有限，按整行分页（表头逐页重复，行与分组头不跨页）。
     2026-10-10 追订（「这种英文不应该省略 表格宽度可以加宽 不强制在一页展示」）：副行撤字符截断与单行 ellipsis、改自然换行
     （overflow-wrap: anywhere），描述列 29% → 31%（经理 / 负责人列各让 1%）；行高随内容增长、页数不设上限。 */
  @page { size: A4 landscape; margin: 10mm 9mm 9mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: #1f2329; font-size: 10px; line-height: 1.45;
    font-family: "Noto Sans SC Variable", "Source Han Sans SC", "Noto Sans SC", sans-serif; }
  .head { padding-bottom: 6px; border-bottom: 2px solid #18181b; }
  .head__logo { display: block; height: 36px; width: auto; }
  .hero { display: flex; align-items: flex-start; gap: 16px; margin-top: 8px; }
  .hero__left { flex: 1; min-width: 0; text-align: right; }
  .hero__code { margin: 2px 0 0; font-size: 9.5px; letter-spacing: 0.04em; color: #71717a; }
  .hero__name { margin: 0; font-size: 17px; line-height: 1.2; font-weight: 700; }
  .hero__name .en { display: block; margin-top: 2px; font-size: 10px; font-weight: 500; }
  .hero__tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 6px; margin: 5px 0 0; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 999px; background: #f4f4f5; color: #52525b; font-size: 9px; }
  .hero__progress { flex: 0 0 240px; }
  .hero__pct { margin: 0; font-size: 24px; line-height: 1; font-weight: 700; font-variant-numeric: tabular-nums; text-align: left; }
  .hero__pct span { margin-left: 1px; font-size: 12px; }
  .hero__label { margin: 2px 0 4px; font-size: 9px; color: #71717a; text-align: left; }
  .hero__foot { margin: 5px 0 0; font-size: 9px; line-height: 1.5; color: #52525b; text-align: left; }
  .bar { height: 4px; border-radius: 999px; background: #eceef1; overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 999px; }
  .stats { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-top: 8px; padding: 6px 10px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
  .stat { display: inline-flex; align-items: baseline; gap: 5px; font-size: 9px; color: #71717a; }
  .stat__dot { width: 6px; height: 6px; border-radius: 999px; align-self: center; }
  .stat__value { font-size: 13px; font-weight: 700; color: #18181b; font-variant-numeric: tabular-nums; }
  .section { margin-top: 8px; }
  .section__title { display: flex; align-items: baseline; gap: 6px; margin: 0 0 5px; font-size: 11.5px; font-weight: 700; }
  .section__title::before { content: ""; width: 3px; height: 11px; border-radius: 2px; background: #18181b; align-self: center; }
  .section__note { margin-left: auto; font-size: 9px; font-weight: 400; color: #a1a1aa; }
  .stages { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px 7px; }
  .stage { padding: 4px 7px 5px; border: 1px solid #e4e4e7; border-radius: 6px; background: #ffffff; break-inside: avoid; }
  .stage__head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
  .stage__name { font-size: 10px; font-weight: 600; }
  .stage__count { font-size: 9px; color: #71717a; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.tasks { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.tasks thead { display: table-header-group; }
  table.tasks th { padding: 4px 5px; background: #18181b; color: #ffffff; font-size: 9px; font-weight: 600; text-align: left; }
  table.tasks td { padding: 3px 5px; border-bottom: 1px solid #e9e9ec; font-size: 9px; line-height: 1.4; vertical-align: top; }
  table.tasks tr { break-inside: avoid; }
  tbody.grp tr.grp__head td { padding: 3px 7px; background: #f4f4f5; border-bottom: 1px solid #e4e4e7; break-after: avoid; }
  .grp__name { font-size: 10px; font-weight: 700; }
  .grp__count { margin-left: 6px; font-size: 9px; color: #71717a; }
  .task__title { font-weight: 600; color: #18181b; }
  .task__sub { display: block; margin-top: 1px; font-size: 8.5px; color: #a1a1aa; overflow-wrap: anywhere; }
  .pnote { font-size: 8.5px; color: #52525b; overflow-wrap: anywhere; }
  .pnote .en { display: block; margin-top: 1px; font-size: 7.5px; }
  .one-line { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .managers { font-size: 8.5px; color: #3f3f46; }
  .chip { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 8.5px; font-weight: 600; white-space: nowrap; }
  .num { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .dim { color: #a1a1aa; }
  .progress { white-space: nowrap; }
  .progress .bar { display: inline-block; width: 28px; height: 4px; vertical-align: middle; }
  .progress__label { display: inline-block; margin-left: 4px; width: 34px; font-size: 8.5px; color: #52525b; vertical-align: middle; }
  .empty { margin: 0; padding: 10px; border: 1px dashed #d4d4d8; border-radius: 6px; color: #a1a1aa; font-size: 10px; text-align: center; }
  /* 2026-10-10 追订（业务口径「先导出 pdf 双语」）：第二语言 = 英文小一号浅灰小字（.en）——
     表头英文独立一行、状态签与进度档位英文独立一行、阶段名英文独立一行，其余标签同行跟随。 */
  .en { font-size: 8px; color: #a1a1aa; }
  table.tasks th .en { display: block; margin-top: 1px; font-size: 7.5px; font-weight: 500; color: rgba(255, 255, 255, 0.78); }
  .chip { text-align: center; line-height: 1.3; }
  .chip .en { display: block; font-size: 7px; font-weight: 500; opacity: 0.8; }
  .stage__head { align-items: flex-start; }
  .stage__name .en { display: block; margin-top: 1px; font-size: 7.5px; font-weight: 400; }
  .grp__name .en { font-weight: 400; }
  .progress__label { width: auto; }
  .progress__label .en { display: block; font-size: 7px; line-height: 1.2; }
  .section__title .en { font-size: 8.5px; font-weight: 600; }
  .tag .en, .stat .en, .section__note .en, .grp__count .en, .hero__code .en, .hero__foot .en, .stage__count .en { font-size: 7.5px; }
  .hero__progress { flex: 0 0 240px; }
`;

/** 报告头部的品牌 logo（业务 2026-10-10 提供的导出专用 SVG，`public/libiao-logo.svg`）：
 *  about:srcdoc 文档里必须用绝对地址，故拼站点 origin（与站内 index.html 的 logo 不同一枚，互不影响）。 */
function brandLogoUrl(): string {
  return window.location.origin + "/libiao-logo.svg";
}

/** 拼一份自包含的报告 HTML（无脚本、无第三方外链；只引用站内 logo 与自托管思源黑体字体分片）。 */
export function buildOverviewReportHtml(input: OverviewExportInput, translationMap: ReadonlyMap<string, string> = EMPTY_TRANSLATIONS): string {
  const { project, tasks, summary } = input;
  const groups = groupedByStage(tasks);
  const counts = countsOf(tasks, summary);
  const stageTextOf = (key: string | null): string => (key === null ? "—" : stageNameOf(key) || "—");
  const slowest = summary === null ? "—" : summary.total > 0 && summary.slowestStage === null ? "全部完成" : stageTextOf(summary.slowestStage);
  const latest = summary === null ? "—" : stageTextOf(summary.latestStage);
  const slowestEn = stageEnOf(slowest);
  const latestEn = stageEnOf(latest);
  const nameEn = translationMap.get(project.description) ?? "";
  const heroLabelZh = counts.total === 0 ? "整体进度" : "整体进度（已完成 " + String(counts.done) + " / " + String(counts.total) + "）";
  const heroLabelEn = "Overall Progress";
  /** 占比文案：总数 0 时省略（不出 0 / 0 的假百分比）。 */
  const shareOf = (part: number): string => (counts.total === 0 ? "" : percentText(part, counts.total));
  const stats = [
    statHtml("任务总数", "Total Tasks", String(counts.total), "", "#18181b"),
    statHtml("已完成", "Completed", String(counts.done), shareOf(counts.done), "#10b981"),
    statHtml("进行中", "In Progress", String(counts.active), shareOf(counts.active), "#f59e0b"),
    statHtml("待开始", "Not Started", String(counts.pending), shareOf(counts.pending), "#0ea5e9"),
    statHtml("已延期", "Overdue", String(counts.overdue), shareOf(counts.overdue), "#f43f5e"),
  ].join("");

  // 阶段进度区：九个施工阶段常显；「临时任务」与契约外的分组只在有任务时出现（0 / 0 的空分组对客户没意义）
  const stageCells = groups
    .filter((group) => group.tasks.length > 0 || STAGE_NAMES.includes(group.name))
    .map((group) => stageCellHtml(group))
    .join("");
  const detailGroups = groups.filter((group) => group.tasks.length > 0);
  const counter = { value: 0 };
  const managerText = projectManagerText(project);
  const detailRows = detailGroups.map((group) => groupSectionHtml(counter, group, managerText, translationMap)).join("");
  const clippedNote = counts.total > tasks.length ? "（列表一次取满 " + String(tasks.length) + " 条，明细只含已取到的任务 · " + enText("list capped, fetched tasks only") + "）" : "";
  const tableHtml =
    detailRows === ""
      ? '<p class="empty">本项目暂无任务 · No tasks in this project.</p>'
      : `<table class="tasks">
    <colgroup>
      <col style="width: 3%" />
      <col style="width: 20%" />
      <col style="width: 17%" />
      <col style="width: 8%" />
      <col style="width: 8%" />
      <col style="width: 8.5%" />
      <col style="width: 7.5%" />
      <col style="width: 7.5%" />
      <col style="width: 8%" />
      <col style="width: 12.5%" />
    </colgroup>
    <thead>
      <tr>
        <th class="center"></th>
        <th>任务描述 <span class="en" lang="en">Task Description</span></th>
        <th>项目进展描述 <span class="en" lang="en">Progress Description</span></th>
        <th>项目经理 <span class="en" lang="en">Project Manager</span></th>
        <th>任务负责人 <span class="en" lang="en">Task Owners</span></th>
        <th class="center">任务状态 <span class="en" lang="en">Status</span></th>
        <th class="center">开始日期 <span class="en" lang="en">Start Date</span></th>
        <th class="center">预计完成 <span class="en" lang="en">Planned End</span></th>
        <th class="center">预计所需施工人数 <span class="en" lang="en">Est. Headcount</span></th>
        <th class="center">进度 <span class="en" lang="en">Progress</span></th>
      </tr>
    </thead>
    ${detailRows}
  </table>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(project.description)} · 项目进度报告 Project Progress Report</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
  <header class="head">
    <img class="head__logo" src="${brandLogoUrl()}" alt="LibiaoLink" />
  </header>

  <section class="hero">
    <div class="hero__progress">
      <p class="hero__pct">${String(counts.pct)}<span>%</span></p>
      <p class="hero__label">${heroLabelZh}<br />${enText(heroLabelEn)}</p>
      ${barHtml(counts.pct, "#18181b", "bar--hero")}
      <p class="hero__foot">最慢阶段 <span class="en" lang="en">Slowest Stage</span>：${bilingual(slowest, slowestEn)}<br />最新阶段 <span class="en" lang="en">Latest Stage</span>：${bilingual(latest, latestEn)}</p>
    </div>
    <div class="hero__left">
      <h1 class="hero__name">${escapeHtml(project.description)} · 进度报告${nameEn === "" ? "" : `<span class="en" lang="en">${escapeHtml(nameEn)} · Progress Report</span>`}</h1>
      <p class="hero__code">项目编号 <span class="en" lang="en">Project Code</span>：${escapeHtml(project.code)}</p>
      <div class="hero__tags">
        <span class="tag">项目经理 <span class="en" lang="en">Project Manager</span>：${escapeHtml(projectManagerText(project))}</span>
      </div>
    </div>
  </section>

  <section class="stats">${stats}</section>

  <section class="section">
    <h2 class="section__title">阶段进度 <span class="en" lang="en">Stage Progress</span><span class="section__note">施工阶段统计完成情况 <span class="en" lang="en">Completion of the nine construction stages</span></span></h2>
    <div class="stages">${stageCells}</div>
  </section>

  <section class="section">
    <h2 class="section__title">任务明细 <span class="en" lang="en">Task Details</span><span class="section__note">共 ${String(counts.total)} 条 · tasks in total${clippedNote}</span></h2>
    ${tableHtml}
  </section>

</body>
</html>`;
}

/**
 * 导出项目总览为 PDF：先补英文小字（项目名 + 「项目进展描述」列，translateApi.ts；通道不通静默降级）——
 * 2026-10-13 起译文通常在「写进展描述」时已后台预热（§6.16 ㉑），命中缓存即取、只有未预热条目才现场翻，
 * 再拼报告 HTML → 离屏 iframe → 唤起系统打印窗口（用户在窗口里选「另存为 PDF」）。
 * 异步返回：等待译文（命中缓存即时返回；未预热条目去重 + 限并发现场翻，单条 0.1–2s 量级）；
 * 落盘位置由用户在打印窗口里选，前端不接触文件系统。
 * onTranslateProgress(done, total)：译文进度回调（导出等待浮层据此显示「项目进展描述翻译中 + 预计秒数」，§6.16 ⑳）。
 */
export async function exportProjectOverviewPdf(
  input: OverviewExportInput,
  onTranslateProgress?: (done: number, total: number) => void,
): Promise<void> {
  const translationMap = await translateZhToEn(
    [input.project.description, ...input.tasks.map((task) => task.note)],
    onTranslateProgress,
  );
  printHtmlDocument(buildOverviewReportHtml(input, translationMap));
}

/** 把报告文档送进离屏 iframe 并唤起打印（iframe 方案不会被弹窗拦截，也不动站内 DOM / 样式）。 */
function printHtmlDocument(html: string): void {
  const previous = document.getElementById(PRINT_FRAME_ID);
  if (previous !== null) {
    previous.remove();
  }
  const frame = document.createElement("iframe");
  frame.id = PRINT_FRAME_ID;
  frame.title = textOf(getLocale(), "exp.frameTitle");
  frame.setAttribute("aria-hidden", "true");
  // 离屏但要保持渲染（display:none 的 iframe 在部分浏览器里会打印空白）：挪到视口外、尺寸给足
  frame.style.cssText = "position: fixed; left: -20000px; top: 0; width: 1280px; height: 900px; border: 0;";
  frame.srcdoc = html;
  frame.addEventListener(
    "load",
    () => {
      const target = frame.contentWindow;
      if (target === null) {
        frame.remove();
        return;
      }
      // 打印窗口关闭（含「取消」）即回收 iframe；个别浏览器不派发 afterprint 时由下面这条兜底
      target.addEventListener("afterprint", () => frame.remove(), { once: true });
      window.setTimeout(() => frame.remove(), 10 * 60 * 1000);
      // 自托管思源黑体按 unicode-range 分片加载；等字体就绪再唤起打印预览，最长等 5s 后兜底。
      const fontReady = target.document.fonts?.ready ?? Promise.resolve();
      void Promise.race([
        fontReady.catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 5000)),
      ]).then(() => {
        window.setTimeout(() => {
          try {
            target.focus();
            target.print();
          } catch {
            frame.remove();
          }
        }, 120);
      });
    },
    { once: true },
  );
  document.body.appendChild(frame);
}
