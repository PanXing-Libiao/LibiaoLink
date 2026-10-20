
import { createHash, randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { IMPORT_ALLOWED_EXTENSIONS, IMPORT_MAX_FILE_BYTES, IMPORT_PREVIEW_TTL_MINUTES } from "@libiaolink/contracts";
import type {
  ImportAccount,
  ImportIssue,
  ImportManualImage,
  ImportManualTarget,
  ImportPreviewCounts,
  ImportResultCounts,
  ImportTaskNode,
  ProjectImportCommitBody,
  ProjectImportPreview,
  ProjectImportResult,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { buildObjectKey, extensionOf, ObjectStorage } from "../../storage/index.js";
import { AuditService } from "../admin/index.js";
import type { UserRow } from "../identity/index.js";
import { FlowService, ProjectMemberRepository, ProjectRepository } from "../project/index.js";
import { TaskNodeRepository } from "../template/index.js";
import type { TaskNodeRow } from "../template/index.js";
import { TranslateService } from "../translate/index.js";
import { convertLegacyWorkbook } from "./legacy.js";
import type {
  LegacyChange,
  LegacyChangeLink,
  LegacyIssueSeed,
  LegacyManualFile,
  LegacyParse,
  LegacyStakeholder,
  LegacyTask,
} from "./legacy.js";
import { proposeAccount, stripParen } from "./people.js";
import { IMPORT_PREVIEW_SWEEP_BATCH, ProjectImportRepository } from "./project-import.repository.js";
import type {
  ImportChangeInsert,
  ImportFileInsert,
  ImportReportInsert,
  ImportReportIssueInsert,
  ImportStakeholderInsert,
  ImportTaskInsert,
} from "./project-import.repository.js";
import { ZipArchive, parseWorkbook } from "./xlsx.js";
import type { ParsedWorkbook } from "./xlsx.js";

/**
 * 导入表导入用例（直连 API 导入 · 业务口径 2026-10-14）：
 * - preview：multipart 收 .xlsx / .xlsm（≤ 256 MB）→ 零依赖解析（xlsx.ts）+ 口径转换（legacy.ts：完成判定 / 进度五档 /
 *   日期笔误照原值 / 节点匹配 / 账号落位）→ 源文件写对象存储（imports/{previewId}/source.{ext}）+ 解析产物落票据表
 *   （project_import_previews.payload，30 分钟有效）；**不写业务库**。返回预览报告（落位建议 + 条数 + 三份清单 + 提醒）。
 * - commit：票据取回（过期 410 IMPORT_PREVIEW_EXPIRED / 已提交 400 / 越权 403）→ 编号占用 409 → 单事务建项目
 *   （与新建项目同款：ProjectRepository.insert + FlowService.importSnapshot 蓝图快照 + 成员名册 + 阶段前移）
 *   + 任务 / 日报 / 问题 / 变更 / 图片（图片对象在事务前先上传，键 = buildObjectKey(projectId 预生成)）。
 * 口径铁律：
 * 1. 照原值导入 + 提醒（日期笔误 / 三档提醒见 legacy.ts 的 seeds；不因提醒阻断）；
 * 2. 五档进度 = 0 / 0.25 / 0.5 / 0.75 / 1（进行中封顶 75%；完成日期未填 = 不算完成）；
 * 3. 任务节点：节点库已有一致标题 → 直接挂；未匹配按文件原名导入，addMissingNodes 勾选时补进节点库（仅阶段范围内；
 *    阶段外 = 临时任务 stage_key 为空，不补）；
 * 4. 账号：只对账不建号 —— 测试环境缺号需先在账号体系建号并登录一次（面板列出 isNew 账号）；正式环境用户目录完整、
 *    全部直接命中，无需任何建号动作（业务口径 2026-10-14：自动创号仅测试环境需要）。提交时账号仍不存在不阻断 ——
 *    项目经理回落导入人（提醒）、任务负责人留空（提醒）、日报作者回落导入人（提醒）；
 *    未解决问题（源表没有处理人字段）默认处理人 = 项目经理（ISSUE_OWNER_FALLBACK），出现在其工作台「待我处理」；
 * 4.1 写入取消（Push 321）：commit 可取消 —— 前端「取消写入」/ 刷新 / 关页 = 连接断开即中止：检查点抛 IMPORT_CANCELLED →
 *      单事务回滚（零残留）+ 清掉本次已传图片对象；票据与源文件保留，可重新确认导入；
 * 5. x x x 占位（变更内容 / 原因）→ 追加「（待补）」标记；需人工补的文件出「需手动导入」清单（不建文件行）；
 * 6. 变更关联：变更表「关联」列命中任务描述 → 提交回写任务 change_refs（追加序 = 变更表行序；任务表「变更关联」
 *    日期仅核对）；导入的变更没有「变更后文件」（源文件在微盘）—— 变更读面容忍 fileId / versionId 为空（前端标待补）；
 * 7. 干系人（Push 324）：「干系人」表 → stakeholders + project_stakeholders（公司分类自由写法映射四值 / 「填写者」匹配库内账号 → created_by /
 *    「提交时间」→ created_at）；导入表没有该表 = 本次不导入干系人。
 */

/** 提醒文案语言（Accept-Language 取 zh / en；缺省 zh）。 */
export type ImportLocale = "zh" | "en";

/** 预览入参：HTTP 层读完 multipart 后把字节与文件名交给用例（服务端不落盘）。 */
export interface ImportPreviewInput {
  bytes: Buffer;
  fileName: string;
  actorId: string;
  locale: ImportLocale;
}

/** 人员解析结果：accounts 进面板，byName 供提交挂人（null = 库里还没有这个账号）。 */
interface AccountResolution {
  accounts: ImportAccount[];
  byName: Map<string, string | null>;
  unknownNames: string[];
}

/** 任务节点分组（按 阶段 + 标题 归并；预览清单与提交挂接同源，避免两套口径）。 */
interface NodeGroup {
  stageKey: string | null;
  title: string;
  titleEn: string | null;
  matched: boolean;
  libraryId: string | null;
  inStageScope: boolean;
  taskCount: number;
  taskIndexes: number[];
}

/** 图片落位计划：对象先上传（键含预生成 projectId），事务内只登记 files / file_versions / file_links。 */
interface ImagePlan {
  fileId: string;
  name: string;
  mime: string | null;
  kind: "onsite" | "issue" | "change_before" | "change_after";
  /** 挂接日报下标（现场图 / 问题图；变更前 / 变更后图 = null）。 */
  reportIndex: number | null;
  issueIndex: number | null;
  /** 变更表下标（变更前 / 变更后图；与 insertChangeRequests 返回同序）；日报图 = null。 */
  changeIndex: number | null;
  /** ZIP 内 xl/media 文件名；图片字节在提交循环中逐张读取，不进入 plans。 */
  media: string;
}

/** 已完成读取 / 哈希 / 上传的图片计划，事务落库时使用。 */
interface UploadedImagePlan extends ImagePlan {
  objectKey: string;
  sizeBytes: number;
  contentHash: string;
}

/** 票据 payload（jsonb）：解析产物 + 账号清单；提交只认这份快照（避免两次解析漂移）。 */
interface ImportPreviewPayload {
  file: { name: string; size: number };
  parse: LegacyParse;
  accounts: ImportAccount[];
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** 变更 / 日报长文本入库上限（与库内 check 同值：daily_reports 2000 / issues.title 500 / 文本类 2000）。 */
const TEXT_LIMIT = 2000;
const TITLE_LIMIT = 500;

/** 导入表导入用例（h2+ · 导入项目按钮的服务端落点）。 */
@Injectable()
export class ProjectImportService {
  private readonly logger = new Logger(ProjectImportService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly previews: ProjectImportRepository,
    private readonly projects: ProjectRepository,
    private readonly members: ProjectMemberRepository,
    private readonly flow: FlowService,
    private readonly nodes: TaskNodeRepository,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
    private readonly translate: TranslateService,
  ) {}

  /**
   * 解析预览（不写业务库）：文件名闸 → 解析 + 转换 → 账号 / 节点对账 → 源文件入对象存储 → 票据落库。
   * 解析失败统一 422 IMPORT_PARSE_FAILED（导入表结构不对 / 不是 xlsx）；文件闸 400 IMPORT_FILE_INVALID。
   */
  async preview(input: ImportPreviewInput): Promise<ProjectImportPreview> {
    const fileName = sanitizeFileName(input.fileName);
    assertImportFile(fileName, input.bytes.length);
    const { parse, workbook } = parseLegacy(input.bytes, fileName);
    const extraSeeds: LegacyIssueSeed[] = [];
    const skippedImages = countSkippedImages(parse, (media) => workbook.hasMedia(media));
    const resolution = await this.resolveAccounts(collectPeople(parse));
    const { groups } = await this.buildNodeGroups(parse.tasks);
    const previewId = randomUUID();
    const objectKey = "imports/" + previewId + "/source." + extensionOf(fileName);
    await this.storage.putObject({
      objectKey,
      body: input.bytes,
      contentType: XLSX_MIME,
      metadata: { origin: "legacy-import", createdBy: input.actorId },
    });
    const at = new Date();
    const expiresAt = new Date(at.getTime() + IMPORT_PREVIEW_TTL_MINUTES * 60_000);
    const payload: ImportPreviewPayload = {
      file: { name: fileName, size: input.bytes.length },
      parse,
      accounts: resolution.accounts,
    };
    const row = await this.previews.insertPreview(
      {
        id: previewId,
        fileName,
        fileSizeBytes: input.bytes.length,
        objectKey,
        payload: payload as unknown as Record<string, unknown>,
        createdBy: input.actorId,
        expiresAt,
      },
      at,
    );
    const counts: ImportPreviewCounts = {
      tasks: parse.tasks.length,
      reports: parse.reports.length,
      changes: parse.changes.length,
      changesLinked: parse.changeLinks.length,
      images: parse.images.length,
      imagesManual: parse.manualFiles.length,
      stakeholders: parse.stakeholders.length,
      accountsNew: resolution.accounts.filter((account) => account.isNew).length,
      nodesNew: groups.filter((group) => !group.matched && group.inStageScope).length,
    };
    if (parse.stakeholderSheetName === null) {
      extraSeeds.push(stakeholderSheetMissingSeed());
    }
    const fillers = await this.resolveStakeholderFillers(parse);
    const unresolvedFillers = unresolvedNamesOf(fillers);
    if (unresolvedFillers.length > 0) extraSeeds.push(stakeholderFillerMissingSeed(unresolvedFillers));
    const changeApplicants = await this.resolveByDisplayNames(parse.changes.map((change) => change.requester));
    const unresolvedChangeApplicants = unresolvedNamesOf(changeApplicants);
    if (unresolvedChangeApplicants.length > 0) extraSeeds.push(changeApplicantMissingSeed(unresolvedChangeApplicants));
    const changeWriters = await this.resolveByDisplayNames(parse.changes.map((change) => change.filler));
    const unresolvedChangeWriters = unresolvedNamesOf(changeWriters);
    if (unresolvedChangeWriters.length > 0) extraSeeds.push(changeWriterMissingSeed(unresolvedChangeWriters));
    if (resolution.unknownNames.length > 0) extraSeeds.push(unknownPeopleSeed(resolution.unknownNames));
    if (skippedImages > 0) extraSeeds.push(imageRowMissingSeed(skippedImages));
    const unresolvedIssues = parse.reports.filter((report) => report.issue !== null && report.issue.state !== "done").length;
    if (unresolvedIssues > 0) {
      extraSeeds.push(issueOwnerFallbackSeed(resolvedManagerName(parse, resolution), unresolvedIssues));
    }
    const issues: ImportIssue[] = [
      ...parse.issues.map((seed) => renderIssue(seed, input.locale)),
      ...extraSeeds.map((seed) => renderIssue(seed, input.locale)),
    ];
    return {
      previewId: row.id,
      expiresAt: expiresAt.toISOString(),
      file: payload.file,
      project: { ...parse.project, managerNames: parse.project.managerNames.map((name) => stripParen(name)) },
      counts,
      accounts: resolution.accounts,
      imagesManual: parse.manualFiles.map((file, index) => manualImageOf(file, index, input.locale)),
      nodes: groups.map(contractNodeOf),
      issues,
    };
  }

  /**
   * 过期票据清扫（worker 周期调用）：先彻底删除源对象，再置 expired；对象删除失败保留 pending，下轮重试。
   */
  async sweepExpiredPreviews(now: Date = new Date(), limit: number = IMPORT_PREVIEW_SWEEP_BATCH): Promise<{ scanned: number; expired: number }> {
    const rows = await this.previews.listExpiredPreviews(now, limit);
    let expired = 0;
    for (const row of rows) {
      try {
        await this.storage.purgeObject(row.objectKey);
        await this.previews.markExpired(row.id);
        expired += 1;
      } catch (error) {
        this.logger.warn("导入表导入过期票据清理失败：" + row.id + " / " + messageOf(error));
      }
    }
    return { scanned: rows.length, expired };
  }

  /**
   * 确认导入（落位确认 + 节点补库开关）：票据校验 → 编号占用 → 账号 / 节点对账 → 图片对象上传 →
   * 单事务（建项目 + 蓝图快照 + 成员 + 任务 + 日报 + 问题 + 变更 + 图片元数据 + 审计 + 票据置 committed）。
   * 提醒复述：解析期 seeds + 提交期兜底（项目经理回落 / 负责人留空 / 日报作者回落 / 图片行未匹配）。
   */
  async commit(body: ProjectImportCommitBody, actorId: string, locale: ImportLocale, signal?: AbortSignal): Promise<ProjectImportResult> {
    throwIfCancelled(signal);
    const preview = await this.previews.findPreview(body.previewId);
    if (preview === null) {
      throw new AppError("NOT_FOUND", "预览票据不存在（请重新选择文件解析）");
    }
    if (preview.createdBy !== actorId) {
      throw new AppError("FORBIDDEN", "预览票据不属于当前账号（请用原账号确认导入）");
    }
    if (preview.status === "committed") {
      throw new AppError("VALIDATION_FAILED", "该预览已导入（项目已创建），请重新选择文件解析");
    }
    if (preview.expiresAt.getTime() <= Date.now()) {
      await this.previews.markExpired(preview.id);
      await this.purgeSource(preview.objectKey);
      throw new AppError(
        "IMPORT_PREVIEW_EXPIRED",
        "预览票据已过期（" + IMPORT_PREVIEW_TTL_MINUTES + " 分钟内未确认导入），请重新选择文件解析",
      );
    }
    const payload = preview.payload as unknown as ImportPreviewPayload;
    const parse = payload.parse;
    const placement = parse.project;
    if (await this.previews.projectCodeExists(placement.code)) {
      throw new AppError("PROJECT_CODE_EXISTS", "项目编号已存在：" + placement.code);
    }
    const region = body.region.trim() === "" ? (placement.region ?? "") : body.region.trim();
    if (region === "") {
      throw new AppError("VALIDATION_FAILED", "项目地区不能为空（源表识别不出时必须由面板选择）");
    }
    const projectType = body.projectType.trim() === "" ? (placement.projectType ?? "未分类") : body.projectType.trim();

    // 账号 / 节点对账（与预览同一套函数；30 分钟窗口内账号可能刚好建好，这一步按最新库内状态挂人）。
    const resolution = await this.resolveAccounts(collectPeople(parse));
    const { groups, groupIndexByTask } = await this.buildNodeGroups(parse.tasks);
    const managerIds: string[] = [];
    for (const name of placement.managerNames) {
      const id = resolution.byName.get(stripParen(name)) ?? null;
      if (id !== null && !managerIds.includes(id)) managerIds.push(id);
    }
    const extraSeeds: LegacyIssueSeed[] = [];
    const fillerIds = await this.resolveStakeholderFillers(parse);
    const unresolvedFillers = unresolvedNamesOf(fillerIds);
    if (unresolvedFillers.length > 0) extraSeeds.push(stakeholderFillerMissingSeed(unresolvedFillers));
    // 变更「申请人 / 填写者」（Push 347）：源表两列命中账号 → applied_by / writer_by；未命中进提醒（申请人回落导入人、填写者留空）。
    const changeApplicantIds = await this.resolveByDisplayNames(parse.changes.map((change) => change.requester));
    const changeWriterIds = await this.resolveByDisplayNames(parse.changes.map((change) => change.filler));
    const unresolvedChangeApplicants = unresolvedNamesOf(changeApplicantIds);
    if (unresolvedChangeApplicants.length > 0) extraSeeds.push(changeApplicantMissingSeed(unresolvedChangeApplicants));
    const unresolvedChangeWriters = unresolvedNamesOf(changeWriterIds);
    if (unresolvedChangeWriters.length > 0) extraSeeds.push(changeWriterMissingSeed(unresolvedChangeWriters));
    if (managerIds.length === 0) {
      managerIds.push(actorId);
      extraSeeds.push(
        managerFallbackSeed(placement.managerNames.map((name) => stripParen(name))),
      );
    }
    const unresolvedIssues = parse.reports.filter((report) => report.issue !== null && report.issue.state !== "done").length;
    if (unresolvedIssues > 0) {
      extraSeeds.push(issueOwnerFallbackSeed(resolvedManagerName(parse, resolution), unresolvedIssues));
    }
    const unresolvedOwners = new Set<string>();
    const unresolvedAuthors = new Set<string>();

    // 图片落位：源工作簿取回 → 解 media 字节 → 先上传（键含预生成 projectId）→ 事务内登记元数据。
    const projectId = randomUUID();
    throwIfCancelled(signal);
    const zip = await this.readSourceZip(preview.objectKey);
    const issueIndexByReport = new Map<number, number>();
    {
      let issueCount = 0;
      parse.reports.forEach((report, index) => {
        if (report.issue === null) return;
        issueIndexByReport.set(index, issueCount);
        issueCount += 1;
      });
    }
    const imageBuild = buildImagePlans(
      parse,
      (media) => zip.has("xl/media/" + media),
      issueIndexByReport,
    );
    const uploadedImageKeys: string[] = [];
    const uploadedPlans: UploadedImagePlan[] = [];
    let skippedImages = imageBuild.skipped;
    try {
      for (const plan of imageBuild.plans) {
        throwIfCancelled(signal);
        // 逐张读取：method 0 返回源 Buffer 视图，method 8 仅在这一轮解压；不进入 ZipArchive 缓存。
        const bytes = zip.readUncached("xl/media/" + plan.media);
        if (bytes === null) {
          skippedImages += 1;
          continue;
        }
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        const objectKey = buildObjectKey({ projectId, fileId: plan.fileId, seq: 1, contentHash, fileName: plan.name });
        await this.storage.putObject({
          objectKey,
          body: bytes,
          contentType: plan.mime,
          metadata: { origin: "legacy-import", previewId: preview.id },
        });
        uploadedImageKeys.push(objectKey);
        uploadedPlans.push({ ...plan, objectKey, sizeBytes: bytes.length, contentHash });
      }
    } catch (error) {
      await this.discardImages(uploadedImageKeys);
      throw error;
    }
    if (skippedImages > 0) {
      extraSeeds.push(imageRowMissingSeed(skippedImages));
    }

    const at = new Date();
    throwIfCancelled(signal);
    const commitTx = this.database.db.transaction(async (tx) => {
      throwIfCancelled(signal);
      const projectRow = await this.projects.insert(
        {
          id: projectId,
          code: placement.code,
          name: placement.name,
          customer: null,
          region,
          projectType,
          managerIds,
          stageKey: "presale",
          description: null,
        },
        at,
        tx,
      );
      const imported = await this.flow.importSnapshot(tx, {
        projectId: projectRow.id,
        projectType: projectRow.projectType,
        at,
      });
      if (projectRow.stageKey !== imported.activeStageKey) {
        await this.projects.setStageKey(projectRow.id, imported.activeStageKey, at, tx);
      }
      for (const managerId of managerIds) {
        await this.members.upsert(projectRow.id, managerId, "project_manager", at, tx);
      }

      // 任务节点补库（业务口径：无对应任务节点按文件原名导入 + 问用户是否补进节点库；阶段外 = 临时任务不补）。
      const nodeIdByGroup = new Map<number, string | null>();
      let nodesAdded = 0;
      if (body.addMissingNodes) {
        const seqCursor = new Map<string, number>();
        for (let index = 0; index < groups.length; index += 1) {
          throwIfCancelled(signal);
          const group = groups[index]!;
          if (group.matched || !group.inStageScope || group.stageKey === null) continue;
          let seq = seqCursor.get(group.stageKey);
          if (seq === undefined) seq = await this.nodes.maxSeq(group.stageKey, tx);
          seq += 10;
          seqCursor.set(group.stageKey, seq);
          const nodeRow = await this.nodes.insert(
            { stageKey: group.stageKey, seq, title: clipText(group.title, 200), titleEn: clipNullable(group.titleEn, 200) },
            tx,
          );
          nodesAdded += 1;
          nodeIdByGroup.set(index, nodeRow.id);
          await this.audit.record(tx, {
            actorId,
            action: "create",
            objectType: "task_node",
            objectId: nodeRow.id,
            projectId: projectRow.id,
            summary: "导入表导入新增任务节点：" + nodeRow.title,
            changes: [
              { field: "stageKey", from: null, to: nodeRow.stageKey },
              { field: "title", from: null, to: nodeRow.title },
              { field: "titleEn", from: null, to: nodeRow.titleEn },
            ],
            metadata: { source: "project-import", previewId: preview.id },
          });
        }
      }

      // 任务：同一阶段内 sortIndex 递增（0 起、密集）；ownerIds 只挂库内已有账号（缺号进提醒，不阻断）。
      const sortCursor = new Map<string, number>();
      const taskRows: ImportTaskInsert[] = parse.tasks.map((task, taskIndex) => {
        const groupIndex = groupIndexByTask[taskIndex]!;
        const group = groups[groupIndex]!;
        const ownerIds: string[] = [];
        for (const owner of task.ownerNames) {
          const base = stripParen(owner);
          const id = resolution.byName.get(base) ?? null;
          if (id === null) {
            if (base !== "") unresolvedOwners.add(base);
            continue;
          }
          if (!ownerIds.includes(id)) ownerIds.push(id);
        }
        const groupKey = group.stageKey ?? "";
        const sortIndex = sortCursor.get(groupKey) ?? 0;
        sortCursor.set(groupKey, sortIndex + 1);
        return {
          stageKey: task.stageKey,
          taskNodeId: group.matched ? group.libraryId : (nodeIdByGroup.get(groupIndex) ?? null),
          title: clipText(task.title, 200),
          titleEn: clipNullable(task.titleEn, 200),
          ownerIds,
          status: task.baseStatus,
          statusOverride: task.statusOverride,
          progress: task.progress,
          plannedStart: task.plannedStart,
          plannedEnd: task.plannedEnd,
          actualEnd: task.actualEnd,
          estimatedDays: task.estimatedDays,
          headcount: task.headcount,
          deliverableTypes: task.deliverableTypes,
          note: clipNullable(task.note, 2000),
          onTime: task.onTime,
          sortIndex,
        };
      });
      throwIfCancelled(signal);
      const taskIds = await this.previews.insertTasks(tx, projectRow.id, taskRows, at);

      // 日报 + 问题：作者账号缺失 → 回落导入人（进提醒）；一条日报最多一个问题（导入表口径）；未解决问题（源表没有
      // 处理人字段）默认处理人 = 项目经理（managerIds 首位）—— 出现在其工作台「待我处理」（业务口径 2026-10-14）。
      const reportRows: ImportReportInsert[] = parse.reports.map((report) => {
        const base = stripParen(report.authorName);
        const authorId = resolution.byName.get(base) ?? null;
        if (authorId === null && base !== "") unresolvedAuthors.add(base);
        return {
          authorId: authorId ?? actorId,
          reportDate: report.reportDate,
          headcount: report.headcount,
          doneWork: clipText(report.doneWork, TEXT_LIMIT),
          plan: clipNullable(report.plan, TEXT_LIMIT),
          foundIssue: clipNullable(report.issue === null ? null : report.issue.title, TEXT_LIMIT),
          issueCategories: report.issue === null ? [] : report.issue.categories,
          suggestion: clipNullable(report.issue === null ? null : report.issue.solution, TEXT_LIMIT),
        };
      });
      throwIfCancelled(signal);
      const reportIds = await this.previews.insertReports(tx, projectRow.id, reportRows, at);
      const issueRows: ImportReportIssueInsert[] = [];
      const unresolvedIssueOwnerId = managerIds[0] ?? actorId;
      parse.reports.forEach((report, index) => {
        if (report.issue === null) return;
        const base = stripParen(report.authorName);
        const reporterId = resolution.byName.get(base) ?? null;
        issueRows.push({
          reportIndex: index,
          title: clipText(report.issue.title, TITLE_LIMIT),
          categories: report.issue.categories,
          state: report.issue.state,
          solution: clipNullable(report.issue.solution, TEXT_LIMIT),
          reporterId: reporterId ?? actorId,
          ownerId: report.issue.state === "done" ? null : unresolvedIssueOwnerId,
          raisedAt: report.reportDate,
          ownerDepartment: null,
        });
      });
      throwIfCancelled(signal);
      const issueIds = await this.previews.insertReportIssues(tx, projectRow.id, reportIds, issueRows, at);

      // 变更：实施 → install / 发货 → assembly（legacy 已映射）；内容 + 原因合并进 reason（库内无内容列），
      // 占位 x x x 追加「（待补）」标记；变更后文件出「需手动导入」清单（这里不建文件行）；
      // 变更关联（Push 319）：按 legacy 的「关联」列命中关系回写任务 change_refs（追加序 = 变更表行序）。
      const changeRows: ImportChangeInsert[] = parse.changes.map((change) => ({
        stageKey: change.stageKey,
        appliedAt: change.appliedAt === null ? null : new Date(change.appliedAt + "T00:00:00.000Z"),
        reason: composeChangeReason(change),
        beforeSummary: clipNullable(change.before, TEXT_LIMIT),
        afterSummary: clipNullable(change.after, TEXT_LIMIT),
        // 申请人 / 填写者（Push 347）：命中 = 源表人；申请人未命中回落导入人（已出提醒），填写者未命中留空。
        appliedBy: changeApplicantIds.get(change.requester) ?? actorId,
        writerBy: changeWriterIds.get(change.filler) ?? null,
      }));
      throwIfCancelled(signal);
      const changeIds = await this.previews.insertChangeRequests(tx, projectRow.id, changeRows, at);
      const changeLinks: LegacyChangeLink[] = parse.changeLinks ?? [];
      if (changeLinks.length > 0) {
        const refsByTask = new Map<string, string[]>();
        for (const link of changeLinks) {
          const taskId = taskIds[link.taskIndex];
          const changeId = changeIds[link.changeIndex];
          if (taskId === undefined || changeId === undefined) continue;
          const refs = refsByTask.get(taskId) ?? [];
          if (!refs.includes(changeId)) refs.push(changeId);
          refsByTask.set(taskId, refs);
        }
        await this.previews.attachChangeRefs(
          tx,
          [...refsByTask].map(([taskId, refs]) => ({ taskId, changeIds: refs })),
        );
      }

      // 干系人（Push 324）：台账 + 项目关联同批写（「填写者」匹配到库内账号 = created_by；提交时间 → created_at）。
      throwIfCancelled(signal);
      const stakeholderRows: ImportStakeholderInsert[] = parse.stakeholders.map((stakeholder) => ({
        name: clipText(stakeholder.name, 80),
        companyType: stakeholder.companyType,
        company: clipNullable(stakeholder.company, 120),
        title: clipNullable(stakeholder.title, 80),
        phone: clipNullable(stakeholder.phone, 40),
        wechat: clipNullable(stakeholder.wechat, 64),
        email: clipEmail(stakeholder.email),
        role: clipNullable(stakeholder.role, 80),
        createdBy: stakeholder.filler === null ? null : (fillerIds.get(stakeholder.filler) ?? null),
        createdAt: stakeholder.submittedAt === null ? null : new Date(stakeholder.submittedAt + "T00:00:00.000Z"),
      }));
      await this.previews.insertStakeholders(tx, projectRow.id, stakeholderRows, actorId, at);

      // 图片：对象已上传；事务内登记 files + file_versions + file_links（现场图挂日报；问题图随问题转挂 issue 侧；
      // 变更前 / 变更后附图（Push 349）不落 file_links —— 登记 files 后回填 change_requests 两列，同 0052 应用内口径）。
      const fileRows: ImportFileInsert[] = uploadedPlans.map((plan) => ({
        id: plan.fileId,
        name: plan.name,
        objectKey: plan.objectKey,
        sizeBytes: plan.sizeBytes,
        contentHash: plan.contentHash,
        mime: plan.mime,
        reportIndex: plan.reportIndex,
        issueIndex: plan.issueIndex,
        changeIndex: plan.changeIndex,
        kind: plan.kind,
      }));
      throwIfCancelled(signal);
      await this.previews.insertFiles(tx, projectRow.id, reportIds, issueIds, fileRows, actorId, at);
      const changeImageUpdates = buildChangeImageUpdates(uploadedPlans, changeIds);
      if (changeImageUpdates.length > 0) {
        await this.previews.attachChangeSummaryImages(tx, changeImageUpdates);
      }

      const counts: ImportResultCounts = {
        tasks: taskRows.length,
        reports: reportRows.length,
        changes: changeRows.length,
        changesLinked: changeLinks.length,
        stakeholders: stakeholderRows.length,
        images: fileRows.length,
        accountsCreated: resolution.accounts.length,
        nodesAdded,
      };
      throwIfCancelled(signal);
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "project",
        objectId: projectRow.id,
        projectId: projectRow.id,
        summary:
          "导入表导入建项目：" +
          projectRow.code +
          "（" +
          projectRow.name +
          "）：任务 " +
          String(counts.tasks) +
          " / 日报 " +
          String(counts.reports) +
          " / 变更 " +
          String(counts.changes) +
          " / 干系人 " +
          String(counts.stakeholders) +
          " / 图片 " +
          String(counts.images),
        changes: [
          { field: "code", from: null, to: projectRow.code },
          { field: "name", from: null, to: projectRow.name },
          { field: "region", from: null, to: projectRow.region },
          { field: "projectType", from: null, to: projectRow.projectType },
          { field: "managerIds", from: null, to: projectRow.managerIds },
          { field: "stageKey", from: null, to: imported.activeStageKey },
        ],
        metadata: {
          source: "project-import",
          previewId: preview.id,
          fileName: preview.fileName,
          counts,
          addMissingNodes: body.addMissingNodes,
        },
      });
      throwIfCancelled(signal);
      await this.previews.markCommitted(preview.id, projectRow.id, at, tx);
      const manualTargets = buildManualTargets(parse.manualFiles, taskIds, changeIds, changeLinks);
      return { projectId: projectRow.id, code: projectRow.code, name: projectRow.name, counts, manualTargets };
    });
    let written: {
      projectId: string;
      code: string;
      name: string;
      counts: ImportResultCounts;
      manualTargets: ImportManualTarget[];
    };
    try {
      written = await commitTx;
    } catch (error) {
      await this.discardImages(uploadedImageKeys);
      throw error;
    }

    if (unresolvedOwners.size > 0) {
      extraSeeds.push(unresolvedOwnersSeed([...unresolvedOwners]));
    }
    if (unresolvedAuthors.size > 0) {
      extraSeeds.push(unresolvedAuthorsSeed([...unresolvedAuthors]));
    }
    await this.purgeSource(preview.objectKey);
    this.translate.warmup([written.name]);
    const issues: ImportIssue[] = [
      ...parse.issues.map((seed) => renderIssue(seed, locale)),
      ...extraSeeds.map((seed) => renderIssue(seed, locale)),
    ];
    return {
      projectId: written.projectId,
      code: written.code,
      name: written.name,
      counts: written.counts,
      manualTargets: written.manualTargets,
      issues,
    };
  }

  /**
   * 导入补充附件回挂变更：文件已由前端直传（draft + 首版本），这里把首版本挂到导入变更并把文件置为 changed（变更后文件，文件库显示「已变更」）。
   * 幂等：同一变更 + 同一文件重复调用 = no-op；一期「一变更一版本」—— 同一变更已有其它文件 / 文件已挂其它变更 400，项目 / 变更不匹配 404。
   */
  async attachManualChangeFile(projectId: string, changeId: string, fileId: string, actorId: string): Promise<void> {
    const file = await this.previews.findFileForManualAttach(fileId);
    if (file === null || file.projectId !== projectId) {
      throw new AppError("NOT_FOUND", "文件不存在或不属于该项目");
    }
    if (file.status === "recycled" || file.status === "archived") {
      throw new AppError("VALIDATION_FAILED", "回收站 / 已归档文件不能挂接变更");
    }
    if (file.currentVersionId === null) {
      throw new AppError("VALIDATION_FAILED", "文件还没有版本，无法挂接变更");
    }
    const changeProjectId = await this.previews.findChangeProjectId(changeId);
    if (changeProjectId !== projectId) {
      throw new AppError("NOT_FOUND", "变更记录不存在或不属于该项目");
    }
    const versionId = file.currentVersionId;
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const outcome = await this.previews.attachChangeFile(tx, { fileId, versionId, changeId, actorId, at });
      if (outcome === "conflict") {
        throw new AppError("VALIDATION_FAILED", "该变更已有其它文件，或该文件已挂接其它变更记录");
      }
      if (outcome === "missing") {
        throw new AppError("NOT_FOUND", "文件版本不存在");
      }
      if (outcome === "missing_change") {
        throw new AppError("NOT_FOUND", "变更记录不存在");
      }
      if (outcome === "already") return;
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "change",
        objectId: changeId,
        projectId,
        summary: "导入补充附件挂接变更后文件：" + file.name,
      });
    });
  }

  /** 「填写者」→ 库内账号（显示名直查：原文 / 去括注 / 去括注 + -test）；未命中 = null（created_by 留空 + 提醒）。 */
  private async resolveStakeholderFillers(parse: LegacyParse): Promise<Map<string, string | null>> {
    const rawNames: string[] = [];
    for (const stakeholder of parse.stakeholders) {
      const raw = stakeholder.filler;
      if (raw !== null && raw !== "" && !rawNames.includes(raw)) rawNames.push(raw);
    }
    return this.resolveByDisplayNames(rawNames);
  }

  /** 显示名 → 库内账号（原文 / 去括注 / 去括注 + -test 三路候选；Push 347 起干系人「填写者」/ 变更「申请人」「填写者」共用）。 */
  private async resolveByDisplayNames(rawNames: readonly string[]): Promise<Map<string, string | null>> {
    const names: string[] = [];
    for (const raw of rawNames) {
      if (raw !== "" && !names.includes(raw)) names.push(raw);
    }
    const result = new Map<string, string | null>();
    if (names.length === 0) return result;
    const candidates: string[] = [];
    for (const raw of names) {
      const base = stripParen(raw);
      for (const candidate of [raw, base, base + "-test"]) {
        if (candidate !== "" && !candidates.includes(candidate)) candidates.push(candidate);
      }
    }
    const idByDisplay = new Map<string, string>();
    for (const user of await this.previews.findUsersByDisplayNames(candidates)) {
      if (!idByDisplay.has(user.displayName)) idByDisplay.set(user.displayName, user.id);
    }
    for (const raw of names) {
      const base = stripParen(raw);
      const hit = idByDisplay.get(raw) ?? idByDisplay.get(base) ?? idByDisplay.get(base + "-test") ?? null;
      result.set(raw, hit);
    }
    return result;
  }

  /** 姓名 → 账号（人员注册表 + 库内用户名 / 显示名两路）：accounts 供面板展示，byName 供挂人。 */
  private async resolveAccounts(names: readonly string[]): Promise<AccountResolution> {
    const entries = names.map((name) => ({ name, registry: proposeAccount(name) }));
    const usernames: string[] = [];
    const displayNames: string[] = [...names];
    for (const entry of entries) {
      if (entry.registry === null) continue;
      usernames.push(entry.registry.username);
      displayNames.push(entry.registry.displayName);
    }
    const byUsername = new Map<string, UserRow>();
    for (const user of await this.previews.findUsersByUsernames(usernames)) byUsername.set(user.username, user);
    const byDisplay = new Map<string, UserRow>();
    for (const user of await this.previews.findUsersByDisplayNames(displayNames)) {
      if (!byDisplay.has(user.displayName)) byDisplay.set(user.displayName, user);
    }
    const accounts: ImportAccount[] = [];
    const byName = new Map<string, string | null>();
    const unknownNames: string[] = [];
    for (const entry of entries) {
      const direct = byDisplay.get(entry.name) ?? null;
      if (entry.registry === null) {
        unknownNames.push(entry.name);
        byName.set(entry.name, direct === null ? null : direct.id);
        continue;
      }
      const user = byUsername.get(entry.registry.username) ?? direct ?? byDisplay.get(entry.registry.displayName) ?? null;
      byName.set(entry.name, user === null ? null : user.id);
      accounts.push({
        name: entry.name,
        username: entry.registry.username,
        displayName: user === null ? entry.registry.displayName : user.displayName,
        isNew: user === null,
      });
    }
    return { accounts, byName, unknownNames };
  }

  /** 节点分组：按 阶段 + 规范化标题 归并；matched = 节点库已有同名（任意阶段），inStageScope = 任务落在九阶段内。 */
  private async buildNodeGroups(tasks: readonly LegacyTask[]): Promise<{ groups: NodeGroup[]; groupIndexByTask: number[] }> {
    const library = await this.nodes.list(null);
    const byStageTitle = new Map<string, TaskNodeRow>();
    const byTitle = new Map<string, TaskNodeRow>();
    for (const row of library) {
      const titleKey = nodeKey(row.title);
      byStageTitle.set(row.stageKey + "\\n" + titleKey, row);
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, row);
    }
    const index = new Map<string, number>();
    const groups: NodeGroup[] = [];
    const groupIndexByTask: number[] = [];
    tasks.forEach((task, taskIndex) => {
      const key = (task.stageKey ?? "") + "\\n" + nodeKey(task.title);
      let groupIndex = index.get(key);
      if (groupIndex === undefined) {
        const titleKey = nodeKey(task.title);
        const sameStage = task.stageKey === null ? null : (byStageTitle.get(task.stageKey + "\\n" + titleKey) ?? null);
        const hit = sameStage ?? byTitle.get(titleKey) ?? null;
        const libraryRow = hit;
        groupIndex = groups.length;
        index.set(key, groupIndex);
        groups.push({
          stageKey: task.stageKey,
          title: task.title,
          titleEn: (libraryRow === null ? null : libraryRow.titleEn) ?? task.titleEn ?? null,
          matched: hit !== null,
          libraryId: hit === null ? null : hit.id,
          inStageScope: task.stageKey !== null,
          taskCount: 0,
          taskIndexes: [],
        });
      }
      const group = groups[groupIndex]!;
      group.taskCount += 1;
      group.taskIndexes.push(taskIndex);
      groupIndexByTask.push(groupIndex);
    });
    return { groups, groupIndexByTask };
  }

  /** 源工作簿取回（提交时解内嵌图）；对象被生命周期清掉 = 票据事实过期（410，请重新解析）。 */
  private async readSourceZip(objectKey: string): Promise<ZipArchive> {
    const object = await this.storage.getObject(objectKey);
    if (object === null) {
      throw new AppError("IMPORT_PREVIEW_EXPIRED", "预览源文件已清理（票据过期），请重新选择文件解析");
    }
    const bytes = Buffer.isBuffer(object.bytes)
      ? object.bytes
      : Buffer.from(object.bytes.buffer, object.bytes.byteOffset, object.bytes.byteLength);
    return ZipArchive.open(bytes);
  }

  /** 取消 / 失败收尾（Push 321）：丢弃本次已上传的图片对象（尽力而为；重试会重新生成对象键）。 */
  private async discardImages(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.purgeObject(key);
      } catch (error) {
        this.logger.warn("导入表导入图片对象清理失败：" + key + "：" + messageOf(error));
      }
    }
  }

/** 源文件清理（提交后 / 过期时）：best-effort，失败只记日志（票据状态已定，不影响业务结果）。 */
  private async purgeSource(objectKey: string): Promise<void> {
    try {
      await this.storage.purgeObject(objectKey);
    } catch (error) {
      this.logger.warn("导入表导入源文件清理失败：" + objectKey + "：" + messageOf(error));
    }
  }
}

/** 文件名净化：去掉 multipart 里可能带上的路径段（C:/fakepath/x.xlsx → x.xlsx），限 255。 */
function sanitizeFileName(raw: string): string {
  const last = raw.split("/").pop() ?? raw;
  const name = (last.split("\\").pop() ?? last).trim();
  return name.length > 255 ? name.slice(name.length - 255) : name;
}

/** 文件闸（与前端同值）：扩展名 / 空文件 / 上限；不通过 400 IMPORT_FILE_INVALID。 */
function assertImportFile(fileName: string, size: number): void {
  if (fileName === "") {
    throw new AppError("IMPORT_FILE_INVALID", "缺少上传文件名");
  }
  const dot = fileName.lastIndexOf(".");
  const extension = dot < 0 ? "" : fileName.slice(dot).toLowerCase();
  if (!(IMPORT_ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new AppError("IMPORT_FILE_INVALID", "只支持 .xlsx / .xlsm 导入表（旧版 .xls 请先另存为 .xlsx）");
  }
  if (size === 0) {
    throw new AppError("IMPORT_FILE_INVALID", "上传文件为空");
  }
  if (size > IMPORT_MAX_FILE_BYTES) {
    throw new AppError(
      "IMPORT_FILE_INVALID",
      "文件超过上限（" + String(Math.floor(IMPORT_MAX_FILE_BYTES / 1024 / 1024)) + " MB），请拆分后再导入",
    );
  }
}

/** 解析 + 转换：解析期异常统一 422 IMPORT_PARSE_FAILED（导入表结构不对、不是 xlsx、缺任务 sheet）。 */
function parseLegacy(bytes: Buffer, fileName: string): { parse: LegacyParse; workbook: ParsedWorkbook } {
  try {
    const workbook = parseWorkbook(bytes);
    return { parse: convertLegacyWorkbook(workbook, fileName), workbook };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("IMPORT_PARSE_FAILED", "导入表解析失败：" + messageOf(error));
  }
}

/** 涉及人员（项目经理 / 任务负责人 / 日报填写者 / 变更申请人）：去括注 + 去重 + 首现顺序。 */
function collectPeople(parse: LegacyParse): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const base = stripParen(raw);
    if (base === "" || seen.has(base)) return;
    seen.add(base);
    names.push(base);
  };
  for (const task of parse.tasks) {
    push(task.managerName ?? "");
    for (const owner of task.ownerNames) push(owner);
  }
  for (const report of parse.reports) push(report.authorName);
  for (const change of parse.changes) push(change.requester);
  return names;
}

/** seeds → 契约提醒（按 Accept-Language 出中 / 英）。 */
function renderIssue(seed: LegacyIssueSeed, locale: ImportLocale): ImportIssue {
  return {
    level: seed.level,
    code: seed.code,
    message: locale === "en" ? seed.en : seed.zh,
    row: seed.row,
    subject: seed.subject,
  };
}

function manualImageOf(file: LegacyManualFile, index: number, locale: ImportLocale): ImportManualImage {
  return {
    id: "manual-" + String(index),
    kind: file.kind,
    task: file.subject,
    name: file.name,
    reason: locale === "en" ? file.en : file.zh,
  };
}

/** 手动文件 → 已写入任务 / 变更 id（与预览 imagesManual 同序；id = manual-<序号>）。 */
function buildManualTargets(
  files: readonly LegacyManualFile[],
  taskIds: readonly string[],
  changeIds: readonly string[],
  changeLinks: readonly LegacyChangeLink[],
): ImportManualTarget[] {
  return files.map((file, index) => {
    const id = "manual-" + String(index);
    if (file.kind === "task") {
      const taskId = file.taskIndex === null ? null : (taskIds[file.taskIndex] ?? null);
      return { id, taskId, changeId: null };
    }
    const changeId = file.changeIndex === null ? null : (changeIds[file.changeIndex] ?? null);
    const link = file.changeIndex === null ? undefined : changeLinks.find((item) => item.changeIndex === file.changeIndex);
    const taskId = link === undefined ? null : (taskIds[link.taskIndex] ?? null);
    return { id, taskId, changeId };
  });
}

function contractNodeOf(group: NodeGroup): ImportTaskNode {
  return {
    name: group.title,
    nameEn: group.titleEn,
    matched: group.matched,
    inStageScope: group.inStageScope,
    taskCount: group.taskCount,
  };
}

/** 标题归一化（逐字一致口径）：折叠空白 + 小写（英文标题大小写不敏感）。 */
function nodeKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 文本裁剪（库内 check 同上限；null / 空串统一 null）。 */
function clipText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function clipNullable(value: string | null | undefined, limit: number): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === "") return null;
  return text.length > limit ? text.slice(0, limit) : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 图片 mime（按扩展名；未知扩展名 = null，走文件模块的默认处理）。 */
function mimeOf(extension: string): string | null {
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "bmp") return "image/bmp";
  if (extension === "webp") return "image/webp";
  return null;
}

/**
 * 变更原因文本（库内只有 reason 一列，导入表是 变更内容描述 + 变更原因 两列）：
 * 两列都有 →「内容；原因：原因」；只有一列 → 原值；占位 x x x → 追加「（待补）」标记（业务口径：标记待补）。
 */
function composeChangeReason(change: LegacyChange): string {
  const content = change.content === "" ? "" : change.content + (change.contentPlaceholder ? "（内容待补）" : "");
  const reason = change.reason === "" ? "" : change.reason + (change.reasonPlaceholder ? "（原因待补）" : "");
  if (content === "") return reason === "" ? "（原因待补）" : reason;
  if (reason === "") return content;
  return content + "；原因：" + reason;
}

/** 未导入的图片数（锚点行不是有效日报 / 变更行、源文件里找不到该 media）：预览与提交同一判定，提醒口径一致。 */
function countSkippedImages(parse: LegacyParse, hasMedia: (media: string) => boolean): number {
  const reportRows = new Set(parse.reports.map((report) => report.row));
  const changeRows = new Set(parse.changes.map((change) => change.row));
  let skipped = 0;
  for (const image of parse.images) {
    const isChange = image.kind === "change_before" || image.kind === "change_after";
    const rowExists = isChange ? changeRows.has(image.row) : reportRows.has(image.row);
    if (!rowExists || !hasMedia(image.media)) skipped += 1;
  }
  return skipped;
}

/** 图片落位计划：只登记元数据；图片字节在提交循环中逐张读取，避免把整包图片留在内存。 */
function buildImagePlans(
  parse: LegacyParse,
  hasMedia: (media: string) => boolean,
  issueIndexByReport: Map<number, number>,
): { plans: ImagePlan[]; skipped: number } {
  const reportIndexByRow = new Map<number, number>();
  parse.reports.forEach((report, index) => reportIndexByRow.set(report.row, index));
  const changeIndexByRow = new Map<number, number>();
  parse.changes.forEach((change, index) => changeIndexByRow.set(change.row, index));
  const counters = new Map<string, number>();
  const plans: ImagePlan[] = [];
  let skipped = 0;
  for (const image of parse.images) {
    const isChange = image.kind === "change_before" || image.kind === "change_after";
    const targetIndex = isChange ? changeIndexByRow.get(image.row) : reportIndexByRow.get(image.row);
    if (targetIndex === undefined) {
      skipped += 1;
      continue;
    }
    if (!hasMedia(image.media)) {
      skipped += 1;
      continue;
    }
    const counterKey = image.kind + "-" + String(targetIndex);
    const index = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, index);
    // 变更附图与应用内同口径上限 ≤ 30 张（库内 CHECK），超出计入提醒。
    if (isChange && index > 30) {
      skipped += 1;
      continue;
    }
    const extension = extensionOf(image.media);
    const seq = String(index).padStart(2, "0");
    let name: string;
    if (image.kind === "change_before" || image.kind === "change_after") {
      const change = parse.changes[targetIndex]!;
      const label = image.kind === "change_before" ? "变更前附图" : "变更后附图";
      name = label + " " + (change.appliedAt === null ? "日期待补" : change.appliedAt) + " " + seq + "." + extension;
    } else {
      const report = parse.reports[targetIndex]!;
      name = (image.kind === "onsite" ? "现场工作照 " : "问题附图 ") + report.reportDate + " " + seq + "." + extension;
    }
    plans.push({
      fileId: randomUUID(),
      name,
      mime: mimeOf(extension),
      kind: image.kind,
      reportIndex: isChange ? null : targetIndex,
      issueIndex: image.kind === "issue" ? (issueIndexByReport.get(targetIndex) ?? null) : null,
      changeIndex: isChange ? targetIndex : null,
      media: image.media,
    });
  }
  return { plans, skipped };
}

/** 变更附图装配（Push 349）：变更下标 → 变更前 / 变更后文件 id 有序数组（序 = 源表锚点阅读序）。 */
function buildChangeImageUpdates(
  plans: readonly ImagePlan[],
  changeIds: readonly string[],
): { changeId: string; beforeFileIds: string[]; afterFileIds: string[] }[] {
  const byChange = new Map<number, { beforeFileIds: string[]; afterFileIds: string[] }>();
  for (const plan of plans) {
    if (plan.changeIndex === null) continue;
    const entry = byChange.get(plan.changeIndex) ?? { beforeFileIds: [], afterFileIds: [] };
    if (plan.kind === "change_before") entry.beforeFileIds.push(plan.fileId);
    else if (plan.kind === "change_after") entry.afterFileIds.push(plan.fileId);
    byChange.set(plan.changeIndex, entry);
  }
  const updates: { changeId: string; beforeFileIds: string[]; afterFileIds: string[] }[] = [];
  for (const [index, entry] of byChange) {
    const changeId = changeIds[index];
    if (changeId === undefined) continue;
    updates.push({ changeId, beforeFileIds: entry.beforeFileIds, afterFileIds: entry.afterFileIds });
  }
  return updates;
}

/** 写入取消（Push 321）：客户端断开 / 主动取消 → 每个检查点抛错 → 单事务回滚；票据保持可再次提交。 */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new AppError("IMPORT_CANCELLED", "导入已取消：本次未写入任何数据（可重新确认导入）");
  }
}

function stakeholderSheetMissingSeed(): LegacyIssueSeed {
  return {
    level: "info",
    code: "STAKEHOLDER_SHEET_MISSING",
    row: null,
    subject: null,
    zh: "未发现「干系人」表：本次不导入干系人（可导入后在项目「干系人」标签手工补录）",
    en: "No stakeholder sheet found: stakeholders are skipped (you can add them later in the project stakeholders tab).",
  };
}

function stakeholderFillerMissingSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "info",
    code: "STAKEHOLDER_FILLER_MISSING",
    row: null,
    subject: list,
    zh: "干系人「填写者」账号未找到（" + list + "）：导入后「填写者」列留空（可到干系人台账补录）",
    en: "Stakeholder 填写者 accounts not found (" + list + "): the 填写者 column stays empty after import (editable in the stakeholder ledger).",
  };
}

/** 变更申请人未命中（Push 347）：按导入人记录（与负责人 / 日报作者回落同口径，出 warning 提醒）。 */
function changeApplicantMissingSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "warning",
    code: "CHANGE_APPLICANT_MISSING",
    row: null,
    subject: list,
    zh: "变更申请人账号不存在（" + list + "）：本次按导入人记录，导入后可在变更详情核对",
    en: "Change requester accounts not found (" + list + "): recorded as the importer (please review the change details after import).",
  };
}

/** 变更「填写者」未命中（Push 347）：writer_by 留空 → 读面「填写者」回落申请人展示（info）。 */
function changeWriterMissingSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "info",
    code: "CHANGE_WRITER_MISSING",
    row: null,
    subject: list,
    zh: "变更「填写者」账号未找到（" + list + "）：该列暂按申请人展示（可到变更详情核对）",
    en: "Change 填写者 accounts not found (" + list + "): the writer column falls back to the applicant display.",
  };
}

/** 显示名映射里没命中账号的名字（去括注、去重、保序；干系人「填写者」/ 变更「申请人」「填写者」共用）。 */
function unresolvedNamesOf(map: Map<string, string | null>): string[] {
  const names: string[] = [];
  for (const [raw, id] of map) {
    if (id !== null) continue;
    const base = stripParen(raw);
    if (base !== "" && !names.includes(base)) names.push(base);
  }
  return names;
}

/** 邮箱入库（库内 check 3..120）：太短 = null，过长裁断。 */
function clipEmail(value: string | null): string | null {
  const text = clipNullable(value, 120);
  if (text === null || text.length < 3) return null;
  return text;
}

function unknownPeopleSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "warning",
    code: "ACCOUNT_MISSING",
    row: null,
    subject: list,
    zh: "人员未收录（人员注册表里没有拼音登录名）：" + list + "。请在注册表补一行后重新解析；相关负责人 / 项目经理本次按兜底处理",
    en:
      "People missing from the registry (no pinyin username): " +
      list +
      ". Add them to the registry and re-run the preview; owners / managers fall back for this import.",
  };
}

function managerFallbackSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.length === 0 ? "（原表为空）" : names.join("、");
  return {
    level: "warning",
    code: "MANAGER_FALLBACK",
    row: null,
    subject: list,
    zh: "项目经理账号不存在（" + list + "）：本次按导入人记录项目经理，导入后请在成员名册更正",
    en:
      "Manager account not found (" +
      list +
      "): the importer is recorded as project manager. Please correct the member list after import.",
  };
}

function issueOwnerFallbackSeed(managerName: string, count: number): LegacyIssueSeed {
  const who = managerName === "" ? "导入人（项目经理未建号，提交会回落）" : "项目经理「" + managerName + "」";
  return {
    level: "info",
    code: "ISSUE_OWNER_FALLBACK",
    row: null,
    subject: managerName === "" ? null : managerName,
    zh: "未解决问题（" + String(count) + " 条）源表没有处理人：默认处理人 = " + who + "（导入后出现在其「待我处理」；可在项目里调整）",
    en:
      "Unresolved issues (" +
      String(count) +
      ") have no handler in the source sheet: default handler = " +
      (managerName === "" ? "the importer (manager account not found)" : "project manager " + managerName) +
      " (they appear in the handler 待我处理 list; adjustable afterwards).",
  };
}

/** 未解决问题默认处理人的名字（与提交口径同源）：首个能命中的项目经理姓名；一个都命中不了 = 空串。 */
function resolvedManagerName(parse: LegacyParse, resolution: AccountResolution): string {
  for (const name of parse.project.managerNames) {
    const base = stripParen(name);
    if (base !== "" && resolution.byName.get(base) !== null) return base;
  }
  return "";
}

function unresolvedOwnersSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "warning",
    code: "OWNER_MISSING",
    row: null,
    subject: list,
    zh: "以下负责人账号不存在（对应任务负责人留空，导入后可再指派）：" + list,
    en: "Owner accounts not found (those tasks were left unassigned): " + list,
  };
}

function unresolvedAuthorsSeed(names: readonly string[]): LegacyIssueSeed {
  const list = names.join("、");
  return {
    level: "warning",
    code: "AUTHOR_MISSING",
    row: null,
    subject: list,
    zh: "以下日报填写者账号不存在（对应日报作者按导入人记录）：" + list,
    en: "Report authors not found (their reports are attributed to the importer): " + list,
  };
}

function imageRowMissingSeed(count: number): LegacyIssueSeed {
  return {
    level: "warning",
    code: "IMAGE_ROW_MISSING",
    row: null,
    subject: String(count) + " 张",
    zh: "有 " + String(count) + " 张表内图片未导入（锚点行不是有效日报 / 变更行、单条变更附图超过 30 张，或源文件里找不到图片对象）：请在对应处手动上传",
    en:
      String(count) +
      " embedded image(s) were skipped (anchor row without a valid daily report / change record, more than 30 images for one change, or media missing in the source file); please upload them manually.",
  };
}
