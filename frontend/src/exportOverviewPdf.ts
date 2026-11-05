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
 *   2026-10-23 追订（业务口径「这边导入加入 日文和韩文 也要翻译」）：主体语言扩为 zh / en / ja / ko；
 *   固定文案走四语词典，日 / 韩主体的项目名、任务名、进展描述按 target=ja|ko 走翻译通道，中文降为小字；
 *   报告内联 Noto Sans JP / KR，中文小字仍用 Noto Sans SC。
 */
import notoSansJpCss from "@fontsource-variable/noto-sans-jp/index.css?inline";
import notoSansKrCss from "@fontsource-variable/noto-sans-kr/index.css?inline";
import notoSansScCss from "@fontsource-variable/noto-sans-sc/index.css?inline";
import { type ProjectTask, type TaskStatus } from "./data/tasks";
import { stageNameOf } from "./taskApi";
import { translateZhTo, type TranslationTarget } from "./translateApi";
import overviewPreviewPagedCss from "./overviewPreviewPaged.css?inline";
import overviewPreviewPagedScriptUrl from "./overviewPreviewPaged.js?url";
import { getLocale, textOf } from "./i18n";
import { projectManagerText } from "./types";
import {
  STAGE_NAMES,
  countsOf,
  dateText,
  groupedByStage,
  isDoneStatus,
  ownersText,
  progressLabel,
  progressPct,
  DEFAULT_OVERVIEW_EXPORT_OPTIONS,
  type OverviewExportInput,
  type OverviewExportLanguage,
  type OverviewExportOptions,
  type StageGroup,
} from "./overviewExportShared";

export type { OverviewExportInput, OverviewExportLanguage, OverviewExportOptions, OverviewExportStageOption } from "./overviewExportShared";

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
 * 四语报告词典（2026-10-23 追订）：中文 / 英文 / 日文 / 韩文主体共用一套固定文案口径。
 * 报告的数据值仍不在这里翻译 —— 项目名 / 任务名 / 进展描述走 translateApi.ts。
 */
type LanguageStrings = { en: string; ja: string; ko: string };

const STAGE_TEXT: Record<string, LanguageStrings> = {
  售前规划: { en: "Presales Planning", ja: "プリセールス計画", ko: "프리세일즈 기획" },
  设计开发: { en: "Design & Development", ja: "設計・開発", ko: "설계 및 개발" },
  加工采购: { en: "Processing & Procurement", ja: "加工・調達", ko: "가공 및 조달" },
  组装发货: { en: "Assembly & Shipping", ja: "組立・出荷", ko: "조립 및 출하" },
  硬件实施: { en: "Hardware Implementation", ja: "ハードウェア実装", ko: "하드웨어 구축" },
  软件部署: { en: "Software Deployment", ja: "ソフトウェア配備", ko: "소프트웨어 배포" },
  试运行: { en: "Trial Run", ja: "試運転", ko: "시운전" },
  生产阶段: { en: "Production", ja: "生産段階", ko: "생산 단계" },
  验收: { en: "Acceptance", ja: "検収", ko: "검수" },
  临时任务: { en: "Temporary Tasks", ja: "臨時タスク", ko: "임시 작업" },
  项目总览: { en: "Project Overview", ja: "プロジェクト概要", ko: "프로젝트 개요" },
};

const STATUS_TEXT: Record<TaskStatus, LanguageStrings> = {
  已完成: { en: "Completed", ja: "完了", ko: "완료" },
  提前完成: { en: "Ahead of Schedule", ja: "予定前完了", ko: "조기 완료" },
  进行中: { en: "In Progress", ja: "進行中", ko: "진행 중" },
  待开始: { en: "Not Started", ja: "未着手", ko: "시작 전" },
  已延期: { en: "Overdue", ja: "遅延", ko: "지연" },
};

const PROGRESS_TEXT: Record<string, LanguageStrings> = {
  未开始: { en: "Not Started", ja: "未着手", ko: "미시작" },
  刚开工: { en: "Just Started", ja: "着工直後", ko: "착수 직후" },
  完成一半: { en: "Halfway", ja: "半ば完了", ko: "절반 완료" },
  快完成了: { en: "Nearly Done", ja: "まもなく完了", ko: "거의 완료" },
  已完成: { en: "Completed", ja: "完了", ko: "완료" },
};

const FIXED_TEXT: Record<string, LanguageStrings> = {
  ...STAGE_TEXT,
  ...STATUS_TEXT,
  ...PROGRESS_TEXT,
  整体进度: { en: "Overall Progress", ja: "全体進捗", ko: "전체 진행률" },
  任务总数: { en: "Total Tasks", ja: "タスク総数", ko: "전체 작업" },
  完成: { en: "completed", ja: "完了", ko: "완료" },
  全部完成: { en: "All Completed", ja: "すべて完了", ko: "모두 완료" },
  暂无任务: { en: "No tasks", ja: "タスクなし", ko: "작업 없음" },
  待分配: { en: "Unassigned", ja: "未割当", ko: "미배정" },
  项目编号: { en: "Project Code", ja: "プロジェクト番号", ko: "프로젝트 번호" },
  项目经理: { en: "Project Manager", ja: "プロジェクト責任者", ko: "프로젝트 관리자" },
  阶段进度: { en: "Stage Progress", ja: "ステージ進捗", ko: "단계 진행률" },
  施工阶段统计完成情况: { en: "Completion of the nine construction stages", ja: "9つの施工段階の完了状況", ko: "9개 시공 단계 완료 현황" },
  任务明细: { en: "Task Details", ja: "タスク詳細", ko: "작업 상세" },
  任务描述: { en: "Task Description", ja: "タスク内容", ko: "작업 설명" },
  项目进展描述: { en: "Progress Description", ja: "進捗内容", ko: "진행 상세" },
  任务负责人: { en: "Task Owners", ja: "タスク担当者", ko: "작업 담당자" },
  任务状态: { en: "Status", ja: "ステータス", ko: "상태" },
  开始日期: { en: "Start Date", ja: "開始日", ko: "시작일" },
  预计完成: { en: "Planned End", ja: "完了予定", ko: "완료 예정" },
  预计所需施工人数: { en: "Est. Headcount", ja: "必要作業人数（概算）", ko: "예상 투입 인원" },
  进度: { en: "Progress", ja: "進捗", ko: "진행률" },
  最新阶段: { en: "Latest Stage", ja: "最新ステージ", ko: "최신 단계" },
  项目进度报告: { en: "Project Progress Report", ja: "プロジェクト進捗報告", ko: "프로젝트 진행 보고서" },
  进度报告: { en: "Progress Report", ja: "進捗報告", ko: "진행 보고서" },
};

/** HTML 文本转义（任务名 / 负责人 / 项目名都是用户输入，一律转义后再拼进报告）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\u0027/g, "&#39;");
}

function languageAttr(language: OverviewExportLanguage): string {
  return language === "zh" ? "zh-CN" : language;
}

/** 次要语言小字：中文主体放英文，其他主体放中文。 */
function secondaryText(value: string, language: OverviewExportLanguage): string {
  return `<span class="secondary" lang="${languageAttr(language)}">${escapeHtml(value)}</span>`;
}

/** 固定文案的目标语言值；缺词典时回退英文，再回退中文。 */
function localizedValue(zh: string, primary: OverviewExportLanguage): string {
  if (primary === "zh") {
    return zh;
  }
  const strings = FIXED_TEXT[zh];
  if (strings === undefined) {
    return zh;
  }
  return strings[primary] || strings.en || zh;
}

/** 固定文案：主体语言为主文案，非中文主体的中文原文作小字；中文主体保留英文小字。 */
function fixedText(zh: string, primary: OverviewExportLanguage): string {
  const main = localizedValue(zh, primary);
  if (primary === "zh") {
    const english = FIXED_TEXT[zh]?.en ?? "";
    return escapeHtml(main) + (english === "" ? "" : " " + secondaryText(english, "en"));
  }
  return escapeHtml(main) + (main === zh ? "" : " " + secondaryText(zh, "zh"));
}

/** 数据值译文：主体语言在前；非中文主体把中文原文降为小字，译文缺失时逐项回退中文。 */
function translatedText(zh: string, translated: string | undefined, primary: OverviewExportLanguage): string {
  if (primary === "zh") {
    return escapeHtml(zh) + (translated === undefined || translated === "" ? "" : " " + secondaryText(translated, "en"));
  }
  const main = translated === undefined || translated === "" ? zh : translated;
  return escapeHtml(main) + (main === zh ? "" : " " + secondaryText(zh, "zh"));
}

/** 英文 / 韩文用半角冒号；中文 / 日文保持全角冒号。 */
function labelColon(primary: OverviewExportLanguage): string {
  return primary === "zh" || primary === "ja" ? "：" : ": ";
}

/** 预计所需施工人数：页面同口径（未填 / ≤0 出「—」，否则「N 人」）。 */
function headcountText(task: ProjectTask, primary: OverviewExportLanguage): string {
  if (task.headcount <= 0) {
    return `<span class="dim">—</span>`;
  }
  if (primary === "zh") {
    return String(task.headcount) + " 人";
  }
  const unit = primary === "en" ? " people " : primary === "ja" ? " 名 " : "명 ";
  return String(task.headcount) + unit + secondaryText("人", "zh");
}

/** 百分比文本：总数 0 时出「—」，避免 0 / 0 的假百分比。 */
function percentText(part: number, whole: number): string {
  return whole === 0 ? "—" : String(Math.round((part / whole) * 100)) + "%";
}

/** 横条进度条（报告里唯一一种进度呈现：阶段进度 / 明细行进度共用）。 */
function barHtml(pct: number, color: string, extraClass: string): string {
  return "<div class=\"bar " + extraClass + "\"><span style=\"width: " + String(pct) + "%; background: " + color + "\"></span></div>";
}

/** 汇总统计条里的一格（色点 + 数值 + 四语标签（占比）横排）。 */
function statHtml(label: string, value: string, hint: string, dot: string, primary: OverviewExportLanguage): string {
  const hintHtml = hint === "" ? "" : primary === "ko" ? " (" + hint + ")" : "（" + hint + "）";
  return (
    `<span class="stat">` +
    `<span class="stat__dot" style="background: ${dot}"></span>` +
    `<span class="stat__value">${value}</span>` +
    fixedText(label, primary) +
    hintHtml +
    `</span>`
  );
}

/** 阶段进度格：九阶段按 5 列网格排、末行 4 格；空阶段出「暂无任务」。 */
function stageCellHtml(group: StageGroup, primary: OverviewExportLanguage): string {
  const pct = group.total === 0 ? 0 : Math.round((group.done / group.total) * 100);
  const fill = group.total === 0 ? "#d4d4d8" : pct === 100 ? "#10b981" : "#18181b";
  const countText =
    group.total === 0 ? fixedText("暂无任务", primary) : String(group.done) + " / " + String(group.total) + " · " + String(pct) + "%";
  return (
    `<div class="stage">` +
    `<div class="stage__head"><span class="stage__name">${fixedText(group.name, primary)}</span>` +
    `<span class="stage__count">${countText}</span></div>` +
    barHtml(pct, fill, "bar--stage") +
    `</div>`
  );
}

/** 阶段总体状态（折叠阶段的分组汇总行实时统计）：有延期优先标记；全部完成 = 已完成；有进展 = 进行中；否则待开始。 */
function stageOverallStatus(group: StageGroup): TaskStatus | null {
  if (group.total === 0) {
    return null;
  }
  if (group.done === group.total) {
    return "已完成";
  }
  if (group.tasks.some((task) => task.status === "已延期")) {
    return "已延期";
  }
  if (group.tasks.some((task) => task.status === "进行中" || isDoneStatus(task.status))) {
    return "进行中";
  }
  return "待开始";
}

/** 任务明细一行：日 / 韩主体额外翻译任务标题；中文 / 英文主体保持原有 title / titleEn 口径。 */
function taskRowHtml(index: number, task: ProjectTask, managerText: string, translationMap: ReadonlyMap<string, string>, primary: OverviewExportLanguage): string {
  const tint = STATUS_TINT[task.status];
  const hasTitleEn = task.titleEn !== "";
  let titleMain = task.title;
  let titleSecondary = "";
  let titleLang = "zh-CN";
  if (primary === "en") {
    titleMain = hasTitleEn ? task.titleEn : task.title;
    titleSecondary = hasTitleEn ? task.title : "";
    titleLang = hasTitleEn ? "en" : "zh-CN";
  } else if (primary === "ja" || primary === "ko") {
    const translated = translationMap.get(task.title) ?? "";
    if (translated !== "") {
      titleMain = translated;
      titleSecondary = task.title;
      titleLang = primary;
    } else if (hasTitleEn) {
      titleMain = task.titleEn;
      titleSecondary = task.title;
      titleLang = "en";
    }
  } else if (hasTitleEn) {
    titleSecondary = task.titleEn;
  }
  const secondaryLang = primary === "zh" ? "en" : "zh-CN";
  const subHtml = titleSecondary === "" ? "" : `<span class="task__sub" lang="${secondaryLang}">${escapeHtml(titleSecondary)}</span>`;
  const translatedNote = task.note === "" ? "" : (translationMap.get(task.note) ?? "");
  const noteHtml = task.note === "" ? `<span class="dim">—</span>` : translatedText(task.note, translatedNote, primary);
  const ownersTextValue = ownersText(task);
  const ownersHtml = task.owners.length === 0
    ? primary === "zh" ? "待分配" : fixedText("待分配", primary)
    : escapeHtml(ownersTextValue);
  const progressZh = progressLabel(task.progress);
  return (
    `<tr>` +
    `<td class="num center">${String(index)}</td>` +
    `<td class="task"><span class="task__title" lang="${titleLang}">${escapeHtml(titleMain)}</span>${subHtml}</td>` +
    `<td class="pnote">${noteHtml}</td>` +
    `<td class="managers"><span class="one-line">${escapeHtml(managerText)}</span></td>` +
    `<td class="owners"><span class="one-line">${ownersHtml}</span></td>` +
    `<td class="center"><span class="chip" style="color: ${tint.text}; background: ${tint.bg}">${fixedText(task.status, primary)}</span></td>` +
    `<td class="num center">${dateText(task.startDate)}</td>` +
    `<td class="num center">${dateText(task.dueDate)}</td>` +
    `<td class="num center">${headcountText(task, primary)}</td>` +
    `<td class="progress">${barHtml(progressPct(task.progress), tint.bar, "bar--row")}<span class="progress__label">${fixedText(progressZh, primary)}</span></td>` +
    `</tr>`
  );
}

/** 折叠阶段日期范围：忽略空值，取组内最早开始日期与最晚预计完成日期（契约日期为 ISO，可直接做字符串比较）。 */
function groupDateRange(group: StageGroup): { start: string; due: string } {
  let start = "";
  let due = "";
  for (const task of group.tasks) {
    if (task.startDate !== "" && (start === "" || task.startDate < start)) {
      start = task.startDate;
    }
    if (task.dueDate !== "" && (due === "" || task.dueDate > due)) {
      due = task.dueDate;
    }
  }
  return { start, due };
}

/** 阶段行只改折叠头：任务表头（10 列）保持原样；折叠阶段不出任务行，完成数 / 项目经理 / 最早开始 / 最晚完成 / 状态 / 进度分别对齐原表列，任务负责人与人数留空。 */
function groupSectionHtml(
  counter: { value: number },
  group: StageGroup,
  managerText: string,
  translationMap: ReadonlyMap<string, string>,
  primary: OverviewExportLanguage,
  collapsed: boolean,
): string {
  const countText =
    String(group.done) + " / " + String(group.total) + " " + escapeHtml(localizedValue("完成", primary)) + " · " +
    (primary === "zh" ? secondaryText("completed", "en") : secondaryText("完成", "zh"));
  if (collapsed) {
    counter.value += group.tasks.length;
    const pct = group.total === 0 ? 0 : Math.round((group.done / group.total) * 100);
    const status = stageOverallStatus(group);
    const tint = status === null ? { text: "#52525b", bg: "#f4f4f5" } : STATUS_TINT[status];
    const dateRange = groupDateRange(group);
    const fill = group.total === 0 ? "#d4d4d8" : pct === 100 ? "#10b981" : "#18181b";
    return (
      '<tbody class="grp">' +
      '<tr class="grp__head grp__head--collapsed">' +
      '<td class="num center"></td>' +
      '<td class="grp__name">' + fixedText(group.name, primary) + '</td>' +
      '<td class="grp__count">' + countText + '</td>' +
      '<td class="managers"><span class="one-line">' + escapeHtml(managerText) + '</span></td>' +
      '<td class="owners"></td>' +
      '<td class="grp__status center">' + '<span class="chip" style="color: ' + tint.text + '; background: ' + tint.bg + '">' + fixedText(status ?? "暂无任务", primary) + '</span></td>' +
      '<td class="num center">' + dateText(dateRange.start) + '</td>' +
      '<td class="num center">' + dateText(dateRange.due) + '</td>' +
      '<td class="num center"></td>' +
      '<td class="grp__progress-cell">' + '<span class="grp__progress">' + barHtml(pct, fill, "bar--grp") + '<span>' + (group.total === 0 ? "—" : String(pct) + "%") + '</span></span></td>' +
      '</tr>' +
      '</tbody>'
    );
  }
  const rows = group.tasks
    .map((task) => {
      counter.value += 1;
      return taskRowHtml(counter.value, task, managerText, translationMap, primary);
    })
    .join("");
  return (
    '<tbody class="grp">' +
    '<tr class="grp__head"><td colspan="10">' +
    '<span class="grp__name">' + fixedText(group.name, primary) + '</span>' +
    '<span class="grp__count">' + countText + '</span>' +
    '</td></tr>' +
    rows +
    '</tbody>'
  );
}

/** 报告的打印样式（自包含在 iframe 文档里：不依赖站内 Tailwind，也不反向影响站内样式）。 */
const REPORT_STYLE = `
  ${notoSansJpCss}
  ${notoSansKrCss}
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
  body.primary-ja { font-family: "Noto Sans JP Variable", "Noto Sans SC Variable", "Noto Sans KR Variable", sans-serif; }
  body.primary-ko { font-family: "Noto Sans KR Variable", "Noto Sans SC Variable", "Noto Sans JP Variable", sans-serif; }
  .secondary[lang="zh-CN"] { font-family: "Noto Sans SC Variable", "Noto Sans JP Variable", "Noto Sans KR Variable", sans-serif; }
  .head { padding-bottom: 6px; border-bottom: 2px solid #18181b; }
  .head__logo { display: block; height: 36px; width: auto; }
  .hero { display: flex; align-items: flex-start; gap: 16px; margin-top: 8px; }
  .hero__left { flex: 1; min-width: 0; text-align: right; }
  .hero__code { margin: 2px 0 0; font-size: 9.5px; letter-spacing: 0.04em; color: #71717a; }
  .hero__name { margin: 0; font-size: 17px; line-height: 1.2; font-weight: 700; }
  .hero__name .secondary { display: block; margin-top: 2px; font-size: 10px; font-weight: 500; }
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
  tbody.grp tr.grp__head--collapsed td { padding: 6px 5px; background: #fafafa; border: 0; border-bottom: 1px solid #e4e4e7; vertical-align: middle; }
  tbody.grp tr.grp__head--collapsed td:first-child { padding-left: 7px; border-left: 1px solid #e4e4e7; }
  tbody.grp tr.grp__head--collapsed td:last-child { padding-right: 7px; border-right: 1px solid #e4e4e7; }
  tbody.grp tr.grp__head--collapsed .grp__status { padding-left: 0; padding-right: 0; }
  tbody.grp tr.grp__head--collapsed .grp__status .chip { font-size: 8.5px; }
  tbody.grp tr.grp__head--collapsed .grp__count { margin-left: 0; padding-left: 5px; }
  tbody.grp tr.grp__head--collapsed .grp__progress { display: flex; justify-content: flex-start; width: 100%; min-width: 0; margin-left: 0; gap: 4px; }
  tbody.grp tr.grp__head--collapsed .grp__progress .bar { width: 28px; }
  .grp__meta { display: inline-flex; align-items: baseline; gap: 3px; margin-left: 7px; color: #71717a; font-size: 8.5px; }
  .grp__meta-label { font-size: 8.5px; }
  .grp__meta-value { max-width: 120px; color: #3f3f46; font-size: 8.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grp__progress { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; min-width: 104px; color: #52525b; font-size: 8.5px; font-variant-numeric: tabular-nums; }
  .grp__progress .bar { width: 72px; height: 4px; }
  .task__title { font-weight: 600; color: #18181b; }
  .task__sub { display: block; margin-top: 1px; font-size: 8.5px; color: #a1a1aa; overflow-wrap: anywhere; }
  .pnote { font-size: 8.5px; color: #52525b; overflow-wrap: anywhere; }
  .pnote .secondary { display: block; margin-top: 1px; font-size: 7.5px; }
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
  /* 中英双语层级：次要语言统一为小一号浅灰小字（.secondary）——中文主体时是英文，英文主体时是中文；
     表头、状态签、进度档位与阶段名的次要语言独立一行，其余标签同行跟随。 */
  .secondary { font-size: 8px; color: #a1a1aa; }
  table.tasks th .secondary { display: block; margin-top: 1px; font-size: 7.5px; font-weight: 500; color: rgba(255, 255, 255, 0.78); }
  .chip { text-align: center; line-height: 1.3; }
  .chip .secondary { display: block; font-size: 7px; font-weight: 500; opacity: 0.8; }
  .stage__head { align-items: flex-start; }
  .stage__name .secondary { display: block; margin-top: 1px; font-size: 7.5px; font-weight: 400; }
  .grp__name .secondary { font-weight: 400; }
  .progress__label { width: auto; }
  .progress__label .secondary { display: block; font-size: 7px; line-height: 1.2; }
  .section__title .secondary { font-size: 8.5px; font-weight: 600; }
  .tag .secondary, .stat .secondary, .section__note .secondary, .grp__count .secondary, .hero__code .secondary, .hero__foot .secondary, .stage__count .secondary { font-size: 7.5px; }
  .hero__progress { flex: 0 0 240px; }
`;

/** 报告头部的品牌 logo（业务 2026-10-10 提供的导出专用 SVG，`public/libiao-logo.svg`）：
 *  about:srcdoc 文档里必须用绝对地址，故拼站点 origin（与站内 index.html 的 logo 不同一枚，互不影响）。 */
function brandLogoUrl(): string {
  return window.location.origin + "/libiao-logo.svg";
}

/** 拼一份自包含的报告 HTML（无脚本、无第三方外链；只引用站内 logo 与自托管思源黑体字体分片）。 */
export function buildOverviewReportHtml(
  input: OverviewExportInput,
  translationMap: ReadonlyMap<string, string> = EMPTY_TRANSLATIONS,
  primary: OverviewExportLanguage = "zh",
  collapsedStages: readonly string[] = [],
): string {
  const { project, tasks, summary } = input;
  const groups = groupedByStage(tasks);
  const counts = countsOf(tasks, summary);
  const stageTextOf = (key: string | null): string => (key === null ? "—" : stageNameOf(key) || "—");
  const latest = summary === null ? "—" : stageTextOf(summary.latestStage);
  const translatedName = translationMap.get(project.description) ?? "";
  const heroLabelZh = counts.total === 0 ? "整体进度" : "整体进度（已完成 " + String(counts.done) + " / " + String(counts.total) + "）";
  const heroLabelEn = counts.total === 0
    ? "Overall Progress"
    : "Overall Progress (" + String(counts.done) + " / " + String(counts.total) + " completed)";
  const heroLabelJa = counts.total === 0
    ? "全体進捗"
    : "全体進捗（完了 " + String(counts.done) + " / " + String(counts.total) + "）";
  const heroLabelKo = counts.total === 0
    ? "전체 진행률"
    : "전체 진행률(완료 " + String(counts.done) + " / " + String(counts.total) + ")";
  const heroLabelMain = primary === "zh" ? heroLabelZh : primary === "en" ? heroLabelEn : primary === "ja" ? heroLabelJa : heroLabelKo;
  const heroLabelSecondary = primary === "zh" ? "Overall Progress" : heroLabelZh;
  const heroLabelHtml = escapeHtml(heroLabelMain) + "<br />" + secondaryText(heroLabelSecondary, primary === "zh" ? "en" : "zh");
  const shareOf = (part: number): string => (counts.total === 0 ? "" : percentText(part, counts.total));
  const stats = [
    statHtml("任务总数", String(counts.total), "", "#18181b", primary),
    statHtml("已完成", String(counts.done), shareOf(counts.done), "#10b981", primary),
    statHtml("进行中", String(counts.active), shareOf(counts.active), "#f59e0b", primary),
    statHtml("待开始", String(counts.pending), shareOf(counts.pending), "#0ea5e9", primary),
    statHtml("已延期", String(counts.overdue), shareOf(counts.overdue), "#f43f5e", primary),
  ].join("");

  const reportGroups = groups.filter((group) => group.tasks.length > 0 || STAGE_NAMES.includes(group.name));
  const stageCells = reportGroups.map((group) => stageCellHtml(group, primary)).join("");
  const detailGroups = groups.filter((group) => group.tasks.length > 0);
  const counter = { value: 0 };
  const managerText = projectManagerText(project);
  const collapsed = new Set(collapsedStages);
  const detailRows = detailGroups
    .map((group) => groupSectionHtml(counter, group, managerText, translationMap, primary, collapsed.has(group.name)))
    .join("");
  const fetchedCount = String(tasks.length);
  let clippedNote = "";
  if (counts.total > tasks.length) {
    const clippedZh = "列表一次取满 " + fetchedCount + " 条，明细只含已取到的任务";
    if (primary === "zh") {
      clippedNote = "（列表一次取满 " + fetchedCount + " 条，明细只含已取到的任务 · " + secondaryText("list capped, fetched tasks only", "en") + "）";
    } else if (primary === "en") {
      clippedNote = " (list capped to " + fetchedCount + " · " + secondaryText(clippedZh, "zh") + ")";
    } else if (primary === "ja") {
      clippedNote = "（一覧は " + fetchedCount + " 件まで取得済みのため、明細は取得済みタスクのみ · " + secondaryText(clippedZh, "zh") + "）";
    } else {
      clippedNote = " (" + fetchedCount + "개까지만 조회되어 상세에는 조회된 작업만 표시됩니다 · " + secondaryText(clippedZh, "zh") + ")";
    }
  }
  let emptyText = "本项目暂无任务 · " + secondaryText("No tasks in this project.", "en");
  if (primary === "en") {
    emptyText = "No tasks in this project. " + secondaryText("本项目暂无任务。", "zh");
  } else if (primary === "ja") {
    emptyText = "このプロジェクトにはタスクがありません。 " + secondaryText("本项目暂无任务。", "zh");
  } else if (primary === "ko") {
    emptyText = "이 프로젝트에는 작업이 없습니다. " + secondaryText("本项目暂无任务。", "zh");
  }
  const tableHtml =
    detailRows === ""
      ? `<p class="empty">${emptyText}</p>`
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
        <th>${fixedText("任务描述", primary)}</th>
        <th>${fixedText("项目进展描述", primary)}</th>
        <th>${fixedText("项目经理", primary)}</th>
        <th>${fixedText("任务负责人", primary)}</th>
        <th class="center">${fixedText("任务状态", primary)}</th>
        <th class="center">${fixedText("开始日期", primary)}</th>
        <th class="center">${fixedText("预计完成", primary)}</th>
        <th class="center">${fixedText("预计所需施工人数", primary)}</th>
        <th class="center">${fixedText("进度", primary)}</th>
      </tr>
    </thead>
    ${detailRows}
  </table>`;

  const latestLabel = fixedText("最新阶段", primary);
  const projectNameTarget = translatedName === "" ? project.description : translatedName;
  const heroNameZh = project.description + " · 进度报告";
  const heroNameEn = projectNameTarget + " · Progress Report";
  const heroNameTarget = projectNameTarget + " · " + localizedValue("进度报告", primary);
  let heroNameHtml = escapeHtml(heroNameZh) + " " + secondaryText(heroNameEn, "en");
  if (primary === "en") {
    heroNameHtml = escapeHtml(heroNameEn) + " " + secondaryText(heroNameZh, "zh");
  } else if (primary === "ja" || primary === "ko") {
    heroNameHtml = escapeHtml(heroNameTarget) + " " + secondaryText(heroNameZh, "zh");
  }
  const reportName = localizedValue("项目进度报告", primary);
  let docTitle = project.description + " · 项目进度报告 Project Progress Report";
  if (primary === "en") {
    docTitle = projectNameTarget + " · Project Progress Report / " + project.description + " · 项目进度报告";
  } else if (primary === "ja" || primary === "ko") {
    docTitle = projectNameTarget + " · " + reportName + " / " + project.description + " · 项目进度报告";
  }
  const taskCount = String(counts.total);
  const taskTotalMain = primary === "zh"
    ? "共 " + taskCount + " 条"
    : primary === "en"
      ? "tasks in total: " + taskCount
      : primary === "ja" ? "タスク合計: " + taskCount + " 件" : "총 작업 " + taskCount + "개";
  const taskTotalSecondary = "共 " + taskCount + " 条";
  const tasksTotalHtml = escapeHtml(taskTotalMain) + " · " + secondaryText(primary === "zh" ? "tasks in total" : taskTotalSecondary, primary === "zh" ? "en" : "zh") + clippedNote;
  return `<!doctype html>
<html lang="${languageAttr(primary)}" data-primary-language="${primary}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(docTitle)}</title>
<style>${REPORT_STYLE}</style>
</head>
<body class="primary-${primary}">
  <header class="head">
    <img class="head__logo" src="${brandLogoUrl()}" alt="LibiaoLink" />
  </header>

  <section class="hero">
    <div class="hero__progress">
      <p class="hero__pct">${String(counts.pct)}<span>%</span></p>
      <p class="hero__label">${heroLabelHtml}</p>
      ${barHtml(counts.pct, "#18181b", "bar--hero")}
      <p class="hero__foot">${latestLabel}${labelColon(primary)}${fixedText(latest, primary)}</p>
    </div>
    <div class="hero__left">
      <h1 class="hero__name">${heroNameHtml}</h1>
      <p class="hero__code">${fixedText("项目编号", primary)}${labelColon(primary)}${escapeHtml(project.code)}</p>
      <div class="hero__tags">
        <span class="tag">${fixedText("项目经理", primary)}${labelColon(primary)}${escapeHtml(projectManagerText(project))}</span>
      </div>
    </div>
  </section>

  <section class="stats">${stats}</section>

  <section class="section">
    <h2 class="section__title">${fixedText("阶段进度", primary)}<span class="section__note">${fixedText("施工阶段统计完成情况", primary)}</span></h2>
    <div class="stages">${stageCells}</div>
  </section>

  <section class="section">
    <h2 class="section__title">${fixedText("任务明细", primary)}<span class="section__note">${tasksTotalHtml}</span></h2>
    ${tableHtml}
  </section>

</body>
</html>`;
}

/**
 * 预览专用报告：内容与正式导出完全同源，仅额外注入屏幕分页样式与运行时。
 * 运行时按 A4 横版打印内容区拆页、重复任务表头，并回传当前页码 / 总页数。
 */
export function buildOverviewPreviewHtml(
  input: OverviewExportInput,
  translationMap: ReadonlyMap<string, string>,
  primary: OverviewExportLanguage,
  collapsedStages: readonly string[] = [],
): string {
  return buildOverviewReportHtml(input, translationMap, primary, collapsedStages)
    .replace("</head>", `<style>${overviewPreviewPagedCss}</style></head>`)
    .replace("</body>", `<script data-overview-preview-runtime="" src="${escapeHtml(new URL(overviewPreviewPagedScriptUrl, window.location.origin).href)}"></script></body>`);
}

/**
 * 预览与正式导出共用同一份译文请求（主体语言 / 折叠阶段变了也保持一致）：
 * 中文、英文主体取英文；日文、韩文主体取对应语言。折叠阶段的任务不进请求。
 */
export function overviewExportTranslationRequest(
  input: OverviewExportInput,
  options: OverviewExportOptions,
): { target: TranslationTarget; texts: string[] } {
  const { primary, collapsedStages } = options;
  const target: TranslationTarget = primary === "ja" ? "ja" : primary === "ko" ? "ko" : "en";
  const collapsed = new Set(collapsedStages);
  const visibleTasks = input.tasks.filter((task) => !collapsed.has(task.stage === "" ? "临时任务" : task.stage));
  const texts = target === "en"
    ? [input.project.description, ...visibleTasks.map((task) => task.note)]
    : [input.project.description, ...visibleTasks.flatMap((task) => [task.title, task.note])];
  return { target, texts };
}

/**
 * 导出项目总览为 PDF：中文 / 英文主体沿用英文译文口径；日文 / 韩文主体额外翻译项目名、任务名与进展描述。
 * 逐阶段折叠：只为未折叠阶段的任务名 / 进展描述发起翻译；默认全部展开时沿用原全量翻译口径。
 * 译文命中会话缓存 / 服务端译文库即取，未预热条目才现场翻；通道不通静默回退中文，不阻断导出。
 * 报告 HTML 送进离屏 iframe 后唤起系统打印窗口（用户选「另存为 PDF」）。
 * onTranslateProgress(done, total)：译文进度回调（导出等待浮层显示「报告内容翻译中 + 预计秒数」）。
 */
export async function exportProjectOverviewPdf(
  input: OverviewExportInput,
  options: OverviewExportOptions = DEFAULT_OVERVIEW_EXPORT_OPTIONS,
  onTranslateProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { primary, collapsedStages } = options;
  const { target, texts } = overviewExportTranslationRequest(input, options);
  const translationMap = await translateZhTo(texts, target, onTranslateProgress);
  printHtmlDocument(buildOverviewReportHtml(input, translationMap, primary, collapsedStages));
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
