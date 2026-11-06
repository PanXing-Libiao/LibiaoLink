import {
  PAGE_EXPORT_COLUMN_KEYS,
  PAGE_EXPORT_COLUMN_LABELS,
  PAGE_EXPORT_SHEET_KEYS,
  PAGE_EXPORT_SHEET_LABELS,
  type PageExportSheetKey,
  type PermissionKey,
} from "@libiaolink/contracts";

/** 页面导出列：列顺序 / 中文表头 / Excel 列宽 / 是否图片列 / 字段级权限。 */
export interface PageExportColumnDefinition {
  key: string;
  label: string;
  width: number;
  photo: boolean;
  permission?: PermissionKey;
}

export interface PageExportSheetDefinition {
  key: PageExportSheetKey;
  label: string;
  permission: PermissionKey;
  defaultColumns: readonly string[];
  columns: readonly PageExportColumnDefinition[];
}

const REPORT_COLUMNS: readonly PageExportColumnDefinition[] = [
  { key: "date", label: PAGE_EXPORT_COLUMN_LABELS.reports.date, width: 14, photo: false },
  { key: "author", label: PAGE_EXPORT_COLUMN_LABELS.reports.author, width: 18, photo: false },
  { key: "stageNames", label: PAGE_EXPORT_COLUMN_LABELS.reports.stageNames, width: 24, photo: false },
  { key: "doneWork", label: PAGE_EXPORT_COLUMN_LABELS.reports.doneWork, width: 42, photo: false },
  { key: "plan", label: PAGE_EXPORT_COLUMN_LABELS.reports.plan, width: 36, photo: false },
  { key: "photos", label: PAGE_EXPORT_COLUMN_LABELS.reports.photos, width: 58, photo: true },
];

const ISSUE_COLUMNS: readonly PageExportColumnDefinition[] = [
  { key: "raisedAt", label: PAGE_EXPORT_COLUMN_LABELS.issues.raisedAt, width: 14, photo: false },
  { key: "title", label: PAGE_EXPORT_COLUMN_LABELS.issues.title, width: 40, photo: false },
  { key: "categories", label: PAGE_EXPORT_COLUMN_LABELS.issues.categories, width: 22, photo: false },
  { key: "owner", label: PAGE_EXPORT_COLUMN_LABELS.issues.owner, width: 18, photo: false },
  { key: "solution", label: PAGE_EXPORT_COLUMN_LABELS.issues.solution, width: 36, photo: false },
  { key: "photos", label: PAGE_EXPORT_COLUMN_LABELS.issues.photos, width: 42, photo: true },
  { key: "state", label: PAGE_EXPORT_COLUMN_LABELS.issues.state, width: 15, photo: false },
];

const STAKEHOLDER_COLUMNS: readonly PageExportColumnDefinition[] = [
  { key: "name", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.name, width: 22, photo: false },
  { key: "phone", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.phone, width: 20, photo: false, permission: "stakeholder.contact.view" },
  { key: "wechat", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.wechat, width: 18, photo: false, permission: "stakeholder.contact.view" },
  { key: "email", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.email, width: 30, photo: false, permission: "stakeholder.contact.view" },
  { key: "title", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.title, width: 28, photo: false, permission: "stakeholder.view" },
  { key: "company", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.company, width: 28, photo: false, permission: "stakeholder.view" },
  { key: "createdBy", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.createdBy, width: 18, photo: false },
  { key: "role", label: PAGE_EXPORT_COLUMN_LABELS.stakeholders.role, width: 18, photo: false },
];

export const PAGE_EXPORT_SHEETS: readonly PageExportSheetDefinition[] = [
  {
    key: "reports",
    label: PAGE_EXPORT_SHEET_LABELS.reports,
    permission: "report.view",
    defaultColumns: PAGE_EXPORT_COLUMN_KEYS.reports,
    columns: REPORT_COLUMNS,
  },
  {
    key: "issues",
    label: PAGE_EXPORT_SHEET_LABELS.issues,
    permission: "issue.view",
    defaultColumns: PAGE_EXPORT_COLUMN_KEYS.issues,
    columns: ISSUE_COLUMNS,
  },
  {
    key: "stakeholders",
    label: PAGE_EXPORT_SHEET_LABELS.stakeholders,
    permission: "stakeholder.view",
    defaultColumns: PAGE_EXPORT_COLUMN_KEYS.stakeholders,
    columns: STAKEHOLDER_COLUMNS,
  },
];

const SHEET_BY_KEY = new Map(PAGE_EXPORT_SHEETS.map((sheet) => [sheet.key, sheet]));

export function pageExportSheetDefinition(key: PageExportSheetKey): PageExportSheetDefinition {
  const definition = SHEET_BY_KEY.get(key);
  if (definition === undefined) throw new Error("未知页面导出 Sheet：" + key);
  return definition;
}

export function pageExportColumnDefinition(sheet: PageExportSheetDefinition, key: string): PageExportColumnDefinition {
  const definition = sheet.columns.find((column) => column.key === key);
  if (definition === undefined) throw new Error("未知页面导出列：" + sheet.key + "/" + key);
  return definition;
}

export function pageExportDefinitionOrder(): readonly PageExportSheetKey[] {
  return PAGE_EXPORT_SHEET_KEYS;
}
