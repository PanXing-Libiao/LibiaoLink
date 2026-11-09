import type {
  MaterialReissueApproval,
  MaterialReissueDepartment,
  MaterialReissueFreight,
  MaterialReissueReason,
  MaterialReissueSnapshot,
} from "./fileApi";
import { fieldText, type Locale } from "./i18n";

export const MATERIAL_REISSUE_REASON_OPTIONS: ReadonlyArray<{ value: MaterialReissueReason; label: string }> = [
  { value: "missing_list", label: "设备清单/机械清单漏出" },
  { value: "transport_damage", label: "运输过程损坏" },
  { value: "warehouse_shortage", label: "仓库漏发" },
  { value: "customer_misoperation", label: "客户误操作损坏" },
  { value: "customer_change", label: "客户需求变更" },
  { value: "warranty_damage", label: "物料损坏质保期内" },
  { value: "out_of_warranty_damage", label: "物料损坏质保期外" },
  { value: "research_upgrade", label: "产品研发升级更换" },
  { value: "other", label: "其他" },
];

export const MATERIAL_REISSUE_DEPARTMENT_OPTIONS: ReadonlyArray<{ value: MaterialReissueDepartment; label: string }> = [
  { value: "project", label: "项目部" },
  { value: "after_sales", label: "售后部" },
  { value: "warehouse", label: "仓库" },
  { value: "research", label: "研发" },
  { value: "customer", label: "客户" },
  { value: "supplier", label: "供应商" },
  { value: "other", label: "其他" },
];

export const MATERIAL_REISSUE_FREIGHT_OPTIONS: ReadonlyArray<{ value: MaterialReissueFreight; label: string }> = [
  { value: "customer", label: "客户" },
  { value: "libiao", label: "立镖" },
  { value: "with_other_goods", label: "随其他货物一并发出" },
  { value: "carried_by_staff", label: "立镖人员带过去" },
];

export const MATERIAL_REISSUE_APPROVAL_OPTIONS: ReadonlyArray<{ value: MaterialReissueApproval; label: string }> = [
  { value: "yes", label: "是" },
  { value: "no", label: "否" },
  { value: "not_applicable", label: "不涉及" },
];

export function materialReissueReasonText(locale: Locale, snapshot: MaterialReissueSnapshot): string {
  const label = MATERIAL_REISSUE_REASON_OPTIONS.find((option) => option.value === snapshot.reason)?.label ?? snapshot.reason;
  const text = fieldText(locale, label);
  return snapshot.reason === "other" && snapshot.reasonOther ? text + "：" + snapshot.reasonOther : text;
}

export function materialReissueDepartmentText(locale: Locale, value: MaterialReissueDepartment, other?: string): string {
  const label = MATERIAL_REISSUE_DEPARTMENT_OPTIONS.find((option) => option.value === value)?.label ?? value;
  const text = fieldText(locale, label);
  return value === "other" && other ? text + "：" + other : text;
}

export function materialReissueFreightText(locale: Locale, value: MaterialReissueFreight): string {
  const label = MATERIAL_REISSUE_FREIGHT_OPTIONS.find((option) => option.value === value)?.label ?? value;
  return fieldText(locale, label);
}

export function materialReissueApprovalText(locale: Locale, value: MaterialReissueApproval): string {
  return fieldText(locale, value === "yes" ? "是" : value === "no" ? "否" : "不涉及");
}
