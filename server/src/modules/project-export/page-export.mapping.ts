import {
  ISSUE_STATE_NAMES,
  STAKEHOLDER_COMPANY_TYPE_NAMES,
  type DailyReport,
  type Issue,
  type Stakeholder,
} from "@libiaolink/contracts";
import type { ExportPhotoRef } from "./project-export.workbook.js";
import { formatReportDay } from "./project-export.workbook.js";
import { personLabel, type ProjectExportUserLabel } from "./project-export.mapping.js";

export type PageExportCellValue = string | number | null;

export interface PageExportMappedRow {
  values: Readonly<Record<string, PageExportCellValue>>;
  photos: Readonly<Record<string, readonly ExportPhotoRef[]>>;
}

function photoRefs(values: readonly { fileId: string; name: string }[]): ExportPhotoRef[] {
  return values.map((value) => ({ fileId: value.fileId, name: value.name }));
}

function joined(values: readonly string[]): string {
  return values.filter((value, index) => value !== "" && values.indexOf(value) === index).join("、");
}

/** 日报记录：一篇日报一行；关联阶段取页面上的阶段名，不展开成任务或问题行。 */
export function pageReportRow(report: DailyReport, users: ReadonlyMap<string, ProjectExportUserLabel>): PageExportMappedRow {
  return {
    values: {
      date: formatReportDay(report.date),
      author: personLabel(report.authorId, report.authorName, users),
      stageNames: joined(report.stageNames),
      doneWork: report.doneWork,
      plan: report.plan ?? "",
    },
    photos: { photos: photoRefs(report.photos) },
  };
}

/** 问题追踪：一条问题一行；不挂到来源日报行，避免与旧「日报及问题汇总」的合并口径混用。 */
export function pageIssueRow(issue: Issue, users: ReadonlyMap<string, ProjectExportUserLabel>): PageExportMappedRow {
  return {
    values: {
      raisedAt: formatReportDay(issue.raisedAt),
      title: issue.title,
      categories: joined(issue.categories),
      owner: personLabel(issue.ownerId, issue.ownerName, users),
      solution: issue.solution ?? "",
      state: ISSUE_STATE_NAMES[issue.state],
    },
    photos: { photos: photoRefs(issue.photos) },
  };
}

/** 干系人：电话 / 微信分开导出；公司分类 + 具体公司名合并为页面「所属公司」列。 */
export function pageStakeholderRow(item: Stakeholder, users: ReadonlyMap<string, ProjectExportUserLabel>): PageExportMappedRow {
  const companyType = STAKEHOLDER_COMPANY_TYPE_NAMES[item.companyType] ?? item.companyType;
  const companyName = item.company ?? "";
  return {
    values: {
      name: item.name,
      phone: item.phone ?? "",
      wechat: item.wechat ?? "",
      email: item.email ?? "",
      title: item.title ?? "",
      company: companyName === "" ? companyType : companyType + " / " + companyName,
      createdBy: personLabel(item.createdBy, item.createdByName, users),
      role: item.role ?? "",
    },
    photos: {},
  };
}

export function pageExportPhotoIds(rows: readonly PageExportMappedRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const refs of Object.values(row.photos)) {
      for (const ref of refs) ids.add(ref.fileId);
    }
  }
  return [...ids];
}
