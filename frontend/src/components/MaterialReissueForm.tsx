import { useEffect, useRef, useState, type ReactNode } from "react";
import { memberNameOf, type Member } from "../data/members";
import type { ProjectTask } from "../data/tasks";
import {
  createMaterialReissue,
  type MaterialReissueApplicationDepartment,
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
import {
  MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS,
  MATERIAL_REISSUE_APPROVAL_OPTIONS,
  MATERIAL_REISSUE_FREIGHT_OPTIONS,
  MATERIAL_REISSUE_REASON_OPTIONS,
  MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS,
  materialReissueDefaultEmailTitle,
} from "../materialReissue";

type MaterialDraft = MaterialReissueLine & { id: number };

const CELL_INPUT =
  "w-full bg-transparent px-2 py-1.5 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-300 focus:bg-amber-50/70";
const CELL_TEXTAREA =
  "w-full resize-y bg-transparent px-2 py-1.5 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-300 focus:bg-amber-50/70";
const TABLE_CELL = "border border-zinc-400 px-2 py-1.5 align-middle";
const LABEL_CELL = "w-[104px] border border-zinc-400 bg-zinc-50 px-2 py-1.5 text-left align-middle text-xs font-normal text-zinc-600 sm:w-[124px]";

function blankMaterial(id: number): MaterialDraft {
  return { id, materialCode: "", materialName: "", specification: "", quantity: 1, unit: "个", remark: "" };
}

function slashDate(value: string): string {
  return value.trim() === "" ? "" : value.replace(/-/g, "/");
}

function TemplateCheck({
  checked,
  label,
  name,
  value,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  label: string;
  name: string;
  value?: string;
  onChange: () => void;
  ariaLabel?: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap text-sm leading-6 text-zinc-800">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        aria-label={ariaLabel ?? label}
        className="sr-only"
      />
      <span aria-hidden="true" className={"text-[15px] leading-none " + (checked ? "text-zinc-900" : "text-zinc-400")}>
        {checked ? "☑" : "☐"}
      </span>
      <span>{label}</span>
    </label>
  );
}

function FormRow({
  label,
  children,
  required = false,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <tr>
      <th scope="row" className={LABEL_CELL}>
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </th>
      <td className={TABLE_CELL}>{children}</td>
    </tr>
  );
}

function ReadOnlyValue({ value }: { value: string }) {
  return <span className="block px-2 py-1.5 text-sm leading-5 text-zinc-800">{value === "" ? "—" : value}</span>;
}

function ChoiceGroup({
  name,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  name: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
      {options.map((option) => (
        <TemplateCheck
          key={option.value}
          name={name}
          value={option.value}
          checked={value === option.value}
          label={option.label}
          onChange={() => { onChange(option.value); }}
        />
      ))}
    </div>
  );
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
  const [emailTitleDraft, setEmailTitleDraft] = useState<string | null>(null);
  const [customerNameDraft, setCustomerNameDraft] = useState<string | null>(null);
  const [reason, setReason] = useState<MaterialReissueReason>("missing_list");
  const [reasonOther, setReasonOther] = useState("");
  const [applicationDepartment, setApplicationDepartment] = useState<MaterialReissueApplicationDepartment>("project");
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

  useEffect(() => {
    setEmailTitleDraft(null);
    setCustomerNameDraft(null);
  }, [projectId, task.id]);

  const defaultEmailTitle = project === null ? "…" : materialReissueDefaultEmailTitle(project.code, project.name);
  const emailTitle = emailTitleDraft ?? defaultEmailTitle;
  const customerName = customerNameDraft ?? project?.customer ?? "";

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
    if (emailTitle.trim() === "") {
      setError(t("mr.err.emailTitle"));
      return;
    }
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
      emailTitle: emailTitle.trim(),
      customerName: customerName.trim(),
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

  const yesNoOptions = [
    { value: "true", label: fieldText(locale, "是") },
    { value: "false", label: fieldText(locale, "否") },
  ];
  const approvalOptions = MATERIAL_REISSUE_APPROVAL_OPTIONS.map((option) => ({
    value: option.value,
    label: fieldText(locale, option.label),
  }));
  const freightOptions = MATERIAL_REISSUE_FREIGHT_OPTIONS.map((option) => ({
    value: option.value,
    label: fieldText(locale, option.label),
  }));

  return (
    <div data-material-reissue-form="true" className="flex flex-col gap-4 py-4">
      <section className="rounded-xl border border-zinc-200 bg-white p-3 sm:p-5">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-300 pb-2">
          <img src="/libiao-logo.svg" alt="Libiao Robotics" className="h-7 w-auto max-w-[150px]" />
          <span className="text-right text-[11px] leading-4 text-zinc-500">{t("mr.form.company")}</span>
        </div>

        <h3 className="mt-4 text-center text-lg font-bold tracking-wide text-zinc-900">{t("mr.title")}</h3>
        <div className="mt-3 flex min-w-0 items-center gap-1 text-[13px] font-bold leading-6 text-zinc-900">
          <span className="shrink-0">{t("mr.form.emailLabel")}</span>
          <input
            data-material-reissue-email-title="true"
            value={emailTitle}
            maxLength={500}
            onChange={(event) => { setEmailTitleDraft(event.target.value); setError(null); }}
            aria-label={t("mr.form.emailLabel")}
            className="min-w-0 flex-1 bg-transparent px-1 py-0.5 font-bold text-zinc-900 outline-none focus:bg-amber-50/70"
          />
        </div>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-2 text-[10px] leading-4 text-zinc-400">
          <span className="min-w-0 flex-1">{t("mr.autoHint")}</span>
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">{t("mr.autoBadge")}</span>
        </div>

        {projectError === null ? null : (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="min-w-0 flex-1">{projectError}</span>
            <button type="button" onClick={() => { setProjectTick((tick) => tick + 1); }} className="shrink-0 font-medium underline">
              {t("common.retry")}
            </button>
          </div>
        )}

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[104px] sm:w-[124px]" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-2 py-1.5 text-center text-xs font-bold text-zinc-800">{fieldText(locale, "项目")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-2 py-1.5 text-center text-xs font-bold text-zinc-800">{t("mr.form.valueHeader")}</th>
              </tr>
            </thead>
            <tbody>
              <FormRow label={fieldText(locale, "项目编号")}>
                <ReadOnlyValue value={project?.code ?? "…"} />
              </FormRow>
              <FormRow label={fieldText(locale, "项目名称")}>
                <ReadOnlyValue value={project?.name ?? "…"} />
              </FormRow>
              <FormRow label={fieldText(locale, "客户名称")}>
                <input
                  data-material-reissue-customer-name="true"
                  value={customerName}
                  maxLength={200}
                  onChange={(event) => { setCustomerNameDraft(event.target.value); setError(null); }}
                  aria-label={fieldText(locale, "客户名称")}
                  placeholder="—"
                  className={CELL_INPUT}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "申请部门")} required>
                <div role="radiogroup" aria-label={t("mr.applicationDepartment.aria")} className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  {MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS.map((option) => (
                    <TemplateCheck
                      key={option.value}
                      name="material-reissue-application-department"
                      value={option.value}
                      checked={applicationDepartment === option.value}
                      label={fieldText(locale, option.label) + (option.value === "other" ? "：" : "")}
                      onChange={() => { setApplicationDepartment(option.value); setError(null); }}
                    />
                  ))}
                  {applicationDepartment === "other" ? (
                    <input
                      value={applicationDepartmentOther}
                      maxLength={100}
                      onChange={(event) => { setApplicationDepartmentOther(event.target.value); setError(null); }}
                      placeholder={t("mr.form.otherPlaceholder")}
                      aria-label={t("mr.applicationDepartmentOther")}
                      className="h-7 w-36 border-b border-zinc-400 bg-transparent px-1 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-900"
                    />
                  ) : (
                    <span className="text-sm text-zinc-300">______</span>
                  )}
                </div>
              </FormRow>
              <FormRow label={fieldText(locale, "申请人")}>
                <ReadOnlyValue value={applicantName} />
              </FormRow>
              <FormRow label={fieldText(locale, "补发类别")} required>
                <div role="radiogroup" aria-label={t("mr.reason.aria")} className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  {MATERIAL_REISSUE_REASON_OPTIONS.map((option) => (
                    <TemplateCheck
                      key={option.value}
                      name="material-reissue-reason"
                      value={option.value}
                      checked={reason === option.value}
                      label={fieldText(locale, option.label) + (option.value === "other" ? "：" : "")}
                      onChange={() => { setReason(option.value); setError(null); }}
                    />
                  ))}
                  {reason === "other" ? (
                    <input
                      value={reasonOther}
                      maxLength={100}
                      onChange={(event) => { setReasonOther(event.target.value); setError(null); }}
                      placeholder={t("mr.form.otherPlaceholder")}
                      aria-label={t("mr.reasonOther")}
                      className="h-7 w-40 border-b border-zinc-400 bg-transparent px-1 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-900"
                    />
                  ) : (
                    <span className="text-sm text-zinc-300">______</span>
                  )}
                </div>
              </FormRow>
              <FormRow label={fieldText(locale, "是否已验收")} required>
                <ChoiceGroup
                  name="material-reissue-accepted"
                  value={accepted ? "true" : "false"}
                  options={yesNoOptions}
                  onChange={(value) => { setAccepted(value === "true"); setError(null); }}
                  ariaLabel={t("mr.accepted.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "是否质保期内")} required>
                <ChoiceGroup
                  name="material-reissue-in-warranty"
                  value={inWarranty ? "true" : "false"}
                  options={yesNoOptions}
                  onChange={(value) => { setInWarranty(value === "true"); setError(null); }}
                  ariaLabel={t("mr.inWarranty.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "是否免费补发")} required>
                <ChoiceGroup
                  name="material-reissue-free"
                  value={freeReissue ? "true" : "false"}
                  options={yesNoOptions}
                  onChange={(value) => { setFreeReissue(value === "true"); setError(null); }}
                  ariaLabel={t("mr.freeReissue.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "是否已审批")} required>
                <ChoiceGroup
                  name="material-reissue-approved"
                  value={approved}
                  options={approvalOptions}
                  onChange={(value) => { setApproved(value as MaterialReissueApproval); setError(null); }}
                  ariaLabel={t("mr.approved.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "责任归属部门")} required>
                <div role="radiogroup" aria-label={t("mr.responsibleDepartment.aria")} className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  {MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS.map((option) => (
                    <TemplateCheck
                      key={option.value}
                      name="material-reissue-responsible-department"
                      value={option.value}
                      checked={responsibleDepartment === option.value}
                      label={fieldText(locale, option.label) + (option.value === "other" ? "：" : "")}
                      onChange={() => { setResponsibleDepartment(option.value); setError(null); }}
                    />
                  ))}
                  {responsibleDepartment === "other" ? (
                    <input
                      value={responsibleDepartmentOther}
                      maxLength={100}
                      onChange={(event) => { setResponsibleDepartmentOther(event.target.value); setError(null); }}
                      placeholder={t("mr.form.otherPlaceholder")}
                      aria-label={t("mr.responsibleDepartmentOther")}
                      className="h-7 w-36 border-b border-zinc-400 bg-transparent px-1 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-900"
                    />
                  ) : (
                    <span className="text-sm text-zinc-300">______</span>
                  )}
                </div>
              </FormRow>
              <FormRow label={fieldText(locale, "要求出库时间")} required>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={requiredOutDate}
                    onChange={(event) => { setRequiredOutDate(event.target.value); setError(null); }}
                    aria-label={fieldText(locale, "要求出库时间")}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-zinc-500"
                  />
                  <span className="text-xs tabular-nums text-zinc-500">{requiredOutDate === "" ? "YYYY/MM/DD" : slashDate(requiredOutDate)}</span>
                </div>
              </FormRow>
              <FormRow label={fieldText(locale, "是否涉及旧件返还")} required>
                <ChoiceGroup
                  name="material-reissue-old-part"
                  value={oldPartReturn ? "true" : "false"}
                  options={yesNoOptions}
                  onChange={(value) => { setOldPartReturn(value === "true"); setError(null); }}
                  ariaLabel={t("mr.oldPartReturn.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "运费承担")} required>
                <ChoiceGroup
                  name="material-reissue-freight"
                  value={freightBearer}
                  options={freightOptions}
                  onChange={(value) => { setFreightBearer(value as MaterialReissueFreight); setError(null); }}
                  ariaLabel={t("mr.freight.aria")}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "收货人")} required>
                <input
                  value={recipient}
                  maxLength={80}
                  onChange={(event) => { setRecipient(event.target.value); setError(null); }}
                  placeholder={t("mr.recipient.placeholder")}
                  className={CELL_INPUT}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "联系电话")} required>
                <input
                  type="tel"
                  value={phone}
                  maxLength={40}
                  onChange={(event) => { setPhone(event.target.value); setError(null); }}
                  placeholder={t("mr.phone.placeholder")}
                  className={CELL_INPUT}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "收货地址")} required>
                <textarea
                  value={address}
                  maxLength={500}
                  rows={2}
                  onChange={(event) => { setAddress(event.target.value); setError(null); }}
                  placeholder={t("mr.address.placeholder")}
                  className={CELL_TEXTAREA}
                />
              </FormRow>
              <FormRow label={fieldText(locale, "补发原因简述")} required>
                <textarea
                  value={description}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => { setDescription(event.target.value); setError(null); }}
                  placeholder={t("mr.description.placeholder")}
                  className={CELL_TEXTAREA}
                />
              </FormRow>
            </tbody>
          </table>
        </div>

        <h4 className="mt-5 text-sm font-bold text-zinc-900">{fieldText(locale, "补发物料清单")}</h4>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed border-collapse text-xs">
            <colgroup>
              <col className="w-[48px]" />
              <col className="w-[128px]" />
              <col className="w-[148px]" />
              <col className="w-[148px]" />
              <col className="w-[72px]" />
              <col className="w-[64px]" />
              <col className="w-[112px]" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "序号")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "物料编码")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "物料名称")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "规格型号")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "数量")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "单位")}</th>
                <th scope="col" className="border border-zinc-400 bg-zinc-100 px-1 py-1.5 text-center font-bold">{fieldText(locale, "备注")}</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((row, index) => (
                <tr key={row.id} data-material-reissue-row={String(index + 1)}>
                  <td className="border border-zinc-400 px-1 py-1 text-center align-middle">
                    <span className="mr-1 tabular-nums text-zinc-600">{String(index + 1)}</span>
                    {materials.length <= 1 ? null : (
                      <button
                        type="button"
                        onClick={() => { removeMaterial(row.id); }}
                        aria-label={t("mr.form.removeMaterial")}
                        title={t("mr.form.removeMaterial")}
                        className="text-[10px] leading-none text-zinc-300 transition hover:text-rose-600"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input value={row.materialCode} maxLength={80} onChange={(event) => { updateMaterial(row.id, { materialCode: event.target.value }); }} placeholder={t("mr.materialCode.placeholder")} aria-label={fieldText(locale, "物料编码")} className={CELL_INPUT + " text-xs"} />
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input value={row.materialName} maxLength={200} onChange={(event) => { updateMaterial(row.id, { materialName: event.target.value }); }} placeholder={t("mr.materialName.placeholder")} aria-label={fieldText(locale, "物料名称")} className={CELL_INPUT + " text-xs"} />
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input value={row.specification} maxLength={200} onChange={(event) => { updateMaterial(row.id, { specification: event.target.value }); }} placeholder={t("mr.specification.placeholder")} aria-label={fieldText(locale, "规格型号")} className={CELL_INPUT + " text-xs"} />
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input type="number" min="0" step="any" value={row.quantity} onChange={(event) => { updateMaterial(row.id, { quantity: Number(event.target.value) }); }} aria-label={fieldText(locale, "数量")} className={CELL_INPUT + " text-center text-xs"} />
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input value={row.unit} maxLength={20} onChange={(event) => { updateMaterial(row.id, { unit: event.target.value }); }} placeholder={t("mr.unit.placeholder")} aria-label={fieldText(locale, "单位")} className={CELL_INPUT + " text-center text-xs"} />
                  </td>
                  <td className="border border-zinc-400 px-1 py-1 align-middle">
                    <input value={row.remark} maxLength={200} onChange={(event) => { updateMaterial(row.id, { remark: event.target.value }); }} placeholder={t("mr.remark.placeholder")} aria-label={fieldText(locale, "备注")} className={CELL_INPUT + " text-xs"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={addMaterial}
          className="mt-2 rounded-md border border-dashed border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-zinc-400 hover:text-zinc-900"
        >
          {t("mr.materials.add")}
        </button>

        <div className="mt-4 text-xs leading-6 text-zinc-700">
          <p className="font-bold text-zinc-900">{t("mr.form.notesTitle")}</p>
          <ol className="mt-1 list-decimal pl-6">
            <li>{t("mr.form.note1")}</li>
            <li>{t("mr.form.note2")}</li>
            <li>{t("mr.form.note3")}</li>
            <li>{t("mr.form.note4")}</li>
          </ol>
        </div>

        <div className="mt-4 flex flex-col gap-2 border-t border-zinc-200 pt-3">
          {error === null ? null : <p data-material-reissue-error="true" className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">{error}</p>}
          <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center">
            <p className="text-[10px] leading-4 text-zinc-400">{t("mr.footnote")}</p>
            <button
              type="button"
              data-material-reissue-submit="true"
              onClick={() => { void submit(); }}
              disabled={busy || project === null}
              className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {busy ? t("mr.submitting") : t("mr.submit")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
