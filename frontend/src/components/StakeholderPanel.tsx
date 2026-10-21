import { ApiError } from "../api";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { keepLiveOrder } from "../liveSync";
import { useLiveRefresh } from "../useLiveRefresh";
import {
  STAKEHOLDER_COMPANY_TYPES,
  createStakeholder,
  deleteStakeholder,
  fetchProjectStakeholders,
  stakeholderCompanyTypeBadge,
  stakeholderCompanyTypeName,
  stakeholderErrorText,
  updateStakeholder,
  type Stakeholder,
  type StakeholderCreateInput,
  type StakeholderPatch,
} from "../stakeholderApi";
import { RowDeleteButton } from "./RowDeleteButton";
import { Toast } from "./Toast";
import { RowEditButton } from "./RowEditButton";
import { SelectMenu, type SelectOption } from "./SelectMenu";
import { ScrollArea } from "./ScrollArea";
import { useFocusTrap } from "./useFocusTrap";
import { fieldText as fieldLabel, textOf as pickText, useLocale, useT, type Locale } from "../i18n";

/**
 * 项目详情「干系人」面板（A27 · M6-06 前端接线；标签排在最右侧）：表格形态与「项目总览」同一套 ——
 * 白卡片 + 表头固定在主标签栏之下（sticky top-[122px]，横向滚动时用 translateX 跟随 scrollLeft）+
 * 每行 CSS grid + minWidth 横向滚动，底部共用 TableScrollbar 滑块（见 ProjectDetail.tsx）。
 * 列 = 用户口径字段：姓名 / 电话（含 WhatsApp）/ 微信 / 邮箱 / 职务（责任板块）/ 所属公司（分类色签；具体公司名为存量只读展示）/ 填写者 / 干系人角色 / 行尾动作；
 * Push 222（业务 2026-09-29：「这个不需要 然后编辑是点编辑按钮才是编辑 点击表格不能编辑」）：① 新建 / 编辑弹窗不再录入「具体公司名称」（写入面不带 company；存量数据照常展示）；② 编辑只走行尾「编辑」按钮 —— 点击行体不再进编辑。
 * Push 225（代 wmj 线扩契约，请 wmj 复核）：`stakeholders.role`（迁移 0042）+ 契约 `Stakeholder.role` 落地 ——「干系人角色」列随本刀补上（自由文本；未登记字段级策略 = 恒可见）。
 * 数据面：GET /api/v1/stakeholders?filter[projectId]（A5-03 按项目查看联系人清单），写 = stakeholder.manage。
 * 字段级脱敏（A5-07 · C3-08）：无权字段**键不存在** —— 表格渲染浅灰「—」并悬停说明，表单对应输入禁用、绝不回写（缺键当空值会清空无权字段）。
 */

/** 表格列（与任务表同一套：width 用于 gridTemplateColumns、min 参与 minWidth）。 */
const COLUMNS = [
  { key: "name", label: "干系人姓名", width: "170px", min: 170 },
  { key: "phone", label: "电话 / WhatsApp", width: "170px", min: 170 },
  { key: "wechat", label: "微信", width: "140px", min: 140 },
  { key: "email", label: "邮箱 Email", width: "230px", min: 230 },
  { key: "title", label: "职务 / 责任板块", width: "190px", min: 190 },
  { key: "company", label: "所属公司", width: "210px", min: 210 },
  { key: "createdBy", label: "填写者", width: "110px", min: 110 },
  { key: "role", label: "干系人角色", width: "150px", min: 150 },
  { key: "actions", label: "", width: "96px", min: 96 },
] as const;

const GRID_TEMPLATE = COLUMNS.map((column) => column.width).join(" ");
const MIN_WIDTH = COLUMNS.reduce((sum, column) => sum + column.min, 0);

const fieldClass =
  "block w-full appearance-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400";

/** 受字段级策略保护的字段（A5-07）：无权时响应里没有该键（不是 null）。 */
type MaskableField = "company" | "title" | "phone" | "wechat" | "email";

/** 表单可编辑的受保护字段（Push 222 起 company 移出 —— 具体公司名不再录入，只在读面展示）。 */
type EditableField = "title" | "phone" | "wechat" | "email";

const EDITABLE_FIELDS: readonly EditableField[] = ["title", "phone", "wechat", "email"];

function recordOf(row: Stakeholder): Record<string, unknown> {
  return row as unknown as Record<string, unknown>;
}

/** 键是否存在：缺键 = 无权查看（A5-07）；null / 空串 = 有权限但没填。 */
function missingKey(row: Stakeholder, field: MaskableField): boolean {
  return !(field in recordOf(row));
}

/** 单元格呈现（Push 301 起随语言切换）：缺键 → 浅灰「—」+ 悬停说明；空值 → 灰「—」；有值 → 文本。 */
function cellOf(row: Stakeholder, field: MaskableField, locale: Locale): { text: string; className: string; title?: string } {
  if (missingKey(row, field)) {
    return { text: "—", className: "text-zinc-300", title: pickText(locale, "sh.locked.cell") };
  }
  const raw = recordOf(row)[field];
  if (typeof raw === "string" && raw.trim() !== "") {
    return { text: raw, className: "text-zinc-600" };
  }
  return { text: "—", className: "text-zinc-300" };
}

function textOf(row: Stakeholder, field: MaskableField): string {
  const raw = recordOf(row)[field];
  return typeof raw === "string" ? raw : "";
}

export type StakeholderDraft = {
  name: string;
  companyType: string;
  title: string;
  phone: string;
  wechat: string;
  email: string;
  role: string;
};

/** 编辑草稿：缺键字段留空（表单里禁用，提交时不带上 —— 绝不把无权字段当空值清掉）。 */
function draftOf(row: Stakeholder): StakeholderDraft {
  return {
    name: row.name,
    companyType: row.companyType,
    title: missingKey(row, "title") ? "" : textOf(row, "title"),
    phone: missingKey(row, "phone") ? "" : textOf(row, "phone"),
    wechat: missingKey(row, "wechat") ? "" : textOf(row, "wechat"),
    email: missingKey(row, "email") ? "" : textOf(row, "email"),
    role: row.role ?? "",
  };
}

function compact(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 新建请求体：只带填了的字段 + 当前项目关联（A5-03）。 */
function createBodyOf(draft: StakeholderDraft, projectId: string): StakeholderCreateInput {
  return {
    name: draft.name.trim(),
    companyType: draft.companyType,
    title: compact(draft.title),
    phone: compact(draft.phone),
    wechat: compact(draft.wechat),
    email: compact(draft.email),
    role: compact(draft.role),
    projectIds: [projectId],
  };
}

/** 编辑请求体（PATCH 合并语义）：只带改动过的键；清空 = null；缺键字段一律跳过。 */
function patchOf(draft: StakeholderDraft, row: Stakeholder): StakeholderPatch {
  const patch: StakeholderPatch = {};
  if (draft.name.trim() !== row.name) {
    patch.name = draft.name.trim();
  }
  if (draft.companyType !== row.companyType) {
    patch.companyType = draft.companyType;
  }
  for (const field of EDITABLE_FIELDS) {
    if (missingKey(row, field)) {
      continue;
    }
    const next = draft[field].trim();
    if (next === textOf(row, field)) {
      continue;
    }
    patch[field] = next === "" ? null : next;
  }
  // role 未登记字段级策略（恒可见）：与 name 同口径直接比对；清空 = null。
  const nextRole = draft.role.trim();
  if (nextRole !== (row.role ?? "")) {
    patch.role = nextRole === "" ? null : nextRole;
  }
  return patch;
}
/** 公司分类下拉项（Push 301：展示名随语言切换；色签与表格同款）。 */
function companyTypeOptions(locale: Locale): SelectOption[] {
  return STAKEHOLDER_COMPANY_TYPES.map((code) => ({
    value: code,
    label: (
      <span className="flex items-center gap-2">
        <span className={"inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium " + stakeholderCompanyTypeBadge(code)}>
          {fieldLabel(locale, stakeholderCompanyTypeName(code))}
        </span>
      </span>
    ),
  }));
}

/** 单元格文本（缺键 / 空值都渲染「—」，样式与悬停说明由 fieldText 给）。 */
function CellText({ value }: { value: { text: string; className: string; title?: string } }) {
  return (
    <span className={"truncate text-sm " + value.className} title={value.title}>
      {value.text}
    </span>
  );
}

/** 新建 / 编辑弹窗（与 ProjectModal 同款：遮罩 + max-w-md 圆角卡片 + 品牌黄主按钮）。Push 265：卡片补 max-h-[calc(100dvh-2rem)] + flex-col + 表单区内滚动（矮视口下底部「取消 / 创建干系人」不再被裁；业务反馈 2026-10-10「干系人新建/编辑弹窗无高度自适应」）。 */
function StakeholderModal({
  mode,
  row,
  projection,
  available,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  /** 编辑时的当行快照（缺键字段在表单里禁用）；新建为 null。 */
  row: Stakeholder | null;
  projection: Stakeholder | null;
  available: boolean;
  onClose: () => void;
  /** 提交：返回 null = 成功（父层关窗 + 重取列表）；返回文案 = 失败提示，窗口保持打开。 */
  onSubmit: (draft: StakeholderDraft) => Promise<string | null>;
}) {
  /** 键盘焦点陷阱（Push 264 追订）：弹窗打开时焦点进弹窗、Tab 在弹窗内循环、关闭还原到触发按钮。 */
  const modalTrapRef = useFocusTrap<HTMLDivElement>();
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<StakeholderDraft>(() =>
    row === null
      ? { name: "", companyType: "", role: "", title: "", phone: "", wechat: "", email: "" }
      : draftOf(row),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = (field: MaskableField): boolean => row !== null && (projection === null || missingKey(projection, field));
  const canSubmit = available && draft.name.trim() !== "" && draft.companyType !== "" && !pending;

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

  const edit = (field: keyof StakeholderDraft, value: string): void => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const lockNote = (field: MaskableField) =>
    locked(field) ? <span className="ml-1 text-[11px] font-normal text-zinc-400">{t("sh.locked.note")}</span> : null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setError(null);
    const message = await onSubmit(draft);
    setPending(false);
    if (message !== null) {
      setError(message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-900/40" onClick={onClose} />
      <div
        ref={modalTrapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(mode === "create" ? "sh.title.create" : "sh.title.edit")}
        data-stakeholder-modal=""
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl bg-white p-6 shadow-[0_24px_60px_rgba(0,0,0,0.25)]"
      >
        <h2 className="text-lg font-bold text-zinc-900">{t(mode === "create" ? "sh.title.create" : "sh.title.edit")}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {t(mode === "create" ? "sh.sub.create" : "sh.sub.edit")}
        </p>
        {available ? null : <p role="status" className="mt-2 text-xs text-amber-700">{t("sh.available.lost")}</p>}
        <ScrollArea viewportClassName="mt-5 min-h-0 flex-1" className="overscroll-contain space-y-4 px-0.5 pb-1" ariaLabel={t("sh.form.aria")} thumbAlwaysVisible>
        <form id="stakeholder-modal-form" className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "干系人姓名")}</span>
            <input data-stakeholder-field="name" className={fieldClass} value={draft.name} onChange={(event) => edit("name", event.target.value)} placeholder={t("sh.placeholder.name")} />
          </label>
          <div className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">
              {fieldLabel(locale, "所属公司分类")}<span className="ml-1 text-xs font-normal text-zinc-400">{t("sh.companyType.hint")}</span>
            </span>
            <div data-stakeholder-field="companyType">
              <SelectMenu
                value={draft.companyType}
                options={companyTypeOptions(locale)}
                onChange={(value) => edit("companyType", value)}
                placeholder={t("sh.placeholder.companyType")}
                ariaLabel={t("sh.aria.companyType")}
              />
            </div>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "职务 / 责任板块")}{lockNote("title")}</span>
            <input
              data-stakeholder-field="title"
              className={fieldClass}
              disabled={locked("title")}
              value={locked("title") ? "" : draft.title}
              onChange={(event) => edit("title", event.target.value)}
              placeholder={locked("title") ? t("sh.locked.note") : t("sh.placeholder.title")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "电话 / WhatsApp")}{lockNote("phone")}</span>
            <input
              data-stakeholder-field="phone"
              className={fieldClass}
              disabled={locked("phone")}
              value={locked("phone") ? "" : draft.phone}
              onChange={(event) => edit("phone", event.target.value)}
              placeholder={locked("phone") ? t("sh.locked.note") : t("sh.placeholder.phone")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "微信")}{lockNote("wechat")}</span>
            <input
              data-stakeholder-field="wechat"
              className={fieldClass}
              disabled={locked("wechat")}
              value={locked("wechat") ? "" : draft.wechat}
              onChange={(event) => edit("wechat", event.target.value)}
              placeholder={locked("wechat") ? t("sh.locked.note") : t("sh.placeholder.wechat")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "邮箱 Email")}{lockNote("email")}</span>
            <input
              data-stakeholder-field="email"
              className={fieldClass}
              disabled={locked("email")}
              value={locked("email") ? "" : draft.email}
              onChange={(event) => edit("email", event.target.value)}
              placeholder={locked("email") ? t("sh.locked.note") : t("sh.placeholder.email")}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-zinc-700">{fieldLabel(locale, "干系人角色")}</span>
            <input
              data-stakeholder-field="role"
              className={fieldClass}
              value={draft.role}
              onChange={(event) => edit("role", event.target.value)}
              placeholder={t("sh.placeholder.role")}
            />
          </label>
          {error === null ? null : (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
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
            form="stakeholder-modal-form"
            data-stakeholder-submit=""
            disabled={!canSubmit}
            className="rounded-lg bg-[#feca04] px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:brightness-95 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? t("modal.submit.pending") : t(mode === "create" ? "sh.submit.create" : "modal.submit.edit")}
          </button>
        </div>
      </div>
    </div>
  );
}
/** 表格行（与任务表行同一套：group grid + px-5 py-2.5；悬停浮出行尾「编辑 / 删除」两枚胶囊）。Push 222 起行体不再可点 —— 编辑只走行尾「编辑」按钮。 */
function StakeholderRow({
  row,
  canManage,
  onEdit,
  onDelete,
}: {
  row: Stakeholder;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const locale = useLocale();
  const phone = cellOf(row, "phone", locale);
  const wechat = cellOf(row, "wechat", locale);
  const email = cellOf(row, "email", locale);
  const title = cellOf(row, "title", locale);
  const company = cellOf(row, "company", locale);
  const t = useT();
  /** 角色未登记字段级策略：恒有值（空 = 未填），行内「—」与姓名列同款。 */
  const role = row.role ?? "";

  return (
    <div
      data-stakeholder-row={row.id}
      className="group grid items-center border-b border-zinc-100 px-5 py-2.5 transition-colors last:border-b-0 hover:bg-zinc-50/80"
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
    >
      <div data-stakeholder-cell="name" className="min-w-0 pr-3">
        <p className="truncate text-sm font-medium text-zinc-800" title={row.name}>
          {row.name}
        </p>
      </div>
      <div data-stakeholder-cell="phone" className="flex min-w-0 items-center justify-center">
        <CellText value={phone} />
      </div>
      <div data-stakeholder-cell="wechat" className="flex min-w-0 items-center justify-center">
        <CellText value={wechat} />
      </div>
      <div data-stakeholder-cell="email" className="flex min-w-0 items-center justify-center">
        <CellText value={email} />
      </div>
      <div data-stakeholder-cell="title" className="flex min-w-0 items-center justify-center">
        <CellText value={title} />
      </div>
      <div data-stakeholder-cell="company" className="flex min-w-0 items-center justify-center">
        <span className="flex min-w-0 items-center gap-2">
          <span className={"inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium " + stakeholderCompanyTypeBadge(row.companyType)}>
            {fieldLabel(locale, stakeholderCompanyTypeName(row.companyType))}
          </span>
          {/* 具体公司名（Push 222 起表单不录）：有值 / 无权（缺键该给「—」说明）才渲染，空值不再挂一个多余的「—」 */}
          {missingKey(row, "company") || (typeof row.company === "string" && row.company.trim() !== "") ? <CellText value={company} /> : null}
        </span>
      </div>
      <div data-stakeholder-cell="createdBy" className="flex min-w-0 items-center justify-center">
        <span className="truncate text-sm text-zinc-600" title={row.createdByName ?? undefined}>
          {row.createdByName === null || row.createdByName === "" ? "—" : row.createdByName}
        </span>
      </div>
      <div data-stakeholder-cell="role" className="flex min-w-0 items-center justify-center">
        <span className="truncate text-sm text-zinc-600" title={role === "" ? undefined : role}>
          {role === "" ? "—" : role}
        </span>
      </div>
      <div data-stakeholder-cell="actions" className="flex items-center justify-end gap-1.5">
        {canManage ? (
          <>
            <span data-stakeholder-edit-slot="">
              <RowEditButton label={t("row.edit.stakeholder")} onEdit={onEdit} />
            </span>
            <span data-stakeholder-delete-slot="">
              <RowDeleteButton label={t("row.delete.stakeholder")} onDelete={onDelete} />
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

type StakeholderPanelProps = {
  /** 当前项目 id（列表按 filter[projectId] 反查本项目联系人，A5-03）。 */
  projectId: string;
  /** 写入口（新建 / 编辑 / 删除）= stakeholder.manage；画像未到时乐观放行，服务端逐请求仍是最终裁决。 */
  canManage: boolean;
  /** 横向滚动容器 ref：与「项目总览」共用同一枚底部 TableScrollbar（见 ProjectDetail.tsx）。 */
  scrollRef: RefObject<HTMLDivElement | null>;
};

export function StakeholderPanel({ projectId, canManage, scrollRef }: StakeholderPanelProps) {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<Stakeholder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 取数版本号：首取 / 写成功后的回读 / 加载失败重试都 +1。 */
  const [dataVersion, setDataVersion] = useState(0);
  /** 弹窗：新建 / 编辑（编辑带当行快照 —— 缺键字段在表单里禁用且不回写）。 */
  const [modal, setModal] = useState<{ mode: "create" } | { mode: "edit"; row: Stakeholder } | null>(null);
  /** 删除二次确认（与首页删项目 / 模板 / 日报问题同一套：第一下只开口，第二下才真删）。 */
  const [pendingDelete, setPendingDelete] = useState<Stakeholder | null>(null);
  /** 键盘焦点陷阱（Push 264 追订）：删除确认条开着时焦点进条内（初始焦点不再留在行内「删除」按钮上）、Tab 在条内循环、关闭还原。 */
  const deleteConfirmTrapRef = useFocusTrap<HTMLDivElement>(pendingDelete !== null);
  const [deletePending, setDeletePending] = useState(false);
  /** 写失败提示（删除）；加载失败走上面的 error 块。 */
  const [actionError, setActionError] = useState<string | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);

  useLiveRefresh(["stakeholders", "permissions"], async () => {
    let result;
    try { result = await fetchProjectStakeholders(projectId); } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return () => { setItems([]); setTotal(0); setError(t("sh.project.gone")); };
      throw error;
    }
    return () => {
      setItems((previous) => keepLiveOrder(previous, result.items));
      setTotal(result.total);
      setError(null);
    };
  }, projectId + ":" + String(dataVersion), !loading, { readOnly: true });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const result = await fetchProjectStakeholders(projectId);
        if (!alive) {
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        setError(null);
      } catch (loadError) {
        if (!alive) {
          return;
        }
        setError(stakeholderErrorText(locale, t("sh.err.act.load"), loadError));
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, dataVersion]);

  /** 表头固定（与 TaskBoard 同一套）：横向滚动（含底部滑块）时用 translateX 跟随 scrollLeft，表头与各列始终对齐。 */
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) {
      return undefined;
    }
    const sync = () => {
      const header = headerRowRef.current;
      if (header !== null) {
        header.style.transform = "translateX(" + String(-scroller.scrollLeft) + "px)";
      }
    };
    sync();
    scroller.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      scroller.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [scrollRef]);

  /** 弹窗提交：新建带当前项目关联；编辑只提交改动键（写成功即回读）。 */
  const submitModal = async (draft: StakeholderDraft): Promise<string | null> => {
    if (modal === null) {
      return null;
    }
    if (!canManage || error !== null) return t("sh.submit.forbidden");
    try {
      if (modal.mode === "create") {
        await createStakeholder(createBodyOf(draft, projectId));
      } else {
        const projection = items.find((item) => item.id === modal.row.id);
        if (projection === undefined) return t("sh.submit.gone");
        const patch = patchOf(draft, modal.row);
        for (const field of EDITABLE_FIELDS) if (missingKey(projection, field)) delete patch[field];
        if (Object.keys(patch).length > 0) {
          await updateStakeholder(modal.row.id, patch);
        }
      }
      setModal(null);
      setDataVersion((version) => version + 1);
      return null;
    } catch (submitError) {
      return stakeholderErrorText(locale, t(modal.mode === "create" ? "sh.err.act.create" : "sh.err.act.save"), submitError);
    }
  };

  /** 删除：软删成功 = 本地移除该行（契约口径「前端列表本地移除即可」）。 */
  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) {
      return;
    }
    const target = pendingDelete;
    setDeletePending(true);
    try {
      await deleteStakeholder(target.id);
      setItems((previous) => previous.filter((item) => item.id !== target.id));
      setTotal((previous) => Math.max(0, previous - 1));
      setPendingDelete(null);
      setActionError(null);
    } catch (deleteError) {
      setActionError(stakeholderErrorText(locale, t("sh.err.act.delete"), deleteError));
      setPendingDelete(null);
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p data-stakeholder-count="" className="text-xs text-zinc-500">
          {t("sh.count.pre")}<span data-stakeholder-total="" className="text-sm font-semibold text-zinc-800">{total}</span>{t("sh.count.post")}
        </p>
        {total > items.length ? (
          <span className="text-[11px] text-amber-600">
            {t("sh.shown", { shown: items.length, total })}
          </span>
        ) : null}
        {canManage ? (
          <button
            type="button"
            data-stakeholder-new=""
            onClick={() => {
              setModal({ mode: "create" });
            }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-[#feca04] px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:brightness-95 active:brightness-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {t("sh.new")}
          </button>
        ) : null}
      </div>

      {error === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setDataVersion((version) => version + 1);
            }}
            className="ml-auto rounded-lg border border-rose-300 px-3 py-1 text-xs font-medium transition hover:bg-rose-100"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {actionError === null ? null : (
        <Toast
          kind="error"
          text={actionError}
          onClose={() => {
            setActionError(null);
          }}
        />
      )}

      <div data-stakeholder-table="" className="rounded-xl border border-zinc-200 bg-white">
        <div data-stakeholder-head="" className="sticky top-[122px] z-[19] overflow-hidden rounded-t-xl border-b border-zinc-200 bg-zinc-50">
          <div
            ref={headerRowRef}
            className="grid items-center px-5 py-2.5 text-xs font-medium text-zinc-400"
            style={{ gridTemplateColumns: GRID_TEMPLATE, minWidth: MIN_WIDTH }}
          >
            {COLUMNS.map((column) => (
              <span key={column.key} data-column={column.key} className={"truncate " + (column.key === "name" ? "" : "text-center")}>
                {column.label === "" ? null : fieldLabel(locale, column.label)}
              </span>
            ))}
          </div>
        </div>
        <div id="stakeholder-board-scroll" ref={scrollRef} className="overflow-x-auto rounded-b-xl">
          <div style={{ minWidth: MIN_WIDTH }}>
            {items.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-zinc-400">
                {loading
                  ? t("sh.loading")
                  : canManage
                    ? t("sh.empty.manage")
                    : t("sh.empty")}
              </div>
            ) : (
              items.map((row) => (
                <StakeholderRow
                  key={row.id}
                  row={row}
                  canManage={canManage}
                  onEdit={() => {
                    setModal({ mode: "edit", row });
                  }}
                  onDelete={() => {
                    setPendingDelete(row);
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {modal === null ? null : (
        <StakeholderModal
          mode={modal.mode}
          row={modal.mode === "edit" ? modal.row : null}
          projection={modal.mode === "edit" ? items.find((item) => item.id === modal.row.id) ?? null : null}
          available={canManage && error === null && (modal.mode === "create" || items.some((item) => item.id === modal.row.id))}
          onClose={() => {
            setModal(null);
          }}
          onSubmit={submitModal}
        />
      )}

      {pendingDelete === null ? null : (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
          <div
            ref={deleteConfirmTrapRef}
            role="dialog"
            aria-label={t("sh.delete.aria")}
            data-delete-confirm-strip=""
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 shadow-lg"
          >
            <span>{t("sh.delete.text", { name: pendingDelete.name })}</span>
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
              disabled={deletePending}
              onClick={() => {
                void confirmDelete();
              }}
              className="rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white transition hover:brightness-95 disabled:opacity-60"
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
