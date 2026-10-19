import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { DashboardDataset, DashboardIssueDataset, DashboardWordDataset } from "../dashboardApi";
import { isChangeWordHit } from "../data/changeWords";
import { DASHBOARD_BINS, DASHBOARD_ISSUE_COLORS, isIssueInCell, isTaskInCell, isTaskInDeliveryBucket, isTaskPendingDelivery, type DashboardDeliveryBucket, type DashboardStatusSlice, type HubDashView } from "../data/dashboardProgress";
import type { TaskStatus } from "../data/tasks";
import { fieldText, statusText, useLocale, useT } from "../i18n";
import { displayStatusLabel } from "../taskApi";
import { HubDashDelivery } from "./HubDashDelivery";
import { HubDashDetail } from "./HubDashDetail";
import { HubDashIssueDetail } from "./HubDashIssueDetail";
import { HubDashIssues, type DashboardIssueRow } from "./HubDashIssues";
import { HubDashOverview } from "./HubDashOverview";
import { HubDashProgress, LEGEND_KEYS } from "./HubDashProgress";
import { HubDashStatus } from "./HubDashStatus";
import { HubDashWordCloud } from "./HubDashWordCloud";
import { HubDashWordDetail } from "./HubDashWordDetail";
import { Loader } from "./Loader";
import { SearchSelect, type SearchSelectOption } from "./SearchSelect";

/**
 * 仪表盘视图（蓝图页「蓝图 ⇄ 仪表盘」转场后半屏 · 2026-10-15 业务口径「鼠标滑动蓝图转场展示仪表盘」）：
 * 阶段 × 进度五档横向堆叠条，口径见 data/dashboardProgress.ts（取数 dashboardApi.ts）。
 *
 * 形态照业务确认过的效果图；按口径「多余的注释和文字不需要」只留标题 + 图例 + 数据，
 * 数据来源 / 口径注释等文字全部去掉。画布 1200 × 660（viewBox 缩放填满面板，永不产生滚动条）。
 * 颜色 / 状态样式见 app.css 的 .hub-dash-*；转场样式见 .hub-deck-*。
 *
 * Push 335（2026-10-15 业务口径「鼠标放上去是这样的效果」+「点击某一段是这个只读效果」）：
 * 悬停柱段出浮层卡（行名 + 档位色块 + 档位 + 条数，替代原生 title 灰框）；点柱段打开只读「数据详情」
 * （HubDashDetail）。「如果是全部项目的话不支持点击查看数据来源」—— 选中具体项目时柱段才可点。
 *
 * Push 336（2026-10-15 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」+「这个选择项目的ui太丑了 和现在的ui完全不符 要重写 要带搜索的选择器」）：
 * 选择器由原生 select 换成全站同款可搜索下拉 SearchSelect（SearchSelect.tsx）；选中项目写回账号偏好
 * user_preferences.prefs.hubDashProject（单键 PATCH，乐观更新 + 失败回滚在 App 层），刷新 / 换设备同账号仍停在同一个项目。
 *
 * Push 339（2026-10-15 业务口径「现在准备做这个任务状态的」+「鼠标触碰效果」+「点击后效果」+
 * 「这些都要参考项目进度一览 之前都做过的」+「在仪表盘页面在底部增加切换的按钮」+「这个按钮再做一个进度一览 靠左不居中」）：
 * 新增「任务状态」视图（HubDashStatus 饼图 = 五态分布 + 色字标签 + 引线）；底部挂两枚勾选框式视图按钮
 * （DashViewSwitch：左「项目进度一览」、右「任务状态」，单选框语义 = 选中态就是当前视图、点已选中的那枚不取消；
 * **靠左与标题条同一条竖线起排**，不再居中）；按钮样式照
 * 业务给的参考代码，见 app.css 的 .hub-dash-switch；**参考代码的白勾 / 脉冲层用 peer-checked: 挂在
 * 内层元素上 —— 兄弟选择器够不到、照抄永不显示，这里改 group-has-[:checked]: 才真正渲染**）。悬停扇区
 * 出浮层卡（状态名 + 色条 + 记录数 / 占比），
 * 点扇区开只读「数据详情」—— 与点柱段同一套口径（「全部项目」不可点）。统计口径 buildDashboardStatus
 * （data/dashboardProgress.ts）、按项目分桶在取数同一轮完成（零额外请求）。
 *
 * Push 340（2026-10-15 业务口径「鼠标放在阴影部分是展示全部阶段的标签的」+「那我们的要展示该阶段的五个状态不就好了」）：
 * 行阴影（行高亮条）常驻化 + 可悬停 —— 悬停整行任意空白处出「行名 + 五档整排」浮层卡（该阶段的五个状态）；
 * 彩色柱段的单档卡不变（悬停柱段仍是「行名 + 单档一行」，点柱段的只读「数据详情」也不变）。
 *
 * Push 342（2026-10-15 业务口径「按钮大小小一点」）：底栏两枚视图勾选框整体收小（32 → 24px 方框、
 * 白勾 20 → 16px、标签间距 ml-3 → ml-2）；靠左起排、选中 / 悬停动效口径不变。
 *
 * Push 344（2026-10-16 业务口径「现在做这个问题 效果和上面做的一样」）：底栏加第三枚视图「问题」——
 * 分组柱状图（HubDashIssues）= 问题状态 × 问题归类，形态照业务参考图（图例居中在顶 / 虚线网格 / 柱顶同色数字）；
 * 悬停柱出浮层卡（状态名 + 归类色点 + 归类 + 条数）、悬停组内空白出「状态名 + 全部归类整排」卡（同 Push 340 口径）；
 * 点柱开只读「数据详情」（HubDashIssueDetail = 参考图的日报侧五列 + 问题侧三列，另补「问题描述」列），
 * 与柱段 / 扇区同一套「选中具体项目才可点」；问题 / 日报读面**懒加载**（首次切到「问题」才拉，见 Hub.tsx 的
 * ensureIssues；三个视图共用同一个项目选择器与常驻项目）。
 *
 * Push 345（2026-10-16 业务口径「这个交付时间也要做一个图表 但是它的这个逻辑我没搞懂 感觉也不好 请你重新设计一个告诉我」
 * +「选择B方案 然后 提前完成也加进去 叫交付时间 加一个「按时率 67%」的小结」+「选择后刷新不变 按账号记住」）：
 * 底栏加第四枚视图「交付时间」—— 三结果竖直柱状图（HubDashDelivery = 按时交付 / 逾期已交付 / 逾期未交付，
 * 口径 buildDashboardDelivery）+ 右上「按时率」小结（悬停出公式卡）+「未到交付节点」注记；悬停柱出浮层卡（记录数 / 占比）、
 * 点柱开只读「数据详情」（与柱段 / 扇区 / 问题柱同一套「选中具体项目才可点」，筛选见 isTaskInDeliveryBucket）；
 * 页内视图写回账号偏好 user_preferences.prefs.hubDashView（单键 PATCH，乐观更新 + 失败回滚在 App 层）——
 * 刷新 / 换设备同账号停在同一个视图。
 *
 * Push 346 追订（2026-10-16 业务口径「点击也要进入详情的」+「取消提前完成展示」）：
 * 点「按时率」小结 = 开按时交付口径的数据详情（与按时交付柱同一筛选）、点「未到交付节点」注记 = 开注记里那 N 条
 * （isTaskPendingDelivery）—— 与点柱同一套「选中具体项目才可点」；「提前完成」并入「按时交付」、不再单独占一档。
 *
 * Push 353（2026-10-16 业务口径「现在做这个词频图 根据变更原因的词频拼成这个图」+「词频图中修饰词不纳入
 * 只保留核心词纳入词频图」+「还是和之前做的地方和效果一样」+「我们的词频图也要拼凑出形状」+
 * 「不需要每个都可以点击只有最中间的需要」）：底栏加第五枚视图「词频图」—— 变更原因核心词
 * 词云（HubDashWordCloud，画布像素蒙版落位 / 悬停卡 / 点词开详情都与其他视图同一套口径）+
 * 点某词的主枚只读「数据详情」（Push 356 起每词主枚可点、重复小枚不可点；此前只有词频最高的正中一枚）
 * （HubDashWordDetail，列序照业务参考图：变更时间 / 变更阶段 / 变更文件 / 变更内容描述 / 变更前 / 变更后 /
 * 变更原因 / 变更申请人 / 填写者）；读面懒加载（首次切到「词频图」才拉变更记录，见 Hub.tsx 的 ensureWords），
 * 分词 / 计数口径见 data/changeWords.ts。
 *
 * Push 358（2026-10-16 业务口径「我要在最左边加一个数据总览 点击后展示的效果如图所示各图表等比例缩小集中展示
 * 点击效果 鼠标触碰标签效果依旧」+「项目进度一览改成项目进度字样」）：底栏最左新增第一枚视图「数据总览」
 * （HubDashOverview）—— 五图等比例缩小并排（左列：项目进度 / 任务状态 / 问题；右列：交付时间 / 词频图），
 * 进度图内联 JSX 抽成 HubDashProgress 组件（总览与单视图共用，DOM / 几何 / 动画逐值不变）；
 * 悬停浮层卡 / 点开只读「数据详情」与单视图同一套口径（回调全复用）；「问题 / 词频图」读面切到总览即懒加载。
 * 同批「项目进度一览」标签改名「项目进度」（i18n 中英 + aria + 页面指示器文案）。
 */
export type HubDashboardState = "loading" | "ready" | "failed";

/** 悬停卡（Push 335 柱段 / Push 339 扇区 / Push 340 行阴影）：柱段 = 行名 + 单档一行；行阴影 = 行名 + 五档整排；
 *  扇区 = 状态名 + 色条 + 记录数 / 占比两行。自绘浮层替代浏览器原生 title 灰框（原生框样式不可控、与本页设计不一致）。 */
type DashTip =
  | {
      readonly kind: "bin";
      readonly left: number;
      readonly top: number;
      readonly row: string;
      readonly bin: number;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly left: number;
      readonly top: number;
      readonly row: string;
      readonly counts: readonly number[];
    }
  | {
      readonly kind: "status";
      readonly left: number;
      readonly top: number;
      readonly status: TaskStatus;
      readonly count: number;
      readonly share: string;
    }
  | {
      readonly kind: "delivery";
      readonly left: number;
      readonly top: number;
      readonly bucket: DashboardDeliveryBucket;
      readonly count: number;
      readonly share: string;
    }
  | {
      readonly kind: "deliveryRate";
      readonly left: number;
      readonly top: number;
    }
  | {
      readonly kind: "issue";
      readonly left: number;
      readonly top: number;
      readonly state: string;
      readonly category: string;
      readonly count: number;
    }
  | {
      readonly kind: "word";
      readonly left: number;
      readonly top: number;
      readonly word: string;
      readonly count: number;
    }
  | {
      readonly kind: "issueRow";
      readonly left: number;
      readonly top: number;
      readonly state: string;
      readonly rows: readonly DashboardIssueRow[];
    };

/** 数据详情打开项（Push 335 / Push 339）：柱段 = 行 × 档；扇区 = 状态。 */
type DashDetailPick =
  | { readonly kind: "cell"; readonly rowKey: string; readonly bin: number }
  | { readonly kind: "status"; readonly status: TaskStatus }
  | { readonly kind: "issue"; readonly state: string; readonly category: string }
  | { readonly kind: "delivery"; readonly bucket: DashboardDeliveryBucket }
  | { readonly kind: "deliveryPending" }
  | { readonly kind: "word"; readonly word: string };

/** 柱段悬停卡尺寸（用于贴边夹紧，避免溢出白卡被裁切）。 */
const TIP_W = 190;
const TIP_H = 84;
/** 行阴影卡（行名 + 五档整排）比单档卡高四行（Push 340）。 */
const ROW_TIP_H = 170;
/** 扇区悬停卡尺寸（同上；形态照业务参考图，比柱段卡高一档）。 */
const STATUS_TIP_W = 200;
const STATUS_TIP_H = 108;
/** 问题柱 / 问题组悬停卡尺寸（Push 344；组卡按归类行数长高，见 showIssueRowTip）。 */
const ISSUE_TIP_W = 200;
const ISSUE_TIP_H = 84;
/** 交付结果柱 / 按时率小结的悬停卡尺寸（Push 345；结果卡与扇区卡同形态）。 */
const DELIVERY_TIP_W = 200;
const DELIVERY_TIP_H = 108;
const RATE_TIP_W = 300;
const RATE_TIP_H = 108;
/** 词频卡（Push 353；与扇区 / 交付卡同形态：行名 = 词、单行 = 词频 + 次数）。 */
const WORD_TIP_W = 200;
const WORD_TIP_H = 84;

/** 底部视图切换按钮（Push 339 追订 · 业务口径「这个按钮再做一个进度一览 靠左不居中」）：一枚按钮一个视图，
 *  勾选框式样照业务给的参考代码（灰底灰边圆角方框 → 选中蓝底白勾 + 渐变脉冲层，鼠标触碰放大 1.05 + 文字转蓝）。
 *  用单选框语义（同组 name，选中态 = 当前视图，点已选中的那枚不会取消选择）；白勾 / 脉冲层用 group-has-[:checked]:
 *  —— 参考代码的 peer-checked: 挂在内层元素上、兄弟选择器够不到，照抄不生效。 */
function DashViewSwitch({ view, checked, label, onSelect }: {
  readonly view: HubDashView;
  readonly checked: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <label className="group flex cursor-pointer items-center" data-switch={view}>
      <input
        type="radio"
        name="hub-dash-view"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => {
          if (event.target.checked) {
            onSelect();
          }
        }}
      />
      <span className="relative flex h-6 w-6 items-center justify-center rounded-md border-2 border-gray-400 bg-gray-100 shadow-md transition-all duration-500 group-hover:scale-105 peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/60">
        <span className="absolute inset-0 rounded-md bg-gradient-to-br from-white/30 to-white/10 opacity-0 transition-all duration-500 group-has-[:checked]:animate-pulse group-has-[:checked]:opacity-100" />
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" className="hidden h-4 w-4 scale-50 text-white transition-transform duration-500 group-has-[:checked]:block group-has-[:checked]:scale-100">
          <path clipRule="evenodd" fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 10-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z" />
        </svg>
      </span>
      <span className="ml-2 font-medium text-gray-700 transition-colors duration-300 group-hover:text-blue-500">{label}</span>
    </label>
  );
}
export function HubDashboard({ data, state, issues, issuesState, onNeedIssues, words, wordsState, onNeedWords, rememberedDashProject, onDashProjectChange, rememberedDashView, onDashViewChange }: {
  data: DashboardDataset | null;
  state: HubDashboardState;
  /** 「问题」视图数据（Push 344 · 懒加载：首次切到「问题」时才拉；null = 还没拉）。 */
  issues: DashboardIssueDataset | null;
  /** 「问题」读面状态：idle = 还没拉过 / loading / ready / failed（切走再切回会重试）。 */
  issuesState: "idle" | "loading" | "ready" | "failed";
  /** 请求拉「问题」读面（首次切到「问题」视图 / 失败后重试）。 */
  onNeedIssues: () => void;
  /** 「词频图」视图数据（Push 353 · 懒加载：首次切到「词频图」时才拉；null = 还没拉）。 */
  words: DashboardWordDataset | null;
  /** 「词频图」读面状态：idle = 还没拉过 / loading / ready / failed（切走再切回会重试）。 */
  wordsState: "idle" | "loading" | "ready" | "failed";
  /** 请求拉「词频图」读面（首次切到「词频图」视图 / 失败后重试）。 */
  onNeedWords: () => void;
  /** 账号记的常驻项目（Push 336 · 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」；null = 全部项目）。 */
  rememberedDashProject: string | null;
  /** 把选中项目写回账号偏好（Push 336；App 层乐观更新 + 失败回滚 + Toast）。 */
  onDashProjectChange: (projectId: string | null) => Promise<void>;
  /** 账号记的仪表盘页内视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；缺省 progress）。 */
  rememberedDashView: HubDashView;
  /** 记下页内视图（Push 345；App 层乐观更新 + 失败回滚 + Toast）。 */
  onDashViewChange: (view: HubDashView) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  /** Push 334：项目选择器（第一行固定「全部项目」；选中项目即只统计该项目）；Push 336：初值取账号常驻项目。 */
  const [pickedId, setPickedId] = useState<string | null>(rememberedDashProject);
  /** 仪表盘页内视图（Push 339 底栏按钮驱动；Push 345 按账号常驻；Push 358 起六枚）：overview = 数据总览（最左）/ progress = 项目进度 / status = 任务状态 / issues = 问题 / delivery = 交付时间 / wordcloud = 词频图。 */
  const [view, setView] = useState<HubDashView>(rememberedDashView);
  /** 悬停卡 + 行高亮（同一行的柱段共用：卡里写行名，图上该行铺一条浅灰底）。 */
  const [tip, setTip] = useState<DashTip | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** 数据详情（Push 335：点柱段打开；Push 339：点扇区打开；记「行 × 档」或「状态」，打开时按它筛任务）。 */
  const [detail, setDetail] = useState<DashDetailPick | null>(null);
  /** 已失效的常驻项目只清一次（Push 336）：PATCH 失败回滚时不再重复请求，避免打转。 */
  const staleClearedRef = useRef<string | null>(null);
  /** 常驻项目（Push 336）：偏好晚到（首屏 prefs 未回）/ 换账号 / 保存失败回滚时跟随 —— 与本地选中同值即空转。 */
  useEffect(() => {
    setPickedId(rememberedDashProject);
  }, [rememberedDashProject]);
  /** 常驻页内视图（Push 345 · 业务口径「选择后刷新不变 按账号记住」）：偏好晚到（首屏 prefs 未回）/ 换账号 / 保存失败回滚时跟随 —— 与本地选中同值即空转。 */
  useEffect(() => {
    setView(rememberedDashView);
  }, [rememberedDashView]);
  /** 「问题 / 词频图」读面懒加载（Push 344 / Push 353；Push 358 起「数据总览」同拉这两份）：切到对应视图时拉；首屏直接落在该视图（常驻视图）也拉。 */
  useEffect(() => {
    if (view === "issues" || view === "overview") {
      onNeedIssues();
    }
    if (view === "wordcloud" || view === "overview") {
      onNeedWords();
    }
  }, [view, onNeedIssues, onNeedWords]);
  /** 常驻的项目已不存在（被删）：界面回落「全部项目」，并把账号偏好一并清掉（只清一次）。 */
  useEffect(() => {
    if (pickedId !== null && data !== null && !data.byProject.has(pickedId)) {
      setPickedId(null);
      if (rememberedDashProject === pickedId && staleClearedRef.current !== pickedId) {
        staleClearedRef.current = pickedId;
        void onDashProjectChange(null);
      }
    }
  }, [data, pickedId, rememberedDashProject, onDashProjectChange]);
  /** 「全部项目」不支持点击查看数据来源（业务口径）：退到全部项目 / 切项目时关掉已开的数据详情。 */
  useEffect(() => {
    if (pickedId === null) {
      setDetail(null);
    }
  }, [pickedId]);
  /** 悬停柱段：把鼠标位置换算成白卡内的坐标（贴边夹紧），卡里写行名 / 档位 / 条数。 */
  const showTip = (event: ReactMouseEvent<SVGGElement>, rowText: string, bin: number, count: number): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "bin",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - TIP_H - 6)),
      row: rowText,
      bin,
      count,
    });
  };
  /** 悬停扇区（Push 339 · 业务口径「鼠标触碰效果」）：卡里写状态名 / 记录数 / 占比（形态照业务参考图）。 */
  const showStatusTip = (event: ReactMouseEvent<SVGGElement>, slice: DashboardStatusSlice, share: string): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "status",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - STATUS_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - STATUS_TIP_H - 6)),
      status: slice.status,
      count: slice.count,
      share,
    });
  };
  /** 悬停交付结果柱（Push 345）：卡里写结果名 + 色条 + 记录数 / 占比（与扇区卡同形态）。 */
  const showDeliveryTip = (event: ReactMouseEvent<SVGRectElement>, bucket: DashboardDeliveryBucket, count: number, share: string): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "delivery",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - DELIVERY_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - DELIVERY_TIP_H - 6)),
      bucket,
      count,
      share,
    });
  };
  /** 悬停「按时率」小结（Push 345）：卡里写口径公式与算式（让 67% 一眼可自查）。 */
  const showDeliveryRateTip = (event: ReactMouseEvent<SVGRectElement>): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "deliveryRate",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - RATE_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - RATE_TIP_H - 6)),
    });
  };
  /** 悬停行阴影（Push 340）：同一坐标口径，卡里写行名 + 五档整排（该阶段的五个状态，0 也列出）。 */
  const showRowTip = (event: ReactMouseEvent<SVGRectElement>, rowText: string, counts: readonly number[]): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "row",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - ROW_TIP_H - 6)),
      row: rowText,
      counts,
    });
  };
  /** 悬停问题柱（Push 344 · 业务口径「效果和上面做的一样」）：卡里写状态名 + 归类色点 / 归类 / 条数（形态照参考图二）。 */
  const showIssueTip = (event: ReactMouseEvent<SVGRectElement>, state: string, category: string, count: number): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "issue",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - ISSUE_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - ISSUE_TIP_H - 6)),
      state,
      category,
      count,
    });
  };
  /** 悬停问题组内空白（Push 344）：卡里写状态名 + 该状态全部归类整排（与 Push 340 的行阴影卡同一口径）。 */
  const showIssueRowTip = (event: ReactMouseEvent<SVGRectElement>, state: string, rows: readonly DashboardIssueRow[]): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    const height = ISSUE_TIP_H + 22 * Math.max(rows.length - 1, 0);
    setTip({
      kind: "issueRow",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - ISSUE_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - height - 6)),
      state,
      rows,
    });
  };
  /** 悬停词（Push 353 · 业务口径「还是和之前做的地方和效果一样」）：卡里写词 + 词频（与扇区 / 交付卡同形态）。 */
  const showWordTip = (event: ReactMouseEvent<SVGTextElement>, word: string, count: number): void => {
    const wrap = wrapRef.current;
    if (wrap === null) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    setTip({
      kind: "word",
      left: Math.max(6, Math.min(event.clientX - box.left + 14, box.width - WORD_TIP_W - 6)),
      top: Math.max(6, Math.min(event.clientY - box.top + 14, box.height - WORD_TIP_H - 6)),
      word,
      count,
    });
  };
  /** 切视图（Push 339 / Push 344 / Push 345 / Push 353）：先关掉旧视图的浮层卡 / 数据详情（详情对应的柱段 / 扇区 / 柱已不在画面上）；
   *  视图写回账号偏好（Push 345 · 「选择后刷新不变 按账号记住」）；「问题」读面懒加载由 view 跟随的 effect 负责。 */
  const switchView = (next: HubDashView): void => {
    setView(next);
    setTip(null);
    setDetail(null);
    void onDashViewChange(next);
  };
  /** 点开只读「数据详情」的七个入口（Push 335 / 339 / 344 / 345 / 346 / 353）：先关浮层卡再开详情 ——
   *  Push 358 起单视图与「数据总览」的五张小图共用同一套（语义与各自原内联实现逐字一致）。 */
  const pickCell = (rowKey: string, bin: number): void => {
    setTip(null);
    setDetail({ kind: "cell", rowKey, bin });
  };
  const pickStatus = (slice: DashboardStatusSlice): void => {
    setTip(null);
    setDetail({ kind: "status", status: slice.status });
  };
  const pickIssue = (state: string, category: string): void => {
    setTip(null);
    setDetail({ kind: "issue", state, category });
  };
  const pickDelivery = (bucket: DashboardDeliveryBucket): void => {
    setTip(null);
    setDetail({ kind: "delivery", bucket });
  };
  const pickDeliveryRate = (): void => {
    setTip(null);
    setDetail({ kind: "delivery", bucket: "按时交付" });
  };
  const pickDeliveryNote = (): void => {
    setTip(null);
    setDetail({ kind: "deliveryPending" });
  };
  const pickWord = (word: string): void => {
    setTip(null);
    setDetail({ kind: "word", word });
  };

  if (state === "failed") {
    return <div className="hub-dash-state">{t("hub.dash.failed")}</div>;
  }
  if (state !== "ready" || data === null) {
    return (
      <div className="hub-dash-state">
        <Loader />
      </div>
    );
  }
  const progress = pickedId === null ? data.all : data.byProject.get(pickedId) ?? data.all;
  /** 任务状态分布（Push 339）：与进度同一套项目选择（同一轮取数里分桶，切换不发请求）。 */
  const statusView = pickedId === null ? data.statusAll : data.statusByProject.get(pickedId) ?? data.statusAll;
  /** 交付结果分布（Push 345 · 「交付时间」视图）：同一套项目选择（同一轮取数里分桶，切换不发请求）。 */
  const deliveryView = pickedId === null ? data.deliveryAll : data.deliveryByProject.get(pickedId) ?? data.deliveryAll;
  /** 问题分布（Push 344）：同一套项目选择；数据懒加载（issues === null = 还没拉过）。 */
  const issuesView = issues === null ? null : pickedId === null ? issues.all : issues.byProject.get(pickedId) ?? issues.all;
  /** 词频图（Push 353）：同一套项目选择；数据懒加载（words === null = 还没拉过）。 */
  const wordsView = words === null ? null : pickedId === null ? words.all : words.byProject.get(pickedId) ?? words.all;
  /** 标题条：<视图名>·<选择器>（选择器里的当前项就是标题的后半段；视图名随底部切换走）。 */
  const pickedName = pickedId !== null ? data.options.find((option) => option.id === pickedId)?.name ?? t("hub.dash.allProjects") : t("hub.dash.allProjects");
  /** 只有选中具体项目才能点开数据详情（「全部项目」= 混合来源，不给来源明细 —— 业务口径；柱段 / 扇区同一套）。 */
  const canDrill = pickedId !== null;
  /** 选择器选项（Push 336）：第一行固定「全部项目」（value ""），其余按项目名。 */
  const pickOptions: readonly SearchSelectOption[] = [{ value: "", label: t("hub.dash.allProjects") }, ...data.options.map((option) => ({ value: option.id, label: option.name }))];
  /** 选中项目（Push 336）：立即上屏并按账号记住（乐观）；切项目即关掉已开的数据详情。 */
  const pickProject = (next: string | null): void => {
    setPickedId(next);
    setDetail(null);
    void onDashProjectChange(next);
  };
  const head = (
    <div className="hub-dash-head">
      <span className="hub-dash-title">{view === "overview" ? t("hub.dash.overview.title") : view === "progress" ? t("hub.dash.title") : view === "status" ? t("hub.dash.status.title") : view === "issues" ? t("hub.dash.issues.title") : view === "delivery" ? t("hub.dash.delivery.title") : t("hub.dash.wordcloud.title")}</span>
      <span className="hub-dash-sep" aria-hidden="true">
        •
      </span>
      <div className="hub-dash-pick">
        <SearchSelect
          options={pickOptions}
          value={pickedId ?? ""}
          onChange={(value) => pickProject(value === "" ? null : value)}
          placeholder={t("hub.dash.allProjects")}
          ariaLabel={t("hub.dash.pickProject")}
          searchPlaceholder={t("hub.dash.pickSearch")}
          emptyText={t("hub.dash.pickEmpty")}
        />
      </div>
    </div>
  );
  if (progress.totalTasks === 0) {
    return (
      <div ref={wrapRef} className="hub-dash-wrap">
        {head}
        <div className="hub-dash-state">{t("hub.dash.empty")}</div>
      </div>
    );
  }
  return (
    <div ref={wrapRef} className="hub-dash-wrap">
      {head}
      {view === "overview" ? (
        <HubDashOverview
          progress={progress}
          status={statusView}
          delivery={deliveryView}
          issues={issuesView}
          issuesState={issuesState}
          words={wordsView}
          wordsState={wordsState}
          canDrill={canDrill}
          onProgressTip={showTip}
          onProgressRowTip={showRowTip}
          onStatusTip={showStatusTip}
          onIssueTip={showIssueTip}
          onIssueRowTip={showIssueRowTip}
          onDeliveryTip={showDeliveryTip}
          onDeliveryRateTip={showDeliveryRateTip}
          onWordTip={showWordTip}
          onLeave={() => setTip(null)}
          onPickCell={pickCell}
          onPickStatus={pickStatus}
          onPickIssue={pickIssue}
          onPickDelivery={pickDelivery}
          onPickDeliveryRate={pickDeliveryRate}
          onPickDeliveryNote={pickDeliveryNote}
          onPickWord={pickWord}
        />
      ) : view === "progress" ? (
        <HubDashProgress
          progress={progress}
          canDrill={canDrill}
          onTip={showTip}
          onRowTip={showRowTip}
          onLeave={() => setTip(null)}
          onPick={pickCell}
        />
      ) : view === "status" ? (
        <HubDashStatus
          status={statusView}
          canDrill={canDrill}
          onTip={showStatusTip}
          onLeave={() => setTip(null)}
          onPick={pickStatus}
        />
      ) : view === "delivery" ? (
        <HubDashDelivery
          delivery={deliveryView}
          canDrill={canDrill}
          onTip={showDeliveryTip}
          onRateTip={showDeliveryRateTip}
          onLeave={() => setTip(null)}
          onPick={pickDelivery}
          onRatePick={pickDeliveryRate}
          onNotePick={pickDeliveryNote}
        />
      ) : view === "wordcloud" ? (
        wordsState === "ready" && wordsView !== null ? (
          wordsView.words.length === 0 ? (
            <div className="hub-dash-state">{t("hub.dash.wordcloud.empty")}</div>
          ) : (
            <HubDashWordCloud
              words={wordsView}
              canDrill={canDrill}
              onTip={showWordTip}
              onLeave={() => setTip(null)}
              onPick={pickWord}
            />
          )
        ) : wordsState === "failed" ? (
          <div className="hub-dash-state">{t("hub.dash.failed")}</div>
        ) : (
          <div className="hub-dash-state">
            <Loader />
          </div>
        )
      ) : issuesState === "ready" && issuesView !== null ? (
        issuesView.totalIssues === 0 ? (
          <div className="hub-dash-state">{t("hub.dash.issues.empty")}</div>
        ) : (
          <HubDashIssues
            issues={issuesView}
            canDrill={canDrill}
            onTip={showIssueTip}
            onRowTip={showIssueRowTip}
            onLeave={() => setTip(null)}
            onPick={pickIssue}
          />
        )
      ) : issuesState === "failed" ? (
        <div className="hub-dash-state">{t("hub.dash.failed")}</div>
      ) : (
        <div className="hub-dash-state">
          <Loader />
        </div>
      )}
      <div className="hub-dash-switch">
        <DashViewSwitch view="overview" checked={view === "overview"} label={t("hub.dash.overview.title")} onSelect={() => switchView("overview")} />
        <DashViewSwitch view="progress" checked={view === "progress"} label={t("hub.dash.title")} onSelect={() => switchView("progress")} />
        <DashViewSwitch view="status" checked={view === "status"} label={t("hub.dash.status.title")} onSelect={() => switchView("status")} />
        <DashViewSwitch view="issues" checked={view === "issues"} label={t("hub.dash.issues.title")} onSelect={() => switchView("issues")} />
        <DashViewSwitch view="delivery" checked={view === "delivery"} label={t("hub.dash.delivery.title")} onSelect={() => switchView("delivery")} />
        <DashViewSwitch view="wordcloud" checked={view === "wordcloud"} label={t("hub.dash.wordcloud.title")} onSelect={() => switchView("wordcloud")} />
      </div>
      {tip !== null ? (
        tip.kind === "bin" ? (
          <div className="hub-dash-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{tip.row}</div>
            <div className="hub-dash-tip__line">
              <span className="hub-dash-tip__dot" data-bin={DASHBOARD_BINS[tip.bin]} />
              <span className="hub-dash-tip__label">{t(LEGEND_KEYS[tip.bin])}</span>
              <span className="hub-dash-tip__count">{tip.count}</span>
            </div>
          </div>
        ) : tip.kind === "row" ? (
          <div className="hub-dash-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{tip.row}</div>
            {tip.counts.map((count, bin) => (
              <div key={bin} className="hub-dash-tip__line">
                <span className="hub-dash-tip__dot" data-bin={DASHBOARD_BINS[bin]} />
                <span className="hub-dash-tip__label">{t(LEGEND_KEYS[bin])}</span>
                <span className="hub-dash-tip__count">{count}</span>
              </div>
            ))}
          </div>
        ) : tip.kind === "status" ? (
          <div className="hub-dash-tip hub-dash-tip--status" data-status={tip.status} style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__statusTitle">{statusText(locale, tip.status)}</div>
            <div className="hub-dash-tip__statusBody">
              <span className="hub-dash-tip__statusBar" />
              <span className="hub-dash-tip__statusRows">
                <span className="hub-dash-tip__statusRow">
                  <span className="hub-dash-tip__statusLabel">{t("hub.dash.status.count")}</span>
                  <span className="hub-dash-tip__statusValue">{tip.count}</span>
                </span>
                <span className="hub-dash-tip__statusRow">
                  <span className="hub-dash-tip__statusLabel">{t("hub.dash.status.share")}</span>
                  <span className="hub-dash-tip__statusValue">{tip.share}</span>
                </span>
              </span>
            </div>
          </div>
        ) : tip.kind === "delivery" ? (
          <div className="hub-dash-tip hub-dash-tip--status hub-dash-tip--delivery" data-bucket={tip.bucket} style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__statusTitle">{statusText(locale, tip.bucket)}</div>
            <div className="hub-dash-tip__statusBody">
              <span className="hub-dash-tip__statusBar" />
              <span className="hub-dash-tip__statusRows">
                <span className="hub-dash-tip__statusRow">
                  <span className="hub-dash-tip__statusLabel">{t("hub.dash.status.count")}</span>
                  <span className="hub-dash-tip__statusValue">{tip.count}</span>
                </span>
                <span className="hub-dash-tip__statusRow">
                  <span className="hub-dash-tip__statusLabel">{t("hub.dash.status.share")}</span>
                  <span className="hub-dash-tip__statusValue">{tip.share}</span>
                </span>
              </span>
            </div>
          </div>
        ) : tip.kind === "deliveryRate" ? (
          <div className="hub-dash-tip hub-dash-tip--deliveryRate" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{t("hub.dash.delivery.rate")}</div>
            <div className="hub-dash-tip__line">{t("hub.dash.delivery.rateFormula")}</div>
            {deliveryView.total > 0 ? <div className="hub-dash-tip__line">{t("hub.dash.delivery.rateCalc", { ontime: deliveryView.counts[0], total: deliveryView.total, rate: deliveryView.onTimeRate ?? "—" })}</div> : null}
          </div>
        ) : tip.kind === "word" ? (
          <div className="hub-dash-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{tip.word}</div>
            <div className="hub-dash-tip__line">
              <span className="hub-dash-tip__dot" />
              <span className="hub-dash-tip__label">{t("hub.dash.wordcloud.frequency")}</span>
              <span className="hub-dash-tip__count">{tip.count}</span>
            </div>
          </div>
        ) : tip.kind === "issue" ? (
          <div className="hub-dash-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{statusText(locale, tip.state)}</div>
            <div className="hub-dash-tip__line">
              <span className="hub-dash-tip__dot" style={{ background: DASHBOARD_ISSUE_COLORS[tip.category] ?? "#c9ced6" }} />
              <span className="hub-dash-tip__label">{fieldText(locale, tip.category)}</span>
              <span className="hub-dash-tip__count">{tip.count}</span>
            </div>
          </div>
        ) : (
          <div className="hub-dash-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="hub-dash-tip__row">{statusText(locale, tip.state)}</div>
            {tip.rows.map((row) => (
              <div key={row.category} className="hub-dash-tip__line">
                <span className="hub-dash-tip__dot" style={{ background: DASHBOARD_ISSUE_COLORS[row.category] ?? "#c9ced6" }} />
                <span className="hub-dash-tip__label">{fieldText(locale, row.category)}</span>
                <span className="hub-dash-tip__count">{row.count}</span>
              </div>
            ))}
          </div>
        )
      ) : null}
      {detail !== null && pickedId !== null ? (
        detail.kind === "word" ? (
          <HubDashWordDetail
            rows={(words === null ? [] : words.changesByProject.get(pickedId) ?? []).filter((change) => isChangeWordHit(change.reason, detail.word))}
            members={words === null ? [] : words.members}
            tasks={data.tasksByProject.get(pickedId) ?? []}
            onClose={() => {
              setDetail(null);
            }}
          />
        ) : detail.kind === "issue" ? (
          <HubDashIssueDetail
            projectName={pickedName}
            rows={(issues === null ? [] : issues.issuesByProject.get(pickedId) ?? [])
              .filter((issue) => isIssueInCell(issue, detail.state, detail.category))
              .map((issue) => ({ issue, report: (issues === null ? [] : issues.reportsByProject.get(pickedId) ?? []).find((report) => report.id === issue.reportId) ?? null }))}
            onClose={() => {
              setDetail(null);
            }}
          />
        ) : (
          <HubDashDetail
            projectName={pickedName}
            manager={data.managerByProject.get(pickedId) ?? ""}
            tasks={(data.tasksByProject.get(pickedId) ?? []).filter((task) => detail.kind === "cell" ? isTaskInCell(task, detail.rowKey, detail.bin) : detail.kind === "delivery" ? isTaskInDeliveryBucket(task, detail.bucket) : detail.kind === "deliveryPending" ? isTaskPendingDelivery(task) : displayStatusLabel(task.displayStatus) === detail.status)}
            onClose={() => {
              setDetail(null);
            }}
          />
        )
      ) : null}
    </div>
  );
}
