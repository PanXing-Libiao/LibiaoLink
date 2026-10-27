import type { CSSProperties, ReactNode } from "react";
import { useLocalizedText, useT } from "../i18n";
import { RowDeleteButton } from "./RowDeleteButton";

/**
 * 项目卡片（首页）：主题色由字典 projectType 条目的 metadata.accent / accentText 下发（M2-07 · A3），
 * 前端不再硬编码「类型 → 颜色」映射；缺省色在 dicts.ts 的 typeAccent 里兜底。
 * 底部动作条（Push 172）：编辑与删除都是**隐式**的 —— 静止不显示，鼠标悬停卡片 / 键盘聚焦才浮现；
 * 删除 = 任务表行内同款（RowDeleteButton，红底胶囊），排在编辑右侧，占固定 48px 槽位、展开不挤动右侧时间。
 * 背景档位（Push 289 · 同日「用 c 试试」；Push 293 加炫彩）：tint 传值 = 该色铺满整卡（适中 = 「我的任务」便签同款淡彩；炫彩 = 同色相高饱和浓彩），
 * 可配 tintBorder 同款细描边（1px）；都不传 = 白底观感（简约口径）。
 * 档位切换口径（Push 289 追订「简约和适中的切换 卡片会出现几秒的边框加深」）：过渡只留 transform / box-shadow ——
 * 原来 transition-all 会把「新出现的边框」从 currentColor（近黑）渐变到淡彩描边，切换瞬间就是一帧深色描边；
 * 顺带免掉整卡底色逐帧重绘（几十张卡一起切换时不再卡顿）。底色 / 描边切换 = 瞬时。
 * 右下角国家名水印（Push 289 追订「像大牌广告」；Push 301 追订「中文模式和英文模式水印不一样」「之前的中文不要改」「缩写不好看 试试全称吧」—— 文字按界面语言分流：中文 = 地区中文名、英文 = 英文全称）：124px 特粗、灰黑 6%，垫在内容之下（-z-10 + 卡片 isolate）。
 * 两种排版（watermarkBleed，默认 true = Push 289 出血口径逐字不变）：出血口径 = 右 20px / 下 46px（右侧与底部各裁一截）+ max-w = 卡片内宽 − 8px（起点锚左内边距线 28px，超长从尾部裁、前字完整）；完整口径（false · 英文侧）= 右内缩 28px + 贴底 + max-w = 卡片内宽 − 56px —— 字形全高完整显示，超长名从尾部裁、起点仍锚左内边距线。
 */

/** 半透明投影色（悬停光晕用）：十六进制色 → rgba；其它写法（rgb / 变量）原样返回。 */
function glowOf(color: string): string {
  const hex = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + String(r) + ", " + String(g) + ", " + String(b) + ", 0.35)";
  }
  return hex;
}

type CardProps = {
  seqNo: number;
  code: string;
  description: string;
  /** 项目类型展示名（字典 name；未知码回落码本身）。 */
  typeLabel: string;
  /** 项目状态取值（契约 projects.status —— 回放钩子 data-card-status）。 */
  status: string;
  /** 项目状态展示文案（Push 262：跟在分类徽标右侧的淡灰字）。 */
  statusText: string;
  /** 主题色（字典 metadata.accent）。 */
  accentColor?: string;
  /** 徽标文字色（字典 metadata.accentText；浅色底用深灰）。 */
  accentText?: string;
  icon?: ReactNode;
  /** 适中档（背景档位）卡片底色：传值 = 该色铺满整卡；不传 = 白底观感。 */
  tint?: string;
  /** 铺色档卡片同色系细描边（与 tint 配套；不传 = 不加边）。 */
  tintBorder?: string;
  /** 炫彩档文字加深（Push 293 追订「炫彩模式文字不明显 看不出来」）：彩底上把卡片次要灰字提深一档（.tint-vivid 作用域）。 */
  vividInk?: boolean;
  /** 右下角大号淡化水印（Push 289 追订 + Push 301 追订按语言分流）：中文界面 = 地区中文名、英文界面 = 英文全称（完整显示）；124px 特粗、灰黑 6%；不传 / 空串 = 不渲染。 */
  watermark?: string;
  /** 水印排版口径（Push 301 追订「之前的中文不要改」）：true / 不传 = Push 289 原出血口径（右 20px / 下 46px，右侧与底部各裁一截；max-w = 卡片内宽 − 8px）；false = 完整显示口径（右内缩 28px + 贴底；max-w = 卡片内宽 − 56px，字形全高不裁）。 */
  watermarkBleed?: boolean;
  /** 项目经理展示文本（多位时按「、」连接；Push 136）。 */
  managerNames: string;
  time: string;
  /** 编辑入口（隐式：悬停 / 聚焦才显示）。 */
  onEdit?: () => void;
  /** 恢复项目（项目回收站：占用原编辑按钮位；与 onEdit 互斥，优先渲染）。 */
  onRestore?: () => void;
  /** 导出项目全部数据（project.export；隐式：位于编辑与删除之间；不传 = 不渲染）。 */
  onExport?: () => void;
  /** 当前项目正在导出：按钮保持可见并显示忙碌态，防止重复点击。 */
  exporting?: boolean;
  /** 打开项目总结（业务项目复盘；读取脚本事实包与可编辑叙述）。 */
  onSummary?: () => void;
  /** 移入项目回收站（首页卡片；隐式：与编辑同款；不传 = 不渲染）。 */
  onDelete?: () => void;
  /** 彻底删除项目（项目回收站：占用原删除按钮位；与 onDelete 互斥，优先渲染）。 */
  onPurge?: () => void;
  restoreLabel?: string;
  purgeLabel?: string;
};

export function Card({
  seqNo,
  code,
  description,
  typeLabel,
  status,
  statusText,
  accentColor = "#feca04",
  accentText = "#313033",
  icon,
  tint,
  tintBorder,
  vividInk,
  watermark,
  watermarkBleed,
  managerNames,
  time,
  onEdit,
  onRestore,
  onExport,
  exporting = false,
  onSummary,
  onDelete,
  onPurge,
  restoreLabel,
  purgeLabel,
}: CardProps) {
  const t = useT();
  /** 手打内容（项目名）机翻显示：英文界面显示译文（到位后自动切换），悬停看原文。 */
  const localizedDescription = useLocalizedText(description);
  /** 序号文案：不足两位补零（7 → "07"）；**三位数之后不再有位置问题** —— 数字锚在圆点右内侧（right-6，不再用 left-6），
   *  卡片是 overflow:hidden，用 left-6 摆时三位数的末位会越过卡片右缘被裁掉（Push 188 十追订「这个编号bug」）。 */
  const seqNoText = String(seqNo).padStart(2, "0");
  const style = {
    "--card-glow": glowOf(accentColor),
    ...(tint === undefined ? null : { backgroundColor: tint }),
    ...(tintBorder === undefined ? null : { border: "1px solid " + tintBorder }),
  } as CSSProperties;
  return (
    <div
      style={style}
      className={
        "project-card group w-full shadow-[0px_0px_15px_rgba(0,0,0,0.09)] p-7 space-y-3 relative overflow-hidden transition-[transform,box-shadow] duration-300 hover:scale-[1.02] isolate" +
        (tint === undefined ? " bg-white" : "") +
        (vividInk === true ? " tint-vivid" : "")
      }
    >
      {watermark === undefined || watermark === "" ? null : (
        <span
          aria-hidden="true"
          data-card-watermark="true"
          className={
            "pointer-events-none absolute -z-10 select-none whitespace-nowrap text-[124px] font-black leading-none tracking-tighter text-zinc-900/[0.06]" +
            (watermarkBleed === false
              ? " bottom-0 right-7 max-w-[calc(100%-56px)]"
              : " -bottom-[46px] -right-5 max-w-[calc(100%-8px)]")
          }
        >
          {watermark}
        </span>
      )}
      <span className="absolute top-0 left-0 flex items-center whitespace-nowrap">
        <span
          style={{ backgroundColor: accentColor, color: accentText }}
          className="rounded-br-xl px-3 py-1 text-[11px] font-semibold tracking-wide"
        >
          {typeLabel}
        </span>
        <span data-card-status={status} className="pl-2 text-[11px] text-zinc-400">
          {statusText}
        </span>
      </span>
      <div className="w-20 h-20 rounded-full absolute -right-5 -top-7 bg-zinc-100">
        <p className="absolute bottom-5 right-6 whitespace-nowrap text-2xl font-medium text-zinc-500" title={t("card.seqNo") + " " + seqNoText}>{seqNoText}</p>
      </div>
      <div className="flex w-full items-center gap-3">
        {icon ?? <span style={{ backgroundColor: accentColor }} className="car-icon block h-9 w-12 shrink-0" />}
        <p className="min-w-0 truncate text-sm text-zinc-400">
          {t("card.manager")}<span className="font-medium text-zinc-600" title={managerNames}>{managerNames}</span>
        </p>
      </div>
      <h1 className="font-mono text-xl font-bold tracking-tight">{code}</h1>
      <p className="text-lg text-zinc-500 leading-7" title={localizedDescription === description ? undefined : description}>{localizedDescription}</p>
      <div className="flex items-center gap-3">
        {onRestore !== undefined || onEdit !== undefined ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (onRestore !== undefined) onRestore();
              else onEdit?.();
            }}
            aria-label={onRestore === undefined ? t("card.edit") : restoreLabel ?? t("lib.restore")}
            title={onRestore === undefined ? t("card.edit") : restoreLabel ?? t("lib.restore")}
            className="relative z-10 -ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400/70 opacity-0 transition duration-200 group-hover:text-zinc-400 group-hover:opacity-100 hover:bg-white hover:text-zinc-700 hover:shadow-xs focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            {onRestore === undefined ? (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 7 7v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        ) : null}
        {onExport !== undefined ? (
          <button
            type="button"
            data-card-export="true"
            disabled={exporting}
            aria-busy={exporting ? true : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onExport();
            }}
            aria-label={exporting ? t("card.exporting") : t("card.export")}
            title={exporting ? t("card.exporting") : t("card.export")}
            className={"relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400/70 transition duration-200 hover:bg-white hover:text-zinc-700 hover:shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-wait " + (exporting ? "opacity-100 text-zinc-500" : "opacity-0 group-hover:text-zinc-400 group-hover:opacity-100 focus-visible:opacity-100")}
          >
            {exporting ? (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        ) : null}
        {onSummary !== undefined ? (
          <button
            type="button"
            data-card-summary="true"
            onClick={(event) => {
              event.stopPropagation();
              onSummary();
            }}
            aria-label={t("card.summary")}
            title={t("card.summary")}
            className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400/70 opacity-0 transition duration-200 hover:bg-white hover:text-zinc-700 hover:shadow-xs group-hover:text-zinc-400 group-hover:opacity-100 focus-visible:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <svg viewBox="0 0 1024 1024" fill="currentColor" className="h-4 w-4" aria-hidden="true" focusable="false">
              <path d="M0 458.9568c83.0464-32.3584 164.352-64.3072 248.32-84.3776 57.6512-13.9264 84.7872-43.8272 98.304-103.8336 20.0704-89.3952 49.7664-176.5376 77.1072-270.7456 5.632 15.5648 9.3184 25.2928 12.1856 34.9184 27.7504 96.0512 55.5008 191.6928 82.6368 287.744 13.6192 48.7424 92.9792 53.3504 132.096 66.2528 65.8432 21.1968 131.4816 43.008 205.1072 66.9696-16.6912 6.2464-25.3952 9.728-34.2016 12.8-65.536 21.2992-280.7808 43.3152-303.8208 123.904-26.3168 96.4608-54.6816 192-82.6368 287.744-2.4576 9.3184-6.4512 18.1248-11.6736 31.744-32.3584-111.2064-63.6928-216.8832-93.2864-322.9696-22.2208-76.8-240.128-100.2496-303.5136-120.832L0 458.9568z m738.7136 300.544c22.3232-6.2464 32.1536-18.2272 37.6832-41.0624 9.8304-40.6528 22.6304-80.5888 34.304-120.4224 1.4336-5.12 4.4032-9.216 8.3968-18.1248 11.776 39.0144 25.2928 71.9872 30.5152 106.3936 7.4752 49.9712 32.0512 75.1616 78.848 83.6608 32.5632 6.144 63.5904 20.1728 95.5392 30.6176-22.016 13.1072-43.6224 19.7632-64.8192 27.0336-30.0032 10.1376-67.584 12.3904-87.3472 33.28-19.7632 20.992-21.9136 60.928-31.4368 92.7744L819.6096 1024a1336.5248 1336.5248 0 0 1-45.056-141.0048c-5.12-19.6608-14.6432-29.3888-33.5872-34.9184-43.9296-12.288-87.1424-27.7504-130.2528-42.0864v-5.8368c42.8032-13.5168 84.8896-29.0816 128-40.6528z m22.016-562.8928c16.5888 4.608 23.8592 13.6192 27.9552 30.5152 7.2704 30.3104 16.896 59.904 25.4976 89.6 1.1264 3.6864 3.2768 6.8608 6.2464 13.4144 8.704-29.0816 18.8416-53.4528 22.6304-79.0528 5.632-37.0688 23.9616-55.9104 58.6752-62.1568 24.2688-4.608 47.4112-15.0528 70.9632-22.8352-16.2816-9.728-32.256-14.6432-48.128-20.0704-22.2208-7.4752-50.176-9.216-65.024-24.6784-14.5408-15.6672-16.1792-45.3632-23.2448-68.9152L820.9408 0a967.68 967.68 0 0 0-33.6896 104.7552c-3.7888 14.7456-10.8544 21.9136-24.9856 25.9072-32.5632 9.216-64.6144 20.7872-96.6656 31.3344v4.4032c31.8464 10.1376 63.0784 21.6064 95.1296 30.208z m0 0" />
            </svg>
          </button>
        ) : null}
        {onPurge !== undefined ? (
          <span className="flex h-6 w-20 shrink-0 items-center">
            <RowDeleteButton
              onDelete={onPurge}
              label={purgeLabel ?? t("lib.purge")}
              text={purgeLabel ?? t("lib.purge")}
              wide
            />
          </span>
        ) : onDelete !== undefined ? (
          <span className="flex h-6 w-12 shrink-0 items-center">
            <RowDeleteButton
              onDelete={() => {
                onDelete();
              }}
              label={t("card.delete")}
            />
          </span>
        ) : null}
        <p className="ml-auto font-mono text-sm text-zinc-400">{time}</p>
      </div>
    </div>
  );
}
