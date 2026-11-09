/**
 * 页面级 Excel 导出（日报记录 / 问题追踪 / 干系人）。
 * - GET  catalog：按当前账号权限返回可选 Sheet、列、默认勾选、记录数与最多 20 条中文预览行。
 * - POST          ：提交 1～3 个 Sheet 的列 key，返回中文多 Sheet xlsx；列只表达选择，服务端固定按目录顺序生成。
 * 导出方案不绑定项目，存 user_preferences.prefs.pageExportPresets，见 preferencesApi.ts。
 */
import { apiDownload, apiRequest } from "./api";

export const PAGE_EXPORT_SHEET_KEYS = ["reports", "issues", "stakeholders"] as const;
export type PageExportSheetKey = (typeof PAGE_EXPORT_SHEET_KEYS)[number];

export type PageExportCatalogColumn = {
  key: string;
  label: string;
  allowed: boolean;
};

/** 与 shared/src/modules/page-exports.ts 的 PAGE_EXPORT_PREVIEW_* 保持同值；前端不直接依赖契约包。 */
export const PAGE_EXPORT_PREVIEW_ROW_LIMIT = 20;
export const PAGE_EXPORT_PREVIEW_PHOTO_LIMIT = 4;

export type PageExportPreviewPhoto = {
  fileId: string;
  name: string;
};

export type PageExportPreviewPhotoCell = {
  kind: "photos";
  total: number;
  items: PageExportPreviewPhoto[];
};

export type PageExportPreviewCell = string | number | null | PageExportPreviewPhotoCell;
export type PageExportPreviewRow = Record<string, PageExportPreviewCell>;

export type PageExportCatalogSheet = {
  key: PageExportSheetKey;
  label: string;
  allowed: boolean;
  rowCount: number;
  defaultColumns: string[];
  columns: PageExportCatalogColumn[];
  previewRows: PageExportPreviewRow[];
};

export type PageExportCatalogResponse = {
  sheets: PageExportCatalogSheet[];
};

export type PageExportSheetSelection = {
  sheet: PageExportSheetKey;
  columns: string[];
};

export type PageExportPreset = {
  id: string;
  name: string;
  sheets: PageExportSheetSelection[];
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function fetchPageExportCatalog(projectId: string): Promise<PageExportCatalogResponse> {
  return apiRequest<PageExportCatalogResponse>("/api/v1/projects/" + encodeURIComponent(projectId) + "/page-exports/catalog");
}

/** 下载多 Sheet xlsx：origin 显式回传，供流式模式把附图单元格链接到项目文件视图。 */
export async function downloadPageExport(projectId: string, sheets: PageExportSheetSelection[]): Promise<void> {
  const response = await apiDownload("/api/v1/projects/" + encodeURIComponent(projectId) + "/page-exports", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: XLSX_MIME },
    body: JSON.stringify({ origin: window.location.origin, sheets }),
  });
  const objectUrl = URL.createObjectURL(response.blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = response.fileName ?? "页面导出.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
