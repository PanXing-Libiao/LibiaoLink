/**
 * 附图 / 成对删除的模块替身（report-issue.links 的内存实现 · Push 215）：
 * 单测验证服务编排，SQL 边界用本替身承接（kind 区分 onsite / issue、问题图转挂、成对删除）。
 * 用法（在各测试文件内）：
 *   import { photoStore } from "./fakes/report-issue-links.fake.js";
 *   vi.mock("../src/modules/report-issue/report-issue.links.js", async () => {
 *     const { createReportIssueLinksFake } = await import("./fakes/report-issue-links.fake.js");
 *     return createReportIssueLinksFake();
 *   });
 * 真机口径见 server/README.md「M6-01 ~ M6-03」与 server/src/modules/report-issue/README.md。
 */
import { AppError } from "../../src/common/errors/app-error.js";

export interface FilePhotoRef {
  fileId: string;
  name: string;
}

interface LinkRow {
  fileId: string;
  objectType: string;
  objectId: string;
  kind: string;
}

/** 内存链路状态：files = 文件表替身（只校验 projectId），links = file_links 表替身（插入序）。 */
export const photoStore = {
  files: new Map<string, { name: string; projectId: string }>(),
  links: [] as LinkRow[],
  calls: {
    loadReportPhotos: [] as string[][],
    loadIssuePhotos: [] as string[][],
  },
  /** 成对删除钩子：由用例接到假仓储上，保持「删日报 = 连派生问题」「删问题 = 连来源日报」语义一致。 */
  hooks: {
    issueIdsByReport: (_reportId: string): string[] => [],
    onIssuesPurged: (_issueIds: string[]): void => {},
    onReportPurged: (_reportId: string): void => {},
  },
  reset(): void {
    photoStore.files.clear();
    photoStore.links.length = 0;
    photoStore.calls.loadReportPhotos.length = 0;
    photoStore.calls.loadIssuePhotos.length = 0;
    photoStore.hooks.issueIdsByReport = () => [];
    photoStore.hooks.onIssuesPurged = () => {};
    photoStore.hooks.onReportPurged = () => {};
  },
  seedFile(fileId: string, name: string, projectId: string): void {
    photoStore.files.set(fileId, { name, projectId });
  },
  refs(objectType: string, objectId: string, kind?: string): FilePhotoRef[] {
    return photoStore.links
      .filter(
        (link) =>
          link.objectType === objectType && link.objectId === objectId && (kind === undefined || link.kind === kind),
      )
      .map((link) => ({ fileId: link.fileId, name: photoStore.files.get(link.fileId)?.name ?? "" }));
  },
};

/** 构造 report-issue.links 的模块替身（vi.mock 工厂返回值）。 */
export function createReportIssueLinksFake() {
  const drop = (objectType: string, objectId: string, kind?: string): void => {
    photoStore.links = photoStore.links.filter(
      (link) =>
        !(
          link.objectType === objectType &&
          link.objectId === objectId &&
          (kind === undefined || link.kind === kind)
        ),
    );
  };
  const insert = (objectType: string, objectId: string, kind: string, fileIds: readonly string[]): void => {
    for (const fileId of fileIds) {
      const exists = photoStore.links.some(
        (link) =>
          link.objectType === objectType && link.objectId === objectId && link.kind === kind && link.fileId === fileId,
      );
      if (!exists) photoStore.links.push({ fileId, objectType, objectId, kind });
    }
  };
  const purgeIssues = async (issueIds: readonly string[]): Promise<void> => {
    const ids = [...issueIds];
    photoStore.links = photoStore.links.filter((link) => !(link.objectType === "issue" && ids.includes(link.objectId)));
    photoStore.hooks.onIssuesPurged(ids);
  };
  const purgeReportCascade = async (reportId: string): Promise<string[]> => {
    const issueIds = photoStore.hooks.issueIdsByReport(reportId);
    await purgeIssues(issueIds);
    drop("report", reportId);
    photoStore.hooks.onReportPurged(reportId);
    return issueIds;
  };
  return {
    assertPhotoFilesInProject: async (projectId: string, fileIds: readonly string[]) => {
      const unique = [...new Set(fileIds)];
      const missing = unique.filter((id) => photoStore.files.get(id)?.projectId !== projectId);
      if (missing.length > 0) {
        throw new AppError(
          "VALIDATION_FAILED",
          "附图文件不存在 / 不属于本项目，或已进回收站",
          missing.map((id) => ({ code: "unknown_file", message: "文件：" + id, path: "photoFileIds" })),
        );
      }
      return new Map(unique.map((id) => [id, photoStore.files.get(id)?.name ?? ""]));
    },
    loadReportPhotos: async (reportIds: readonly string[]) => {
      photoStore.calls.loadReportPhotos.push([...reportIds]);
      const result = new Map<string, { onsite: FilePhotoRef[]; issue: FilePhotoRef[] }>();
      for (const id of new Set(reportIds)) {
        result.set(id, { onsite: photoStore.refs("report", id, "onsite"), issue: photoStore.refs("report", id, "issue") });
      }
      return result;
    },
    loadIssuePhotos: async (issueIds: readonly string[]) => {
      photoStore.calls.loadIssuePhotos.push([...issueIds]);
      const result = new Map<string, FilePhotoRef[]>();
      for (const id of new Set(issueIds)) result.set(id, photoStore.refs("issue", id));
      return result;
    },
    insertReportPhotos: async (reportId: string, kind: string, fileIds: readonly string[]) => {
      insert("report", reportId, kind, fileIds);
    },
    replaceReportPhotos: async (reportId: string, kind: string, fileIds: readonly string[]) => {
      drop("report", reportId, kind);
      insert("report", reportId, kind, fileIds);
    },
    replaceIssuePhotos: async (issueId: string, fileIds: readonly string[]) => {
      drop("issue", issueId);
      insert("issue", issueId, "", fileIds);
    },
    moveIssuePhotosToIssue: async (reportId: string, issueId: string) => {
      const moved = photoStore.refs("report", reportId, "issue");
      drop("report", reportId, "issue");
      insert("issue", issueId, "", moved.map((ref) => ref.fileId));
    },
    deleteFileLinks: async (objectType: string, objectIds: readonly string[]) => {
      photoStore.links = photoStore.links.filter(
        (link) => !(link.objectType === objectType && objectIds.includes(link.objectId)),
      );
    },
    purgeIssues,
    purgeReportCascade,
  };
}
