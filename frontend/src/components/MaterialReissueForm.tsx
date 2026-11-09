import { useEffect, useRef, useState } from "react";
import { memberNameOf, type Member } from "../data/members";
import type { ProjectTask } from "../data/tasks";
import {
  createMaterialReissue,
  type MaterialReissueApproval,
  type MaterialReissueDepartment,
  type MaterialReissueFreight,
  type MaterialReissueInput,
  type MaterialReissueLine,
  type MaterialReissueReason,
  type MaterialReissueResult,
} from "../fileApi";
import { fieldText, useLocale, useT } from "../i18n";
import { useMyPermissions } from "../permissions";
import { fetchProject, type ApiProject } from "../projectApi";
import { SelectMenu, type SelectOption } from "./SelectMenu";

const FIELD_CLASS =
  "block w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10";
const LABEL_CLASS = "text-xs font-medium text-zinc-500";
const CAPTION_CLASS = "mt-1 block text-[11px] leading-4 text-zinc-400";

import {
  MATERIAL_REISSUE_APPROVAL_OPTIONS as APPROVAL_OPTIONS,
  MATERIAL_REISSUE_DEPARTMENT_OPTIONS as DEPARTMENT_OPTIONS,
  MATERIAL_REISSUE_FREIGHT_OPTIONS as FREIGHT_OPTIONS,
  MATERIAL_REISSUE_REASON_OPTIONS as REASON_OPTIONS,
} from "../materialReissue";

type MaterialDraft = MaterialReissueLine & { id: number };

function blankMaterial(id: number): MaterialDraft {
  return { id, materialCode: "", materialName: "", specification: "", quantity: 1, unit: "个", remark: "" };
}

function optionList(
  options: ReadonlyArray<{ value: string; label: string }>,
  locale: ReturnType<typeof useLocale>,
): SelectOption[] {
  return options.map((option) => ({ value: option.value, label: fieldText(locale, option.label) }));
}

function shanghaiNowText(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

export function MaterialReissueForm({ projectId, task, members, onSubmitted }: {
  projectId: string;
  task: ProjectTask;
  members: readonly Member[];
  onSubmitted: (result: MaterialReissueResult) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const projectErrorText = t("mr.err.project");
  const permissions = useMyPermissions();
  const [project, setProject] = useState<ApiProject | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectTick, setProjectTick] = useState(0);
  const [submittedAt] = useState(shanghaiNowText);
  const [reason, setReason] = useState<MaterialReissueReason>("missing_list");
  const [reasonOther, setReasonOther] = useState("");
  const [applicationDepartment, setApplicationDepartment] = useState<MaterialReissueDepartment>("project");
  const [applicationDepartmentOther, setApplicationDepartmentOther] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [inWarranty, setInWarranty] = useState(false);
  const [freeReissue, setFreeReissue] = useState(false);
  const [approved, setApproved] = useState<MaterialReissueApproval>("no");
  const [responsibleDepartment, setResponsibleDepartment] = useState<MaterialReissueDepartment>("project");
  const [responsibleDepartmentOther, setResponsibleDepartmentOther] = useState("");
  const [requiredOutDate, setRequiredOutDate] = useState("");
  const [oldPartReturn, setOldPartReturn] = useState(false);
  const [freightBearer, setFreightBearer] = useState<MaterialReissueFreight>("libiao");
  const [recipient, setRecipient] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const nextMaterialId = useRef(2);
  const [materials, setMaterials] = useState<MaterialDraft[]>(() => [blankMaterial(1)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProject(null);
    setProjectError(null);
    void fetchProject(projectId)
      .then((loaded) => {
        if (!cancelled) setProject(loaded);
      })
      .catch(() => {
        if (!cancelled) setProjectError(projectErrorText);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projectTick, projectErrorText]);

  const applicantName =
    permissions === null
      ? t("common.loading")
      : memberNameOf(members, permissions.userId) ?? permissions.userId;

  const updateMaterial = (id: number, patch: Partial<MaterialReissueLine>) => {
    setMaterials((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setError(null);
  };

  const removeMaterial = (id: number) => {
    setMaterials((current) => (current.length <= 1 ? current : current.filter((row) => row.id !== id)));
  };

  const addMaterial = () => {
    const id = nextMaterialId.current;
    nextMaterialId.current += 1;
    setMaterials((current) => [...current, blankMaterial(id)]);
  };

  const submit = async () => {
    if (busy) return;
    if (reason === "other" && reasonOther.trim() === "") {
      setError(t("mr.err.reasonOther"));
      return;
    }
    if (applicationDepartment === "other" && applicationDepartmentOther.trim() === "") {
      setError(t("mr.err.applicationDepartmentOther"));
      return;
    }
    if (responsibleDepartment === "other" && responsibleDepartmentOther.trim() === "") {
      setError(t("mr.err.responsibleDepartmentOther"));
      return;
    }
    if (requiredOutDate === "") {
      setError(t("mr.err.outDate"));
      return;
    }
    if (recipient.trim() === "") {
      setError(t("mr.err.recipient"));
      return;
    }
    if (phone.trim() === "") {
      setError(t("mr.err.phone"));
      return;
    }
    if (address.trim() === "") {
      setError(t("mr.err.address"));
      return;
    }
    if (description.trim() === "") {
      setError(t("mr.err.description"));
      return;
    }
    const badName = materials.findIndex((row) => row.materialName.trim() === "");
    if (badName >= 0) {
      setError(t("mr.err.materialName", { n: String(badName + 1) }));
      return;
    }
    const badQuantity = materials.findIndex((row) => !Number.isFinite(row.quantity) || row.quantity <= 0);
    if (badQuantity >= 0) {
      setError(t("mr.err.materialQuantity", { n: String(badQuantity + 1) }));
      return;
    }
    const badUnit = materials.findIndex((row) => row.unit.trim() === "");
    if (badUnit >= 0) {
      setError(t("mr.err.materialUnit", { n: String(badUnit + 1) }));
      return;
    }
    const input: MaterialReissueInput = {
      reason,
      reasonOther: reason === "other" ? reasonOther.trim() : undefined,
      applicationDepartment,
      applicationDepartmentOther:
        applicationDepartment === "other" ? applicationDepartmentOther.trim() : undefined,
      accepted,
      inWarranty,
      freeReissue,
      approved,
      responsibleDepartment,
      responsibleDepartmentOther:
        responsibleDepartment === "other" ? responsibleDepartmentOther.trim() : undefined,
      requiredOutDate,
      oldPartReturn,
      freightBearer,
      recipient: recipient.trim(),
      phone: phone.trim(),
      address: address.trim(),
      description: description.trim(),
      materials: materials.map((row) => ({
        materialCode: row.materialCode.trim(),
        materialName: row.materialName.trim(),
        specification: row.specification.trim(),
        quantity: row.quantity,
        unit: row.unit.trim(),
        remark: row.remark.trim(),
      })),
    };
    setBusy(true);
    setError(null);
    try {
      const result = await createMaterialReissue(projectId, task.id, input);
      onSubmitted(result);
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "" ? caught.message : t("mr.err.submit"));
    } finally {
      setBusy(false);
    }
  };

  const boolOptions = (yesLabel: string, noLabel: string): SelectOption[] => [
    { value: "true", label: yesLabel },
    { value: "false", label: noLabel },
  ];
  const yesText = fieldText(locale, "是");
  const noText = fieldText(locale, "否");

  return (
    <div data-material-reissue-form="true" className="flex flex-col gap-4 py-4">
      <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-zinc-900">{t("mr.title")}</h3>
            <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{t("mr.autoHint")}</p>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            {t("mr.autoBadge")}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "项目编号")}</dt><dd className="mt-0.5 truncate text-zinc-800">{project?.code ?? "…"}</dd></div>
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "项目名称")}</dt><dd className="mt-0.5 truncate text-zinc-800">{project?.name ?? "…"}</dd></div>
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "客户名称")}</dt><dd className="mt-0.5 truncate text-zinc-800">{project?.customer ?? "—"}</dd></div>
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "来源任务")}</dt><dd className="mt-0.5 truncate text-zinc-800">{task.title}</dd></div>
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "申请人")}</dt><dd className="mt-0.5 truncate text-zinc-800">{applicantName}</dd></div>
          <div><dt className={LABEL_CLASS}>{fieldText(locale, "提交时间")}</dt><dd className="mt-0.5 text-zinc-800">{submittedAt}</dd></div>
        </dl>
        {projectError === null ? null : (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="min-w-0 flex-1">{projectError}</span>
            <button type="button" onClick={() => { setProjectTick((tick) => tick + 1); }} className="shrink-0 font-medium underline">
              {t("common.retry")}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
        <h3 className="text-xs font-medium text-zinc-500">{t("mr.section.basic")}</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <span className={LABEL_CLASS}>{fieldText(locale, "补发类别")} <span className="text-rose-500">*</span></span>
            <div className="mt-1"><SelectMenu value={reason} options={optionList(REASON_OPTIONS, locale)} onChange={(value) => { setReason(value as MaterialReissueReason); setError(null); }} ariaLabel={t("mr.reason.aria")} /></div>
          </div>
          {reason === "other" ? (
            <div className="col-span-2">
              <span className={LABEL_CLASS}>{t("mr.reasonOther")} <span className="text-rose-500">*</span></span>
              <input value={reasonOther} maxLength={100} onChange={(event) => { setReasonOther(event.target.value); setError(null); }} placeholder={t("mr.reasonOther.placeholder")} className={FIELD_CLASS + " mt-1"} />
            </div>
          ) : null}
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "申请部门")}</span>
            <div className="mt-1"><SelectMenu value={applicationDepartment} options={optionList(DEPARTMENT_OPTIONS, locale)} onChange={(value) => { setApplicationDepartment(value as MaterialReissueDepartment); setError(null); }} ariaLabel={t("mr.applicationDepartment.aria")} /></div>
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "责任归属部门")}</span>
            <div className="mt-1"><SelectMenu value={responsibleDepartment} options={optionList(DEPARTMENT_OPTIONS, locale)} onChange={(value) => { setResponsibleDepartment(value as MaterialReissueDepartment); setError(null); }} ariaLabel={t("mr.responsibleDepartment.aria")} /></div>
          </div>
          {applicationDepartment === "other" ? (
            <div className="col-span-2">
              <span className={LABEL_CLASS}>{t("mr.applicationDepartmentOther")} <span className="text-rose-500">*</span></span>
              <input value={applicationDepartmentOther} maxLength={100} onChange={(event) => { setApplicationDepartmentOther(event.target.value); setError(null); }} placeholder={t("mr.departmentOther.placeholder")} className={FIELD_CLASS + " mt-1"} />
            </div>
          ) : null}
          {responsibleDepartment === "other" ? (
            <div className="col-span-2">
              <span className={LABEL_CLASS}>{t("mr.responsibleDepartmentOther")} <span className="text-rose-500">*</span></span>
              <input value={responsibleDepartmentOther} maxLength={100} onChange={(event) => { setResponsibleDepartmentOther(event.target.value); setError(null); }} placeholder={t("mr.departmentOther.placeholder")} className={FIELD_CLASS + " mt-1"} />
            </div>
          ) : null}
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "是否已验收")}</span>
            <div className="mt-1"><SelectMenu value={String(accepted)} options={boolOptions(yesText, noText)} onChange={(value) => { setAccepted(value === "true"); setError(null); }} ariaLabel={t("mr.accepted.aria")} /></div>
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "是否质保期内")}</span>
            <div className="mt-1"><SelectMenu value={String(inWarranty)} options={boolOptions(yesText, noText)} onChange={(value) => { setInWarranty(value === "true"); setError(null); }} ariaLabel={t("mr.inWarranty.aria")} /></div>
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "是否免费补发")}</span>
            <div className="mt-1"><SelectMenu value={String(freeReissue)} options={boolOptions(yesText, noText)} onChange={(value) => { setFreeReissue(value === "true"); setError(null); }} ariaLabel={t("mr.freeReissue.aria")} /></div>
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "是否已审批")}</span>
            <div className="mt-1"><SelectMenu value={approved} options={optionList(APPROVAL_OPTIONS, locale)} onChange={(value) => { setApproved(value as MaterialReissueApproval); setError(null); }} ariaLabel={t("mr.approved.aria")} /></div>
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "要求出库时间")} <span className="text-rose-500">*</span></span>
            <input type="date" value={requiredOutDate} onChange={(event) => { setRequiredOutDate(event.target.value); setError(null); }} className={FIELD_CLASS + " mt-1"} />
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "是否涉及旧件返还")}</span>
            <div className="mt-1"><SelectMenu value={String(oldPartReturn)} options={boolOptions(yesText, noText)} onChange={(value) => { setOldPartReturn(value === "true"); setError(null); }} ariaLabel={t("mr.oldPartReturn.aria")} /></div>
          </div>
          <div className="col-span-2">
            <span className={LABEL_CLASS}>{fieldText(locale, "运费承担")}</span>
            <div className="mt-1"><SelectMenu value={freightBearer} options={optionList(FREIGHT_OPTIONS, locale)} onChange={(value) => { setFreightBearer(value as MaterialReissueFreight); setError(null); }} ariaLabel={t("mr.freight.aria")} /></div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
        <h3 className="text-xs font-medium text-zinc-500">{t("mr.section.shipping")}</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "收货人")} <span className="text-rose-500">*</span></span>
            <input value={recipient} maxLength={80} onChange={(event) => { setRecipient(event.target.value); setError(null); }} placeholder={t("mr.recipient.placeholder")} className={FIELD_CLASS + " mt-1"} />
          </div>
          <div>
            <span className={LABEL_CLASS}>{fieldText(locale, "联系电话")} <span className="text-rose-500">*</span></span>
            <input value={phone} maxLength={40} onChange={(event) => { setPhone(event.target.value); setError(null); }} placeholder={t("mr.phone.placeholder")} className={FIELD_CLASS + " mt-1"} />
          </div>
          <div className="col-span-2">
            <span className={LABEL_CLASS}>{fieldText(locale, "收货地址")} <span className="text-rose-500">*</span></span>
            <textarea value={address} maxLength={500} rows={2} onChange={(event) => { setAddress(event.target.value); setError(null); }} placeholder={t("mr.address.placeholder")} className={FIELD_CLASS + " mt-1 resize-none leading-5"} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium text-zinc-500">{t("mr.section.materials")}</h3>
          <button type="button" onClick={addMaterial} disabled={materials.length >= 200} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50">
            {t("mr.materials.add")}
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {materials.map((row, index) => (
            <div key={row.id} data-material-reissue-row={String(index + 1)} className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-zinc-500">{t("mr.materials.row", { n: String(index + 1) })}</span>
                {materials.length <= 1 ? null : (
                  <button type="button" onClick={() => removeMaterial(row.id)} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600">
                    {t("common.delete")}
                  </button>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "物料编码")}</span>
                  <input value={row.materialCode} maxLength={80} onChange={(event) => updateMaterial(row.id, { materialCode: event.target.value })} placeholder={t("mr.materialCode.placeholder")} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
                <div>
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "物料名称")} <span className="text-rose-500">*</span></span>
                  <input value={row.materialName} maxLength={200} onChange={(event) => updateMaterial(row.id, { materialName: event.target.value })} placeholder={t("mr.materialName.placeholder")} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
                <div className="col-span-2">
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "规格型号")}</span>
                  <input value={row.specification} maxLength={200} onChange={(event) => updateMaterial(row.id, { specification: event.target.value })} placeholder={t("mr.specification.placeholder")} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
                <div>
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "数量")} <span className="text-rose-500">*</span></span>
                  <input type="number" min="0" step="any" value={row.quantity} onChange={(event) => updateMaterial(row.id, { quantity: Number(event.target.value) })} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
                <div>
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "单位")} <span className="text-rose-500">*</span></span>
                  <input value={row.unit} maxLength={20} onChange={(event) => updateMaterial(row.id, { unit: event.target.value })} placeholder={t("mr.unit.placeholder")} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
                <div className="col-span-2">
                  <span className="text-[10px] text-zinc-400">{fieldText(locale, "备注")}</span>
                  <input value={row.remark} maxLength={200} onChange={(event) => updateMaterial(row.id, { remark: event.target.value })} placeholder={t("mr.remark.placeholder")} className={FIELD_CLASS + " mt-0.5 px-2 py-1.5 text-xs"} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
        <h3 className="text-xs font-medium text-zinc-500">{t("mr.section.reason")}</h3>
        <span className={LABEL_CLASS + " mt-2 block"}>{fieldText(locale, "补发原因简述")} <span className="text-rose-500">*</span></span>
        <textarea value={description} maxLength={2000} rows={3} onChange={(event) => { setDescription(event.target.value); setError(null); }} placeholder={t("mr.description.placeholder")} className={FIELD_CLASS + " mt-1 resize-none leading-5"} />
      </section>

      <section className="flex flex-col gap-2 border-t border-zinc-100 pt-4">
        <p className={CAPTION_CLASS}>{t("mr.footnote")}</p>
        {error === null ? null : <p data-material-reissue-error="true" className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{error}</p>}
        <button type="button" data-material-reissue-submit="true" onClick={() => { void submit(); }} disabled={busy || project === null} className="w-full rounded-lg bg-zinc-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300">
          {busy ? t("mr.submitting") : t("mr.submit")}
        </button>
      </section>
    </div>
  );
}
