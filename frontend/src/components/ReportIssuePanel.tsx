import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { keepLiveOrder } from "../liveSync";
import { useLiveRefresh } from "../useLiveRefresh";
import { createPortal } from "react-dom";
import { DateRangePicker } from "./DateRangePicker";
import { MultiOptionList, MultiSelectMenu, type SelectOption } from "./SelectMenu";
import { SearchSelect, type SearchSelectItem } from "./MemberSelect";
import { ImageZoomViewer } from "./ImageZoomViewer";
import { InlineCell, InlineMemberCell, InlineMultiOptionCell, InlineNumberCell, InlineOptionCell, InlineTextCell } from "./InlineEdit";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, TextareaHTMLAttributes } from "react";
import { ISSUE_STATES, type DailyReport, type Issue, type IssueState, type ReportPhoto } from "../data/reports";
import {
  ISSUE_STATE_NAMES,
  REPORT_STATE_NAMES,
  createReport,
  deleteIssue,
  deleteReport,
  fetchProjectIssues,
  fetchProjectReports,
  updateIssue,
  updateReport,
  type IssueUpdateInput,
  type ReportIssueWriteDraft,
  type ReportUpdateInput,
  type ReportWriteInput,
} from "../reportApi";
import { ApiError } from "../api";
import { uploadPhoto, usePhotoUrl } from "../fileApi";
import { stageKeyOfName } from "../taskApi";
import { PROJECT_STAGES } from "../data/projects";
import { lockBodyScroll } from "../scrollLock";
import type { DailySubView } from "../useHashRoute";
import { SUB_TAB_KEYS, SUB_TABS } from "./DailySubMenu";
import { RowDeleteButton } from "./RowDeleteButton";
import { RowEditButton } from "./RowEditButton";
import { ScrollArea } from "./ScrollArea";
import { SearchInput } from "./SearchInput";
import { useFocusTrap } from "./useFocusTrap";
import type { Member } from "../data/members";
import type { MeResponse, Project } from "../types";
import { mediumCardBorderOf, mediumCardTintOf, vividCardBorderOf, vividCardTintOf, type TintedTier } from "../backgroundTier";
import { fieldText, fullDateText, stageText, statusText, textOf, useLocale, useLocalizedTranslator, useT, type Locale } from "../i18n";
import { prefetchZhToEn } from "../translateApi";

/**
 * 项目详情「日报及问题」视图（Push 128）：页内四块子视图 —— 日报填写 / 日报记录 / 问题追踪 / 问题看板。
 * - 四块子视图的入口 = **主标签栏「日报及问题」标签的下拉子菜单**（业务口径 2026-09-30「日报及问题页面的导航栏按钮集成到页面导航栏
 *   如图一的效果」；面板与分组见 components/DailySubMenu.tsx，每项 = 16px 图标 + 单行文字）——原来的**页内键帽导航栏**
 *   （Push 200/201 吸顶那排）随之下架：吸顶位、内衬与 z 层那套修 bug 的口径一并作废。
 *   **Push 214**（业务口径「这几个页面也要做路由」）：四块子视图进地址 ?view=daily&sub=form|records|issues|board ——
 *   中文标签 ↔ slug 映射见 components/DailySubMenu.tsx 的 SUB_TAB_KEYS，当前块由 ProjectDetail 从地址派生后透传（本组件不自持子视图状态），
 * - 数据口径承 `系统功能书.md` A3：日报字段 A3-01 / 草稿与补填 A3-02 / 提交校验 A3-04 / 自动生成问题 A3-09 / 问题三态 A3-10（Push 207 业务口径「取消未分组 未分组就是未解决」修订 —— 原四态的四态 → 三态契约修订挂 wmj 线）；处理时限 SLA 见 ADR-026。
 * - 内容列宽：视图整体**全宽**（日报记录 / 问题追踪 / 问题看板 照旧铺满）；只有「日报填写」收成**居中窄栏**
 *   （max-w-3xl = 768px），业务口径「我只要日报填写页面居中然后尺寸舒适一点、像一个表单，其它的不变还是全屏」。
 * - 「日报记录」= **列表 / 表格**（一行一篇；业务口径「日报记录还是做成列表 不要卡片」，原卡片网格已撤），列口径 = 时间
 *   （+ 状态签 + 提交时间）/ 填写者 / 关联阶段 / 当日完成工作 / 明日计划 / 现场工作附图（Push 199 收窄 —— 业务口径
 *   2026-09-28「只保留 填写者 / 关联任务 / 当日完成工作 / 明日计划 / 现场附图」）——「今日施工人数 / 现场发现问题 /
 *   解决方案或建议」三列**不在列表展示**（表单字段 A3-01 与 A3-09 自动生成问题的口径不变）；
 *   与「问题追踪」同一套表壳（白底 + 圆角 + 行悬停），窄屏横向滚动。
 * - 原型阶段数据存浏览器内存（换项目 / 刷新即重置；任务域已接线，本模块随 M4 日报切片接线）：演示数据只挂在示例项目印度 `inmu-0010`，
 *   其余项目从空白开始；「日报填写」提交后**真的会**写进「日报记录」，含「现场发现问题」时按 A3-09 自动生成一条「未解决」问题（Push 207 起三态：未分组并入未解决）。
 * - Push 198（业务口径 2026-09-28「日报这里关联任务改成关联阶段」）：「关联任务」改「**关联阶段**」——
 *   多选项 = 九个施工阶段（`PROJECT_STAGES` 去掉「项目总览」，与任务表 / 看板同一份口径），不再列具体任务 / 负责人；
 *   关联单位由「任务」改「阶段」后，契约层 `taskIds` → `stageKeys` 的修订挂 wmj 线（见 `前端功能需求.md` §3.8 A21），
 *   原 A3-08「按任务回写项目进展描述」的副作用随之停用（落点待口径定案）。
 * - Push 199（业务口径 2026-09-28「日报记录里面不需要体现这两个 以及施工人数」+「只保留 填写者 / 关联任务 /
 *   当日完成工作 / 明日计划 / 现场附图」）：「日报记录」列表收窄为 **6 列** —— 去掉「今日施工人数 / 现场发现问题 /
 *   解决方案或建议」三列（只改**列表展示**：表单字段 A3-01 与 A3-09 问题生成口径不变，问题记录仍照常生成）；
 *   「关联任务」按 Push 198 口径显示为「关联阶段」；时间列保留（一行一篇、按日期倒序，无时间列无法辨认）。
 * - Push 202（业务口径 2026-09-28「填日报文字提示如图分点」+「问题归类可以多选」+「日报记录英文加上 如图所示」
 *   +「时间格式也要年月日 具体提交时间不需要 已提交状态也不要」+「点击暂存草稿就暂存在日报填写页面吧 …
 *   暂存就保留表单里面填的内容皆可」）：
 *   ① 「日报填写」：「当日完成工作Work completed today」「明日计划Tomorrow's plan」「现场发现问题Problem」三个多行框
 *      **补英文表头**；三行分点占位提示（`1:` / `2:` / `3:`）先落、随后业务看后撤回（「算了 不要提示文字了」）——
 *      三个多行框最终**无占位提示文字**、行数回到原口径（下一个改动即此）；「当日完成工作」是 A3-04 必填（星号保留），
 *      图 1 「明日计划」的必填星当时**未采纳**（Push 205 业务口径「明日计划也是必填项」已改必填）；
 *   ② 「问题归类」由单选改**多选**（`SelectMenu.tsx` 新增 `MultiSelectMenu`：弹层点选不关闭、选中项绿勾，
 *      触发器顿号连接已选项）—— 原型存储口径 = 多值顿号连接（`issueCategories` → `issueCategory` 字符串 / `Issue.category`），
 *      `issue_category` 单值 → 多值的契约修订挂 wmj 线（见 `字段对照清单.md` §二.3 增补）；
 *   ③ 「日报记录」表头中英拼写（时间time / 填写者 / 关联阶段Related stages / 当日完成工作Work completed today /
 *      明日计划Tomorrow's plan / 现场工作附图On-site photos）；时间列改**年月日**（如 `2026年9月16日`）、
 *      撤「提交 HH:MM」小字与状态签（草稿 / 已提交 / 补填不再在列表出现；`state` 仍在数据模型里）；
 *   ④ 「暂存草稿」不写「日报记录」、不切子视图、**不清表单** —— 只保留表单里已填内容 + 顶部提示
 *      （业务口径「暂存就保留表单里面填的内容皆可」；原「左侧草稿卡片」方案已撤回）；
 *   ⑤ 撤「现场发现问题」的琥珀色特殊底 / 琥珀字色（业务口径「这个也不用搞特殊 样式和别的保持一致」）——
 *      标签走 FORM_LABEL、说明走灰色小字，与其它字段同一套；
 *   ⑥ 表单字段标题统一**加粗**（业务口径「标题都标标粗」：`FORM_LABEL` 字重 medium → bold；字色口径不变）；
 *   ⑦ **附图以「复制粘贴」为主入口**（业务口径 2026-09-28「附图要可以复制粘贴 不能全靠选择文件 我们以复制粘贴为主」）：
 *      两个附图区（现场工作附图 / 当前问题附图）改 `AttachmentPicker` —— 形态按业务给的样（虚线卡 + 文件 / 云图标）
 *      **左右分半（无说明文字）**：左半 = **剪贴板图标**（Push 204 由键帽改纯文字、Push 212 续再按业务口径「ctrl v 的地方改成这个图标吧」换成 PasteIcon —— 无键帽材质、字色随半区悬停 / 就绪态转深；垂直居中与右半图标中线齐平 —— 业务口径「位置要居中」；点一下，Ctrl+V 直接粘图；截图 / 复制的图片文件都收；
 *      剪贴板图没有名字时按「剪贴板图片-N.png」命名）、右半 = 文件 / 云图标（点击选择文件，次入口，原生文件框仍在）；
 *      左半里放一个不可见的粘贴落点输入框 —— 浏览器只对有可编辑焦点的元素执行 Ctrl+V 粘贴命令，粘贴一律 preventDefault、不落文字；
 *      附件胶囊可逐个移除。
 * - Push 205（业务口径 2026-09-28「这里应该先填发现的问题 才能填另外三个」+「明日计划也是必填项」）：
 *   ① 「现场发现问题」= **前置开关** —— 为空时「问题归类」「当前问题附图」「解决方案或建议」三项**禁用**（灰底 / 灰字 / 点不开，
 *      与「问题归类」原禁用口径同一套）；填了「现场发现问题」三项立即解禁、清空又回禁用；「现场工作附图」不受影响；
 *   ② 「明日计划」改**必填**（A3-04 口径修订：必填 = 时间 + 当日完成工作 + 明日计划，标签补红色必填星）——
 *      服务端契约 / 校验（reports.ts superRefine、库侧成对 CHECK）的同步修订挂 wmj 线。
 * - Push 206（业务口径 2026-09-28「这个日报记录要大一点效果要如图二所示」+「图三还是文字提示改成图四的吧 然后用户填写后换行
 *   填到表格后也要是换行的」）：
 *   ① 「日报记录」整表放大 —— 字号 xs → sm、单元格内边距 py-2.5 → py-4（表头 py-3.5）、表格 min-w 900 → 1080，
 *      行高随多行内容撑开（业务样 = 图 2 的多维表格：行更高、留白更足）；
 *   ② 「当日完成工作 / 明日计划」两列 whitespace-pre-line —— 用户在多行框里按行写（回车换行），填到表格后**按行换行**显示；
 *   ③ 「现场工作附图」列改**大图瓦片**（PhotoStrip 新增 size 档位 lg：约 128×96、多张自动折行、只出图不带文件名 —— 业务样 = 图 2）；
 *   ④ 分点提示（1: / 2: / 3: 三行灰色小字）曾按图 4 落在「当日完成工作」「明日计划」，并随「这个现场问题也要同上」
 *      扩到「现场发现问题」；随后按业务口径「有了自动的扩展 那这个提示就不要了」**整体撤回**（三个框都不留静态提示）；
 *   ⑤ （同批追加 ·「自动添加序号可以做到吗」+「这个现场问题也要同上」）「当日完成工作 / 明日计划 / 现场发现问题」
 *      三个多行框**自动序号** —— 空框聚焦预置 1: 、回车自动带下一行序号（2: / 3: …）、失焦与提交前 "renumberLines"
 *      统一重排（剥旧号 / 去空行 / 重编）；落库即带序号文本，「日报记录」表格里序号 + 换行一并显示；
 *      判定「现场发现问题」是否算填（前置开关）先剥序号 —— 空框只剩「1: 」不算填；**Push 242 修**：回车续号改按
 *      **内容行数**编（原按物理换行数算）—— 删掉旧序号 / 删空后再回车仍从「1: 」起，不再跳成「2: 」；
 *   ⑥ （同批再追加 ·「换行很多时要自动下扩」）「日报填写」四个多行框（当日完成工作 / 明日计划 / 现场发现问题 /
 *      解决方案或建议）改 GrowingTextarea**自动下扩** —— 高度随行数长（下限 = 原 rows 行），不再出内滚动条。
 * - Push 207（业务口径 2026-09-28「责任这一栏不需要 删除吧」+「状态改成图二的三种」+「取消未分组 未分组就是未解决」+
 *   「问题归类也要用不同颜色来展示」+「格式参考这种 然后处理时限不需要 所属任务也不需要」+「文字标题参考图五的来」+
 *   「整体列表样式参考图6 项目总览页面」）：问题侧整批改版 ——
 *   ① 「问题追踪」表格重做：列口径 = 业务样「图五」六列（日期 / 问题描述 / 问题归类 / 解决方案或建议 / 问题附图 /
 *      问题是否处理）—— 列头**纯文字**（首版按图五复刻了小图标与排序小漏斗，随后按同批业务口径「这些图标不需要」整体下架）；
 *      撤「责任 / 处理时限 / 所属任务」三列（业务口径「责任这一栏不需要」+
 *      「处理时限不需要 所属任务也不需要」；三个字段仍在数据模型里，只是不展示）；「提出人」并进问题描述列的灰字小行
 *      （图五没有该列，信息不丢）；「问题描述 / 解决方案或建议」按行换行（whitespace-pre-line —— 承接 Push 206 自动序号）；
 *   ② 行样式 = 业务样「图六」（项目总览任务表）：白卡 + 圆角边框 + 列头 `bg-zinc-50 text-xs font-medium text-zinc-400`
 *      + 行 `px-5 py-2.5` + `divide-zinc-100` 细分割线 + 行悬停 `hover:bg-zinc-50/80`（Push 217 整表比例对齐「日报记录」—— 内边距 px-4 / py-4 / 表头 py-3.5 / 动作列 w-20，见本文件头 Push 217 条）；
 *   ③ 状态三态（业务样「图二」·「状态改成图二的三种」）：未分组并入未解决 —— `ISSUE_STATES` = 未解决 / 处理中 / 已完成；
 *      色签 = 项目总览「任务状态」同款（同批业务口径「这个问题的状态想要和项目总览里面的状态样式同款」）：
 *      未解决 = 待开始 `bg-sky-100 text-sky-700` / 处理中 = 进行中 `bg-amber-100 text-amber-800` /
 *      已完成 `bg-emerald-100 text-emerald-700`（色值 / 圆角 / 内距直接对齐 TaskBoard 的 STATUS_CAPSULE_CLASS 同名档）；
 *      问题看板四列 → **三列**（空列保留）；新建问题初始态 = 未解决；「未分组」字样从问题域整体下线
 *      （四态 → 三态的契约 / 库侧修订挂 wmj 线，见 `系统功能书.md` A3-10 与 `前端功能需求.md` §6.12）；
 *   ④ 问题归类彩色胶囊（业务样「图三 / 图四」·「问题归类也要用不同颜色来展示」）：机械部 `#adcbff` /
 *      采购部 · 项目部 `#ade4ff` / 规划部 `#ace2c5` / 物流原因 `#dcdfe4` / 供应商原因 `#ffea99` / 客户原因 `#ffb5b3` /
 *      客观原因 `#e7b4ff` / 生产原因 `#ffb3dc` / 其它原因 `#ffcea3`（浅底 + 深字）；多选值按「、」拆开逐枚出签，
 *      未知值 / 空值回落浅灰；
 *   ⑤ 「问题附图」列（新增数据面）：`Issue.photos` —— 来源 = 日报「当前问题附图」（提交时带入问题记录），
 *      列里出 40×40 缩略图（点开看大图 · PhotoStrip 新增 `md` 档位）、空 = 「—」；演示问题补内联 SVG 占位图；
 *   ⑥ （同批追加 ·「这个也要1 2 3 同上」）「解决方案或建议」并进自动序号一套 —— 解禁后空框聚焦预置 1: 、
 *      回车续号（2: / 3: …）、失焦与提交前 "renumberLines" 重排（与上三个多行框同一套口径；Push 242 同修续号基准）。
 *   ⑦ （同批追加 ·「增加项目总览 同款醒目模式在问题追踪里面」；Push 290 起「醒目模式」下架、统一改吃**背景档位**）「问题追踪」跟随顶栏背景档位 ——
 *      档位「适中」= 问题表整行铺该问题状态的行色（便签同款兑白配方）+ 状态列收口（撤色签底、只留深色字）；
 *      档位「简约」= 行还原（白底 + 行悬停灰）、状态列回「项目总览同款」色签胶囊。
 * - Push 208（业务口径 2026-09-28「问题追溯里面也要可以这样编辑 文字 以及问题归类都要可以修改 文字修改需要点击保存
 *   编辑后时间不变 日报记录同理」）：两块表接**行内编辑**（复用项目总览那套 InlineEdit，业务样 = 项目总览状态列的行内下拉）——
 *   ① 「问题追踪」：**问题描述 / 解决方案或建议**（文字列）= InlineTextCell 多行框 —— **点「保存」才落值**（Esc / 点浮层外 =
 *      取消，原值不动）；**问题归类** = InlineMultiOptionCell（与「问题归类」表单侧同款多选：绿勾选中项、点选不收浮层、
 *      再点取消，落值仍按「、」连接）；**问题是否处理** = InlineOptionCell 三态下拉（色签同项目总览，适中档下只留深色字）；
 *   ② 「日报记录」：「当日完成工作 / 明日计划」两列同款文字编辑（业务口径「日报记录同理」）；
 *   ⑤ 「日报记录」的**关联阶段**同批追加行内编辑（业务口径 2026-09-28「这个也要可以编辑筛选选择」）——
 *      浮层 = 与「日报填写」表单侧完全同款的九阶段勾选清单（勾选不收浮层 · 值仍是同一份 REPORT_STAGES 口径）；
 *   ⑥ 关联阶段「显示态」也出彩色色签（同日追加 · 业务口径 2026-09-28「显示也要有颜色」）：StageTags 逐枚出签、
 *      与浮层共用同一张九阶段色表，空值 = 「—」灰字（问题归类显示态色签见 ④，两处同款）。
 *   ③ 「编辑后时间不变」：日期 / 提出日期列**不参与编辑**（单元格里没有可点目标），patch 也从不写 date / raisedAt /
 *      submittedAt —— 改完文字时间列原样；文字列保存前统一过一遍自动序号（renumberLines，与「日报填写」提交口径一致）；
 *   ④ 编辑落原型内存态（setReports / setIssues）：刷新 / 换项目即复位；字段级 PATCH 接口的契约挂 wmj 线。
 *
 * - Push 210（业务口径 2026-09-28「卡片要可以拖动」）：问题看板卡片接**指针拖动**（与「任务进展」看板 Push 108 / 156
 *   同一套口径）—— 按住卡片位移超过 4px = 拖动（没超过 = 点一下开问题详情抽屉）；拖动中卡片跟手（半透明拖动卡 ·
 *   data-drag-ghost）、目标列描边高亮 + 列顶浮出落点槽「放开：移到「X」」，拖到看板 / 列边缘逐帧自动滚；
 *   放开 = 把问题状态改成目标列（同一 patchIssue 内存态：「问题追踪」表 / 计数 / 抽屉同步跟着变）；
 *   同列不是落点（问题没有列内顺序，放开不改动）；Esc / 指针取消 = 原地取消；整段拖动没有原生拖拽参与，滚轮照常可用。
 *
 * - Push 211（业务口径 2026-09-28「要加问题描述标题」）：问题看板**卡面首段补字段名「问题描述」** ——
 *   与其余三段（问题归类 / 解决方案或建议 / 问题附图）同款 11px 浅灰小字；首段不带上间距（Field 增 first 变体）；
 *   「问题追踪」表头 / 问题详情抽屉的「问题描述」口径照旧，三处一致。
 *
 * - Push 212（业务口径 2026-09-28「只保留关联阶段 且不需要隐藏」）：问题详情抽屉**撤「已隐藏 · N」折叠区** ——
 *   中间区只留「关联阶段」一行、改常显（无折叠开关）；其余五枚次要字段整体下架（提出人在抽屉头部已有、
 *   来源日报在页脚已有；提交时间 / 日报状态 / 问题编号不再展示）。
 *   同批（业务口径「抽屉里面可以编辑内容」）：抽屉内**两块表能编辑的字段同样可编辑** —— 问题描述 / 问题归类 /
 *   解决方案或建议 / 关联阶段 / 当日完成工作 / 明日计划 / 问题是否处理（同一套 InlineEdit 组件与落值口径）。
 *   续（业务口径「图片也要可以增删」）：两张附图（问题附图 / 现场工作附图）接 AttachmentPicker —— 复制粘贴 / 选文件**增图**、
 *   × **删图**（与「日报填写」同一套组件与钩子），落 value 走 patchIssue / patchReport 的 photos 字段。
 *
 * - Push 213（业务口径 2026-09-28「日报记录 和 问题追随都要有删除按钮 和之前的删除同款 请你看看有没有合适的位置
 *   这两个任意删除谁都是关联的 都会导致双方都删除 因为他们本质是同一个日报」）：两块表**行尾各加一列动作列**
 *   （固定 48px 槽位 + 同款 RowDeleteButton —— 静止 24px 幽灵态随行悬停浮现、悬停展开 48px 红胶囊「删除」），
 *   槽位是**预留**的：展开只在槽内长大，列宽 / 表宽一格不动（业务反馈「鼠标触碰表格会动」）。
 *   删除语义 = **按「同一篇日报」整组删**：删日报 = 连它派生的全部问题；删问题 = 连它来源的那篇日报；
 *   无派生问题的日报 / 无来源日报的问题只删自己（纯前端内存态，服务端 DELETE 契约挂 wmj 线）。
 *
 * - Push 217（业务口径 2026-09-29「问题追踪的卡片比例也要和日报记录的相同」+「现场工作附图放在明日计划填写下面」）：
 *   ① 「问题追踪」整表**比例对齐「日报记录」**（Push 206 放大后的同一套行列尺寸）—— 列内边距 px-5 → px-4、
 *      单元格 py-2.5 → py-4（表头 px-4 py-3.5）、表头字号 xs → sm（text-zinc-500）、行补 align-top、
 *      行尾动作列 w-[88px] → w-20（px-4×2 + 48 = 80，同「日报记录」槽位）；**「问题附图」列同批改大图瓦片**
 *      （md 40×40 → lg 约 128×96、列 min-w 130 → 440 —— 业务口径「这比例完全不一样啊 包括图片」）；列口径 / 交互不变；
 *   ② 「日报填写」表单**「现场工作附图」整块移到「明日计划」正下方**（原排「解决方案或建议」之后）——
 *      字段集 / 必填口径 / 自动序号 / 前置开关等交互不变，只调块序；
 *   ③ 表格间距收口（业务口径「问题归类去左侧一些这个间距不协调」+「这个在表格里面始终居中」）：
 *      「问题描述」列 min-w-[320px] → min-w-[240px]（描述与「问题归类」之间的空档收窄，归类列及其后各列随之前移）、
 *      「问题是否处理」列单元格 text-center（状态色签在列内**始终水平居中**，三态 / 适中档 / 行内改后同款）；
 *   ④ 「问题归类」色签不裁剪（业务口径「会出现截断的问题」）：行内编辑壳 `InlineCell` 加 `wrapContent` 档 ——
 *      「问题追踪」表与问题详情抽屉的归类单元格撤包裹层 `truncate` 裁剪（窄窗 / 列被挤到最小时色签不再被裁掉一角），
 *      色签折行与触发器内衬等其余表现不变；
 *   ⑤ **图片预览层修复**（业务口径「抽屉中点击图片也要居中显示」+「从看板里面点了图片 再从抽屉点图片怎么是这样的 bug」）：
 *      预览层 portal 到 body、图幅上限 min(90vw, calc(100vw - 3rem))、预览层与缩略图的 click / pointerdown 止冒泡、
 *      Esc 捕获阶段只关预览层（根因与口径逐条见 PhotoPreview 头注）；
 *   ⑥ 问题详情抽屉「施工人数」**空值出杠 + 行内可编辑**（业务口径「空用杠来表示 和之前项目总览的抽屉一样」+
 *      「施工人数抽屉也要可以编辑」）：`headcount` 为 null 时不再渲染字面量「null」，与「项目总览」任务详情抽屉同款出
 *      text-zinc-300 的 —；并接 `InlineNumberCell`（项目总览任务表同款：点开浮层 / 0 以上的整数 / 带「人」后缀 /
 *      落值即收浮层），落值走 `PATCH …/reports/{id}` 的 headcount（null = 清空）。
 *
 * - Push 223（业务口径 2026-09-29「日报记录 问题追溯里面 这个编辑也要和干系人同款 不是像现在这样」+
 *   「文字和图片编辑要同款 下拉框的保持原来的」）：两块表的**行尾动作列补一枚「编辑」按钮**
 *   （与「干系人」台账同款 `RowEditButton`：静止 24px 幽灵态随行悬停浮现、悬停展开 48px 近黑胶囊「编辑」）——
 *   点它打开**编辑弹窗**（与「干系人」弹窗同款：遮罩 + max-w-md 圆角白卡 + 品牌黄主按钮 + Esc / 点遮罩关闭）；
 *   **文字列 / 图片列改走弹窗**：「日报记录」= 当日完成工作 / 明日计划 / 现场工作附图，
 *   「问题追踪」= 问题描述 / 解决方案或建议 / 问题附图（图片 = 与表格 / 抽屉同一套 `AttachmentPicker`：
 *   粘贴 / 选文件增图、× 删图、改名、点开大图）；**下拉口径保持原来的行内编辑** ——
 *   「关联阶段」（日报）/ 「问题归类」「问题是否处理」（问题）三处仍是点单元格直接改、不进弹窗；
 *   表格里点空白 / 点行体依旧不进入编辑（编辑只走行尾按钮）；行尾两枚按钮共用**预留槽位**，
 *   展开只在槽内长大、列宽 / 表宽一格不动（沿用「鼠标触碰表格会动」的修法）。
 */

/** 行内编辑能改的日报字段（Push 208 · 业务口径「日报记录同理」+ 追加「这个也要可以编辑筛选选择」）：
 *  文字两列 + 关联阶段多选 —— 时间 / 填写者不动（「编辑后时间不变」）。
 *  Push 212 续（业务口径「图片也要可以增删」）：追加**现场工作附图**（photos）—— 抽屉里与两列文字共用同一份 patchReport 内存态。
 *  Push 217 续⑥（业务口径「施工人数抽屉也要可以编辑」）：追加**施工人数**（headcount，契约 number | null，null = 清空）。
 *  Push 223：文字两列 / 现场工作附图改走行尾「编辑」弹窗（表格内只做展示），「关联阶段」仍是行内多选。 */
export type ReportPatch = Partial<Pick<DailyReport, "doneWork" | "plan" | "stageNames" | "photos" | "headcount">>;

/** 行内编辑能改的问题字段（Push 208）：问题描述 / 问题归类 / 解决方案或建议 / 问题状态 —— 日期不动（「编辑后时间不变」）。
 *  Push 212 续：追加**问题附图**（photos）。
 *  Push 223：文字两列 / 问题附图改走行尾「编辑」弹窗（表格内只做展示），「问题归类 / 问题是否处理」仍是行内下拉。
 *  Push 244（业务口径「这个负责人要可以编辑」）：追加**问题处理人 / 责任人**（ownerId；空串 = 清空回「待分派」）。 */
export type IssuePatch = Partial<Pick<Issue, "title" | "categories" | "solution" | "state" | "photos" | "ownerId">>;

/** 卡片外壳（与两块任务看板同一套材质：白壳 + 发丝边 + 三层投影）。 */
const CARD_SHELL =
  "relative block w-full rounded-[35px] border border-zinc-900/[0.07] bg-white p-[9px] text-left transition " +
  "[box-shadow:0_18px_40px_-20px_rgba(15,23,42,0.18),0_4px_14px_-8px_rgba(15,23,42,0.06),inset_0_-2px_6px_rgba(15,23,42,0.05)]";

/** 细纹叠加（同两块看板：白壳上透明度收到 6%）。 */
const CARD_NOISE =
  "pointer-events-none absolute inset-0 rounded-[35px] opacity-[0.06] [filter:contrast(105%)] " +
  "bg-[repeating-conic-gradient(#e8e8e8_0.0000001%,#93a1a1_0.000104%)] [background-position:60%_60%] [background-size:600%_600%]";

/** 卡片内容区（Push 106 口径：只保留外框，内容直接落在壳上）。 */
const CARD_BODY = "relative px-4 py-3.5";

/** 拖动卡片用的半透明壳（与「任务进展」看板同一套：拖动中跟手的那张卡）。 */
const ISSUE_CARD_SHELL_GHOST =
  "relative block w-full rounded-[35px] border border-zinc-900/[0.07] bg-white/[0.6] p-[9px] text-left backdrop-blur-[5px] backdrop-saturate-150 " +
  "[box-shadow:0_18px_40px_-20px_rgba(15,23,42,0.18),0_4px_14px_-8px_rgba(15,23,42,0.06),inset_0_-2px_6px_rgba(15,23,42,0.05)]";

/** 拖动判定阈值（Push 210 · 与「任务进展」看板同一套）：按下后位移不超过这么多像素 = 「点一下看详情」。 */
const DRAG_THRESHOLD = 4;

/** 拖卡片到边缘 = 看板跟着滚（Push 210 · 同「任务进展」Push 156）：进边缘 DRAG_EDGE_PX 内逐帧滚，越深越快。 */
const DRAG_EDGE_PX = 72;
const DRAG_EDGE_MAX_SPEED = 16;

/** 边缘自动滚的速度：按深入边缘的程度 1~16px/帧。 */
function dragEdgeScrollSpeed(depth: number): number {
  return Math.min(Math.max((depth / DRAG_EDGE_PX) * DRAG_EDGE_MAX_SPEED, 1), DRAG_EDGE_MAX_SPEED);
}

/** ScrollArea 的滚动视口（组件内部那层带 data-scroll-area 的 div）—— 按轴找它。 */
function dragScrollAreaViewport(root: ParentNode | null, axis: "horizontal" | "vertical"): HTMLElement | null {
  if (root === null) {
    return null;
  }
  const node = root.querySelector('[data-scroll-area="' + axis + '"]');
  return node instanceof HTMLElement ? node : null;
}

/** 点 (x, y) 落在哪一列问题上（没有 = null）。 */
function dragColumnAtPoint(x: number, y: number): Element | null {
  const under = document.elementFromPoint(x, y);
  return under === null ? null : under.closest("[data-issue-column]");
}

/** 拖卡片到边缘时的逐帧自动滚（Push 210）：横向滚看板本体、纵向滚指针底下那一列（列内列表也是 ScrollArea）。 */
function autoScrollIssueDrag(root: HTMLElement | null, point: { x: number; y: number }): void {
  const viewport = dragScrollAreaViewport(root, "horizontal");
  if (viewport !== null) {
    const rect = viewport.getBoundingClientRect();
    if (point.y >= rect.top - 24 && point.y <= rect.bottom + 24) {
      if (point.x < rect.left + DRAG_EDGE_PX) {
        viewport.scrollLeft -= dragEdgeScrollSpeed(rect.left + DRAG_EDGE_PX - point.x);
      } else if (point.x > rect.right - DRAG_EDGE_PX) {
        viewport.scrollLeft += dragEdgeScrollSpeed(point.x - (rect.right - DRAG_EDGE_PX));
      }
    }
  }
  const under = document.elementFromPoint(point.x, point.y);
  const column = under === null ? null : under.closest("[data-issue-column]");
  const list = dragScrollAreaViewport(column, "vertical");
  if (list === null) {
    return;
  }
  const rect = list.getBoundingClientRect();
  if (point.y < rect.top + DRAG_EDGE_PX) {
    list.scrollTop -= dragEdgeScrollSpeed(rect.top + DRAG_EDGE_PX - point.y);
  } else if (point.y > rect.bottom - DRAG_EDGE_PX) {
    list.scrollTop += dragEdgeScrollSpeed(point.y - (rect.bottom - DRAG_EDGE_PX));
  }
}

/** 问题三态色签（Push 207 · 业务样 = 图二「状态改成图二的三种」；同批再按业务口径「这个问题的状态想要
 *  和项目总览里面的状态样式同款」对齐「项目总览」任务状态胶囊 —— 底色 / 字色直取 TaskBoard 的
 *  STATUS_CAPSULE_CLASS 同名档：未解决 = 待开始 蓝 bg-sky-100 text-sky-700 / 处理中 = 进行中 琥珀
 *  bg-amber-100 text-amber-800 / 已完成 = emerald 绿 bg-emerald-100 text-emerald-700）；
 *  原四态色签（未分组灰 / 未解决红 / 处理中琥珀 / 已完成绿）随「取消未分组 未分组就是未解决」改版下架，
 *  首版实色三态（#ade4ff / #feca04 / #dcdfe4）随本口径下架。 */
export const ISSUE_TAG_CLASS: Record<IssueState, string> = {
  open: "bg-sky-100 text-sky-700",
  in_progress: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-700",
};

/** 背景档位「适中」（Push 290 统一口径 · 原醒目模式挂点）的整行色对：与项目总览任务表的 STATUS_ROW_TINT 同一套
 *  配方 —— 底色 = 状态色 × 0.15 + 白、悬停 = × 0.32 + 白（复用 backgroundTier.ts 的 mediumCardTintOf / mediumCardBorderOf）；
 *  三态色系对照 = 未解决 / sky（项目总览「待开始」）、处理中 / amber（「进行中」）、已完成 / emerald（「已完成」）。
 *  导出给工作台「我提出的问题」表复用（避免两处色表漂移）。 */
export const ISSUE_ROW_TINT: Record<IssueState, { tint: string; hover: string }> = {
  open: { tint: mediumCardTintOf("#0ea5e9") ?? "", hover: mediumCardBorderOf("#0ea5e9") ?? "" },
  in_progress: { tint: mediumCardTintOf("#f59e0b") ?? "", hover: mediumCardBorderOf("#f59e0b") ?? "" },
  done: { tint: mediumCardTintOf("#10b981") ?? "", hover: mediumCardBorderOf("#10b981") ?? "" },
};

/** 背景档位 · 炫彩档的问题行色（Push 293 · 与 STATUS_ROW_TINT_VIVID 同一套高饱和配方：底色 × 0.62 / 悬停 × 0.82 兑白）；
 *  三态色系照旧（未解决 sky / 处理中 amber / 已完成 emerald）；工作台「我提出的问题」与项目页问题追踪共用本表。 */
export const ISSUE_ROW_TINT_VIVID: Record<IssueState, { tint: string; hover: string }> = {
  open: { tint: vividCardTintOf("#0ea5e9") ?? "", hover: vividCardBorderOf("#0ea5e9") ?? "" },
  in_progress: { tint: vividCardTintOf("#f59e0b") ?? "", hover: vividCardBorderOf("#f59e0b") ?? "" },
  done: { tint: vividCardTintOf("#10b981") ?? "", hover: vividCardBorderOf("#10b981") ?? "" },
};

/** 背景档位铺色档（适中 / 炫彩）的问题状态字色：整行已有行色，撤色签底只留深色字（口径 = TaskBoard 的 STATUS_TAG_TEXT_TIER_CLASS ——
 *  自定 oklch：彩度 500 档 ×1.08、明度 52~58%；三态与任务表同源：未解决 = 待开始蓝 / 处理中 = 进行中琥珀 / 已完成 = 已完成绿）。
 *  导出给工作台「我提出的问题」表复用。 */
export const ISSUE_TAG_TEXT_TIER_CLASS: Record<IssueState, string> = {
  open: "text-[oklch(53%_.18_237.32)]",
  in_progress: "text-[oklch(58%_.20_70.08)]",
  done: "text-[oklch(53%_.18_162.48)]",
};

/** 问题归类色签（Push 207 · 业务样 = 图三 / 图四「问题归类也要用不同颜色来展示」）：浅底 + 深字，
 *  色值取自业务样 —— 机械部 #adcbff / 采购部 · 项目部 #ade4ff / 规划部 #ace2c5 / 物流原因 #dcdfe4 /
 *  供应商原因 #ffea99 / 客户原因 #ffb5b3 / 客观原因 #e7b4ff / 生产原因 #ffb3dc / 其它原因 #ffcea3；
 *  未收录 / 空值回落浅灰。多选值（「、」连接）按分类拆开逐枚出签。 */
export const ISSUE_CATEGORY_CLASS: Record<string, string> = {
  机械部: "bg-[#adcbff]",
  采购部: "bg-[#ade4ff]",
  规划部: "bg-[#ace2c5]",
  项目部: "bg-[#ade4ff]",
  物流原因: "bg-[#dcdfe4]",
  供应商原因: "bg-[#ffea99]",
  客户原因: "bg-[#ffb5b3]",
  客观原因: "bg-[#e7b4ff]",
  生产原因: "bg-[#ffb3dc]",
  其它原因: "bg-[#ffcea3]",
};

/** 问题归类色签组（契约多值数组逐枚渲染；空数组 = 「未归类」灰签）。 */
function CategoryTags({ values }: { values: readonly string[] }) {
  const locale = useLocale();
  const items = values.length === 0 ? ["未归类"] : values;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((item, index) => (
        <span
          key={item + "#" + String(index)}
          data-issue-category={item}
          className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 " + (ISSUE_CATEGORY_CLASS[item] ?? "bg-zinc-100")}
        >
          {fieldText(locale, item)}
        </span>
      ))}
    </span>
  );
}

/** 关联阶段色签（Push 208 追加 · 业务口径「要有颜色 两处」· 业务样 = 九阶段各一档浅色）：
 *  售前规划 #adcbff / 设计开发 #ade4ff / 加工采购 #dcdfe4 / 组装发货 #ffb5b3 / 硬件实施 #ace2c5 /
 *  软件部署 #ffcea3 / 试运行 #ffea99 / 生产阶段 #e7b4ff / 验收 #ffb3dc —— 与「问题归类」共用同一张调色盘。 */
const STAGE_TAG_CLASS: Record<string, string> = {
  售前规划: "bg-[#adcbff]",
  设计开发: "bg-[#ade4ff]",
  加工采购: "bg-[#dcdfe4]",
  组装发货: "bg-[#ffb5b3]",
  硬件实施: "bg-[#ace2c5]",
  软件部署: "bg-[#ffcea3]",
  试运行: "bg-[#ffea99]",
  生产阶段: "bg-[#e7b4ff]",
  验收: "bg-[#ffb3dc]",
};

/** 关联阶段色签组（Push 208 追加 · 业务口径 2026-09-28「显示也要有颜色」）：多选值逐枚出签，与浮层
 *  小签同一张色表；空值 = 「—」灰字（与列内其它空态一致）。 */
function StageTags({ names }: { names: readonly string[] }) {
  const locale = useLocale();
  if (names.length === 0) return <span className="text-zinc-300">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {names.map((item, index) => (
        <span key={item + "#" + String(index)} data-report-stage={item}
          className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 " + (STAGE_TAG_CLASS[item] ?? "bg-zinc-100")}>
          {stageText(locale, item)}
        </span>
      ))}
    </span>
  );
}

/** 浮层里的小色签（Push 208 追加）：问题归类 / 关联阶段两个多选浮层的选项都按各自的色表出签。 */
function tagChip(name: string, tagClass: string) {
  return <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-800 " + tagClass}>{name}</span>;
}

/** 问题归类的小色签（浮层用；与表内 CategoryTags 同一张色表）。 */
const categoryChip = (name: string, locale: Locale) => tagChip(fieldText(locale, name), ISSUE_CATEGORY_CLASS[name] ?? "bg-zinc-100");

/** 关联阶段的小色签（浮层用）。 */
const stageChip = (name: string, locale: Locale) => tagChip(stageText(locale, name), STAGE_TAG_CLASS[name] ?? "bg-zinc-100");
/** 三态色签壳体（「问题追踪」与工作台问题表共用一处）：与「项目总览」任务状态胶囊同款 —— rounded-lg +
 *  px-3 py-1.5 + text-[11px] font-medium。Push 260 抽出：工作台问题表原先自带一档更小的壳（rounded + px-1.5 +
 *  py-0.5），业务口径「问题是否解决的颜色要统一和项目里面的一致」收口到本常量，两处不再各写各的。 */
export const ISSUE_TAG_SHELL = "rounded-lg px-3 py-1.5 text-[11px] font-medium";

/** 问题状态色签（一处出签：追踪表「问题是否处理」列 + 看板卡片 / 列头共用）。Push 207 追加：壳体与「项目总览」
 *  任务状态胶囊同款（壳 = ISSUE_TAG_SHELL，见上；项目总览侧是可点下拉、悬停深一档；静态签不挂悬停加深，其余逐项对齐）。
 *  `tierTint` = 背景档位铺色档（适中 / 炫彩；仅追踪表传）：整行已铺行色，色签收口成只留深色字（透明底 + 13px / 700 / 字距
 *  —— 同 TaskBoard 适中档状态列口径）；看板卡片 / 列头不传 = 胶囊照旧。 */
function IssueStateTag({ state, tierTint = false }: { state: IssueState; tierTint?: TintedTier | false }) {
  const locale = useLocale();
  return (
    <span
      data-issue-state={state}
      className={
        "inline-block " +
        (tierTint
          ? "text-[13px] font-bold tracking-wide " + ISSUE_TAG_TEXT_TIER_CLASS[state]
          : ISSUE_TAG_SHELL + " " + ISSUE_TAG_CLASS[state])
      }
    >
      {statusText(locale, ISSUE_STATE_NAMES[state])}
    </span>
  );
}

/** 问题状态行内下拉的可选项（Push 208）：与「项目总览」任务状态同款 —— 弹层里每项 = 该状态的色签胶囊。 */
function issueStateOptions(locale: Locale): SelectOption[] {
  return ISSUE_STATES.map((state) => ({
    value: state,
    label: <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + ISSUE_TAG_CLASS[state]}>{statusText(locale, ISSUE_STATE_NAMES[state])}</span>,
  }));
}
/** 问题追踪列头（Push 207 · 业务样 = 图五）：六列**纯文字列名**（同批业务口径 2026-09-28「这些图标不需要」——
 *  首版列头曾带日历 / A 字 / 分栏 / 图片 / 对勾圈小图标与排序小漏斗，随后按上面口径整体下架）。
 *  Push 243（业务口径 2026-10-08「图三图四增加列 问题处理人 / 责任人」）：在「问题归类」后补**第七列**
 *  「问题处理人 / 责任人」（与「日报填写」问题块的字段序一致：描述 / 归类 / 处理人 / …；表格 min-w 1080 → 1180）。 */
const ISSUE_TABLE_COLUMNS: readonly { key: string; label: string }[] = [
  { key: "date", label: "日期" },
  { key: "title", label: "问题描述" },
  { key: "category", label: "问题归类" },
  { key: "owner", label: "问题处理人 / 责任人" },
  { key: "solution", label: "解决方案或建议" },
  { key: "photos", label: "问题附图" },
  { key: "state", label: "问题是否处理" },
];

/** 问题看板列壳（Push 209 改版 · 业务口径「样式参考任务进展的」）：与「任务进展」看板**同一套列壳** —— 原灰底面板
 *  （白底 + 圆角 + 描边）整体下架，列 = 纯列容器（280px 宽、铺满视口、上限 52rem、下限 22rem）；列内 / 列间滚动条
 *  都走 ScrollArea 的隐式口径（原生滚动条隐藏，滚动 / 悬停才浮出自绘滑块）。
 *  Push 244（业务口径「问题看板怎么有两个滚动条」）：列高改**按实高自适应**（见 IssueBoard 的 columnHeight 测量），
 *  这里的静态值只作首帧兜底 —— 实测列顶距 180px（顶栏 64 + main pt-3 12 + 主标签栏 59 + 段头 45）+ 列底内衬 52px
 *  （ScrollArea pb-3 12 + main pb-10 40）= 232px；旧口径固定 12.75rem 会让整页超出视口 28px（两根滚动条并存）。 */
const ISSUE_COLUMN = "flex h-[calc(100vh-14.5rem)] max-h-[52rem] min-h-[22rem] w-[280px] shrink-0 flex-col";

/** 问题归类（C9 字典「问题归类」取值，口径见技术设计 v0.2 §6）。 */
const ISSUE_CATEGORIES: readonly string[] = [
  "机械部",
  "采购部",
  "规划部",
  "项目部",
  "物流原因",
  "供应商原因",
  "客户原因",
  "客观原因",
  "生产原因",
  "其它原因",
];

/** 问题处理人 / 责任人下拉候选（Push 243；Push 244 首项文案收敛为「待分派」—— 撤「（按归类自动分派）」字样）：
 *  首项 = 待分派（缺省按 A3-12 归类分派责任部门；提交时转契约 null），其余 = 成员目录。 */
function issueOwnerItems(members: readonly Member[], locale: Locale): SearchSelectItem[] {
  return [
    { kind: "plain", value: "", name: fieldText(locale, "待分派"), hint: textOf(locale, "report.ownerHint") },
    ...members.map((member): SearchSelectItem => ({ kind: "member", value: member.id, member })),
  ];
}

/** 日报「关联阶段」可选项（Push 198）：九个施工阶段 —— 与项目总览分组 / 两块看板同一份口径（不含「项目总览」汇总视图）。 */
const REPORT_STAGES: readonly string[] = PROJECT_STAGES.filter((stage) => stage !== "项目总览");

/** 表单小框（与任务表行内编辑同一套「白底 + 淡灰描边」口径）。 */
const FORM_INPUT =
  "w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400";

/** 表单字段名（浅灰小字；Push 202「标题都标标粗」—— 字重 medium → bold）。 */
const FORM_LABEL = "text-xs font-bold text-zinc-500";

/** 行内编辑触发器 · 色签列（Push 208）：问题归类 / 问题状态用 —— 触发器贴着内容（不满宽），四周留 2px 可点外沿。 */
const CELL_EDIT_CHIP = "-m-0.5 rounded-lg p-0.5 hover:bg-zinc-900/[0.04]";

/** 行内可改的「问题是否处理」单元格（Push 260）：项目页「问题追踪」与工作台问题表**共用同一枚** ——
 *  显示器 = IssueStateTag（三态色签 / 适中档只留深色字），点色签弹三态下拉（每项 = 该状态色签胶囊），
 *  选中即落值（onPick）并关掉浮层。原先这段内联在追踪表里；抽出本组件的口径 = 业务口径 2026-10-09
 *  「我提出 我处理的问题这里的状态都要和项目内部一样可以点击」—— 两处壳 / 触发器 / aria 名一处出、不走样。 */
export function IssueStateCell({ state, tierTint = false, ariaLabel, onPick }: {
  state: IssueState;
  /** 背景档位铺色档（适中 / 炫彩 · 整行已铺行色）：色签收口成只留深色字 —— 同追踪表口径。 */
  tierTint?: TintedTier | false;
  ariaLabel: string;
  onPick: (next: IssueState) => void;
}) {
  const locale = useLocale();
  return (
    <InlineOptionCell
      bare
      value={state}
      options={issueStateOptions(locale)}
      ariaLabel={ariaLabel}
      triggerClassName={CELL_EDIT_CHIP}
      display={<IssueStateTag state={state} tierTint={tierTint} />}
      onPick={(value) => {
        onPick(value as IssueState);
      }}
    />
  );
}


/** 行首序号（自动序号用：1: / 2. / 3、/ 4：都算 —— 重排时先剥掉，再统一按 1: / 2: / 3: 编）。 */
const LINE_NUMBER_HEAD = /^[ 　]*[0-9]+[ 　]*[:：.、．][ 　]*/;

/** 光标前的这段 = 序号本身（含「删了一半」的形态：1 / 1: / 1: ␠）—— Push 244（业务口径「1：要作为整体删除
 *  不然会出现冒号删除了 1 还在 再回车」）：退格落在序号里时一次删整段，不出现半截数字残留。 */
const LINE_NUMBER_PREFIX_PART = /^[ 　]*[0-9]+[ 　]*[:：.、．]?[ 　]*$/;

/** 「自动序号」重排（Push 206 续 · 业务口径「自动添加序号可以做到吗」）：剥掉各行行首序号 → 去空行 → 按 1: / 2: / 3: 重编；
 *  空文本 / 全是空行 → 空串（只聚焦自动预置的「1: 」不算有效内容，失焦即还原为空）。 */
function renumberLines(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(LINE_NUMBER_HEAD, "").trim())
    .filter((line) => line !== "");
  return lines.map((line, index) => String(index + 1) + ": " + line).join("\n");
}

/** 光标前**内容行**数（剥掉行首序号、忽略空行）—— 回车「自动序号」的续号基准（Push 242）：
 *  序号按内容行数编、不按物理换行数 —— 删掉旧序号 / 把框删空后再回车仍从「1: 」起（原按 `before.split("\n").length`
 *  算，空串也算一行 → 删空后回车跳成「2: 」—— 业务反馈「用户删除了再回车就生成2：了 用户觉得这个是bug」）。 */
function contentLineCount(text: string): number {
  return text
    .split("\n")
    .map((line) => line.replace(LINE_NUMBER_HEAD, "").trim())
    .filter((line) => line !== "").length;
}

/** 主按钮（提交日报）。 */
const BTN_PRIMARY =
  "rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300";

/** 次按钮（暂存草稿）—— Push 202：悬停反馈加明显（业务口径「鼠标放到暂存草稿的ui效果不太明显」）：描边 200 → 400、
 *  背景压到站内次按钮同一档 `hover:bg-zinc-100`、字色转深；禁用态照旧灰字、悬停不再变面。 */
const BTN_SECONDARY =
  "rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-sm font-medium text-zinc-600 transition hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-300 disabled:hover:border-zinc-200 disabled:hover:bg-white disabled:hover:text-zinc-300";

/** 表单里的一条问题（Push 243 · 业务口径「日报填写问题时新增 添加问题按钮 … 一天可以出现多个类型的问题 提交后各自独立便于追溯」）：
 *  每条 = 问题描述 / 问题归类 / 问题处理人 / 该问题附图 / 解决方案或建议 —— 提交时逐条生成独立问题记录；
 *  原单问题四件套（foundIssue / issueCategories / suggestion / issuePhotos）整体下线（旧数据照旧在列表 / 抽屉只读展示）。 */
type ReportIssueDraftUi = {
  /** 问题描述（自动序号文本；提交前统一重排） */
  title: string;
  /** 问题归类（C9 字典十项；可多选，≥1 项） */
  categories: string[];
  /** 问题处理人 / 责任人（成员 id；"" = 未指定 —— 按归类自动分派责任部门，A3-12） */
  ownerId: string;
  /** 解决方案或建议 */
  suggestion: string;
  /** 该问题附图（提交时直接挂到生成的问题） */
  photos: ReportPhoto[];
};

/** 日报填写的表单草稿（字段按 A3-01；改子视图不清空；Push 202 起「暂存草稿」= 保留内容不清空，只有提交后复位；
 *  Push 243：单问题字段 → 问题块数组 issues（默认一条，可增删；空块提交时忽略）。 */
type ReportDraft = {
  /** 时间（填报日期，ISO） */
  dateIso: string;
  /** 今日施工人数（输入框里是字符串，提交时转数字） */
  headcount: string;
  doneWork: string;
  plan: string;
  /** 现场发现问题（逐条成块；至少保留一条占位） */
  issues: ReportIssueDraftUi[];
  /** 关联阶段（按阶段名多选；九阶段口径） */
  stages: string[];
  /** 现场工作附图（名单 + 图片预览地址；Push 202 同批续「图片要可以预览」） */
  photos: ReportPhoto[];
};

/** 一条空问题块（Push 243）。 */
function emptyIssueDraft(): ReportIssueDraftUi {
  return { title: "", categories: [], ownerId: "", suggestion: "", photos: [] };
}

/** ISO 日期 → 「YYYY年M月D日」（Push 202 起带年：业务口径「时间格式也要年月日」；原「M月D日」写法下架）。 */
function cnDateOf(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) {
    return iso;
  }
  return String(Number(match[1])) + "年" + String(Number(match[2])) + "月" + String(Number(match[3])) + "日";
}

/** 日期显示（英文界面「Sep 16, 2026」/ 中文界面「YYYY年M月D日」—— Push 301 追订：与「我的任务」问题表同一套日期样式，不再用 ISO）。 */
function isoDateText(locale: Locale, iso: string): string {
  return locale === "en" ? fullDateText(locale, iso) : cnDateOf(iso);
}

/** 当天 ISO 日期（YYYY-MM-DD）。 */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return String(now.getFullYear()) + "-" + month + "-" + day;
}

/** 空表单：日期默认今天，其余留空。 */
function emptyDraft(): ReportDraft {
  return { dateIso: todayIso(), headcount: "", doneWork: "", plan: "", issues: [emptyIssueDraft()], stages: [], photos: [] };
}

/** 接口错误 → 页面提示文案（ApiError.message 已是服务端中文口径）。 */
function friendlyError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** 可落库的附图文件 id（用户中途删掉的、上传中 / 失败的都不在内）。 */
function readyFileIds(photos: readonly ReportPhoto[]): string[] {
  return photos.filter((photo) => photo.pending === undefined && photo.fileId !== "").map((photo) => photo.fileId);
}

/** 提交 / 暂存前拦「图片还在上传 / 上传失败」（返回空串 = 放行）。 */
function uploadBlockingMessage(draft: ReportDraft, locale: Locale): string {
  const photos = draft.photos.concat(draft.issues.flatMap((item) => item.photos));
  if (photos.some((photo) => photo.pending === "uploading")) {
    return textOf(locale, "report.uploadPending");
  }
  if (photos.some((photo) => photo.pending === "failed")) {
    return textOf(locale, "report.uploadFailed");
  }
  return "";
}

/** 界面 patch → 契约日报写体（只带被改字段；plan 空串 = 清空 → null）。 */
function reportUpdateBody(current: DailyReport, patch: ReportPatch): ReportUpdateInput {
  const body: ReportUpdateInput = { version: current.version };
  if (patch.doneWork !== undefined) {
    body.doneWork = patch.doneWork;
  }
  if (patch.plan !== undefined) {
    body.plan = patch.plan === "" ? null : patch.plan;
  }
  if (patch.stageNames !== undefined) {
    body.stageKeys = patch.stageNames.map(stageKeyOfName).filter((key): key is string => key !== null);
  }
  if (patch.photos !== undefined) {
    body.photoFileIds = readyFileIds(patch.photos);
  }
  if (patch.headcount !== undefined) {
    // Push 217 续⑥（业务口径「施工人数抽屉也要可以编辑」）：施工人数 —— 明确带 null（＝清空）；
    // 与 plan 的「空串转 null」不同，这里本来就是 number | null，原样透传。
    body.headcount = patch.headcount;
  }
  return body;
}

/** 界面 patch → 契约问题写体（solution 空串 = 清空 → null；ownerId 空串 = 回「待分派」→ null）。 */
function issueUpdateBody(current: Issue, patch: IssuePatch): IssueUpdateInput {
  const body: IssueUpdateInput = { version: current.version };
  if (patch.title !== undefined) {
    body.title = patch.title;
  }
  if (patch.categories !== undefined) {
    body.categories = patch.categories;
  }
  if (patch.solution !== undefined) {
    body.solution = patch.solution === "" ? null : patch.solution;
  }
  if (patch.state !== undefined) {
    body.state = patch.state;
  }
  if (patch.photos !== undefined) {
    body.photoFileIds = readyFileIds(patch.photos);
  }
  if (patch.ownerId !== undefined) {
    body.ownerId = patch.ownerId === "" ? null : patch.ownerId;
  }
  return body;
}

/** 新建体口径（Push 216 接真）：`DailyReportCreateBodySchema` 里 headcount / plan / foundIssue / issueCategories / suggestion
 *  都是**可选非空**（`z.string().min(1).optional()`）—— 空值必须**省字段**；显式传 null 会被 Zod 拒（invalid_type）。
 *  只有 PATCH 更新体（`DailyReportUpdateBodySchema`）才用 null 表示「清空」，所以这一层只在 create 路径上做。 */
function createBody(body: ReportWriteInput): ReportWriteInput {
  const next: ReportWriteInput = { ...body };
  if (next.headcount === null) {
    delete next.headcount;
  }
  if (next.plan === null) {
    delete next.plan;
  }
  if (next.suggestion === null) {
    delete next.suggestion;
  }
  if (next.foundIssue === null) {
    delete next.foundIssue;
    delete next.issueCategories;
  }
  if (next.issues !== undefined && next.issues.length === 0) {
    delete next.issues;
  }
  return next;
}

/** 去掉 create 专有的 date 字段（PATCH 编辑体不含 date —— 填报日期不可改）。 */
function withoutDate(body: ReportWriteInput): Omit<ReportWriteInput, "date"> {
  return {
    state: body.state,
    headcount: body.headcount,
    doneWork: body.doneWork,
    plan: body.plan,
    foundIssue: body.foundIssue,
    issueCategories: body.issueCategories,
    suggestion: body.suggestion,
    stageKeys: body.stageKeys,
    photoFileIds: body.photoFileIds,
    issuePhotoFileIds: body.issuePhotoFileIds,
    issues: body.issues,
  };
}

/** 卡片字段行（Push 209 改版 · 业务口径 2026-09-28「问题看板是这样的 要这些内容 然后样式参考任务进展的」）：
 *  字段名独占一行浅灰小字、取值在下一行 —— 与「任务进展」看板卡片的 Field 同一套口径（业务样 = 图一）。
 *  Push 211（业务口径「要加问题描述标题」）：增 first 变体 —— 卡面首段用它（不带上间距 mt-3）。 */
function Field({ label, children, first = false }: { label: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={first ? "" : "mt-3"}>
      <p className="text-[11px] text-zinc-500">{label}</p>
      <div className="mt-1 min-w-0">{children}</div>
    </div>
  );
}

/** 提交人 / 提出人的姓名头。 */
function InitialAvatar({ name }: { name: string }) {
  const initial = Array.from(name)[0] ?? "—";
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-medium text-zinc-600">
      {initial}
    </span>
  );
}

/** 区块标题（子视图标题 + 一行口径说明）。 */
function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      <span className="text-xs text-zinc-400">{hint}</span>
    </div>
  );
}

/** 子视图空态。 */
function EmptyCard({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white/50 px-6 py-12 text-center">
      <p className="text-sm text-zinc-500">{text}</p>
      <p className="mt-1.5 text-xs text-zinc-400">{hint}</p>
    </div>
  );
}

/** 剪贴板图的「无名」判定：空名，或浏览器从位图生成的通用名（Chrome 粘图恒为 `image.png` 这类）。 */
function isClipboardGenericName(name: string): boolean {
  return name === "" || /^image\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** 附图图标（右半「点击选择文件」= 业务给的样：文件 + 云；fill=currentColor 随字色；Push 212 续按业务口径「小一点 太大了」缩到 16px）。 */
function UploadIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10 1C9.73478 1 9.48043 1.10536 9.29289 1.29289L3.29289 7.29289C3.10536 7.48043 3 7.73478 3 8V20C3 21.6569 4.34315 23 6 23H7C7.55228 23 8 22.5523 8 22C8 21.4477 7.55228 21 7 21H6C5.44772 21 5 20.5523 5 20V9H10C10.5523 9 11 8.55228 11 8V3H18C18.5523 3 19 3.44772 19 4V9C19 9.55228 19.4477 10 20 10C20.5523 10 21 9.55228 21 9V4C21 2.34315 19.6569 1 18 1H10ZM9 7H6.41421L9 4.41421V7ZM14 15.5C14 14.1193 15.1193 13 16.5 13C17.8807 13 19 14.1193 19 15.5V16V17H20C21.1046 17 22 17.8954 22 19C22 20.1046 21.1046 21 20 21H13C11.8954 21 11 20.1046 11 19C11 17.8954 11.8954 17 13 17H14V16V15.5ZM16.5 11C14.142 11 12.2076 12.8136 12.0156 15.122C10.2825 15.5606 9 17.1305 9 19C9 21.2091 10.7909 23 13 23H20C22.2091 23 24 21.2091 24 19C24 17.1305 22.7175 15.5606 20.9844 15.122C20.7924 12.8136 18.858 11 16.5 11Z"
        fill="currentColor"
      />
    </svg>
  );
}
/** 粘贴入口图标（Push 212 续 · 业务口径「ctrl v 的地方改成这个图标吧」→「两个图标不协调」）：业务给的 1024 视框「剪贴板 + 文件」图。
 *  原图直接缩到 16px 时字形只占视框 81%、线圈仅 ~41 单位（≈0.68px），与右半「文件 + 云」（24 视框 / 2 单位描边 ⇒ 16px 下 1.33px）又细又小 ≈ 不协调；
 *  对齐口径：viewBox 收成 "40 40 944 944"（字形内容 828×890 居中，四周各留 40）并给 strokeWidth="38" ⇒
 *  线圈 ≈ 79 单位 × 16/944 ≈ 1.34px ≈ 右半 1.33px，字形占宽 ≈ 866/944 ≈ 91.7% ≈ 右半 22/24；round 转角与站内图标同观感。
 *  形状仍是原图三条 path（未改一笔），只改视框与描边。 */
function PasteIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="40 40 944 944" fill="currentColor" stroke="currentColor" strokeWidth="38" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M922.21 787.33l0.31-0.45c0.32-0.5 0.62-1 0.9-1.51l0.06-0.12c0.3-0.56 0.57-1.14 0.81-1.72l0.18-0.46q0.27-0.66 0.48-1.35c0.06-0.17 0.11-0.35 0.16-0.53q0.24-0.81 0.42-1.65v-0.18c0.12-0.62 0.21-1.24 0.28-1.86v-0.52c0-0.48 0.06-1 0.07-1.46v-363.9a21.51 21.51 0 0 0-21.5-21.5H487.81a21.53 21.53 0 0 0-21.5 21.57L468 935.76a21.51 21.51 0 0 0 21.5 21.44h256.07c0.71 0 1.42 0 2.13-0.11 0.23 0 0.45-0.07 0.68-0.1 0.47-0.06 0.94-0.12 1.41-0.21 0.29-0.06 0.58-0.15 0.87-0.22s0.79-0.18 1.17-0.3 0.57-0.2 0.85-0.3 0.77-0.25 1.14-0.41 0.51-0.24 0.77-0.36 0.77-0.35 1.14-0.55 0.49-0.29 0.74-0.44 0.73-0.41 1.08-0.65 0.56-0.41 0.84-0.62 0.59-0.42 0.87-0.65a19.92 19.92 0 0 0 1.59-1.46l158.9-160.49a19 19 0 0 0 1.25-1.43l0.35-0.43c0.32-0.37 0.65-0.75 0.86-1.14zM509.38 433.12H883V753.7H745.58a21.5 21.5 0 0 0-21.5 21.5v139H510.91z m331 376.23l-73.34 74.07V796.7h85.85z" />
      <path d="M138.92 751.28V201.57h86v10.75a38.14 38.14 0 0 0 11.1 26.8 37.62 37.62 0 0 0 26.8 11.1h246a37.9 37.9 0 0 0 37.89-37.9v-10.75h71.47v118.06h40.9V181.12a20.49 20.49 0 0 0-20.45-20.45h-91.91v-9.84a38.13 38.13 0 0 0-11.1-26.8 37.59 37.59 0 0 0-26.78-11.1h-58.17a68.64 68.64 0 0 0-129.69 0h-58.17A37.63 37.63 0 0 0 236 124a38.16 38.16 0 0 0-11.09 26.8v9.84H118.47A20.49 20.49 0 0 0 98 181.12V771.7a20.07 20.07 0 0 0 0.11 2c0 0.29 0.07 0.58 0.12 0.86l0.07 0.46c0 0.23 0.06 0.46 0.11 0.68 0.09 0.43 0.2 0.85 0.33 1.35v0.12c0 0.16 0.08 0.31 0.13 0.48 0.14 0.45 0.31 0.89 0.47 1.32v0.11c0 0.15 0.11 0.3 0.17 0.45 0.15 0.36 0.33 0.72 0.5 1.07l0.13 0.26c0.07 0.16 0.15 0.32 0.23 0.48s0.33 0.56 0.5 0.83l0.2 0.33a5.58 5.58 0 0 0 0.34 0.56c0.14 0.21 0.3 0.42 0.46 0.63l0.27 0.36c0.15 0.2 0.3 0.41 0.46 0.61l0.56 0.63 0.3 0.32c0.15 0.18 0.31 0.35 0.47 0.51a4.58 4.58 0 0 0 0.46 0.42l0.28 0.26c0.24 0.22 0.48 0.44 0.74 0.66l0.47 0.36 0.3 0.23 0.83 0.6 0.43 0.27 0.16 0.09c0.37 0.23 0.74 0.46 1.13 0.67a4.8 4.8 0 0 0 0.45 0.22c0.45 0.23 0.89 0.45 1.36 0.64l0.41 0.15c0.48 0.19 1 0.37 1.45 0.52 0.15 0 0.3 0.08 0.53 0.14 0.47 0.13 0.94 0.26 1.41 0.35 0.22 0 0.45 0.08 0.67 0.11l0.48 0.07c0.28 0.05 0.56 0.09 0.85 0.12 0.51 0.06 1.07 0.08 1.68 0.09H382.55v-40.81z m126.9-597.45h92.24v-18.38a27.76 27.76 0 1 1 55.52 0v18.35h92.25v55.5h-240z" />
      <path d="M385.83 117.05a18.39 18.39 0 1 0 0 36.78h3v-0.24a18.38 18.38 0 0 0-3-36.51z" />
    </svg>
  );
}
/** 图片预览层（业务口径「图片要可以预览」）：点缩略图放大看；点任意处 / Esc 关。
 *  Push 217 续④（业务口径「抽屉中点击图片也要居中显示」+「从看板里面点了图片 再从抽屉点图片怎么是这样的 bug」）：
 *  1) 预览层改 **portal 到 body** —— 抽屉壳 .drawer-panel 带 ll-drawer-in 入场动画（animation-fill-mode: both），
 *     动画结束后它的 computed transform 仍是 matrix(1,0,0,1,0,0)（≠ none）⇒ 它就是 fixed 后代的 containing block：
 *     预览层的 fixed inset-0 会退化成「只盖抽屉面板（460px）」而不是整个视口，大图因此贴面板顶 / 溢出到面板外、
 *     和看板入口的正常预览层叠成两层。portal 到 body 后 containing block 回到视口，两处入口同一居中口径。
 *  2) 图幅上限 90vw → min(90vw, calc(100vw - 3rem))：保留 90vw 留白，同时不超过预览层内容宽（减去 p-6 的 48px），
 *     极窄窗口下大图也不会溢出预览层。
 *  3) 预览层自带 stopPropagation（click / pointerdown）—— React 的 portal 事件沿 **React 树**继续冒泡：
 *     看板卡片的整卡 onClick / onPointerDown 会把「点预览层关掉」当成「点卡片」，预览一关抽屉就被带着打开
 *     （业务截图里「看板预览 + 抽屉预览」两层同屏的另一半原因）。同 InlineEdit 浮层的 portal 口径。
 *  4) Esc 改**捕获阶段**监听并止住传播：预览层在最上层时 Esc 只关预览层（再按一次才轮到抽屉自己的 Esc）。
 *  Push 273（业务口径 2026-10-10「图片预览要有缩放功能」）：图改挂共享组件 ImageZoomViewer —— 滚轮 / ＋− / 双击 /
 *  拖动平移（25% ~ 800%）；点图不再关（留给缩放 / 拖动），关浮层 = 点遮罩 / Esc。 */
function PhotoPreview({ url, name, onClose, zClass = "z-[60]" }: { url: string; name: string; onClose: () => void; /** 浮层层级（Push 350：变更详情弹窗（z-[70]）内嵌缩略图的大图预览要盖在弹窗之上 → 传 z-[80]；默认同抽屉口径 z-[60]）。 */ zClass?: string }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  /** 键盘焦点陷阱（Push 264 追订）：预览层打开时焦点进层内、Tab 在层内循环、关闭还原到缩略图。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  return createPortal(
    <div
      ref={trapRef}
      data-photo-preview=""
      role="dialog" data-live-sync-readonly="true"
      aria-label={t("rp.preview", { name })}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className={"fixed inset-0 " + zClass + " flex items-center justify-center bg-zinc-900/60 p-6"}
    >
      <figure className="flex max-h-full max-w-full flex-col items-center">
        <ImageZoomViewer src={url} alt={name} />
        <figcaption className="relative z-10 mt-2 rounded-md bg-zinc-900/35 px-2 py-1 text-center text-xs text-white/80 backdrop-blur-sm">{name}</figcaption>
      </figure>
    </div>,
    document.body,
  );
}

/** 单枚附图瓦片（Push 216）：预览地址本地 blob 优先、否则懒取服务端预览签名；pending 态出「上传中 / 上传失败」标记。 */
function PhotoTile({ item, index, isLarge, isThumb, editingAt, editingText, editingExt, setEditingText, setEditingAt, commitRename, startRename, onRename, onRemove, onPreview }: {
  item: ReportPhoto;
  index: number;
  isLarge: boolean;
  isThumb: boolean;
  editingAt: number | null;
  editingText: string;
  editingExt: string;
  setEditingText: (text: string) => void;
  setEditingAt: (at: number | null) => void;
  commitRename: () => void;
  startRename: (at: number) => void;
  onRename?: (at: number, name: string) => void;
  onRemove?: (at: number) => void;
  onPreview: (url: string, name: string) => void;
}) {
  const t = useT();
  const url = usePhotoUrl(item.fileId, item.url);
  const editing = editingAt === index;
  return (
    <span
      data-attachment={item.name}
      title={isLarge || isThumb ? item.name : undefined}
      className={
        isLarge || isThumb
          ? "group relative inline-flex shrink-0"
          : "inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600"
      }
    >
      {url === null ? null : (
        <button
          type="button"
          data-attachment-thumb=""
          aria-label={t("rp.preview", { name: item.name })}
          onClick={(event) => {
            // Push 217 续④：看板卡片整卡可点（开抽屉），缩略图的预览点击若冒泡 = 「预览层 + 抽屉」同时打开、
            // 两层预览叠着（业务截图）；这里止住冒泡，点图只出预览层。
            event.stopPropagation();
            onPreview(url, item.name);
          }}
          className="shrink-0 rounded-md transition hover:opacity-80"
        >
          <img
            src={url}
            alt={item.name}
            className={
              (isLarge ? "h-24 w-32 rounded-lg border border-zinc-200 object-cover" : isThumb ? "h-10 w-10 rounded-md border border-zinc-200 object-cover" : "h-8 w-8 rounded-md border border-zinc-200 object-cover") +
              (item.pending === "failed" ? " ring-1 ring-rose-400" : item.pending === "uploading" ? " opacity-60" : "")
            }
          />
        </button>
      )}
      {editing ? (
        <input
          data-attachment-input=""
          value={editingText}
          autoFocus
          onChange={(event) => setEditingText(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitRename();
            }
            if (event.key === "Escape") {
              setEditingAt(null);
            }
          }}
          className="w-20 rounded border border-zinc-300 bg-white px-1 py-0.5 text-[10px] text-zinc-700 outline-none focus:border-zinc-400"
        />
      ) : null}
      {item.pending === undefined ? null : isLarge || isThumb ? (
        <span
          className={
            "pointer-events-none absolute inset-x-0 bottom-0 rounded-b-lg px-1 py-0.5 text-center text-[10px] leading-3 text-white " +
            (item.pending === "failed" ? "bg-rose-600/85" : "bg-zinc-900/70")
          }
        >
          {item.pending === "uploading" ? t("photo.uploading") : t("photo.failed")}
        </span>
      ) : (
        <span className={"text-[10px] " + (item.pending === "failed" ? "text-rose-500" : "text-zinc-400")}>
          {item.pending === "uploading" ? t("photo.uploading") : t("photo.failed")}
        </span>
      )}
      {isLarge || isThumb ? null : editing && editingExt !== "" ? (
        <span className="text-[10px] text-zinc-400">{editingExt}</span>
      ) : onRename === undefined || item.pending !== undefined ? (
        <span>{item.name}</span>
      ) : (
        <button
          type="button"
          data-rename-attachment=""
          aria-label={t("rp.renameAria", { name: item.name })}
          title={t("photo.renameTitle")}
          onClick={() => startRename(index)}
          className="max-w-[9rem] truncate text-left transition hover:text-zinc-900 hover:underline"
        >
          {item.name}
        </button>
      )}
      {onRemove === undefined ? null : isLarge || isThumb ? (
        // Push 212 续：md / lg 瓦片走**角标**移除（absolute 覆盖在图上，不占行宽 —— 保证大瓦片仍能并排折行）。
        // Push 224：× 角标改为**悬停才显形**（业务口径「鼠标放置图片右上再显示叉」—— 默认 opacity-0，悬停瓦片或键盘聚焦时显出）。
        <button
          type="button"
          data-action="remove-attachment"
          aria-label={t("rp.removeAria", { name: item.name })}
          onClick={() => onRemove(index)}
          title={t("photo.removeTitle")}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-zinc-200 bg-white text-[11px] leading-none text-zinc-500 opacity-0 shadow-sm transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:opacity-100"
        >
          ×
        </button>
      ) : (
        <button
          type="button"
          data-action="remove-attachment"
          aria-label={t("rp.removeAria", { name: item.name })}
          onClick={() => onRemove(index)}
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** 附图清单：图片出**缩略图**（点开预览层看大图）、非图片出文件名胶囊；表单里再带 × 可逐个移除。
 *  Push 206 加 size 档位：sm（默认 —— 表单贴图区：32×32 小缩略图 + 文件名胶囊）/ lg（「日报记录」列表用：
 *  约 128×96 大图瓦片、多张自动折行、只出图不带文件名 —— 业务样 = 图 2；名字放 title 提示）。
 *  Push 207 再加 md（40×40 紧凑缩略图、只出图不带文件名 —— 业务样 = 图五；Push 217 起「问题追踪」表改用 lg，
 *  现用于「问题看板」卡片与问题详情抽屉的贴图区）。
 *  Push 350：大图预览层层级参数 previewZClass（变更详情弹窗内传 z-[80]，避免大图被弹窗 z-[70] 盖住；默认 z-[60]）+ 开合通知 onPreviewOpenChange（宿主弹窗 Esc 让位：预览开着时 Esc 先关预览、弹窗仍在）。 */
export function PhotoStrip({ items, onRemove, onRename, strip, size = "sm", confirmRemove = false, previewZClass = "z-[60]", onPreviewOpenChange }: { items: readonly ReportPhoto[]; onRemove?: (at: number) => void; onRename?: (at: number, name: string) => void; strip?: string; size?: "sm" | "md" | "lg"; /** Push 224 续：移除图片二次确认（只开在抽屉口径 —— 抽屉里 × 是即时落库的，业务口径「移除图片要加二次确认」；表单 / 编辑弹窗里的删除仍是一下即摘，保存时才落库）。 */ confirmRemove?: boolean; /** 大图预览层层级（Push 350：默认 z-[60]；变更详情弹窗内传 z-[80]，大图盖在弹窗 z-[70] 之上）。 */ previewZClass?: string; /** 大图预览开 / 关通知（Push 350：宿主弹窗据此让出 Esc 优先级 —— 预览开着时 Esc 先关预览、弹窗仍在）。 */ onPreviewOpenChange?: (open: boolean) => void }) {
  const t = useT();
  const isLarge = size === "lg";
  /** 列表里的紧凑缩略图档（40×40、名字进 title）。 */
  const isThumb = size === "md";
  /** 大图预览（Push 216：存已解析的展示地址 —— 本地 blob 或服务端预览签名）。 */
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  /** 大图预览开 / 关（Push 350：带出开合通知 —— 宿主弹窗 Esc 让位给预览层）。 */
  const setPreviewOpen = (next: { url: string; name: string } | null) => {
    setPreview(next);
    onPreviewOpenChange?.(next !== null);
  };
  /** 移除图片二次确认（Push 224 续 · 业务口径「移除图片要加二次确认」，只开在抽屉口径）：
   *  第一下「×」只出底部确认条（与行删除二次提示同款固定底栏），第二下「移除」才真摘。
   *  确认条 portal 到 body —— 抽屉壳 .drawer-panel 的入场动画会当 containing block，留在组件里会偏移。 */
  const [pendingRemove, setPendingRemove] = useState<{ at: number; name: string } | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：移除图片确认条开着时焦点进条内、Tab 在条内循环、关闭还原到缩略图删除按钮。 */
  const removeConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingRemove !== null);
  const requestRemove = (at: number) => {
    const item = items[at];
    if (item === undefined) {
      return;
    }
    setPendingRemove({ at, name: item.name });
  };
  const confirmPendingRemove = () => {
    if (pendingRemove === null || onRemove === undefined) {
      setPendingRemove(null);
      return;
    }
    onRemove(pendingRemove.at);
    setPendingRemove(null);
  };
  /** 正在改名的第几份（null = 没有在改名）；业务口径「图片名称可以自定义」。 */
  const [editingAt, setEditingAt] = useState<number | null>(null);
  /** 编辑中的**主名**（后缀不参与编辑 —— 业务口径「自定义把图片png格式删了怎么办」：格式由系统保留）。 */
  const [editingText, setEditingText] = useState("");
  /** 编辑中保留的后缀（含点；没后缀 = 空串）。 */
  const [editingExt, setEditingExt] = useState("");
  /** 提交改名：空名 / 没变 = 原样（不写回）。 */
  const commitRename = () => {
    if (editingAt === null || onRename === undefined) {
      setEditingAt(null);
      return;
    }
    const base = editingText.trim();
    const next = base === "" ? items[editingAt].name : base + editingExt;
    if (next !== items[editingAt].name) {
      onRename(editingAt, next);
    }
    setEditingAt(null);
  };

  /** 开始改名：主名进输入框、后缀原位保留（图片 png 格式不会被改掉）。 */
  const startRename = (at: number) => {
    const name = items[at].name;
    const dot = name.lastIndexOf(".");
    const hasExt = dot > 0 && dot < name.length - 1;
    setEditingAt(at);
    setEditingText(hasExt ? name.slice(0, dot) : name);
    setEditingExt(hasExt ? name.slice(dot) : "");
  };
  if (items.length === 0) {
    return null;
  }
  return (
    <div data-attachment-strip={strip} className={isLarge ? "mt-1.5 flex flex-wrap items-start gap-2" : isThumb ? "flex flex-wrap items-center gap-1.5" : "mt-1.5 flex flex-wrap items-center gap-1.5"}>
      {items.map((item, index) => (
        <PhotoTile
          key={item.name + "#" + String(index)}
          item={item}
          index={index}
          isLarge={isLarge}
          isThumb={isThumb}
          editingAt={editingAt}
          editingText={editingText}
          editingExt={editingExt}
          setEditingText={setEditingText}
          setEditingAt={setEditingAt}
          commitRename={commitRename}
          startRename={startRename}
          onRename={onRename}
          onRemove={onRemove === undefined ? undefined : confirmRemove ? requestRemove : onRemove}
          onPreview={(url, name) => { setPreviewOpen({ url, name }); }}
        />
      ))}
      {preview === null ? null : <PhotoPreview url={preview.url} name={preview.name} onClose={() => { setPreviewOpen(null); }} zClass={previewZClass} />}
      {pendingRemove === null ? null : createPortal(
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
          <div
            ref={removeConfirmTrapRef}
            role="dialog"
            aria-label={t("rp.removeConfirmAria")}
            data-remove-attachment-confirm-strip=""
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
          >
            <span>{t("photo.removeConfirm", { name: pendingRemove.name })}</span>
            <button
              type="button"
              onClick={() => { setPendingRemove(null); }}
              className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-remove-attachment-confirm=""
              onClick={confirmPendingRemove}
              className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
            >
              {t("photo.remove")}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** 附图选择（原型：名字 + 图片预览地址，正式版走站内文件库）。
 *  Push 202 同批续：以**复制粘贴**为主入口（业务口径「附图要可以复制粘贴 不能全靠选择文件 我们以复制粘贴为主」）——
 *  点一下虚线框**左半**（`Ctrl + V` 半区）拿到焦点，Ctrl+V 直接粘图（截图 / 复制的图片文件都收；剪贴板图没有名字时按「剪贴板图片-N.png」命名）；
 *  形态按业务给的样（虚线卡 + 文件 / 云图标）本地化：**左右分半、无说明文字** —— 左半**剪贴板图标**（主入口；Push 204 起键帽材质下架 —— 业务口径「做成文字吧」、Push 212 续文字换 PasteIcon —— 「ctrl v 的地方改成这个图标吧」；h-full 撑满 44px 行、垂直居中 —— 「位置要居中」）、
 *  右半文件 / 云图标（点击选择文件 · 次入口）；图片存 `URL.createObjectURL` 本地预览地址、**同时立即上传站内文件库**
 *  （Push 216 接真：完成回填 `fileId` —— 提交时随 `photoFileIds` 落 `file_links`；上传中 / 失败在瓦片上出标记）；
 *  两个贴图区同在一张表单时，Ctrl+V 只投给**最近点过**的那一个（armed 态在左半上可见）。
 *  Push 205：「当前问题附图」加**前置开关**（业务口径「先填发现的问题 才能填另外三个」）—— disabled 时整卡灰底 / 灰字、
 *  两半都点不开（左半按钮 disabled、粘贴落点不可聚焦、文件框 disabled、文档级粘贴监听不挂）。 */
export function AttachmentPicker({ projectId, field, items, onChange, ariaLabel, disabled = false, size = "sm", variant = "card", confirmRemove = false }: { projectId: string; field: string; items: readonly ReportPhoto[]; onChange: (items: ReportPhoto[]) => void; ariaLabel: string; disabled?: boolean; /** Push 212 续：主题图清单档位（sm = 表单胶囊档；抽屉沿用各自图幅 —— 问题附图 md / 现场工作附图 lg）。 */ size?: "sm" | "md" | "lg"; /** Push 212 续：形态 —— card = 表单那张虚线贴图卡（业务样）；compact = 紧凑小图标入口（问题详情抽屉用 —— 业务口径「框太大了 不需要」）。 */ variant?: "card" | "compact"; /** Push 224 续：移除图片二次确认 —— 仅抽屉两处开启（× 即时落库，先出确认条）。 */ confirmRemove?: boolean }) {
  const t = useT();
  /** 本区是否是「最近点过的贴图区」——点一下左半（粘贴落点拿到焦点）置位，粘贴事件按它路由。 */
  const [armed, setArmed] = useState(false);
  /** 粘贴落点（左半里的不可见输入框：浏览器只对有可编辑焦点的元素执行 Ctrl+V 粘贴命令）。 */
  const sinkRef = useRef<HTMLInputElement | null>(null);
  /** 粘贴图命名序号（截图多数没有名字 → 剪贴板图片-1.png / -2.png …）。 */
  const pasteSeq = useRef(0);
  /** 最新 props（document 级粘贴监听不随每次输入重挂）。 */
  const latest = useRef({ items, onChange });
  latest.current = { items, onChange };
  /** 就绪态 = 已点过左半 **且未禁用**（禁用态一律不亮、不接粘贴）。 */
  const armedNow = armed && disabled === false;
  /** 紧凑形态（抽屉）：不套虚线卡 —— 只留两枚小图标入口（粘贴 / 选文件）。 */
  const compact = variant === "compact";

  /** 把一批新附件并进已有清单（粘贴与选文件共用；按现有顺序追加，同名不去重）。 */
  const appendItems = (next: readonly ReportPhoto[]) => {
    if (next.length === 0) {
      return;
    }
    latest.current.onChange(latest.current.items.concat(next));
  };

  /** 按条目引用回填（用户中途删掉 = 找不到、自然忽略）。 */
  const updateEntry = (entry: ReportPhoto, update: (current: ReportPhoto) => ReportPhoto) => {
    latest.current.onChange(latest.current.items.map((item) => (item === entry ? update(item) : item)));
  };

  /** 单张上传（Push 216 接真）：文件库直传完成回填 fileId；失败标「uploaded failed」等待用户删除重贴。 */
  const startUpload = async (file: File, entry: ReportPhoto) => {
    try {
      const fileId = await uploadPhoto(projectId, file, entry.name);
      updateEntry(entry, (current) => ({ ...current, fileId, pending: undefined }));
    } catch {
      updateEntry(entry, (current) => ({ ...current, pending: "failed" }));
    }
  };

  /** 一批文件 → 附件（Push 216 接真：本地 blob 预览 + 立即上传文件库；`imagesOnly` = 粘贴路径只收图）。 */
  const toItems = (files: readonly File[], imagesOnly: boolean): ReportPhoto[] => {
    const picked = imagesOnly ? files.filter((file) => file.type.indexOf("image/") === 0) : files;
    return picked.map((file) => {
      const isImage = file.type.indexOf("image/") === 0;
      let name = file.name;
      if (isImage && isClipboardGenericName(file.name)) {
        pasteSeq.current += 1;
        const slash = file.type.indexOf("/");
        const ext = slash >= 0 ? file.type.slice(slash + 1) : "png";
        name = t("rp.clipboardName") + String(pasteSeq.current) + "." + ext;
      }
      const entry: ReportPhoto = { fileId: "", name, url: isImage ? URL.createObjectURL(file) : null, pending: "uploading" };
      void startUpload(file, entry);
      return entry;
    });
  };

  /** 一次粘贴：剪贴板里有图就留下（并 preventDefault，不让图片落成输入框内容）。 */
  const onPasteImage = (event: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const next = toItems(files, true);
    if (next.length > 0) {
      appendItems(next);
      event.preventDefault();
    }
  };

  /** document 级粘贴监听：兜底 —— 焦点在别处（如刚点过右半）时，仍投给「最近点过的贴图区」。 */
  useEffect(() => {
    if (!armed || disabled) {
      return;
    }
    const onPaste = (event: ClipboardEvent) => {
      onPasteImage(event);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [armed, disabled]);

  return (
    <div>
      {/* Push 204 同批：卡片自身不再可聚焦 —— 原来 tabIndex=0 + onFocus 兜就绪态，点右半「选择文件」时浏览器的
          焦点落点是这张卡片，左半被重新点亮、Ctrl+V 被一直劫持（业务口径「点击ctrl v 再点右侧图标就会卡ctrl v一直被点击的bug」）；
          就绪态只由左半（点击 → 粘贴落点聚焦）驱动。 */}
      <div
        data-paste-zone={field}
        data-paste-disabled={disabled ? "true" : "false"}
        role="group"
        aria-label={ariaLabel}
        aria-disabled={disabled}
        className={
          compact
            ? "relative flex items-center gap-1"
            : "overflow-hidden rounded-xl border border-dashed transition " +
              (disabled
                ? "border-zinc-200 bg-zinc-50"
                : armedNow
                  ? "border-zinc-400 bg-white ring-2 ring-zinc-900/5"
                  : "border-zinc-300 bg-white hover:border-zinc-400")
        }
      >
        <div className={compact ? "flex items-center gap-1" : "grid grid-cols-2 divide-x divide-zinc-200 text-center"}>
          <div className="relative">
            <button
              type="button"
              data-paste-half=""
              aria-label={t("rp.pasteAria")}
              disabled={disabled}
              onClick={() => {
                if (disabled) {
                  return;
                }
                sinkRef.current?.focus();
              }}
              className={
                compact
                  ? "flex h-7 w-7 items-center justify-center rounded-lg transition " +
                    (disabled
                      ? "cursor-not-allowed text-zinc-300"
                      : armedNow
                        ? "bg-zinc-100 text-zinc-900"
                        : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600")
                  : "flex h-full w-full items-center justify-center px-2 py-3 transition " +
                    (disabled
                      ? "cursor-not-allowed text-zinc-300"
                      : armedNow
                        ? "bg-zinc-100 text-zinc-900"
                        : "text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600")
              }
            >
              {/* Push 204：键帽下架、改纯文字（业务口径「做成文字吧」）—— 去渐变底 / 内阴影 / 圆角材质；字色随半区悬停 / 就绪态转深（不再单独写字色）
                  垂直居中（业务口径「位置要居中」）：h-full 撑满右半图标定高的 44px 行。
                  Push 212 续（业务口径「ctrl v 的地方改成这个图标吧」→「小一点 太大了」）：文字换**剪贴板图标**（PasteIcon —— 与右半「文件 + 云」同款 currentColor / 16px 口径）。 */}
              <PasteIcon className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </button>
            {/* 粘贴落点：不可见、不可点，只借它的可编辑焦点接浏览器的 Ctrl+V（粘贴被 preventDefault，不会落文字）。Push 311：撤 aria-hidden 改挂 aria-label —— Chrome 119+ 会对「被聚焦的 aria-hidden 元素」拦下并打「Blocked aria-hidden」控制台告警（聚焦元素不能对辅助技术隐藏）；落点不进 Tab 序、仅程序聚焦，聚焦时按真输入框读出来即正确语义 */}
            <input
              ref={sinkRef}
              data-paste-sink=""
              data-paste-hint={armedNow ? "armed" : "idle"}
              disabled={disabled}
              aria-label={t("rp.pasteAria")}
              tabIndex={-1}
              onFocus={() => setArmed(true)}
              onBlur={() => setArmed(false)}
              onChange={() => undefined}
              className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 opacity-0"
            />
          </div>
          <label
            data-file-half=""
            aria-label={disabled ? t("rp.pickDisabledAria") : t("rp.pickAria")}
            onClick={() => {
              if (disabled) {
                return;
              }
              // 右半是文件入口：点它 = 放弃本区粘贴就绪态（修「点右半点亮左半、Ctrl+V 卡住」），并让粘贴落点失焦。
              setArmed(false);
              sinkRef.current?.blur();
            }}
            className={
              compact
                ? "flex h-7 w-7 items-center justify-center rounded-lg transition " +
                  (disabled ? "cursor-not-allowed text-zinc-300" : "cursor-pointer text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600")
                : "flex items-center justify-center px-2 py-3 transition " +
                  (disabled ? "cursor-not-allowed text-zinc-300" : "cursor-pointer text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600")
            }
          >
            <UploadIcon className={compact ? "h-4 w-4" : "h-5 w-5"} />
            <input
              data-field={field}
              type="file"
              multiple
              disabled={disabled}
              onChange={(event) => {
                appendItems(toItems(Array.from(event.target.files ?? []), false));
                event.target.value = "";
              }}
              className="hidden"
            />
          </label>
        </div>
      </div>
      <PhotoStrip
        items={items}
        strip={field}
        size={size}
        confirmRemove={confirmRemove}
        onRemove={(at) => onChange(items.filter((_, index) => index !== at))}
        onRename={(at, name) => onChange(items.map((item, index) => (index === at ? { ...item, name } : item)))}
      />
    </div>
  );
}
/** 「日报记录」的列口径（业务口径「做成列表 不要卡片」，字段仍是 A3-01）；
 *  Push 199 收窄 = 时间 / 填写者 / 关联阶段 / 当日完成工作 / 明日计划 / 现场工作附图 六列 ——「今日施工人数 /
 *  现场发现问题 / 解决方案或建议」只从列表展示去掉（表单字段与 A3-09 问题生成口径不变）；
 *  Push 202 = 六列表头改**中英拼写**（时间time / 填写者 / 关联阶段Related stages / 当日完成工作Work completed today /
 *  明日计划Tomorrow's plan / 现场工作附图On-site photos），时间列改**年月日**、撤状态签与「提交 HH:MM」小字。 */
const REPORT_COLUMNS: readonly string[] = [
  "时间time",
  "填写者",
  "关联阶段Related stages",
  "当日完成工作Work completed today",
  "明日计划Tomorrow's plan",
  "现场工作附图On-site photos",
];

/** 一篇日报一行：**列表 / 表格**（业务口径「日报记录还是做成列表 不要卡片」），列内容与原来的卡片一致；
 *  表格壳与「问题追踪」同一套（白底 + 圆角边框 + 行悬停），窄屏横向滚动。
 *  （Push 199 收窄后不再带问题记录当前态 —— 问题态仍在「问题追踪 / 问题看板」可查。）
 *  Push 206（业务口径「这个日报记录要大一点效果要如图二所示」+「用户填写后换行 填到表格后也要是换行的」）：
 *  整表放大（字号 xs → sm、单元格内边距 py-2.5 → py-4、表头 py-3.5、表格 min-w 900 → 1080）+「当日完成工作 / 明日计划」
 *  两列 whitespace-pre-line 按行换行 + 「现场工作附图」列 PhotoStrip 大图瓦片（size 档位 lg）。
 *  Push 223（业务口径 2026-09-29「日报记录 … 这个编辑也要和干系人同款」+「文字和图片编辑要同款 下拉框的保持原来的」）：
 *  行尾补一枚干系人同款「编辑」按钮 —— 文字两列 / 现场工作附图改走编辑弹窗（ReportEditModal）落值
 *  （表格里只做展示），「关联阶段」是下拉口径、保持原来的行内多选。 */
function ReportList({ reports, onEdit, onPatch, onDelete }: {
  reports: readonly DailyReport[];
  /** 行尾「编辑」按钮（Push 223）：打开日报编辑弹窗 —— 文字两列 + 现场工作附图（关联阶段是下拉口径，保持行内）。 */
  onEdit: (report: DailyReport) => void;
  /** 行内编辑落值（Push 208 口径保留）：本表只剩「关联阶段」一列。 */
  onPatch: (id: string, patch: ReportPatch) => void;
  onDelete: (id: string) => void;
}) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  const t = useT();
  return (
    <div data-report-table="" className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
        <thead className="bg-zinc-50 text-zinc-500">
          <tr>
            {REPORT_COLUMNS.map((title) => (
              <th key={title} className="whitespace-nowrap border-b border-zinc-200 px-4 py-3.5 font-medium">
                {fieldText(locale, title)}
              </th>
            ))}
            {/* Push 213（业务口径「日报记录 和 问题追随都要有删除按钮 … 请你看看有没有合适的位置」）：行尾动作列 ——
                Push 223 再补一枚「编辑」（干系人同款 RowEditButton）—— 两枚共用一枚预留槽位（78px = 悬停展开 48 + 间距 6 + 静止 24），
                哪一枚展开都只吃槽内空间 ⇒ 列宽 / 表宽一格不动（业务反馈「鼠标触碰表格会动」的修法照旧）。 */}
            <th className="w-[110px] border-b border-zinc-200 px-4 py-3.5 font-medium">
              <span className="sr-only">{t("rp.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => {
            return (
              <tr key={report.id} data-report-row={report.id} className="group align-top transition hover:bg-zinc-50/70">
                <td className="whitespace-nowrap border-b border-zinc-100 px-4 py-4">
                  {/* Push 202：时间列只留年月日（业务口径「时间格式也要年月日 具体提交时间不需要 已提交状态也不要」）——
                      状态签与「提交 HH:MM」小字一并下架（state 字段仍保留在数据模型里） */}
                  {/* Push 207 同批追加：时间列**去加粗**（业务口径「问题追踪里面的时间不用加粗」· 业务样 = 图里日报记录时间列）
                      —— 字重回常规、字色对齐「问题追踪」日期列 text-zinc-700（不再用 font-semibold / zinc-900） */}
                  <p data-report-date="" className="text-zinc-700">{isoDateText(locale, report.date)}</p>
                  {report.state === "submitted" ? null : (
                    <span
                      data-report-state={report.state}
                      className={
                        "mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium " +
                        (report.state === "draft" ? "bg-zinc-100 text-zinc-600" : "bg-amber-100 text-amber-800")
                      }
                    >
                      {statusText(locale, REPORT_STATE_NAMES[report.state])}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap border-b border-zinc-100 px-4 py-4">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <InitialAvatar name={report.author} />
                    <span className="truncate text-zinc-700">{report.author}</span>
                  </span>
                </td>
                <td className="min-w-[150px] border-b border-zinc-100 px-4 py-4 leading-6 text-zinc-700">
                  {/* Push 208 追加（业务口径「这个也要可以编辑筛选选择」+ 同日追加「显示也要有颜色」）：关联阶段行内可改 ——
                      浮层 = 与表单同款九阶段勾选清单；显示态 = StageTags 色签组（逐枚出签、与浮层共用一张色表）。
                      Push 223 续（业务口径 2026-09-29「阴影太大了」）：触发器 hover 底色改**贴色签**（CELL_EDIT_CHIP ——
                      不再 w-full 铺满整列），只有色签四周那圈 2px 亮起。 */}
                  <InlineCell
                    ariaLabel={t("rp.stagesAria", { date: report.date })}
                    title={t("rp.pickMultiTitle")}
                    width={220}
                    height={REPORT_STAGES.length * 30 + 12}
                    bare
                    triggerClassName={CELL_EDIT_CHIP}
                    display={<StageTags names={report.stageNames} />}
                    render={() => (
                      <MultiOptionList
                        values={report.stageNames}
                        options={REPORT_STAGES}
                        ariaLabel={t("rp.stagesAria", { date: report.date })}
                        onChange={(next) => {
                          onPatch(report.id, { stageNames: next });
                        }}
                        renderLabel={(name) => stageChip(name, locale)}
                      />
                    )}
                  />
                </td>
                <td className="min-w-[240px] whitespace-pre-line break-words border-b border-zinc-100 px-4 py-4 leading-6 text-zinc-800">
                  {/* Push 223（业务口径「文字和图片编辑要同款」）：当日完成工作改由行尾「编辑」弹窗落值 ——
                      表格里只做展示，不再是可点目标（点表格不进入任何编辑）。 */}
                  {report.doneWork === "" ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    <span data-report-done="" title={locale === "en" ? report.doneWork : undefined} className="block whitespace-pre-line break-words">{localize(report.doneWork)}</span>
                  )}
                </td>
                <td className="min-w-[200px] whitespace-pre-line break-words border-b border-zinc-100 px-4 py-4 leading-6 text-zinc-700">
                  {/* Push 223：明日计划同上（展示only，编辑在行尾弹窗里做）。 */}
                  {report.plan === "" ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    <span data-report-plan="" title={locale === "en" ? report.plan : undefined} className="block whitespace-pre-line break-words">{localize(report.plan)}</span>
                  )}
                </td>
                <td className="min-w-[440px] border-b border-zinc-100 px-4 py-4">
                  {/* 展示only（Push 223）：现场工作附图的增删 / 改名改由行尾「编辑」弹窗（AttachmentPicker）做（点图仍可看大图）。 */}
                  {report.photos.length === 0 ? <span className="text-zinc-400">—</span> : <PhotoStrip items={report.photos} size="lg" />}
                </td>
                <td className="w-[110px] border-b border-zinc-100 px-4 py-4 align-top" data-report-delete-cell="">
                  {/* 行尾动作槽位（Push 223 · 干系人同款两枚：编辑 + 删除）——
                      幽灵态 24px → 悬停 48px **只在槽内长大**；槽容器固定 78px（48 展开 + 6 间距 + 24 静止），
                      单元格内容宽不变 ⇒ 表格列宽 / 表宽一格不动（业务反馈「鼠标触碰表格会动」）。
                      px-4(16×2) + 78 = 110 = w-[110px]，列宽正好对上表头。 */}
                  <span className="flex h-6 w-[78px] shrink-0 items-center justify-end gap-1.5">
                    <span data-report-edit-slot="">
                      <RowEditButton
                        label={t("report.row.editReport", { date: report.date })}
                        onEdit={() => {
                          onEdit(report);
                        }}
                      />
                    </span>
                    <span data-report-delete-slot="">
                      <RowDeleteButton
                        label={t("report.row.deleteReport", { date: report.date })}
                        onDelete={() => {
                          onDelete(report.id);
                        }}
                      />
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 一条问题记录（问题看板的一张卡 · Push 209 改版 —— 业务口径 2026-09-28「问题看板是这样的 要这些内容 然后样式
 *  参考任务进展的」）：卡面与业务样「图一」对齐 —— 只出**问题内容**五段：问题描述（多行 pre-line）/ 问题归类（彩色
 *  色签）/ 问题处理人 / 责任人（Push 243 · 业务口径「图四增加列 问题处理人 / 责任人」）/ 解决方案或建议（多行 pre-line，
 *  有才显示）/ 问题附图（40×40 缩略图，有才显示）；字段名 = 独占一行的浅灰小字。
 *  样式 = 与「任务进展」看板卡片同一套材质（CARD_SHELL 白壳 + 发丝边 + 三层投影 + 细纹），点一下开「问题详情」抽屉。
 *  同批下架（图一没有）：状态签 / 提出人 / 提出日期 —— 状态看列头、其余进抽屉（Push 207 的「责任 / 处理时限 / 所属任务」
 *  不再展示口径照旧不变）。Push 210（业务口径「卡片要可以拖动」）：卡片接指针拖动 —— 按住拖到别的列 = 改问题状态（细节见 IssueBoard）。Push 211（业务口径「要加问题描述标题」）：首段问题描述补「问题描述」字段名 —— 卡面四段全部有字段名。 */
function IssueCard({ issue, onOpen, onPointerDownDrag, dragging = false, ghost = false }: {
  issue: Issue;
  onOpen: () => void;
  onPointerDownDrag?: (issueId: string, node: HTMLElement, event: ReactPointerEvent<HTMLDivElement>) => void;
  dragging?: boolean;
  ghost?: boolean;
}) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  return (
    <div
      role={ghost ? undefined : "button"}
      tabIndex={ghost ? undefined : 0}
      aria-hidden={ghost ? true : undefined}
      aria-label={ghost ? undefined : textOf(locale, "rp.cardAria", { title: issue.title })}
      title={onPointerDownDrag === undefined ? undefined : textOf(locale, "rp.cardDragTitle")}
      data-issue-card={issue.id}
      onClick={onOpen}
      onPointerDown={onPointerDownDrag === undefined ? undefined : (event) => { onPointerDownDrag(issue.id, event.currentTarget, event); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={(ghost ? ISSUE_CARD_SHELL_GHOST : CARD_SHELL) + (dragging ? " cursor-grabbing" : " cursor-pointer")}
    >
      <span aria-hidden="true" className={CARD_NOISE} />
      <div className={CARD_BODY}>
        <Field label={fieldText(locale, "问题描述")} first>
          <p data-issue-card-title="" title={locale === "en" ? issue.title : undefined} className="whitespace-pre-line break-words text-sm leading-5 text-zinc-900">{localize(issue.title)}</p>
        </Field>
        <Field label={fieldText(locale, "问题归类")}>
          <CategoryTags values={issue.categories} />
        </Field>
        <Field label={fieldText(locale, "问题处理人 / 责任人")}>
          {issue.owner === "" ? (
            <p data-issue-card-owner="" className="text-sm leading-5 text-zinc-300">—</p>
          ) : (
            <p data-issue-card-owner="" className="text-sm leading-5 text-zinc-900">{issue.owner}</p>
          )}
        </Field>
        {issue.solution === "" ? null : (
          <Field label={fieldText(locale, "解决方案或建议")}>
            <p data-issue-card-solution="" title={locale === "en" ? issue.solution : undefined} className="whitespace-pre-line break-words text-sm leading-5 text-zinc-700">{localize(issue.solution)}</p>
          </Field>
        )}
        {issue.photos.length === 0 ? null : (
          <Field label={fieldText(locale, "问题附图")}>
            <PhotoStrip items={issue.photos} size="md" />
          </Field>
        )}
      </div>
    </div>
  );
}

/** 按下卡片、还没到拖动阈值时的暂存（Push 210）。 */
type PendingIssueDrag = {
  issueId: string;
  pointerId: number;
  /** 按下时的坐标：用来判「过没过阈值」。 */
  x: number;
  y: number;
  /** 卡片 DOM：真拖起来之后把指针捕获在它身上（鼠标滑出窗口再放开也收得到 pointerup）。 */
  node: HTMLElement;
  dragging: boolean;
};

/**
 * 「问题看板」列板 + 卡片拖动（Push 210 · 业务口径 2026-09-28「卡片要可以拖动」）：
 * 与「任务进展」看板同一套指针拖动口径 —— 按住卡片位移超过 DRAG_THRESHOLD 才算拖动（没超过 = 点一下开
 * 问题详情抽屉）；拖动中卡片跟手（半透明拖动卡），非当前列描边高亮 + 列顶浮出落点槽；拖到看板 / 列边缘逐帧自动滚；
 * 放开 = 把问题状态改成目标列（同一 patchIssue 内存态：「问题追踪」表 / 计数 / 抽屉同步跟着变）。
 * 同列不是落点（问题没有列内顺序，放开不改动）；Esc / 指针取消 = 原地取消；整段拖动没有原生拖拽参与，滚轮照常可用。
 */
function IssueBoard({ issues, onPatch, onOpen }: {
  issues: readonly Issue[];
  onPatch: (id: string, patch: IssuePatch) => void;
  onOpen: (id: string) => void;
}) {
  const locale = useLocale();
  const t = useT();
  /** 正在拖动的卡片 id（null = 没在拖）。 */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 当前落点列（null = 不在任何别的列上；同列不算落点）。 */
  const [dropState, setDropState] = useState<IssueState | null>(null);
  /** 按下卡片、还没过拖动阈值时的暂存（没过阈值就还是「点一下看详情」）。 */
  const pendingRef = useRef<PendingIssueDrag | null>(null);
  /** 拖动中鼠标的最后位置：滚轮 / 边缘自动滚时鼠标可以不动，落点按这个位置重算。 */
  const pointerRef = useRef({ x: 0, y: 0 });
  /** 拖动收尾那一下的 click 不当成「打开抽屉」。 */
  const suppressClickRef = useRef(false);
  /** 跟着鼠标走的拖动卡片：直接用 DOM 改 transform，不走 state（每帧都要动）。 */
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /** 看板本体：拖到边缘自动滚按它找横向视口。 */
  const boardRef = useRef<HTMLDivElement | null>(null);
  /** 抓取偏移：按下时鼠标在卡片内的位置 + 卡片宽度，拖动卡按这个对齐。 */
  const grabRef = useRef({ dx: 0, dy: 0, width: 0 });
  /** 列高自适应（Push 244 续）：按「看板顶边 → 视口底」实高给列高 —— 提交提示条出现 / 窗口缩放时自动让位，
   *  页面永远不多出第二根滚动条（列内溢出仍走各自 ScrollArea）。null = 用 ISSUE_COLUMN 的静态兜底值。 */
  const [columnHeight, setColumnHeight] = useState<number | null>(null);
  /** 最新问题表 / 落点判定 / 落值回调（指针与每帧回调里读，免得闭包吃到旧值）。 */
  const issuesRef = useRef(issues);
  const dropStateAtRef = useRef<(x: number, y: number) => IssueState | null>(() => null);
  const patchRef = useRef(onPatch);

  /** 列高测量（Push 244 续）：挂载 + 窗口缩放时按实高更新（列顶已被提示条 / 段头等抬高多少都算进去）。 */
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (board === null) {
      return;
    }
    const apply = () => {
      // 列底内衬 = ScrollArea pb-3 12 + main pb-10 40 = 52px。
      const next = Math.max(352, Math.round(window.innerHeight - board.getBoundingClientRect().top - 52));
      setColumnHeight((previous) => (previous === next ? previous : next));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
    };
  }, []);

  /** 鼠标底下是「哪一列」：别的列才是落点 —— 同列放开不改状态，所以同列不给提示；指针压到看板左右边缘之外时
   *  夹回看板可视范围再判一次（同「任务进展」看板口径）。 */
  const dropStateAt = (x: number, y: number, issueId: string): IssueState | null => {
    const issue = issuesRef.current.find((item) => item.id === issueId);
    if (issue === undefined) {
      return null;
    }
    let column = dragColumnAtPoint(x, y);
    if (column === null) {
      const board = dragScrollAreaViewport(boardRef.current, "horizontal");
      if (board !== null) {
        const rect = board.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom && x >= rect.left - 64 && x <= rect.right + 64) {
          column = dragColumnAtPoint(Math.min(Math.max(x, rect.left + 1), rect.right - 1), y);
        }
      }
    }
    if (column === null) {
      return null;
    }
    const key = column.getAttribute("data-issue-column");
    if (key === null || key === issue.state) {
      return null;
    }
    return ISSUE_STATES.find((state) => state === key) ?? null;
  };

  // 三个「最新实现」的 ref：指针 / 每帧回调里读最新实现，免得闭包吃到上一轮的函数
  useEffect(() => {
    issuesRef.current = issues;
    patchRef.current = onPatch;
    dropStateAtRef.current = (x, y) => {
      const pending = pendingRef.current;
      return pending === null ? null : dropStateAt(x, y, pending.issueId);
    };
  });

  /**
   * 指针拖动（Push 210）：① 按下卡片后位移超过 DRAG_THRESHOLD 才算真拖动（没过阈值 = 点一下看详情）；
   * ② 拖动中鼠标动一下就更新落点；③ 放开时落在哪一列就交给 patchIssue 改状态；④ Esc / 指针取消 = 原地取消。
   * 整段拖动没有原生拖拽参与，所以滚轮照常可用。
   */
  useEffect(() => {
    /** 收尾（放开 / Esc / 指针取消）：清掉暂存与落点，恢复页面文字选择。 */
    const endDrag = () => {
      pendingRef.current = null;
      document.body.style.userSelect = "";
      setDraggingId(null);
      setDropState(null);
    };
    const handleMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const pending = pendingRef.current;
      if (pending === null || pending.dragging) {
        return;
      }
      if (Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y) < DRAG_THRESHOLD) {
        return;
      }
      pending.dragging = true;
      try {
        // 指针捕获在卡片上：鼠标滑出窗口再放开也收得到 pointerup
        pending.node.setPointerCapture(pending.pointerId);
      } catch {
        // 指针已经不在了（例如刚抬起）：忽略，落点照样按下面的逻辑算
      }
      const rect = pending.node.getBoundingClientRect();
      grabRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, width: rect.width };
      document.body.style.userSelect = "none";
      suppressClickRef.current = true;
      setDraggingId(pending.issueId);
      setDropState(dropStateAtRef.current(event.clientX, event.clientY));
    };
    const handleUp = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending === null) {
        return;
      }
      const wasDragging = pending.dragging;
      const target = wasDragging ? dropStateAt(event.clientX, event.clientY, pending.issueId) : null;
      pendingRef.current = null;
      document.body.style.userSelect = "";
      setDraggingId(null);
      setDropState(null);
      if (!wasDragging || target === null) {
        return;
      }
      patchRef.current(pending.issueId, { state: target });
    };
    const handleCancel = () => {
      endDrag();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingRef.current !== null) {
        endDrag();
      }
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  /** 拖动中按帧重算落点：鼠标可以不动、容器在滚（滚轮 / 边缘自动滚），槽位得跟着走。 */
  useEffect(() => {
    if (draggingId === null) {
      return;
    }
    let raf = window.requestAnimationFrame(function tick() {
      const ghost = ghostRef.current;
      if (ghost !== null) {
        const grab = grabRef.current;
        ghost.style.transform = "translate(" + (pointerRef.current.x - grab.dx) + "px," + (pointerRef.current.y - grab.dy) + "px)";
      }
      autoScrollIssueDrag(boardRef.current, pointerRef.current);
      const next = dropStateAtRef.current(pointerRef.current.x, pointerRef.current.y);
      setDropState((prev) => (prev === next ? prev : next));
      raf = window.requestAnimationFrame(tick);
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [draggingId]);

  /** 按下卡片：先只记「可能拖动」，真拖动由上面的指针循环判定。 */
  const beginCardDrag = (issueId: string, node: HTMLElement, event: ReactPointerEvent<HTMLDivElement>) => {
    pendingRef.current = { issueId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, node, dragging: false };
    pointerRef.current = { x: event.clientX, y: event.clientY };
    suppressClickRef.current = false;
  };

  /** 点一下卡片 = 打开问题详情抽屉；拖动收尾那一下的 click 不算。 */
  const openIssueCard = (issueId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen(issueId);
  };

  /** 拖动中的那张问题（用来画跟着鼠标走的拖动卡）。 */
  const draggingIssue = draggingId === null ? null : issues.find((issue) => issue.id === draggingId) ?? null;

  return (
    <div data-issue-board="" ref={boardRef}>
      <ScrollArea axis="horizontal" ariaLabel={t("rp.boardScrollAria")} viewportClassName="pb-3" className="flex items-start gap-4">
        {ISSUE_STATES.map((state) => {
          const items = issues.filter((issue) => issue.state === state);
          const isTarget = dropState === state;
          return (
            <section
              key={state}
              data-issue-column={state}
              style={columnHeight === null ? undefined : { height: columnHeight }}
              className={ISSUE_COLUMN + (isTarget ? " rounded-[28px] ring-2 ring-emerald-400/70 ring-offset-4 ring-offset-white" : "")}
            >
              <header className="mb-3 flex items-center gap-2 px-1">
                <IssueStateTag state={state} />
                <span className="shrink-0 text-xs text-zinc-400">{t("report.board.count", { n: items.length })}</span>
              </header>
              <ScrollArea viewportClassName="min-h-0 flex-1" className="flex flex-col gap-3 pr-1" ariaLabel={t("rp.boardCardsAria", { state: statusText(locale, ISSUE_STATE_NAMES[state]) })}>
                {isTarget ? (
                  <div
                    data-issue-drop-slot="true"
                    className="flex items-center justify-center rounded-[35px] border-2 border-dashed border-emerald-400/70 bg-emerald-50/60 px-3 py-6 text-center text-[11px] font-medium text-emerald-700"
                  >
                    {t("report.board.dropTo", { state: statusText(locale, ISSUE_STATE_NAMES[state]) })}
                  </div>
                ) : null}
                {items.length === 0 ? (
                  isTarget ? null : (
                    <p className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed border-zinc-300 px-3 text-center text-xs text-zinc-400">
                      {t("report.board.none")}
                    </p>
                  )
                ) : (
                  items.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      onOpen={() => {
                        openIssueCard(issue.id);
                      }}
                      dragging={draggingId === issue.id}
                      onPointerDownDrag={beginCardDrag}
                    />
                  ))
                )}
              </ScrollArea>
            </section>
          );
        })}
      </ScrollArea>
      {draggingIssue === null ? null : (
        <div
          ref={ghostRef}
          data-drag-ghost="true"
          aria-hidden="true"
          style={{ width: grabRef.current.width === 0 ? undefined : grabRef.current.width }}
          className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
        >
          <IssueCard issue={draggingIssue} ghost onOpen={() => undefined} />
        </div>
      )}
    </div>
  );
}

/** 问题追踪：一条问题一行的表格（Push 207 改版）。列口径 = 业务样「图五」六列 —— 日期 / 问题描述 / 问题归类 /
 *  解决方案或建议 / 问题附图 / 问题是否处理（列头带小图标）；撤「责任 / 处理时限 / 所属任务」（业务口径「责任这一栏
 *  不需要 删除吧」+「处理时限不需要 所属任务也不需要」）；「提出人」并进问题描述列的灰字小行（图五没有这一列，
 *  信息不丢）；「问题描述 / 解决方案或建议」按行换行（whitespace-pre-line —— 承接 Push 206 自动序号）。
 *  行样式 = 业务样「图六」（项目总览任务表）：白卡 + 圆角边框 + 列头 bg-zinc-50 小字 + 行 px-5 py-2.5 /
 *  divide-zinc-100 细分割线 / hover:bg-zinc-50/80。
 *  Push 217（业务口径 2026-09-29「问题追踪的卡片比例也要和日报记录的相同」+ 同批追加「这比例完全不一样啊 包括图片」）：
 *  整表**比例对齐「日报记录」** —— 列内边距 px-5 → px-4、单元格 py-2.5 → py-4（表头 px-4 py-3.5）、
 *  表头字号 xs → sm（text-zinc-500）、行补 align-top、行尾动作列 w-[88px] → w-20（px-4×2 + 48 = 80，与「日报记录」同槽位）；
 *  「问题附图」列图幅 md（40×40）→ **lg 大图瓦片**（约 128×96、多张折行 —— 与「日报记录 → 现场工作附图」同一档）、
 *  列宽 min-w-[130px] → 440；列口径 / 交互不变。
 *  Push 217 续（业务口径「问题归类去左侧一些这个间距不协调」+「这个在表格里面始终居中」）：
 *  「问题描述」列 min-w-[320px] → min-w-[240px] —— 收窄描述与「问题归类」之间的空档，归类列（及其后各列）随之前移；
 *  「问题是否处理」列单元格补 text-center —— 状态色签（InlineOptionCell 触发器 = 行内级盒）在列内**始终水平居中**；
 *  另（业务口径「会出现截断的问题」）：归类单元格改 `wrapContent` —— 包裹层撤 `truncate` 裁剪，窄窗 / 列被挤到最小时色签不再被裁掉一角。
 *  Push 207 同批追加「增加项目总览 同款醒目模式在问题追踪里面」（Push 290 起改吃**背景档位**）：`tierTint` = 档位「适中」——
 *  整行铺该问题状态的行色（适中 = ISSUE_ROW_TINT 便签同款兑白 / 炫彩 = ISSUE_ROW_TINT_VIVID 高饱和，与项目总览任务表同一套口径），状态列只留深色字；否则 = 原样。
 *  Push 223（业务口径 2026-09-29「日报记录 问题追溯里面 这个编辑也要和干系人同款」+「文字和图片编辑要同款 下拉框的保持原来的」）：
 *  行尾补一枚干系人同款「编辑」按钮 —— 「问题描述 / 解决方案或建议 / 问题附图」改走编辑弹窗（IssueEditModal）
 *  落值（表格里只做展示）；「问题归类」「问题是否处理」是下拉口径、保持原来的行内编辑。 */
function IssueTable({ issues, tierTint, onEdit, onPatch, onDelete }: {
  issues: readonly Issue[];
  tierTint: TintedTier | false;
  /** 行尾「编辑」按钮（Push 223）：打开问题编辑弹窗 —— 文字两列 + 问题附图（归类 / 状态是下拉口径，保持行内）。 */
  onEdit: (issue: Issue) => void;
  onPatch: (id: string, patch: IssuePatch) => void;
  onDelete: (issue: Issue) => void;
}) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  const t = useT();
  return (
    <div data-issue-table="" className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
        <thead className="bg-zinc-50 text-zinc-500">
          <tr>
            {ISSUE_TABLE_COLUMNS.map((column) => (
              <th key={column.key} data-issue-head={column.key} className="whitespace-nowrap border-b border-zinc-200 px-4 py-3.5 font-medium">
                {fieldText(locale, column.label)}
              </th>
            ))}
            {/* Push 213（业务口径「日报记录 和 问题追随都要有删除按钮 … 请你看看有没有合适的位置」）：行尾动作列 ——
                Push 223 再补一枚「编辑」（干系人同款 RowEditButton）—— 两枚共用同一枚预留槽位
                （78px = 悬停展开 48 + 间距 6 + 静止 24）；删问题 = 连它来源的那篇日报一起删（同一篇日报整组）。 */}
            <th className="w-[110px] border-b border-zinc-200 px-4 py-3.5 font-medium">
              <span className="sr-only">{t("rp.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {issues.map((issue) => (
            <tr key={issue.id} data-issue-row={issue.id} className={"group align-top transition-colors " + (tierTint ? "issue-row-tint" + (tierTint === "vivid" ? " tint-vivid" : "") : "hover:bg-zinc-50/80")} style={tierTint ? ({ "--row-tint": (tierTint === "vivid" ? ISSUE_ROW_TINT_VIVID : ISSUE_ROW_TINT)[issue.state].tint, "--row-tint-hover": (tierTint === "vivid" ? ISSUE_ROW_TINT_VIVID : ISSUE_ROW_TINT)[issue.state].hover } as CSSProperties) : undefined}>
              <td className="whitespace-nowrap px-4 py-4 text-zinc-700">{isoDateText(locale, issue.raisedAt)}</td>
              <td className="min-w-[240px] px-4 py-4">
                {/* Push 217 续（业务口径「问题归类去左侧一些这个间距不协调」）：min-w 320 → 240 —— 收窄本列与
                    「问题归类」之间的空档，归类列（及其后各列）随之前移；描述 / 「提出人」小行仍按行换行，不截断。 */}
                {/* Push 223（业务口径「文字和图片编辑要同款」）：问题描述改由行尾「编辑」弹窗落值 ——
                    表格里只做展示，不再是可点目标（点表格不进入任何编辑）。 */}
                <span data-issue-title="" title={locale === "en" ? issue.title : undefined} className="block whitespace-pre-line break-words leading-6 text-zinc-800">{localize(issue.title)}</span>
                <p className="mt-1 text-[11px] leading-4 text-zinc-400">{t("report.issue.reporter", { name: issue.reporter })}</p>
              </td>
              <td className="whitespace-nowrap px-4 py-4">
                {/* Push 208：问题归类行内可改 —— 浮层 = 表单侧同款多选（绿勾 · 点选不收浮层），落值按「、」连接 */}
                {/* Push 217 续③（业务口径「会出现截断的问题」）：wrapContent —— 撤包裹层 truncate 裁剪：窄窗 / 列被挤到
                    最小时色签不再被裁掉一角（色签折行 / 触发器内衬等其他表现不变，壳档位见 InlineCell）。 */}
                <InlineMultiOptionCell
                  bare
                  wrapContent
                  values={issue.categories}
                  options={ISSUE_CATEGORIES}
                  ariaLabel={t("rp.catAria", { date: issue.raisedAt })}
                  renderLabel={(name) => categoryChip(name, locale)}
                  triggerClassName={CELL_EDIT_CHIP}
                  display={<CategoryTags values={issue.categories} />}
                  onChange={(values) => {
                    onPatch(issue.id, { categories: values });
                  }}
                />
              </td>
              <td className="min-w-[110px] whitespace-nowrap px-4 py-4 text-zinc-700">
                {/* Push 243（业务口径「图三图四增加列 问题处理人 / 责任人」）：展示only —— 问题记录生成时随内联问题
                    清单的处理人 ownerId 落库；空（旧数据 / 无人）出灰杠，与看板卡 / 抽屉同一口径。 */}
                <span data-issue-owner="">{issue.owner === "" ? <span className="text-zinc-300">—</span> : issue.owner}</span>
              </td>
              <td className="min-w-[280px] px-4 py-4">
                {/* Push 223：解决方案或建议同上（展示only，编辑在行尾弹窗里做）。 */}
                <span data-issue-solution="" title={locale === "en" ? issue.solution : undefined} className="block whitespace-pre-line break-words leading-6 text-zinc-600">{issue.solution === "" ? "—" : localize(issue.solution)}</span>
              </td>
              <td className="min-w-[440px] px-4 py-4">
                {/* 展示only（Push 223）：问题附图的增删 / 改名改由行尾「编辑」弹窗（AttachmentPicker）做（点图仍可看大图）。
                    Push 217 续（业务口径「这比例完全不一样啊 包括图片」）：图幅 md（40×40）→ lg（约 128×96 大图瓦片、
                    多张自动折行、只出图不带文件名 —— 与「日报记录 → 现场工作附图」同一档），列宽同口径 min-w-[440px]。 */}
                {issue.photos.length === 0 ? <span className="text-zinc-400">—</span> : <PhotoStrip items={issue.photos} size="lg" />}
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-center">
                {/* Push 217 续（业务口径「这个在表格里面始终居中」）：text-center —— 触发器是行内级盒（inline-flex），
                    状态色签在列内**始终水平居中**（三态 / 适中档 / 行内改后同款；列宽再变也不贴左沿）。 */}
                {/* Push 208：问题是否处理行内可改 —— 单态下拉（业务样 = 项目总览状态列那枚）。
                    Push 260：抽成 IssueStateCell 与工作台问题表共用（那边要「和项目内部一样可以点击」）。 */}
                <IssueStateCell
                  state={issue.state}
                  tierTint={tierTint}
                  ariaLabel={t("rp.stateAria", { date: issue.raisedAt })}
                  onPick={(next) => {
                    onPatch(issue.id, { state: next });
                  }}
                />
              </td>
              <td className="w-[110px] px-4 py-4" data-issue-delete-cell="">
                {/* 行尾动作槽位（Push 223 · 干系人同款两枚：编辑 + 删除）—— 槽容器固定 78px（48 展开 + 6 间距 + 24 静止），
                    幽灵态 24px → 悬停 48px 只在槽内长大，不推挤左侧列（业务反馈「问题追踪的没做好 鼠标触碰表格会动」）。
                    px-4(16×2) + 78 = 110 = w-[110px]（与「日报记录」同槽位）。 */}
                <span className="flex h-6 w-[78px] shrink-0 items-center justify-end gap-1.5">
                  <span data-issue-edit-slot="">
                    <RowEditButton
                      label={t("report.row.editIssue", { date: issue.raisedAt })}
                      onEdit={() => {
                        onEdit(issue);
                      }}
                    />
                  </span>
                  <span data-issue-delete-slot="">
                    <RowDeleteButton
                      label={t("report.row.deleteIssue", { date: issue.raisedAt })}
                      onDelete={() => {
                        onDelete(issue);
                      }}
                    />
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 「日报记录 / 问题追踪」行编辑弹窗外壳（Push 223 · 与「干系人」新建 / 编辑弹窗同款：遮罩 + max-w-md 圆角白卡 + 品牌黄主按钮
 *  + Esc / 点遮罩关闭；内容超高时表单区自己滚动、页脚按钮不跟着滚）。 */
function RecordEditModal({ label, hint, submitLabel, pending, canSubmit, error, onClose, onSubmit, children }: {
  label: string;
  hint: string;
  submitLabel: string;
  /** 提交中（主按钮转「保存中…」并禁用）。 */
  pending: boolean;
  canSubmit: boolean;
  /** 服务端失败文案（非空时显示在按钮上方；窗口保持打开）。 */
  error: string | null;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);
  /** 键盘焦点陷阱（Push 264 追订）：编辑弹窗打开时焦点进弹窗、Tab 在弹窗内循环、关闭还原到触发按钮。 */
  const trapRef = useFocusTrap<HTMLDivElement>();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-900/40" onClick={onClose} />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-record-edit-modal=""
        className="relative flex max-h-[calc(100vh-3rem)] w-full max-w-md flex-col rounded-2xl bg-white p-6 shadow-[0_24px_60px_rgba(0,0,0,0.25)]"
      >
        <h2 className="text-lg font-bold text-zinc-900">{label}</h2>
        <p className="mt-1 text-sm text-zinc-500">{hint}</p>
        <form className="mt-5 flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-0.5">{children}</div>
          {error === null ? null : (
            <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              data-record-edit-submit=""
              disabled={!canSubmit}
              className="rounded-lg bg-[#feca04] px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:brightness-95 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? t("report.modal.saving") : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 「日报记录」行编辑弹窗（Push 223 · 业务口径「日报记录 … 这个编辑也要和干系人同款」+「文字和图片编辑要同款」）：
 *  只收**文字 + 图片**两类字段 —— 当日完成工作 / 明日计划 / 现场工作附图；「关联阶段」是下拉口径，
 *  按业务要求**保持原来的行内编辑**，不进弹窗。
 *  PATCH 合并语义与「干系人」弹窗一致：只提交改动过的键（文字保存前统一过自动序号 renumberLines）。 */
function ReportEditModal({ projectId, row, onClose, onSubmit }: {
  projectId: string;
  row: DailyReport;
  onClose: () => void;
  /** 提交：返回 null = 成功（父层关窗）；返回文案 = 失败提示，窗口保持打开。 */
  onSubmit: (patch: ReportPatch) => Promise<string | null>;
}) {
  const locale = useLocale();
  const t = useT();
  const [doneWork, setDoneWork] = useState(row.doneWork);
  const [plan, setPlan] = useState(row.plan);
  const [photos, setPhotos] = useState<ReportPhoto[]>(row.photos);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 保存前统一过一遍自动序号（与表格行内编辑 / 「日报填写」提交同一口径）。 */
  const nextDoneWork = renumberLines(doneWork);
  const nextPlan = renumberLines(plan);
  /** 图片还在上传 / 上传失败先拦住（复用「日报填写」提交那套文案）。 */
  const uploadBlocked = uploadBlockingMessage({ ...emptyDraft(), photos }, locale);
  /** 「当日完成工作」是契约必填 —— 清空不允许保存（与行内编辑同口径）。 */
  const canSubmit = nextDoneWork !== "" && uploadBlocked === "" && !pending;
  /** 只提交改动过的键（与干系人弹窗的 PATCH 合并语义一致）；无改动 = 空 patch（父层直接关窗）。 */
  const changedPatch = (): ReportPatch => {
    const patch: ReportPatch = {};
    if (nextDoneWork !== row.doneWork) {
      patch.doneWork = nextDoneWork;
    }
    if (nextPlan !== row.plan) {
      patch.plan = nextPlan;
    }
    if (readyFileIds(photos).join("|") !== readyFileIds(row.photos).join("|")) {
      patch.photos = photos;
    }
    return patch;
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setError(null);
    void onSubmit(changedPatch()).then((message) => {
      setPending(false);
      if (message !== null) {
        setError(message);
      }
    });
  };
  return (
    <RecordEditModal
      label={t("report.modal.report.title")}
      hint={t("report.modal.report.hint", { date: isoDateText(locale, row.date), author: row.author })}
      submitLabel={t("report.modal.submit")}
      pending={pending}
      canSubmit={canSubmit}
      error={error}
      onClose={onClose}
      onSubmit={handleSubmit}
    >
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "当日完成工作")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("report.required")}</span>
        </span>
        <GrowingTextarea
          data-record-field="doneWork"
          className={FORM_INPUT + " resize-none leading-6"}
          rows={3}
          value={doneWork}
          onChange={(event) => setDoneWork(event.target.value)}
          placeholder={t("report.placeholder.doneWork")}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "明日计划")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("report.optional.clear")}</span>
        </span>
        <GrowingTextarea
          data-record-field="plan"
          className={FORM_INPUT + " resize-none leading-6"}
          rows={3}
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
          placeholder={t("report.placeholder.plan")}
        />
      </label>
      <div className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "现场工作附图")}
        </span>
        <AttachmentPicker
          projectId={projectId}
          variant="compact"
          field="photos"
          size="lg"
          items={photos}
          onChange={setPhotos}
          ariaLabel={t("rp.photosHalfAria")}
        />
      </div>
      {uploadBlocked === "" ? null : <p className="text-xs text-amber-700">{uploadBlocked}</p>}
    </RecordEditModal>
  );
}

/** 「问题追踪」行编辑弹窗（Push 223 · 业务口径「问题追溯里面 这个编辑也要和干系人同款」+「文字和图片编辑要同款」）：
 *  只收**文字 + 图片**两类字段 —— 问题描述 / 解决方案或建议 / 问题附图；「问题归类」「问题是否处理」是下拉口径，
 *  按业务要求**保持原来的行内编辑**，不进弹窗。
 *  Push 244（业务口径「这个负责人要可以编辑」）：追加**问题处理人 / 责任人**单选（成员搜索下拉 + 首项「待分派」）。 */
function IssueEditModal({ projectId, members, row, onClose, onSubmit }: {
  projectId: string;
  members: readonly Member[];
  row: Issue;
  onClose: () => void;
  onSubmit: (patch: IssuePatch) => Promise<string | null>;
}) {
  const locale = useLocale();
  const t = useT();
  const [title, setTitle] = useState(row.title);
  const [solution, setSolution] = useState(row.solution);
  const [photos, setPhotos] = useState<ReportPhoto[]>(row.photos);
  /** 问题处理人 / 责任人（Push 244）："" = 待分派（落值时转契约 null）。 */
  const [ownerId, setOwnerId] = useState(row.ownerId);
  const ownerItems = issueOwnerItems(members, locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 保存前统一过一遍自动序号（与表格行内编辑同一口径）。 */
  const nextTitle = renumberLines(title);
  const nextSolution = renumberLines(solution);
  /** 图片还在上传 / 上传失败先拦住（复用「日报填写」提交那套文案）。 */
  const uploadBlocked = uploadBlockingMessage({ ...emptyDraft(), photos }, locale);
  /** 「问题描述」是契约必填（清空会被服务端拒）—— 前端先拦（与行内编辑同口径）。 */
  const canSubmit = nextTitle !== "" && uploadBlocked === "" && !pending;
  /** 只提交改动过的键（solution 空串 = 清空 → 契约 null，口径同 issueUpdateBody）。 */
  const changedPatch = (): IssuePatch => {
    const patch: IssuePatch = {};
    if (nextTitle !== row.title) {
      patch.title = nextTitle;
    }
    if (nextSolution !== row.solution) {
      patch.solution = nextSolution;
    }
    if (readyFileIds(photos).join("|") !== readyFileIds(row.photos).join("|")) {
      patch.photos = photos;
    }
    if (ownerId !== row.ownerId) {
      patch.ownerId = ownerId;
    }
    return patch;
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setError(null);
    void onSubmit(changedPatch()).then((message) => {
      setPending(false);
      if (message !== null) {
        setError(message);
      }
    });
  };
  return (
    <RecordEditModal
      label={t("report.modal.issue.title")}
      hint={t("report.modal.issue.hint", { date: isoDateText(locale, row.raisedAt), reporter: row.reporter })}
      submitLabel={t("report.modal.submit")}
      pending={pending}
      canSubmit={canSubmit}
      error={error}
      onClose={onClose}
      onSubmit={handleSubmit}
    >
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "问题描述")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("report.required")}</span>
        </span>
        <GrowingTextarea
          data-record-field="title"
          className={FORM_INPUT + " resize-none leading-6"}
          rows={3}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("report.placeholder.issueTitleEdit")}
        />
      </label>
      <div className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldText(locale, "问题处理人 / 责任人")}</span>
        <div data-record-field="owner">
          <SearchSelect
            value={ownerId}
            items={ownerItems}
            onChange={setOwnerId}
            ariaLabel={t("rp.ownerPickAria")}
            footer={t("report.members.footer", { n: members.length })}
            placeholder={fieldText(locale, "待分派")}
          />
        </div>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "解决方案或建议")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("report.optional.clear")}</span>
        </span>
        <GrowingTextarea
          data-record-field="solution"
          className={FORM_INPUT + " resize-none leading-6"}
          rows={3}
          value={solution}
          onChange={(event) => setSolution(event.target.value)}
          placeholder={t("report.placeholder.issueSuggestionEdit")}
        />
      </label>
      <div className="block">
        <span className="mb-1.5 block text-sm font-medium text-zinc-700">
          {fieldText(locale, "问题附图")}
        </span>
        <AttachmentPicker
          projectId={projectId}
          variant="compact"
          field="issuePhotos"
          size="md"
          items={photos}
          onChange={setPhotos}
          ariaLabel={t("rp.issuePhotosHalfAria")}
        />
      </div>
      {uploadBlocked === "" ? null : <p className="text-xs text-amber-700">{uploadBlocked}</p>}
    </RecordEditModal>
  );
}

/** 自动下扩的多行框（Push 206 续 · 业务口径「换行很多时要自动下扩」）：行数多起来高度随内容长，不出内滚动条；
 *  高度下限 = rows 行（空框不塌），其余 props（data-field / 事件 / 样式）原样透传给原生 textarea。 */
function GrowingTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const value = props.value;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    el.style.height = "auto";
    el.style.height = String(el.scrollHeight + (el.offsetHeight - el.clientHeight)) + "px";
  }, [value]);
  return <textarea {...props} ref={ref} />;
}

/** 关联阶段勾选清单（Push 198 表单侧口径 · 只服务「日报填写」表单 —— 「日报记录」的行内编辑浮层走
 *  九阶段复选行 —— 点一行勾 / 取消勾（**点选不收浮层**，可连着勾几个），值 = 勾选顺序的数组。
 *  dataField = 表单侧的 data-field 钩子（回放探针用）；行内浮层不传（浮层自带 data-inline-popover 钩子）。 */
function StageChecklist({
  values,
  onChange,
  dataField,
  boxClass,
}: {
  values: readonly string[];
  onChange: (next: string[]) => void;
  dataField?: string;
  boxClass: string;
}) {
  const locale = useLocale();
  return (
    <div data-field={dataField} className={boxClass}>
      {REPORT_STAGES.map((stage) => {
        const checked = values.includes(stage);
        return (
          <label key={stage} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-700 transition hover:bg-zinc-50">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? values.filter((name) => name !== stage) : [...values, stage])}
              className="h-3.5 w-3.5 shrink-0 accent-zinc-900"
            />
            <span className="min-w-0 flex-1 truncate">{stageText(locale, stage)}</span>
          </label>
        );
      })}
    </div>
  );
}
/** 「日报填写」表单（字段按 A3-01；校验口径 A3-04：日期 + 当日完成工作 + 明日计划必填）；
 *  自动序号（Push 206 续 / Push 242 修）：「当日完成工作 / 明日计划 / 问题描述 / 解决方案或建议」四个多行框 ——
 *  空框聚焦预置 1: 、回车按光标前**内容行数**续下一行序号、失焦 / 提交前重排；四个多行框均自动下扩。
 *  Push 217（业务口径 2026-09-29「现场工作附图放在明日计划填写下面」）：块序调整 —— 「现场工作附图」移到
 *  「明日计划」正下方。
 *  Push 243（业务口径 2026-10-08）：原「现场发现问题 + 问题归类 + 当前问题附图 + 解决方案或建议」单问题四件套
 *  改为**问题块列表** —— 默认一条，点「添加问题」逐条追加（一天可有多个类型的问题；「新加可以选择 问题处理人 / 责任人」），
 *  提交后逐条生成独立问题记录便于追溯；动过的问题块必须齐「问题描述 + 问题归类」，全空块提交时忽略。 */
function ReportFillForm({
  project,
  author,
  members,
  draft,
  submitting = false,
  onChange,
  onPatchIssue,
  onAddIssue,
  onRemoveIssue,
  onSubmit,
  onSaveDraft,
}: {
  project: Project;
  author: string;
  /** 项目成员（问题处理人 / 责任人下拉的候选；Push 243）。 */
  members: readonly Member[];
  draft: ReportDraft;
  /** 提交 / 暂存请求在飞（Push 216 接真）：两枚按钮转「提交中…」并禁用。 */
  submitting?: boolean;
  onChange: (patch: Partial<ReportDraft>) => void;
  /** 改一条问题块（Push 243）。 */
  onPatchIssue: (index: number, patch: Partial<ReportIssueDraftUi>) => void;
  /** 追加一条空问题块（「添加问题」按钮）。 */
  onAddIssue: () => void;
  /** 删除一条问题块（至少保留一条）。 */
  onRemoveIssue: (index: number) => void;
  onSubmit: () => void;
  onSaveDraft: () => void;
}) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  const t = useT();
  const missing: string[] = [];
  if (draft.dateIso === "") {
    missing.push(t("report.missing.time"));
  }
  if (draft.doneWork.trim() === "") {
    missing.push(t("report.missing.doneWork"));
  }
  if (draft.plan.trim() === "") {
    missing.push(t("report.missing.plan"));
  }
  // 问题块校验（Push 243）：动过的问题块（描述 / 归类 / 处理人 / 附图 / 解决方案任一有内容）必须齐「描述 + 归类」；
  // 全空块 = 没填，提交时忽略（不拦提交）。内容判定先剥行首序号（只剩「1: 」不算填）—— 与自动序号同一口径。
  draft.issues.forEach((item, index) => {
    const title = renumberLines(item.title);
    const touched = title !== "" || item.categories.length > 0 || item.ownerId !== "" || item.suggestion.trim() !== "" || item.photos.length > 0;
    if (!touched) {
      return;
    }
    if (title === "") {
      missing.push(t("report.missing.issueTitle", { n: index + 1 }));
    } else if (item.categories.length === 0) {
      missing.push(t("report.missing.issueCategory", { n: index + 1 }));
    }
  });

  const ownerItems = issueOwnerItems(members, locale);

  /** 回车「自动序号」（Push 206 续 · 业务口径「自动添加序号可以做到吗」；Push 207 同批扩到「解决方案或建议」·「这个也要1 2 3 同上」）：
   *  在光标处续「下一行序号」（2: / 3: …）并补回光标；序号按**光标前的内容行数**编（Push 242 修：原按物理换行数算，
   *  删掉旧序号 / 把框删空后再回车会跳成「2: 」—— 业务反馈「用户删除了再回车就生成2：了 用户觉得这个是bug」）：
   *  ① 光标行已经有内容 → 换行 + 下一序号；② 光标停在还没写内容的行（空框 / 空行 / 只剩一个旧序号）→ 序号**就地落这一行**
   *  （替换行首旧序号、不再多插空行，连按回车也不会 2: / 3: 地空涨）。失焦 / 提交前还会统一 "renumberLines" 重排 ——
   *  中途删改、行序乱掉也能归位。
   *  Push 244（业务口径「1：要作为整体删除」）：退格键落在行首序号里（光标前这段只由序号字符组成）时，**一次删整段**，
   *  不出现「冒号删掉了、1 还在」的半截残留（残留的「1」会被当成内容行，回车续成 2:）。 */
  const numberOnKeyDown = (value: string, applyValue: (next: string) => void) => (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    if (event.key === "Backspace" && target.selectionStart === target.selectionEnd) {
      const caret = target.selectionStart ?? 0;
      const before = value.slice(0, caret);
      const lineStart = before.lastIndexOf("\n") + 1;
      const prefix = before.slice(lineStart);
      if (prefix !== "" && LINE_NUMBER_PREFIX_PART.test(prefix)) {
        event.preventDefault();
        applyValue(value.slice(0, lineStart) + value.slice(caret));
        requestAnimationFrame(() => target.setSelectionRange(lineStart, lineStart));
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    const caret = target.selectionStart === null ? value.length : target.selectionStart;
    const before = value.slice(0, caret);
    const lineStart = before.lastIndexOf("\n") + 1;
    const onEmptyLine = before.slice(lineStart).replace(LINE_NUMBER_HEAD, "").trim() === "";
    const lineNo = contentLineCount(onEmptyLine ? before.slice(0, lineStart) : before) + 1;
    const insert = (onEmptyLine ? "" : "\n") + String(lineNo) + ": ";
    const head = onEmptyLine ? before.slice(0, lineStart) : before;
    applyValue(head + insert + value.slice(caret));
    const nextCaret = head.length + insert.length;
    requestAnimationFrame(() => target.setSelectionRange(nextCaret, nextCaret));
  };

  /** 问题块里的多行框（Push 243）：与「当日完成工作 / 明日计划」同一套自动序号（空框聚焦预置 1: · 回车续号 · 失焦重排）+ 自动下扩。 */
  const numberedTextarea = (value: string, applyValue: (next: string) => void, dataField: string, rows: number, placeholder?: string) => (
    <GrowingTextarea
      data-field={dataField}
      value={value}
      onChange={(event) => { applyValue(event.target.value); }}
      onFocus={(event) => {
        if (value === "") {
          applyValue("1: ");
          const target = event.currentTarget;
          requestAnimationFrame(() => target.setSelectionRange(target.value.length, target.value.length));
        }
      }}
      onBlur={() => {
        const next = renumberLines(value);
        if (next !== value) {
          applyValue(next);
        }
      }}
      onKeyDown={numberOnKeyDown(value, applyValue)}
      rows={rows}
      placeholder={placeholder}
      className={FORM_INPUT + " mt-1 resize-y"}
    />
  );

  return (
    <form
      data-fill-form="true"
      onSubmit={(event) => {
        event.preventDefault();
        if (missing.length === 0) {
          onSubmit();
        }
      }}
      className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className={FORM_LABEL}>{fieldText(locale, "项目名称")}</span>
          <span data-field="projectName" className="mt-1 flex items-center rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 text-sm text-zinc-600">
            {localize(project.description)}{locale === "en" ? " (" + project.code + ")" : "（" + project.code + "）"}
          </span>
        </label>
        <div className="block">
          <span className={FORM_LABEL}>
            {fieldText(locale, "时间")}<span className="ml-1 text-rose-500">*</span>
          </span>
          {/* 时间 = 站内日期选择器（与分类筛选 / 任务编辑同一套 DateRangePicker，单选模式），不用浏览器原生日期控件 */}
          <div data-field="date" className="mt-1">
            <DateRangePicker
              mode="single"
              value={draft.dateIso === "" ? null : { from: draft.dateIso, to: draft.dateIso }}
              onChange={(next) => onChange({ dateIso: next === null ? "" : next.from })}
              hintDate={draft.dateIso}
              placeholder={t("report.placeholder.date")}
              ariaLabel={t("rp.datePickAria")}
              triggerClassName="border-zinc-200 bg-white px-2.5! py-2 text-sm!"
            />
          </div>
        </div>
        <label className="block">
          <span className={FORM_LABEL}>{fieldText(locale, "提交人")}</span>
          <span data-field="author" className="mt-1 flex items-center rounded-lg border border-zinc-100 bg-zinc-50 px-2.5 py-2 text-sm text-zinc-600">{author}</span>
        </label>
        <label className="block">
          <span className={FORM_LABEL}>{fieldText(locale, "今日施工人数")}</span>
          <input
            data-field="headcount"
            type="number"
            min="0"
            value={draft.headcount}
            onChange={(event) => onChange({ headcount: event.target.value })}
            placeholder={t("report.placeholder.headcount")}
            className={FORM_INPUT + " mt-1"}
          />
        </label>
      </div>

      <div>
        <span className={FORM_LABEL}>{fieldText(locale, "关联阶段")}</span>
        <span className="ml-2 text-[11px] text-zinc-400">{t("report.hint.stages")}</span>
        {/* Push 208：清单本体抽成 StageChecklist —— 「日报记录」的行内编辑浮层复用同一份（两处口径永远一致） */}
        <StageChecklist
          values={draft.stages}
          onChange={(next) => onChange({ stages: next })}
          dataField="stages"
          boxClass="mt-1 max-h-44 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1.5"
        />
      </div>

      <label className="block">
        <span className={FORM_LABEL}>
          {fieldText(locale, "当日完成工作Work completed today")}<span className="ml-1 text-rose-500">*</span>
        </span>
        {/* Push 202：表头补英文；占位提示按业务口径「算了 不要提示文字了」不落（无 placeholder）。
            Push 206：按图 4 复落的分点提示随后按业务口径「有了自动的扩展 那这个提示就不要了」撤回 ——
            不落静态提示（自动序号见空框聚焦预置「1: 」+ 回车续号） */}
        <GrowingTextarea
          data-field="doneWork"
          value={draft.doneWork}
          onChange={(event) => onChange({ doneWork: event.target.value })}
          onFocus={(event) => {
            // 自动序号（Push 206 续）：空框聚焦预置「1: 」，用户直接写内容、序号随回车自动排（没写内容失焦后还原为空）
            if (draft.doneWork === "") {
              onChange({ doneWork: "1: " });
              const target = event.currentTarget;
              requestAnimationFrame(() => target.setSelectionRange(target.value.length, target.value.length));
            }
          }}
          onBlur={() => {
            const next = renumberLines(draft.doneWork);
            if (next !== draft.doneWork) {
              onChange({ doneWork: next });
            }
          }}
          onKeyDown={numberOnKeyDown(draft.doneWork, (next) => onChange({ doneWork: next }))}
          rows={3}
          className={FORM_INPUT + " mt-1 resize-y"}
        />
      </label>

      <label className="block">
        {/* Push 202：表头补英文；占位提示按业务口径「算了 不要提示文字了」不落。
            Push 205：业务口径「明日计划也是必填项」—— 补红色必填星（A3-04 必填口径同步修订） */}
        <span className={FORM_LABEL}>
          {fieldText(locale, "明日计划Tomorrow's plan")}<span className="ml-1 text-rose-500">*</span>
        </span>
        <GrowingTextarea
          data-field="plan"
          value={draft.plan}
          onChange={(event) => onChange({ plan: event.target.value })}
          onFocus={(event) => {
            // 自动序号（Push 206 续）：同「当日完成工作」—— 空框聚焦预置「1: 」、回车自动排下一行序号
            if (draft.plan === "") {
              onChange({ plan: "1: " });
              const target = event.currentTarget;
              requestAnimationFrame(() => target.setSelectionRange(target.value.length, target.value.length));
            }
          }}
          onBlur={() => {
            const next = renumberLines(draft.plan);
            if (next !== draft.plan) {
              onChange({ plan: next });
            }
          }}
          onKeyDown={numberOnKeyDown(draft.plan, (next) => onChange({ plan: next }))}
          rows={2}
          className={FORM_INPUT + " mt-1 resize-y"}
        />
      </label>

      {/* Push 217（业务口径 2026-09-29「现场工作附图放在明日计划填写下面」）：整块移到「明日计划」正下方
          （原排「解决方案或建议」之后）；字段集 / 交互不变。 */}
      <div>
        <span className={FORM_LABEL}>{fieldText(locale, "现场工作附图")}</span>
        <div className="mt-1">
          <AttachmentPicker projectId={project.id} field="photos" items={draft.photos} onChange={(items) => onChange({ photos: items })} ariaLabel={t("rp.photosPasteAria")} />
        </div>
      </div>

      {/* Push 243（业务口径 2026-10-08「日报填写问题时新增 添加问题按钮 … 提交后各自独立便于追溯」+「图二这边新加可以选择
          问题处理人 / 责任人」）：原「现场发现问题 + 问题归类 + 当前问题附图 + 解决方案或建议」单问题四件套改为**问题块**列表 ——
          默认一条，点「添加问题」逐条追加（一天可有多个类型的问题）；提交时逐条生成独立问题记录（A3-09 多条口径），空块忽略。 */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className={FORM_LABEL}>{fieldText(locale, "现场发现问题Problem")}</span>
            <span className="ml-2 text-[11px] text-zinc-400">{t("report.hint.issues")}</span>
          </div>
          <button type="button" data-action="add-issue" onClick={onAddIssue} className={BTN_SECONDARY + " !px-2.5 !py-1.5 text-xs"}>
            {t("report.addIssue")}
          </button>
        </div>
        {draft.issues.map((item, index) => (
          <div key={index} data-issue-draft={index} className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-zinc-500">{t("report.issueNo", { n: index + 1 })}</span>
              {draft.issues.length > 1 ? (
                <button
                  type="button"
                  data-action="remove-issue"
                  onClick={() => { onRemoveIssue(index); }}
                  className="rounded-md px-2 py-0.5 text-xs text-zinc-400 transition hover:bg-zinc-200/70 hover:text-zinc-600"
                >
                  {t("common.delete")}
                </button>
              ) : null}
            </div>
            <label className="mt-2 block">
              <span className={FORM_LABEL}>
                {fieldText(locale, "问题描述")}<span className="ml-1 text-rose-500">*</span>
              </span>
              {numberedTextarea(item.title, (next) => { onPatchIssue(index, { title: next }); }, "issueTitle", 2, t("report.placeholder.issueTitle"))}
            </label>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <label className="block">
                <span className={FORM_LABEL}>
                  {fieldText(locale, "问题归类")}<span className="ml-1 text-rose-500">*</span>
                </span>
                <div data-field="issueCategory" className="mt-1">
                  <MultiSelectMenu
                    values={item.categories}
                    options={ISSUE_CATEGORIES}
                    labelOf={(name) => fieldText(locale, name)}
                    onChange={(next) => { onPatchIssue(index, { categories: next }); }}
                    placeholder={t("report.placeholder.issueCategory")}
                    ariaLabel={t("rp.issueCatAria", { n: index + 1 })}
                  />
                </div>
              </label>
              <div className="block">
                <span className={FORM_LABEL}>{fieldText(locale, "问题处理人 / 责任人")}</span>
                <div data-field="issueOwner" className="mt-1">
                  <SearchSelect
                    value={item.ownerId}
                    items={ownerItems}
                    onChange={(value) => { onPatchIssue(index, { ownerId: value }); }}
                    ariaLabel={t("rp.issueOwnerAria", { n: index + 1 })}
                    footer={t("report.members.footer", { n: members.length })}
                    placeholder={fieldText(locale, "待分派")}
                  />
                </div>
              </div>
              <div className="block">
                <span className={FORM_LABEL}>{fieldText(locale, "当前问题附图")}</span>
                <div className="mt-1">
                  <AttachmentPicker
                    projectId={project.id}
                    field="issuePhotos"
                    items={item.photos}
                    onChange={(items) => { onPatchIssue(index, { photos: items }); }}
                    ariaLabel={t("rp.issuePhotosPasteAria", { n: index + 1 })}
                  />
                </div>
              </div>
            </div>
            <label className="mt-3 block">
              <span className={FORM_LABEL}>{fieldText(locale, "解决方案或建议")}</span>
              {numberedTextarea(item.suggestion, (next) => { onPatchIssue(index, { suggestion: next }); }, "issueSuggestion", 2, t("report.placeholder.issueSuggestion"))}
            </label>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-4">
        <button type="submit" data-action="submit" disabled={missing.length > 0 || submitting} className={BTN_PRIMARY}>
          {submitting ? t("report.submitting") : t("report.submit")}
        </button>
        <button type="button" data-action="draft" onClick={onSaveDraft} disabled={draft.dateIso === "" || submitting} className={BTN_SECONDARY}>
          {t("report.saveDraft")}
        </button>
        <span data-fill-hint className={"text-xs " + (missing.length === 0 ? "text-zinc-400" : "text-rose-500")}>
          {missing.length === 0 ? t("report.form.footer") : t("report.form.missing", { list: missing.join(locale === "en" ? ", " : "、") })}
        </span>
      </div>
    </form>
  );
}

/** 「日报及问题」视图：页内四个键帽按钮（日报填写 / 日报记录 / 问题追踪 / 问题看板）+ 对应内容。 */
/** 抽屉关闭动画时长（同「任务详情抽屉」：先播 170ms 退场动画再真正卸载）。 */
const CLOSE_ANIMATION_MS = 170;

/** 问题详情抽屉（Push 209 · 业务口径 2026-09-28「点击要出现抽屉 是关于这个问题的日报内容」）：
 *  卡面只留摘要，点开抽屉看全量 —— 上半 = 问题本身（问题描述 / 问题归类 / 解决方案或建议 / 问题附图），下半 = 来源日报
 *  （当日完成工作 / 日期 / 填写者 / 明日计划 / 现场工作附图 / 问题是否处理 / 施工人数），
 *  中间 = 「关联阶段」一行（Push 212 起常显 —— 业务口径「只保留关联阶段 且不需要隐藏」：原「已隐藏 · 6」折叠区整块撤除，
 *  其余五枚次要字段下架；提出人在抽屉头部、来源日报在页脚本就有）。
 *  壳与交互动效复用「任务详情抽屉」那套（drawer-backdrop / drawer-panel 两枚全局类 + Esc / 点遮罩关闭 + 锁页面滚动）。
 *  Push 212 同批（业务口径「抽屉里面可以编辑内容」）：抽屉内**两块表能编辑的字段这里同样可编辑** —— 问题描述 / 问题归类 /
 *  解决方案或建议（IssuePatch）+ 关联阶段 / 当日完成工作 / 明日计划（ReportPatch）+ 问题是否处理（IssuePatch）；文字列点
 *  「保存」才落值、Esc / 点浮层外 = 取消（与两块表同一套 InlineEdit 口径）；日期 / 填写者 / 施工人数保持只读（「编辑后时间不变」）。
 *  Push 244（业务口径「这个负责人要可以编辑」）：加**问题处理人 / 责任人**行内单选（首行「待分派」= 清空回缺省）。
 *  续（业务口径「图片也要可以增删」）：问题附图 / 现场工作附图接 AttachmentPicker（与「日报填写」同款：点左半 Ctrl+V 粘贴 /
 *  右半选文件 = 增图，胶囊 / 瓦片上的 × = 删图），落值走 patchIssue({ photos }) / patchReport({ photos })。
 *  Push 244（业务口径「修改的选择区域要统一 都和施工人数这个一致」+「关联阶段 明日计划也要同理统一」）：抽屉里**所有可编辑行**
 *  （问题描述 / 问题归类 / 处理人 / 解决方案 / 关联阶段 / 当日完成工作 / 明日计划 / 问题是否处理 / 施工人数）的触发器统一为
 *  「施工人数」同款默认小框 —— 撤裸框 / 贴签样式（白底描边 + 内容宽），点按手感与视觉整抽屉一致。 */
function IssueDrawer({ projectId, members, issue, report, onPatchIssue, onPatchReport, onClose }: {
  projectId: string;
  members: readonly Member[];
  issue: Issue;
  report: DailyReport | null;
  onPatchIssue: (id: string, patch: IssuePatch) => void;
  onPatchReport: (id: string, patch: ReportPatch) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const localize = useLocalizedTranslator();
  const t = useT();
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => lockBodyScroll(), [issue.id]);
  /** 键盘焦点陷阱（Push 264 追订）：抽屉打开时焦点进抽屉、Tab 在抽屉内循环、关闭还原到行内触发按钮。 */
  const drawerTrapRef = useFocusTrap<HTMLElement>();

  const requestClose = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(onClose, CLOSE_ANIMATION_MS);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [requestClose]);
  /** 上半：问题本身（业务样 = 图二前四行；Push 212 同批：前三行接行内编辑 —— 与「问题追踪」表同一套组件与落值口径）。 */
  const rows: { key: string; label: string; value: ReactNode }[] = [
    {
      key: "title",
      label: fieldText(locale, "问题描述"),
      value: (
        <InlineTextCell
          value={issue.title}
          ariaLabel={t("rp.editTitleAria", { date: issue.raisedAt })}
          placeholder={t("report.placeholder.issueTitleSave")}
          display={<span data-issue-title="" title={locale === "en" ? issue.title : undefined} className="block whitespace-pre-line break-words">{localize(issue.title)}</span>}
          onSave={(text) => {
            onPatchIssue(issue.id, { title: renumberLines(text) });
          }}
        />
      ),
    },
    {
      key: "category",
      label: fieldText(locale, "问题归类"),
      value: (
        <InlineMultiOptionCell
          wrapContent
          values={issue.categories}
          options={ISSUE_CATEGORIES}
          ariaLabel={t("rp.catAria", { date: issue.raisedAt })}
          renderLabel={(name) => categoryChip(name, locale)}
          display={<CategoryTags values={issue.categories} />}
          onChange={(values) => {
            onPatchIssue(issue.id, { categories: values });
          }}
        />
      ),
    },
    {
      key: "owner",
      label: fieldText(locale, "问题处理人 / 责任人"),
      // Push 243（业务口径「图三图四增加列 问题处理人 / 责任人」）：生成问题记录时随内联问题清单的处理人落库；
      // 空（旧数据 / 无人）出灰杠（与「施工人数」空态同一枚样式）。
      // Push 244（业务口径「这个负责人要可以编辑」）：改**行内单选**（成员搜索列表 + 首行「待分派」清空），落值走 patchIssue({ ownerId })。
      // Push 244（业务口径「修改的选择区域要统一 都和施工人数这个一致」+「关联阶段 明日计划也要同理统一」）：**不用裸框** ——
      // 与「施工人数」同款 InlineCell 默认小框（白底描边 + 内容宽），抽屉里所有可编辑行的点按手感 / 视觉统一。
      value: (
        <InlineMemberCell
          value={issue.ownerId}
          options={members}
          ariaLabel={t("rp.editOwnerAria", { date: issue.raisedAt })}
          display={
            issue.owner === "" ? (
              <span className="text-zinc-300">—</span>
            ) : (
              <span data-issue-owner="">{issue.owner}</span>
            )
          }
          onPick={(member) => {
            onPatchIssue(issue.id, { ownerId: member.id });
          }}
          onClear={() => {
            onPatchIssue(issue.id, { ownerId: "" });
          }}
        />
      ),
    },
    {
      key: "solution",
      label: fieldText(locale, "解决方案或建议"),
      value: (
        <InlineTextCell
          value={issue.solution}
          ariaLabel={t("rp.editSolutionAria", { date: issue.raisedAt })}
          placeholder={t("report.placeholder.issueSuggestionSave")}
          display={<span data-issue-solution="" title={locale === "en" ? issue.solution : undefined} className="block whitespace-pre-line break-words">{issue.solution === "" ? "—" : localize(issue.solution)}</span>}
          onSave={(text) => {
            onPatchIssue(issue.id, { solution: renumberLines(text) });
          }}
        />
      ),
    },
    {
      key: "issuePhotos",
      label: fieldText(locale, "问题附图"),
      // Push 212 续（业务口径「图片也要可以增删」）：与「日报填写 → 当前问题附图」同一套 AttachmentPicker —— 复制粘贴 / 选文件增图、
      // × 删图（改名随组件口径）；图幅沿用抽屉原样 md。
      value: (
        <AttachmentPicker
          projectId={projectId}
          variant="compact"
          field="issuePhotos"
          size="md"
          confirmRemove
          items={issue.photos}
          onChange={(items) => {
            onPatchIssue(issue.id, { photos: items });
          }}
          ariaLabel={t("rp.issuePhotosPickAria")}
        />
      ),
    },
  ];

  /** 下半：来源日报（问题是否处理 = 问题侧状态、施工人数 = 日报侧人数；业务样 = 图二后七行）。
   *  Push 212 同批：当日完成工作 / 明日计划 / 问题是否处理接行内编辑（与「日报记录」「问题追踪」同一套口径）。 */
  const reportRows: { key: string; label: string; value: ReactNode }[] =
    report === null
      ? [{ key: "report", label: fieldText(locale, "来源日报"), value: <span className="text-zinc-400">{t("report.drawer.reportMissing")}</span> }]
      : [
          {
            key: "doneWork",
            label: fieldText(locale, "当日完成工作"),
            value: (
              <InlineTextCell
                value={report.doneWork}
                ariaLabel={t("rp.editDoneAria", { date: report.date })}
                placeholder={t("report.placeholder.doneWorkSave")}
                display={<span data-report-done="" title={locale === "en" ? report.doneWork : undefined} className="block whitespace-pre-line break-words">{report.doneWork === "" ? "—" : localize(report.doneWork)}</span>}
                onSave={(text) => {
                  onPatchReport(report.id, { doneWork: renumberLines(text) });
                }}
              />
            ),
          },
          { key: "date", label: fieldText(locale, "日期"), value: isoDateText(locale, report.date) },
          {
            key: "author",
            label: fieldText(locale, "填写者"),
            value: (
              <span className="flex items-center gap-1.5">
                <InitialAvatar name={report.author} />
                <span>{report.author}</span>
              </span>
            ),
          },
          {
            key: "plan",
            label: fieldText(locale, "明日计划"),
            value: (
              <InlineTextCell
                value={report.plan}
                ariaLabel={t("rp.editPlanAria", { date: report.date })}
                placeholder={t("report.placeholder.planSave")}
                display={<span data-report-plan="" title={locale === "en" ? report.plan : undefined} className="block whitespace-pre-line break-words">{report.plan === "" ? "—" : localize(report.plan)}</span>}
                onSave={(text) => {
                  onPatchReport(report.id, { plan: renumberLines(text) });
                }}
              />
            ),
          },
          {
            key: "reportPhotos",
            label: fieldText(locale, "现场工作附图"),
            // Push 212 续（业务口径「图片也要可以增删」）：与「日报填写 → 现场工作附图」同一套 AttachmentPicker；图幅沿用抽屉原样 lg。
            value: (
              <AttachmentPicker
                projectId={projectId}
                variant="compact"
                field="photos"
                size="lg"
                confirmRemove
                items={report.photos}
                onChange={(items) => {
                  onPatchReport(report.id, { photos: items });
                }}
                ariaLabel={t("rp.photosPickAria")}
              />
            ),
          },
          {
            key: "state",
            label: fieldText(locale, "问题是否处理"),
            value: (
              <InlineOptionCell
                value={issue.state}
                options={issueStateOptions(locale)}
                ariaLabel={t("rp.stateAria", { date: issue.raisedAt })}
                display={<IssueStateTag state={issue.state} />}
                onPick={(value) => {
                  onPatchIssue(issue.id, { state: value as IssueState });
                }}
              />
            ),
          },
          {
            key: "headcount",
            label: fieldText(locale, "施工人数"),
            // Push 217 续⑤（业务口径「空用杠来表示 和之前项目总览的抽屉一样」）：headcount 是 number | null，
            // 没填（null）时直接 String() 会渲染出字面量「null」；空值改出灰杠 —— 与「项目总览」任务详情抽屉
            // 里同一字段的空态同一个样式（text-zinc-300 的 —）。
            // Push 217 续⑥（业务口径「施工人数抽屉也要可以编辑」）：接行内数字编辑 —— 与「项目总览」任务表 /
            // 任务抽屉同一套口径（InlineNumberCell：点开浮层、0 以上的整数、空 / 0 = 未填出杠、带「人」后缀）；
            // 落值走 PATCH .../reports/{id} 的 headcount（契约 number | null，null = 清空）。
            value: (
              <InlineNumberCell
                value={report.headcount ?? 0}
                ariaLabel={t("rp.editHeadcountAria", { date: report.date })}
                display={report.headcount === null || report.headcount === 0 ? <span className="text-zinc-300">—</span> : report.headcount + (locale === "en" ? "" : " 人")}
                onSave={(value) => {
                  onPatchReport(report.id, { headcount: value === 0 ? null : value });
                }}
              />
            ),
          },
        ];
  /** 中间区：只留「关联阶段」一行、常显（Push 212 · 业务口径「只保留关联阶段 且不需要隐藏」——
   *  原「已隐藏 · N」折叠区与其余五枚次要字段整块撤除）；同批接行内多选（与「日报记录」表同款九阶段清单）。 */
  const stagesRow: { key: string; label: string; value: ReactNode } = {
    key: "stages",
    label: fieldText(locale, "关联阶段"),
    value:
      report === null ? (
        <span className="text-zinc-400">—</span>
      ) : (
        <InlineCell
          ariaLabel={t("rp.stagesAria", { date: report.date })}
          title={t("rp.pickMultiTitle")}
          width={220}
          height={REPORT_STAGES.length * 30 + 12}
          display={<StageTags names={report.stageNames} />}
          render={() => (
            <MultiOptionList
              values={report.stageNames}
              options={REPORT_STAGES}
              ariaLabel={t("rp.stagesAria", { date: report.date })}
              onChange={(next) => {
                onPatchReport(report.id, { stageNames: next });
              }}
              renderLabel={(name) => stageChip(name, locale)}
            />
          )}
        />
      ),
  };

  const rowView = (row: { key: string; label: string; value: ReactNode }) => (
    <div key={row.key} data-issue-field={row.key} className="grid grid-cols-[96px_1fr] items-start gap-x-4 border-b border-zinc-50 py-3 last:border-b-0">
      <dt className="pt-px text-xs leading-5 text-zinc-400">{row.label}</dt>
      <dd className="min-w-0 text-sm leading-5 text-zinc-800">{row.value}</dd>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50">
      <div
        className={"drawer-backdrop absolute inset-0 bg-zinc-900/25" + (closing ? " is-closing" : "")}
        onClick={requestClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerTrapRef}
        data-issue-drawer=""
        role="dialog" data-live-sync-readonly="true"
        aria-modal="true"
        aria-labelledby="issue-drawer-title"
        className={
          "drawer-panel absolute right-0 top-0 flex h-full w-[460px] max-w-[94vw] flex-col bg-white shadow-[-24px_0_60px_rgba(15,23,42,0.18)]" +
          (closing ? " is-closing" : "")
        }
      >        <header className="border-b border-zinc-100 px-6 pb-5 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-medium text-zinc-500">{t("report.drawer.tag")}</span>
              <IssueStateTag state={issue.state} />
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t("rp.drawerCloseAria")}
              className="-mr-1.5 shrink-0 rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <h2 id="issue-drawer-title" title={locale === "en" ? issue.title : undefined} className="mt-3.5 whitespace-pre-line break-words text-lg font-semibold leading-7 text-zinc-900">
            {localize(issue.title)}
          </h2>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{t("report.drawer.raised", { date: isoDateText(locale, issue.raisedAt), reporter: issue.reporter })}</p>
        </header>
        <ScrollArea viewportClassName="min-h-0 flex-1" className="px-6 py-1" ariaLabel={t("rp.drawerFieldsAria")}>
          <dl>{rows.map(rowView)}</dl>
          <dl>{rowView(stagesRow)}</dl>
          <dl>{reportRows.map(rowView)}</dl>
        </ScrollArea>

        <footer className="flex items-center justify-between gap-3 border-t border-zinc-100 px-6 py-3">
          <p className="text-[11px] text-zinc-400">{t("report.drawer.footer", { id: issue.reportId })}</p>
        </footer>
      </aside>
    </div>
  );
}

export function ReportIssuePanel({ project, me, members, tierTint, sub, onChangeSub }: {
  project: Project;
  me: MeResponse;
  /** 项目成员（Push 243：问题处理人 / 责任人下拉的候选）。 */
  members: readonly Member[];
  /** 背景档位铺色档（Push 290 统一口径 · 原醒目模式挂点；Push 293 加炫彩）：ProjectDetail 透传；
   *  medium / vivid = 问题表整行铺行色（浓淡随档）+ 状态列收口。 */
  tierTint?: TintedTier | false;
  /** 当前页内子视图（Push 214 起由地址 `?view=daily&sub=` 派生：form = 日报填写（缺省）/ records / issues / board）。 */
  sub: DailySubView;
  /** 切页内子视图（写回地址 · replace，不新增历史条目）。 */
  onChangeSub: (sub: DailySubView) => void;
}) {
  const locale = useLocale();
  const t = useT();
  /** 当前子视图（地址是唯一来源：slug → 中文标签；不认识的取值已在路由层落回 form）。 */
  const subTab = SUB_TABS.find((tab) => SUB_TAB_KEYS[tab] === sub) ?? "日报记录";
  /** 背景档位铺色档（Push 290 统一口径 · 原「醒目模式」挂点）：投影到本地（缺省 = 不铺色）。 */
  const tierRows: TintedTier | false = tierTint ?? false;
  /** 日报 / 问题（Push 216 接真：来自服务端；项目内成员读写）。 */
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  /** 首屏加载态（loading / ready / error）。 */
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  /** 最新两份数据（写回调里读最新 version，不随渲染闭包过期）。 */
  const reportsRef = useRef(reports);
  reportsRef.current = reports;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  /** 填写草稿（切子视图不丢；「暂存草稿」写库后保留内容，提交后复位）。 */
  const [draft, setDraft] = useState<ReportDraft>(() => emptyDraft());
  /** 当前表单对应的草稿行 id（Push 216：暂存 = 写库 state=draft；提交 = 把这条草稿 PATCH 成已提交；null = 还没暂存过）。 */
  const [draftId, setDraftId] = useState<string | null>(null);
  const draftVersion = useRef<number | null>(null);
  /** 写请求防重入（提交 / 暂存）。 */
  const [saving, setSaving] = useState(false);
  /** 操作提示（提交 / 暂存 / 删除 / 失败）。 */
  const [notice, setNotice] = useState<string>("");
  /** 删除二次确认（Push 218 业务口径「删除要二次提示」）：行尾红胶囊的第一下只把待删项挂到底部确认条
   *  （与首页「删除项目」/ 模板面板同款非阻断浮条），第二下「删除」才真删 —— 成对删除的连带范围写进文案。 */
  const [pendingDelete, setPendingDelete] = useState<{ kind: "report"; report: DailyReport } | { kind: "issue"; issue: Issue } | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内、Tab 在条内循环、关闭还原到行尾删除按钮。 */
  const deleteConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDelete !== null);
  /** 问题详情抽屉（Push 209 · 业务口径「点击要出现抽屉 是关于这个问题的日报内容」）：存打开的问题 id，
   *  渲染时现找问题与来源日报 —— 行内编辑改过之后抽屉里也始终是最新值。 */
  const [openIssueId, setOpenIssueId] = useState<string | null>(null);
  /** 页内搜索（业务口径 2026-09-30「给日报记录 / 问题追踪增加搜索功能，搜索的组件和项目空间右上角的相同」）：
   *  两枚关键词各管一张表（客户端过滤 —— 列表一次取满 limit 200，无需回服务端）；换项目随组件 key 复位。 */
  const [recordKeyword, setRecordKeyword] = useState("");
  const [issueKeyword, setIssueKeyword] = useState("");

  /** 编辑弹窗（Push 223 · 业务口径「这个编辑也要和干系人同款」）：存打开行的 id —— 渲染时现找该行
   *  （行内下拉改过之后，弹窗里也始终是最新值）；编辑只走行尾「编辑」按钮，点行体不进入编辑。 */
  const [editModal, setEditModal] = useState<{ kind: "report"; id: string } | { kind: "issue"; id: string } | null>(null);

  /** 拉取两份列表（首屏 / 写失败后重取）。 */
  const reload = useCallback(async () => {
    try {
      const [nextReports, nextIssues] = await Promise.all([fetchProjectReports(project.id), fetchProjectIssues(project.id)]);
      setReports(nextReports);
      setIssues(nextIssues);
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setNotice(friendlyError(error, t("report.error.load")));
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefresh(["reports", "issues", "files", "permissions", "users"], async () => {
    const [nextReports, nextIssues] = await Promise.all([fetchProjectReports(project.id), fetchProjectIssues(project.id)]);
    return () => {
      setReports((previous) => keepLiveOrder(previous, nextReports));
      setIssues((previous) => keepLiveOrder(previous, nextIssues));
    };
  }, project.id, loadState === "ready");
  /** 手打内容提前后台机翻（业务口径 2026-10-13「因为页面有些内容是手打的 我建议是提前后台机翻」）：
   *  日报与问题数据一到，就把「当日完成工作 / 明日计划 / 问题描述 / 解决方案或建议」静默丢进预热队列 ——
   *  英文界面下这些列命中会话缓存直接出译文（见 translateApi.ts），不用现场等机器翻译。 */
  useEffect(() => {
    prefetchZhToEn([
      ...reports.map((report) => report.doneWork),
      ...reports.map((report) => report.plan),
      ...issues.map((issue) => issue.title),
      ...issues.map((issue) => issue.solution),
    ]);
  }, [reports, issues]);

  /** 行内编辑落值（Push 216 接真）：先本地乐观更新，PATCH 回包替换该行；失败提示并重取（409 乐观锁冲突同路）。
   *  日期 / 提交时间一律不碰（「编辑后时间不变」）；文字列在保存时统一过一遍自动序号（与「日报填写」提交口径一致）；
   *  「当日完成工作」是契约必填，清空会被服务端拒绝 —— 前端先拦。 */
  const patchReport = (id: string, patch: ReportPatch) => {
    if (patch.doneWork !== undefined && patch.doneWork === "") {
      setNotice(t("report.notice.doneRequired"));
      return;
    }
    const current = reportsRef.current.find((item) => item.id === id);
    if (current === undefined) {
      return;
    }
    setReports((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    void updateReport(project.id, id, reportUpdateBody(current, patch))
      .then((updated) => {
        setReports((previous) => previous.map((item) => (item.id === id ? updated : item)));
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.reportSave")));
        void reload();
      });
  };

  /** 问题行内编辑落值（Push 216 接真）：同日报一套 —— 乐观更新 + PATCH 回包替换；提出日期不动。 */
  const patchIssue = (id: string, patch: IssuePatch) => {
    if (patch.title !== undefined && patch.title === "") {
      setNotice(t("report.notice.titleRequired"));
      return;
    }
    if (patch.categories !== undefined && patch.categories.length === 0) {
      setNotice(t("report.notice.categoryRequired"));
      return;
    }
    const current = issuesRef.current.find((item) => item.id === id);
    if (current === undefined) {
      return;
    }
    setIssues((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    void updateIssue(project.id, id, issueUpdateBody(current, patch))
      .then((updated) => {
        setIssues((previous) => previous.map((item) => (item.id === id ? updated : item)));
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.issueSave")));
        void reload();
      });
  };


  /** 日报编辑弹窗落值（Push 223）：与行内编辑同一套（乐观更新 + PATCH 回包替换该行）；
   *  区别是**把失败文案还给弹窗**（窗口保持打开、不关）—— 失败同时重取，409 乐观锁冲突同路。 */
  const submitReportEdit = async (row: DailyReport, patch: ReportPatch): Promise<string | null> => {
    if (Object.keys(patch).length === 0) {
      setEditModal(null);
      return null;
    }
    setReports((previous) => previous.map((item) => (item.id === row.id ? { ...item, ...patch } : item)));
    try {
      const updated = await updateReport(project.id, row.id, reportUpdateBody(row, patch));
      setReports((previous) => previous.map((item) => (item.id === row.id ? updated : item)));
      setEditModal(null);
      return null;
    } catch (error) {
      void reload();
      return friendlyError(error, t("report.error.reportSave"));
    }
  };


  /** 问题编辑弹窗落值（Push 223）：同日报一套（同样把失败文案还给弹窗）。 */
  const submitIssueEdit = async (row: Issue, patch: IssuePatch): Promise<string | null> => {
    if (Object.keys(patch).length === 0) {
      setEditModal(null);
      return null;
    }
    setIssues((previous) => previous.map((item) => (item.id === row.id ? { ...item, ...patch } : item)));
    try {
      const updated = await updateIssue(project.id, row.id, issueUpdateBody(row, patch));
      setIssues((previous) => previous.map((item) => (item.id === row.id ? updated : item)));
      setEditModal(null);
      return null;
    } catch (error) {
      void reload();
      return friendlyError(error, t("report.error.issueSave"));
    }
  };

  /** 删除日报（Push 216 接真）：服务端成对删除（连带派生问题）—— 本地按来源关系清两表、关掉被删的抽屉 / 表单草稿。 */
  const deleteReportUnit = (reportId: string) => {
    void deleteReport(project.id, reportId)
      .then(() => {
        setReports((previous) => previous.filter((item) => item.id !== reportId));
        setIssues((previous) => previous.filter((item) => item.reportId !== reportId));
        setOpenIssueId((current) => {
          if (current === null) {
            return current;
          }
          const open = issuesRef.current.find((item) => item.id === current);
          return open !== undefined && open.reportId === reportId ? null : current;
        });
        // Keep the deleted draft identity so a later save cannot silently recreate it.
        setNotice(t("report.notice.reportDeleted"));
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.reportDelete")));
        void reload();
      });
  };

  /** 问题侧删除（Push 216 接真）：服务端成对删除 —— 有来源日报连那篇日报整组删；无来源日报只摘这一条。 */
  const deleteIssueUnit = (issue: Issue) => {
    void deleteIssue(project.id, issue.id)
      .then((result) => {
        setIssues((previous) =>
          previous.filter((item) => item.id !== issue.id && (issue.reportId === "" || item.reportId !== issue.reportId)),
        );
        if (result.cascadedReportId !== null) {
          const cascaded = result.cascadedReportId;
          setReports((previous) => previous.filter((item) => item.id !== cascaded));
          // Keep the deleted draft identity and its text until the user starts a new report.
        }
        setOpenIssueId((current) => (current === issue.id ? null : current));
        setNotice(result.cascadedReportId === null ? t("report.notice.issueDeleted") : t("report.notice.issueDeletedWithReport"));
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.issueDelete")));
        void reload();
      });
  };

  /** 行尾删除的第一下（日报记录表）：只记下待删日报 —— 派生问题的连带删除语义见 deleteReportUnit。 */
  const requestDeleteReport = (reportId: string) => {
    const report = reportsRef.current.find((item) => item.id === reportId);
    if (report !== undefined) {
      setPendingDelete({ kind: "report", report });
    }
  };

  /** 行尾删除的第一下（问题追踪表）：只记下待删问题 —— 来源日报的连带删除语义见 deleteIssueUnit。 */
  const requestDeleteIssue = (issue: Issue) => {
    setPendingDelete({ kind: "issue", issue });
  };

  /** 底部确认条的第二下：先收浮条、再按待删项派发真删（成对删除都在上面两个 delete*Unit 里落库）。 */
  const confirmPendingDelete = () => {
    const pending = pendingDelete;
    if (pending === null) {
      return;
    }
    setPendingDelete(null);
    if (pending.kind === "report") {
      deleteReportUnit(pending.report.id);
    } else {
      deleteIssueUnit(pending.issue);
    }
  };


  /** 抽屉要展示的问题 / 它的来源日报（现找现用）。 */
  const openIssue = openIssueId === null ? null : issues.find((item) => item.id === openIssueId) ?? null;
  const openIssueReport = openIssue === null ? null : reports.find((item) => item.id === openIssue.reportId) ?? null;



  /** 编辑弹窗要编辑的行（现找现用；行不存在 = 不开窗）。 */
  const editingReport = editModal !== null && editModal.kind === "report" ? reports.find((item) => item.id === editModal.id) ?? null : null;
  const editingIssue = editModal !== null && editModal.kind === "issue" ? issues.find((item) => item.id === editModal.id) ?? null : null;

  const author = me.user.displayName ?? me.user.name ?? t("header.unnamed");

  /** 问题块增删改（Push 243）：默认保留一条；只剩一条时不允许删除（清内容即可）。 */
  const patchDraftIssue = (index: number, patch: Partial<ReportIssueDraftUi>) => {
    setDraft((previous) => ({
      ...previous,
      issues: previous.issues.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    }));
  };
  const addDraftIssue = () => {
    setDraft((previous) => ({ ...previous, issues: [...previous.issues, emptyIssueDraft()] }));
  };
  const removeDraftIssue = (index: number) => {
    setDraft((previous) =>
      previous.issues.length <= 1 ? previous : { ...previous, issues: previous.issues.filter((_, at) => at !== index) },
    );
  };

  /** 表单 → 契约日报写体（state 由调用方给；空值口径：plan 空串清空 → null）。
   *  Push 243：问题走**内联问题清单** issues（逐条生成独立问题；空块已忽略）；旧单问题字段显式清空（null —— PATCH 语义；
   *  新建路径由 createBody() 摘掉 null）。 */
  const draftWriteBody = (state: "draft" | "submitted"): ReportWriteInput => {
    const headcount = Number.parseInt(draft.headcount, 10);
    const plan = renumberLines(draft.plan);
    const issues = draft.issues
      .map((item) => ({
        title: renumberLines(item.title),
        categories: item.categories,
        ownerId: item.ownerId === "" ? null : item.ownerId,
        solution: renumberLines(item.suggestion),
        photoFileIds: readyFileIds(item.photos),
      }))
      .filter((item) => item.title !== "")
      .map((item) => {
        const next: ReportIssueWriteDraft = { title: item.title, categories: item.categories, ownerId: item.ownerId };
        if (item.solution !== "") {
          next.solution = item.solution;
        }
        if (item.photoFileIds.length > 0) {
          next.photoFileIds = item.photoFileIds;
        }
        return next;
      });
    return {
      date: draft.dateIso,
      state,
      headcount: Number.isFinite(headcount) ? headcount : null,
      doneWork: renumberLines(draft.doneWork),
      plan: plan === "" ? null : plan,
      foundIssue: null,
      issueCategories: null,
      suggestion: null,
      issues,
      stageKeys: draft.stages.map(stageKeyOfName).filter((key): key is string => key !== null),
      photoFileIds: readyFileIds(draft.photos),
      issuePhotoFileIds: [],
    };
  };

  /** 提交（已提交）：写库（有本表单草稿 = PATCH 把草稿提交，否则新建）→ 服务端按 A3-09 自动生成问题（幂等）；
   *  成功后重取两表、表单复位并切「日报记录」。 */
  const handleSubmit = () => {
    if (saving) {
      return;
    }
    const blocking = uploadBlockingMessage(draft, locale);
    if (blocking !== "") {
      setNotice(blocking);
      return;
    }
    const body = draftWriteBody("submitted");
    if (draftId !== null && (!reportsRef.current.some((item) => item.id === draftId) || draftVersion.current === null)) {
      setNotice(t("rp.draftGone"));
      return;
    }
    const draftRow = draftId === null ? null : reportsRef.current.find((item) => item.id === draftId) ?? null;
    const dateText = isoDateText(locale, draft.dateIso);
    const issueCount = body.issues?.length ?? 0;
    setSaving(true);
    const write =
      draftRow === null
        ? createReport(project.id, createBody(body))
        : updateReport(project.id, draftRow.id, { ...withoutDate(body), version: draftVersion.current ?? draftRow.version });
    write
      .then(() => {
        setDraft(emptyDraft());
        setDraftId(null);
        draftVersion.current = null;
        setNotice(
          t("report.notice.submitted", { date: dateText }) +
            (issueCount > 0 ? t("report.notice.submittedIssues", { n: issueCount }) : t("report.notice.submittedEnd")),
        );
        onChangeSub("records");
        return reload();
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.submit")));
        void reload();
      })
      .finally(() => {
        setSaving(false);
      });
  };

  /** 暂存草稿（Push 216 接真 · 业务口径「接真后草稿到底写不写库 写」）：写库 state=draft（同日多条不设限；
   *  已有本表单草稿 = 更新那一条）；契约「当日完成工作」必填 —— 暂存同样先填，否则服务端 400。 */
  const handleSaveDraft = () => {
    if (saving) {
      return;
    }
    if (renumberLines(draft.doneWork) === "") {
      setNotice(t("report.notice.draftNeedsDone"));
      return;
    }
    const blocking = uploadBlockingMessage(draft, locale);
    if (blocking !== "") {
      setNotice(blocking);
      return;
    }
    const body = draftWriteBody("draft");
    if (draftId !== null && (!reportsRef.current.some((item) => item.id === draftId) || draftVersion.current === null)) {
      setNotice(t("rp.draftGone"));
      return;
    }
    const draftRow = draftId === null ? null : reportsRef.current.find((item) => item.id === draftId) ?? null;
    setSaving(true);
    const write =
      draftRow === null
        ? createReport(project.id, createBody(body))
        : updateReport(project.id, draftRow.id, { ...withoutDate(body), version: draftVersion.current ?? draftRow.version });
    write
      .then((saved) => {
        draftVersion.current = saved.version;
        if (draftRow === null) {
          setDraftId(saved.id);
        }
        setNotice(t("report.notice.draftSaved"));
        return reload();
      })
      .catch((error) => {
        setNotice(friendlyError(error, t("report.error.draft")));
        void reload();
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const remoteDraft = draftId === null ? null : reports.find((item) => item.id === draftId) ?? null;
  const draftChanged = draftId !== null && (remoteDraft === null || remoteDraft.version !== draftVersion.current);

  /** 搜索命中（与项目空间同口径：不区分大小写的子串匹配；空关键词 = 全部命中）。 */
  const searchHit = (keyword: string, fields: readonly (string | number)[]): boolean => {
    const needle = keyword.trim().toLowerCase();
    return needle === "" || fields.some((field) => String(field).toLowerCase().includes(needle));
  };

  /** 「日报记录」过滤：覆盖表里可见的文字列（时间 / 填写者 / 关联阶段 / 当日完成工作 / 明日计划）。 */
  const visibleReports = reports.filter((report) =>
    searchHit(recordKeyword, [report.date, report.author, report.stageNames.join("、"), report.doneWork, report.plan]),
  );

  /** 「问题追踪」过滤：覆盖表里可见的文字列（日期 / 问题描述（含并入的提出人）/ 问题归类 / 解决方案或建议 / 问题是否处理）。 */
  const visibleIssues = issues.filter((issue) =>
    searchHit(issueKeyword, [issue.raisedAt, issue.reporter, issue.title, issue.categories.join("、"), issue.owner, issue.solution, statusText(locale, ISSUE_STATE_NAMES[issue.state])]),
  );


  return (
    // 列宽（业务口径「我只要日报填写页面居中然后尺寸舒适一点、像一个表单，其它的不变还是全屏」）：
    // 整块视图**全宽**（不封顶、不居中）—— 日报记录 / 问题追踪 / 问题看板 照旧铺满；
    // 只有「日报填写」那一块在下面单独收成居中窄栏。
    <div className="w-full space-y-5">

      {notice === "" ? null : (
        <p data-subnav-notice className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-800">
          {notice}
        </p>
      )}

      {subTab === "日报填写" ? (
        /* 日报填写 = 居中窄栏（max-w-3xl = 768px，像一张表单）；其余三块子视图仍是全宽 */
        <div className="mx-auto w-full max-w-3xl">
          <ReportFillForm
            project={project}
            author={author}
            members={members}
            draft={draft}
            submitting={saving}
            onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
            onPatchIssue={patchDraftIssue}
            onAddIssue={addDraftIssue}
            onRemoveIssue={removeDraftIssue}
            onSubmit={handleSubmit}
            onSaveDraft={handleSaveDraft}
          />
          {draftChanged ? (
            <div data-report-draft-conflict="" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
              <p>{remoteDraft === null ? t("rp.draftRemoteGone") : t("rp.draftRemoteChanged")}</p>
              {remoteDraft === null ? <button type="button" className="mt-2 underline" onClick={() => { setDraftId(null); draftVersion.current = null; }}>{t("rp.draftKeep")}</button> : (
                <details className="mt-2"><summary>{t("rp.draftReview")}</summary><p className="whitespace-pre-wrap py-2">{remoteDraft.doneWork + "\n" + t("rp.planInline") + remoteDraft.plan}</p><button type="button" className="underline" onClick={() => { draftVersion.current = remoteDraft.version; setNotice(t("rp.draftConfirm")); }}>{t("rp.draftConfirmBtn")}</button></details>
              )}
            </div>
          ) : null}
        </div>
      ) : loadState === "loading" ? (
        /* Push 216 接真：三个列表子视图共用同一份首屏加载态 */
        <EmptyCard text={t("common.loading")} hint={t("report.loading.hint")} />
      ) : loadState === "error" ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-white/50 px-6 py-12 text-center">
          <p className="text-sm text-zinc-500">{t("report.error.load")}</p>
          <button
            type="button"
            onClick={() => {
              setNotice("");
              void reload();
            }}
            className={BTN_SECONDARY}
          >
            {t("common.reload")}
          </button>
        </div>
      ) : subTab === "日报记录" ? (
        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SectionHeader
              title={t("report.records.title")}
              hint={
                recordKeyword.trim() === ""
                  ? t("report.records.hint", { n: reports.length })
                  : t("report.records.hintFound", { found: visibleReports.length, total: reports.length })
              }
            />
            <div data-report-search="" className="w-full sm:ml-auto sm:w-72">
              <SearchInput value={recordKeyword} onChange={setRecordKeyword} placeholder={t("report.records.search")} className="w-full" />
            </div>
          </div>
          {reports.length === 0 ? (
            <EmptyCard text={t("report.records.empty")} hint={t("report.records.emptyHint")} />
          ) : visibleReports.length === 0 ? (
            <EmptyCard text={t("report.records.emptyMatch", { kw: recordKeyword.trim() })} hint={t("report.emptyHint")} />
          ) : (
            <ReportList reports={visibleReports} onEdit={(report) => { setEditModal({ kind: "report", id: report.id }); }} onPatch={patchReport} onDelete={requestDeleteReport} />
          )}
        </section>
      ) : subTab === "问题追踪" ? (
        <section className="space-y-3">
          {/* Push 290 起原「醒目模式」开关已随功能下架：观感统一由顶栏「背景 · 档位」驱动，本视图不再有独立开关。 */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SectionHeader
              title={t("report.issues.title")}
              hint={
                issueKeyword.trim() === ""
                  ? t("report.issues.hint", { n: issues.length })
                  : t("report.issues.hintFound", { found: visibleIssues.length, total: issues.length })
              }
            />
            <div data-issue-search="" className="w-full sm:ml-auto sm:w-72">
              <SearchInput value={issueKeyword} onChange={setIssueKeyword} placeholder={t("report.issues.search")} className="w-full" />
            </div>
          </div>
          {issues.length === 0 ? (
            <EmptyCard text={t("report.issues.empty")} hint={t("report.issues.emptyHint")} />
          ) : visibleIssues.length === 0 ? (
            <EmptyCard text={t("report.issues.emptyMatch", { kw: issueKeyword.trim() })} hint={t("report.emptyHint")} />
          ) : (
            <IssueTable issues={visibleIssues} tierTint={tierRows} onEdit={(issue) => { setEditModal({ kind: "issue", id: issue.id }); }} onPatch={patchIssue} onDelete={requestDeleteIssue} />
          )}
        </section>
      ) : (
        <section className="space-y-3">
          <SectionHeader title={t("report.board.title")} hint={t("report.board.hint")} />
          {issues.length === 0 ? (
            <EmptyCard text={t("report.issues.empty")} hint={t("report.issues.emptyHint")} />
          ) : (
            <IssueBoard issues={issues} onPatch={patchIssue} onOpen={(id) => { setOpenIssueId(id); }} />
          )}
        </section>
      )}

      {/* 问题详情抽屉（Push 209）：点看板卡片打开，Esc / 点遮罩关闭 */}
      {openIssue === null ? null : <IssueDrawer projectId={project.id} members={members} issue={openIssue} report={openIssueReport} onPatchIssue={patchIssue} onPatchReport={patchReport} onClose={() => { setOpenIssueId(null); }} />}

      {/* 行编辑弹窗（Push 223）：日报 / 问题各一枚 —— 与「干系人」弹窗同款；取消 / Esc / 点遮罩关闭，保存成功才关 */}
      {editingReport === null ? null : (
        <ReportEditModal
          projectId={project.id}
          row={editingReport}
          onClose={() => { setEditModal(null); }}
          onSubmit={(patch) => submitReportEdit(editingReport, patch)}
        />
      )}
      {editingIssue === null ? null : (
        <IssueEditModal
          projectId={project.id}
          members={members}
          row={editingIssue}
          onClose={() => { setEditModal(null); }}
          onSubmit={(patch) => submitIssueEdit(editingIssue, patch)}
        />
      )}

      {/* 删除二次确认条（Push 218 业务口径「删除要二次提示」）：与首页「删除项目」/ 模板面板同款固定底栏 ——
          非阻断（第一下只是开口，不锁页面），第二下「删除」才真删；文案把成对删除的连带范围写清。 */}
      {pendingDelete === null ? null : (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
          <div
            ref={deleteConfirmTrapRef}
            role="dialog"
            aria-label={pendingDelete.kind === "report" ? t("report.delete.ariaReport") : t("report.delete.ariaIssue")}
            data-delete-confirm-strip=""
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
          >
            <span>
              {pendingDelete.kind === "report"
                ? t("report.delete.report", { date: isoDateText(locale, pendingDelete.report.date) })
                : pendingDelete.issue.reportId === ""
                  ? t("report.delete.issueAlone", { date: isoDateText(locale, pendingDelete.issue.raisedAt) })
                  : t("report.delete.issueWithReport", { date: isoDateText(locale, pendingDelete.issue.raisedAt) })}
            </span>
            <button
              type="button"
              onClick={() => {
                setPendingDelete(null);
              }}
              className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-delete-confirm=""
              onClick={confirmPendingDelete}
              className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95"
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
