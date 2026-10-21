import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ReactNode } from "react";
import { DICT_ACCENT_PALETTE, accentOfItem, dictLabel, type DictItem, type Dicts } from "../dicts";
import type { DictTools } from "../dictTools";
import type { Member } from "../data/members";
import { DictSelect } from "./DictSelect";
import { ScrollArea } from "./ScrollArea";
import { MemberMultiSelect } from "./MemberSelect";
import { RegionSelect } from "./RegionSelect";
import { useFocusTrapFor } from "./useFocusTrap";
import { PROJECT_STATUS_VALUES, projectStatusOf, type ProjectStatusValue } from "../types";
import { fieldText, projectStatusTextOf, projectTypeText, useLocale, useT } from "../i18n";
import { regionNameEn } from "../data/regionPicker";
import { fetchUsedRegions } from "../projectApi";

/**
 * 项目地区（Push 195）：点开 = 贴字段弹出的小窗（RegionSelect）——最上方「已有项目地区」（有项目在用的，
 * 带项目数；Push 304 起按项目落库值聚合，含字典外国名），下面按洲分组列全部标准国家 / 地区（字典没收录的
 * 国家也能搜到、选到）。
 * 业务口径（2026-09-28）：「还是要之前的小窗 然后最上方是已有项目地区」＋「那我搜索现在没有的国家不就还是不行吗」。
 * 纯选择：不支持手填 / 添加 / 删除（Push 194 口径延续）——值 = 字典码 / 标准中文国名，地图立柱 / 侧栏筛选
 * 按同一套认名规则识别（见 src/data/regionPicker.ts）。
 */

export type ProjectDraft = {
  code: string;
  /** 前端「项目描述」= 契约 name。 */
  description: string;
  /** 备注（契约 description，Push 280 恢复采集）：空串 = 未填写（新建不发送、编辑发送 null 清空）。 */
  note: string;
  /** 项目经理（多位，Push 136）：至少一位，数组顺序 = 展示顺序。 */
  managerIds: string[];
  /** 项目类型：字典 projectType 的码（主题色由字典元数据下发）。 */
  projectType: string;
  /** 项目地区：字典 region 的码 / 标准国家清单里的中文国名（Push 195 模态窗点选）。 */
  region: string;
  /** 项目状态（Push 262）：active / paused / done 走 PATCH；archived 走归档端点（见 App.handleUpdateProject）。 */
  status: ProjectStatusValue;
};

/** 弹窗提交结果（Push 262）：ok = 成功（父层关窗）；error = 提示文案；archive-confirm = 归档缺项，弹窗内二次确认。 */
export type ProjectSubmitResult =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; latest: ProjectDraft; version: number }
  | { kind: "archive-confirm"; missing: string[] };

type ProjectModalProps = {
  mode: "create" | "edit";
  initial?: ProjectDraft;
  /** 字典下拉项（GET /api/v1/dicts）：地区 + 项目类型。 */
  dicts: Dicts;
  /** 字典「＋ 添加」与行内删除的落地方式，由 App 层实现（region 登录即可；projectType 与删除需 dict.manage）。 */
  dictTools: DictTools;
  /** 是否持有 dict.manage（Push 172）：决定「＋ 添加项目类型」与两类条目删除入口的呈现（服务端仍是最终裁决）。 */
  canManageDicts: boolean;
  /** 项目经理候选（GET /api/v1/users）。 */
  managerOptions: Member[];
  /** 是否持有 project.archive（Push 262）：决定「已归档」选项的呈现（服务端仍是最终裁决）。 */
  canArchive?: boolean;
  onClose: () => void;
  /** 提交（Push 262 起返回结构化结果）：ok = 成功（父层负责关窗 / 刷新列表）；error = 失败提示；archive-confirm = 归档缺项，弹窗内二次确认。 */
  onSubmit: (draft: ProjectDraft, options?: { archiveConfirm?: boolean; version?: number }) => Promise<ProjectSubmitResult>;
};

const fieldClass =
  "block w-full appearance-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25";

/**
 * 项目类型下拉内容（触发器与选项行同款）：色点 + 名称 —— 色值随字典 metadata.accent 下发，前端不硬编码；
 * 存量值（item === null：已删除条目的存量值 / 字典外的码）按兜底色（品牌黄）渲染。
 */
function projectTypeContent(name: string, item: DictItem | null): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-zinc-900/10"
        style={{ backgroundColor: accentOfItem(item ?? undefined).color }}
        aria-hidden="true"
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function ProjectModal({ mode, initial, dicts, dictTools, canManageDicts, managerOptions, canArchive = false, onClose, onSubmit }: ProjectModalProps) {
  const isEdit = mode === "edit";
  const t = useT();
  const locale = useLocale();
  /** 冲突摘要行的标点（中文全角 / 英文半角）。 */
  const colon = locale === "en" ? ": " : "：";
  const semi = locale === "en" ? "; " : "；";
  /** 已归档项目只读（ADR-027）：弹窗只读展示，不给保存（服务端同样 409 PROJECT_ARCHIVED）。 */
  const archivedLock = isEdit && initial?.status === "archived";
  const [code, setCode] = useState(initial?.code ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [managerIds, setManagerIds] = useState<string[]>(initial?.managerIds ?? []);
  const [projectType, setProjectType] = useState<string>(initial?.projectType ?? dicts.projectType[0]?.code ?? "");
  /** 新建默认不带地区（业务口径「新建项目不要默认英国 默认为空即可」）：占位「请选择地区」，由用户在小窗里点选。 */
  const [region, setRegion] = useState<string>(initial?.region ?? "");
  /** 项目状态（Push 262）：新建 = active；编辑 = 库里现值（未知值回落 active 兜底）。 */
  const [status, setStatus] = useState<ProjectStatusValue>(projectStatusOf(initial?.status ?? "active") ?? "active");
  const [regionPopoverOpen, setRegionPopoverOpen] = useState(false);
  /**
   * 「已有项目地区」计数（Push 304）：挂载即取全量 region 计数（值 = 项目落库原文 → 未删除项目数）——
   * 之前只认字典条目 usageCount，地区存标准国名（如「美国」）时「已有」页恒空；取数失败维持 undefined（回落字典口径，不阻塞弹窗）。
   */
  const [usedRegions, setUsedRegions] = useState<Record<string, number> | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetchUsedRegions()
      .then((counts) => {
        if (!cancelled) {
          setUsedRegions(counts);
        }
      })
      .catch(() => {
        // 计数取不到 = 小窗回落字典 usageCount（不提示、不影响建项目）。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ latest: ProjectDraft; version: number } | null>(null);
  const [confirmedVersion, setConfirmedVersion] = useState<number | undefined>(undefined);
  /** 归档缺项（Push 262）：非空 = 显示二次确认区（仍要归档 / 取消）。 */
  const [archiveMissing, setArchiveMissing] = useState<string[] | null>(null);
  /** 缺项面板出现时滚进视野（Push 262 追订：弹窗内容高过视口时可滚动，面板在折叠区外）。 */
  const archivePanelRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 键盘焦点陷阱（Push 264 追订）：打开时焦点进弹窗（已有 autoFocus 的输入框就不抢）、Tab 在弹窗内循环、关闭还原到触发按钮
  useFocusTrapFor(dialogRef);

  /** Esc：地区小窗开着时由它自己关（usePopover 统一处理），这里放行 —— 再按一次才关整个项目弹窗。 */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (regionPopoverOpen) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, regionPopoverOpen]);

  useEffect(() => {
    if (archiveMissing !== null) {
      archivePanelRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [archiveMissing]);

  /** 弹窗打开期间锁背景滚动（Push 262 追订②）：鼠标在卡片外滚动不许带动后方项目页。 */
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const previous = { html: html.style.overflow, body: body.style.overflow, pad: body.style.paddingRight };
    // 经典滚动条占位补回来，锁滚动时页面不横向跳动
    const gap = window.innerWidth - html.clientWidth;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (gap > 0) {
      body.style.paddingRight = String(gap) + "px";
    }
    return () => {
      html.style.overflow = previous.html;
      body.style.overflow = previous.body;
      body.style.paddingRight = previous.pad;
    };
  }, []);

  /**
   * 滚轮只滚弹窗：卡片内的滚轮交给 ScrollArea 原生处理；卡片外的滚轮转给弹窗滚动区
   * （`passive: false` 才能拦下默认行为 —— React 的合成 wheel 监听是被动的，拦不住页面滚动）。
   */
  useEffect(() => {
    const node = overlayRef.current;
    if (node === null) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      const dialog = dialogRef.current;
      if (dialog === null) {
        return;
      }
      const viewport = dialog.querySelector("[data-scroll-area=vertical]");
      if (!(viewport instanceof HTMLElement)) {
        return;
      }
      if (event.target instanceof Node && viewport.contains(event.target)) {
        return;
      }
      event.preventDefault();
      viewport.scrollTop += event.deltaY;
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const canSubmit =
    code.trim() !== "" &&
    description.trim() !== "" &&
    managerIds.length > 0 &&
    projectType !== "" &&
    region !== "" &&
    !pending &&
    archiveMissing === null &&
    !archivedLock;
  const title = isEdit ? t("card.edit") : t("home.create");
  /** 触发器上的展示名：字典条目给字典名（阿联酋 → 阿拉伯联合酋长国）；否则值本身（标准中文国名）。 */
  const regionLabel = dictLabel(dicts, "region", region);

  const applyResult = (result: ProjectSubmitResult): void => {
    if (result.kind === "conflict") {
      setConflict(result);
      setError(t("modal.conflict"));
      setArchiveMissing(null);
      return;
    }
    if (result.kind === "error") {
      setError(result.message);
      setArchiveMissing(null);
      return;
    }
    if (result.kind === "archive-confirm") {
      setError(null);
      setArchiveMissing(result.missing);
      return;
    }
    // ok：父层负责关窗
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await onSubmit({ code, description, note, managerIds, projectType, region, status }, { version: confirmedVersion });
    setPending(false);
    applyResult(result);
  };

  /** 归档缺项二次确认（Push 262）：带 confirm=true 重试归档（缺项随归档清单留痕）。 */
  const handleArchiveConfirm = async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await onSubmit({ code, description, note, managerIds, projectType, region, status }, { archiveConfirm: true, version: confirmedVersion });
    setPending(false);
    applyResult(result);
  };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-900/40" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl bg-white p-6 shadow-[0_24px_60px_rgba(0,0,0,0.25)]"
      >
        <h2 className="text-lg font-bold text-zinc-900">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {isEdit ? t("modal.subtitle.edit") : t("modal.subtitle.new")}
        </p>

        <ScrollArea viewportClassName="mt-5 min-h-0 flex-1" className="overscroll-contain space-y-4 px-0.5 pb-1" ariaLabel={t("modal.form.aria")} thumbAlwaysVisible>
        <form id="project-modal-form" className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{t("modal.code.field")}</span>
            <input
              className={fieldClass}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t("modal.code.placeholder")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{t("modal.name.field")}</span>
            <input
              className={fieldClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("modal.name.placeholder")}
            />
          </label>
          <div className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">
              {fieldText(locale, "项目经理")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("modal.managers.any")}</span>
            </span>
            <MemberMultiSelect
              values={managerIds}
              onChange={setManagerIds}
              options={managerOptions}
              placeholder={t("drawer.manager.placeholder")}
              ariaLabel={t("drawer.manager.aria")}
            />
            <span className="mt-1 block text-[11px] text-zinc-400">{t("modal.managers.caption")}</span>
          </div>
          <div className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{t("modal.province")}</span>
            {/* Push 195：小窗 = 搜索框 + 最上方「已有项目地区」+ 分洲全部国家（不支持手填 / 添加 / 删除，不写字典） */}
            <RegionSelect
              value={region}
              valueLabel={regionLabel}
              items={dicts.region}
              usedRegions={usedRegions}
              onChange={setRegion}
              onOpenChange={setRegionPopoverOpen}
            />
          </div>
          <div className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{t("modal.type.field")}</span>
            <DictSelect
              value={projectType}
              items={dicts.projectType}
              ariaLabel={t("modal.type.aria")}
              placeholder={t("modal.type.placeholder")}
              renderContent={(name, item) => projectTypeContent(projectTypeText(locale, name), item)}
              onAdd={
                canManageDicts
                  ? (input) => dictTools.onAdd("projectType", input)
                  : undefined
              }
              addText={{
                label: t("modal.type.add"),
                placeholder: t("modal.type.namePlaceholder"),
              }}
              palette={{
                label: fieldText(locale, "颜色模板"),
                options: DICT_ACCENT_PALETTE,
              }}
              onDelete={
                canManageDicts
                  ? (code) => dictTools.onDelete("projectType", code)
                  : undefined
              }
              deleteLabelOf={(_code, name) => t("modal.type.deleteAria", { name })}
              onChange={setProjectType}
            />
          </div>

          {/* Push 280：备注（契约 description）恢复采集 —— 新建 / 编辑都可填；多行、选填、上限 2000（契约 max(2000)）。 */}
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">
              {t("modal.note.field")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("modal.note.optional")}</span>
            </span>
            <textarea
              className={fieldClass + " min-h-20 resize-y"}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              placeholder={t("modal.note.placeholder")}
            />
          </label>

          {isEdit ? (
            <div className="block">
              <span className="mb-1.5 block text-sm font-medium text-zinc-700">{t("modal.status.field")}</span>
              <div role="radiogroup" aria-label={t("modal.status.aria")} className="flex flex-wrap gap-2">
                {PROJECT_STATUS_VALUES.map((value) => {
                  const archiveOption = value === "archived";
                  const disabled = archivedLock || (archiveOption && !canArchive);
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={status === value}
                      data-project-status-option={value}
                      data-selected={status === value ? "true" : "false"}
                      disabled={disabled}
                      title={
                        disabled
                          ? archivedLock
                            ? t("modal.archive.locked")
                            : t("modal.archive.needPerm")
                          : undefined
                      }
                      onClick={() => {
                        setStatus(value);
                        setArchiveMissing(null);
                        setError(null);
                      }}
                      className={
                        "rounded-lg border px-3 py-1.5 text-sm transition " +
                        (status === value
                          ? "border-transparent bg-[#feca04] font-medium text-zinc-900 shadow-sm"
                          : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100") +
                        (disabled ? " cursor-not-allowed opacity-50" : "")
                      }
                    >
                      {projectStatusTextOf(locale, value)}
                    </button>
                  );
                })}
              </div>
              <span className="mt-1 block text-[11px] text-zinc-400">
                {archivedLock
                  ? t("modal.err.archived")
                  : status === "archived"
                    ? t("modal.gate.note")
                    : t("modal.save.note")}
              </span>
            </div>
          ) : null}

          {archiveMissing === null ? null : (
            <div
              ref={archivePanelRef}
              data-archive-confirm="true"
              role="alertdialog"
              aria-label={t("modal.gate.aria")}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900"
            >
              <p className="font-medium">{t("modal.gate.title", { n: archiveMissing.length })}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {archiveMissing.map((item, index) => (
                  <li key={String(index)} data-archive-missing-item="true">{item}</li>
                ))}
              </ul>
              <p className="mt-1.5">{t("modal.gate.body")}</p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  data-archive-cancel-button="true"
                  onClick={() => {
                    setArchiveMissing(null);
                  }}
                  className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  data-archive-confirm-button="true"
                  disabled={pending}
                  onClick={() => void handleArchiveConfirm()}
                  className="rounded-lg bg-[#feca04] px-2.5 py-1 text-xs font-medium text-zinc-900 shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? t("modal.gate.pending") : t("modal.gate.confirm")}
                </button>
              </div>
            </div>
          )}

          {error === null ? null : (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          )}
          {conflict === null ? null : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <details><summary>{t("modal.conflict.latest")}</summary><p className="mt-2 whitespace-pre-wrap">{fieldText(locale, "项目编号")}{colon}{conflict.latest.code}<br />{fieldText(locale, "项目描述")}{colon}{conflict.latest.description}<br />{fieldText(locale, "备注")}{colon}{conflict.latest.note || "—"}<br />{fieldText(locale, "项目经理")}{colon}{conflict.latest.managerIds.map((id) => managerOptions.find((member) => member.id === id)?.name ?? id).join(locale === "en" ? ", " : "、")}<br />{fieldText(locale, "项目类型")}{colon}{projectTypeText(locale, dictLabel(dicts, "projectType", conflict.latest.projectType))}{semi}{fieldText(locale, "项目地区")}{colon}{locale === "en" ? regionNameEn(dictLabel(dicts, "region", conflict.latest.region)) || dictLabel(dicts, "region", conflict.latest.region) : dictLabel(dicts, "region", conflict.latest.region)}{semi}{fieldText(locale, "项目状态")}{colon}{projectStatusTextOf(locale, conflict.latest.status)}</p></details>
              <button type="button" disabled={pending || conflict.latest.status === "archived"} className="mt-2 underline disabled:opacity-50" onClick={() => {
                setConfirmedVersion(conflict.version);
                setConflict(null);
                setError(t("modal.conflict.noted"));
              }}>{t("modal.conflict.ok")}</button>
            </div>
          )}

        </form>
        </ScrollArea>

        <div className="mt-4 flex shrink-0 justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="project-modal-form"
            disabled={!canSubmit}
            className="rounded-lg bg-[#feca04] px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:brightness-95 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {archivedLock ? t("modal.submit.archived") : pending ? t("modal.submit.pending") : isEdit ? t("modal.submit.edit") : t("modal.submit.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
