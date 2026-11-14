import type { TaskNodeRequestRow } from "./task-node-request.repository.js";
import type { TaskNodeRow } from "./task-node.repository.js";

/** 企微回复：同意 / 驳回 + 申请人显示名 + 申请人维度申请号。 */
export interface TaskNodeReviewCommand {
  decision: "approve" | "reject";
  requesterName: string;
  requestNo: number;
  /** 驳回理由；未填写时为「无」。同意时恒为 null。 */
  reason: string | null;
}

const REVIEW_REPLY_PATTERN = /^\s*(同意|驳回)\s*(.+?)\s*的\s*([1-9][0-9]{0,8})\s*号申请(?:\s+([\s\S]*?))?\s*$/;
const REVIEW_INTENT_PATTERN = /^\s*(同意|驳回)/;
const NODE_LIST_MAX_CHARS = 1100;

/**
 * 解析企微审核回复：
 * - 同意潘兴的1号申请
 * - 驳回潘兴的1号申请
 * - 驳回潘兴的1号申请 与节点重复
 * 非审核命令返回 null；审议理由只取申请号后的文字，避免把空格混入姓名。
 */
export function parseTaskNodeReviewReply(text: string): TaskNodeReviewCommand | null {
  const normalized = text.replace(/\u00a0/g, " ").trim();
  const matched = REVIEW_REPLY_PATTERN.exec(normalized);
  if (matched === null) return null;
  const decision = matched[1] === "同意" ? "approve" : "reject";
  const requesterName = (matched[2] ?? "").trim();
  const requestNo = Number(matched[3]);
  if (requesterName === "" || !Number.isSafeInteger(requestNo) || requestNo <= 0) return null;
  const rawReason = (matched[4] ?? "").trim();
  return {
    decision,
    requesterName,
    requestNo,
    reason: decision === "reject" ? (rawReason === "" ? "无" : rawReason) : null,
  };
}

/** 是否像一条审核回复（用于格式错误时回提示，不用于真正落审核）。 */
export function looksLikeTaskNodeReviewReply(text: string): boolean {
  return REVIEW_INTENT_PATTERN.test(text.replace(/\u00a0/g, " ").trim());
}

function cell(value: string | null | undefined): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.replace(/\|/g, "\\|") || "—";
}

function formatRequestedAt(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return pick("month") + "-" + pick("day") + " " + pick("hour") + ":" + pick("minute");
}

function nodeSummary(nodes: readonly Pick<TaskNodeRow, "title">[]): string {
  if (nodes.length === 0) return "暂无";
  const titles = nodes.map((node) => node.title.trim()).filter((title) => title !== "");
  if (titles.length === 0) return "暂无";
  let text = "";
  let shown = 0;
  for (const title of titles) {
    const next = text === "" ? title : text + "、" + title;
    if (next.length > NODE_LIST_MAX_CHARS) break;
    text = next;
    shown += 1;
  }
  const suffix = shown < titles.length ? "……" : "";
  return "共 " + String(titles.length) + " 个：" + text + suffix;
}

/**
 * 一条申请一条企微消息：横向表格第一列是字段名，第二列只放当前申请。
 * 不把多条申请并排，手机端只需上下滑动；当前节点过长时保留可读摘要并标出总数。
 */
export function buildTaskNodeReviewMessage(input: {
  stageName: string;
  request: Pick<
    TaskNodeRequestRow,
    "title" | "titleEn" | "requestedByName" | "requestNo" | "projectCode" | "projectName" | "requestedAt"
  >;
  existingNodes: readonly Pick<TaskNodeRow, "title">[];
  publicBaseUrl: string;
}): string {
  const requesterName = cell(input.request.requestedByName);
  const requestLabel = requesterName + "的" + String(input.request.requestNo) + "号申请";
  const project = [input.request.projectCode, input.request.projectName].filter((value): value is string => value !== null && value.trim() !== "").map((value) => cell(value)).join(" · ");
  const link = input.publicBaseUrl.trim() === ""
    ? ""
    : "\n\n[打开入库审核](" +
      input.publicBaseUrl.trim().replace(/\/+$/, "") +
      "/#/templates?section=inbound_review)";
  return [
    "| 审核信息 | " + requestLabel + " |",
    "|---|---|",
    "| " + cell(input.stageName) + "现有公共节点 | " + cell(nodeSummary(input.existingNodes)) + " |",
    "| 申请加入公共节点 | **" + cell(input.request.title) + "**" + (input.request.titleEn === null ? "" : " / " + cell(input.request.titleEn)) + " |",
    "| 申请号 | " + String(input.request.requestNo) + "号 |",
    "| 申请人 | " + requesterName + " |",
    "| 来源项目 | " + (project === "" ? "—" : project) + " |",
    "| 提交时间 | " + formatRequestedAt(input.request.requestedAt) + " |",
    "",
    "请审核人按以下回复：",
    "",
    "同意" + requesterName + "的" + String(input.request.requestNo) + "号申请",
    "驳回" + requesterName + "的" + String(input.request.requestNo) + "号申请 （空格后填写理由 空则默认为无）" + link,
  ].join("\n");
}
