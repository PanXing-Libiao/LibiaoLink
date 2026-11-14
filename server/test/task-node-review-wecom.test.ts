import { describe, expect, it } from "vitest";
import {
  buildTaskNodeReviewMessage,
  buildTaskNodeReviewResultMessage,
  looksLikeTaskNodeReviewReply,
  parseTaskNodeReviewReply,
} from "../src/modules/template/task-node-review-wecom.js";

const REQUEST = {
  title: "第四批空箱上架",
  titleEn: "The fourth batch of empty boxes is on the shelves",
  requestedByName: "潘兴",
  requestNo: 1,
  projectCode: "PRJ-2026-0142",
  projectName: "某客户项目",
  requestedAt: new Date("2026-11-14T10:20:00Z"),
};

describe("企微公共节点审核命令", () => {
  it("解析同意 / 驳回，驳回省略理由按无", () => {
    expect(parseTaskNodeReviewReply("  同意潘兴的1号申请  ")).toEqual({
      decision: "approve",
      requesterName: "潘兴",
      requestNo: 1,
      reason: null,
    });
    expect(parseTaskNodeReviewReply("驳回潘兴的2号申请")).toMatchObject({ decision: "reject", reason: "无" });
    expect(parseTaskNodeReviewReply("驳回 潘兴 的 3 号申请 与节点重复")).toEqual({
      decision: "reject",
      requesterName: "潘兴",
      requestNo: 3,
      reason: "与节点重复",
    });
    expect(parseTaskNodeReviewReply("同意潘兴申请")).toBeNull();
    expect(looksLikeTaskNodeReviewReply("同意潘兴申请")).toBe(true);
    expect(looksLikeTaskNodeReviewReply("今天同意一下")).toBe(false);
  });
});

describe("企微公共节点审核消息", () => {
  it("一条申请一条消息，第一列字段名，附回复格式和平台链接", () => {
    const body = buildTaskNodeReviewMessage({
      stageName: "硬件实施",
      request: REQUEST,
      existingNodes: [{ title: "空箱上架" }, { title: "空箱复检" }],
      publicBaseUrl: "https://test-pm.libiaorobot.com/",
    });
    expect(body).toContain("| 审核信息 | 潘兴的1号申请 |");
    expect(body).toContain("| 硬件实施现有公共节点 | 共 2 个：空箱上架、空箱复检 |");
    expect(body).not.toContain("当前阶段现有公共节点");
    expect(body).toContain("| 申请加入公共节点 | **第四批空箱上架** / The fourth batch");
    expect(body).toContain("同意潘兴的1号申请");
    expect(body).toContain("驳回潘兴的1号申请 （空格后填写理由 空则默认为无）");
    expect(body).toContain("[打开入库审核](https://test-pm.libiaorobot.com/#/templates?section=inbound_review)");
    expect(body.split("| 审核信息 |").length - 1).toBe(1);
  });

  it("审核结果只保留阶段、任务、申请人、审核人和通过 / 驳回", () => {
    const approved = buildTaskNodeReviewResultMessage({
      stageName: "硬件实施",
      request: { title: "第四批空箱上架", requestedByName: "潘兴", reviewedByName: "吴孟杰" },
      decision: "approved",
    });
    expect(approved).toBe("**阶段**：硬件实施\n**任务**：第四批空箱上架\n**申请人**：潘兴\n**审核人**：吴孟杰\n**审核结果**：审核通过");
    const rejected = buildTaskNodeReviewResultMessage({
      stageName: "硬件实施",
      request: { title: "第四批空箱上架", requestedByName: "潘兴", reviewedByName: "吴孟杰" },
      decision: "rejected",
    });
    expect(rejected).toContain("**审核结果**：审核驳回");
    expect(rejected.split("\n")).toHaveLength(5);
  });

  it("节点名中的竖线不破坏 Markdown 表格", () => {
    const body = buildTaskNodeReviewMessage({
      stageName: "硬件实施",
      request: { ...REQUEST, title: "A|B" },
      existingNodes: [{ title: "X|Y" }],
      publicBaseUrl: "",
    });
    expect(body).toContain("**A\\|B**");
    expect(body).toContain("X\\|Y");
    expect(body).not.toContain("open");
  });
});
