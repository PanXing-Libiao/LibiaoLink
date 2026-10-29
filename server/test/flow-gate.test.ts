import { describe, expect, it } from "vitest";
import type { DbClient } from "../src/db/db-client.js";
import { GateRepository, type DocCountRow, type RequirementRow, type StageNodeRow } from "../src/modules/node/gate.repository.js";
import type { TaskStatsService } from "../src/modules/task/index.js";
import { GateService } from "../src/modules/node/gate.service.js";

const TX = {} as unknown as DbClient;
const NODE_ID = "11111111-1111-4111-8111-111111111111";

class FakeGateRepository {
  requirements: RequirementRow[] = [];
  files: DocCountRow[] = [];
  nodes: StageNodeRow[] = [];
  async listRequirements(): Promise<RequirementRow[]> {
    return this.requirements;
  }
  async countFinalFilesByDocType(): Promise<DocCountRow[]> {
    return this.files;
  }
  async listStageNodes(): Promise<StageNodeRow[]> {
    return this.nodes;
  }
  async listStageProgress(): Promise<never[]> {
    return [];
  }
  async countLinkedFiles(): Promise<number> {
    return 0;
  }
}

class FakeTaskStats {
  tasks: { total: number; done: number; deliveryReady: number } = {
    total: 0,
    done: 0,
    deliveryReady: 0,
  };
  project = {
    total: 0,
    done: 0,
    deliveryReady: 0,
    issues: [] as {
      taskId: string;
      taskTitle: string;
      stageKey: string | null;
      docType: string;
      required: number;
      present: number;
    }[],
  };
  async countStageTasks(): Promise<{ total: number; done: number; deliveryReady: number }> {
    return this.tasks;
  }
  async evaluateProjectDelivery() {
    return this.project;
  }
  async stageTaskCounts(): Promise<never[]> {
    return [];
  }
}

function makeService(repo: FakeGateRepository, stats: FakeTaskStats = new FakeTaskStats()): GateService {
  return new GateService(repo as unknown as GateRepository, stats as unknown as TaskStatsService);
}

describe("GateService.evaluateNode（v0.2 §3.6 完成门禁）", () => {
  it("无 required_doc 约束 → 直接通过", async () => {
    const repo = new FakeGateRepository();
    repo.requirements = [{ requirementType: "field", docType: null, minCount: 1 }];
    const result = await makeService(repo).evaluateNode(TX, NODE_ID);
    expect(result.missing).toEqual([]);
  });

  it("缺必交成果文件 → missing 明细（docType / required / present）", async () => {
    const repo = new FakeGateRepository();
    repo.requirements = [
      { requirementType: "required_doc", docType: "技术协议", minCount: 1 },
      { requirementType: "required_doc", docType: "合同", minCount: 2 },
    ];
    repo.files = [{ docType: "合同", present: 1 }];
    const result = await makeService(repo).evaluateNode(TX, NODE_ID);
    expect(result.missing).toEqual([
      { docType: "技术协议", required: 1, present: 0 },
      { docType: "合同", required: 2, present: 1 },
    ]);
  });

  it("补齐后通过（status ∈ final / changed 且已定档的口径在计数查询里）", async () => {
    const repo = new FakeGateRepository();
    repo.requirements = [{ requirementType: "required_doc", docType: "合同", minCount: 1 }];
    repo.files = [{ docType: "合同", present: 1 }];
    const result = await makeService(repo).evaluateNode(TX, NODE_ID);
    expect(result.missing).toEqual([]);
  });
});

describe("GateService.evaluateStageAdvance（ADR-023 阶段推进门禁）", () => {
  const STAGE = "presale";
  const PROJECT = "22222222-2222-4222-8222-222222222222";

  it("节点未完成 → node_not_done；任务未完成 → task_not_done", async () => {
    const repo = new FakeGateRepository();
    const stats = new FakeTaskStats();
    repo.nodes = [{ id: "node-1", nodeKey: "presale.requirement", name: "需求澄清", status: "active" }];
    stats.tasks = { total: 3, done: 1, deliveryReady: 1 };
    const result = await makeService(repo, stats).evaluateStageAdvance(TX, PROJECT, STAGE);
    expect(result.ok).toBe(false);
    expect(result.missing[0]).toMatchObject({ type: "node_not_done", nodeId: "node-1", status: "active" });
    expect(result.missing[1]).toEqual({ type: "task_not_done", total: 3, done: 1 });
  });

  it("节点已完成但成果文件被回收 → doc_missing 兜底", async () => {
    const repo = new FakeGateRepository();
    repo.nodes = [{ id: "node-1", nodeKey: "presale.contract", name: "合同评审", status: "done" }];
    repo.requirements = [{ requirementType: "required_doc", docType: "合同", minCount: 1 }];
    repo.files = [];
    const result = await makeService(repo).evaluateStageAdvance(TX, PROJECT, STAGE);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      { type: "doc_missing", nodeId: "node-1", nodeKey: "presale.contract", docType: "合同", required: 1, present: 0 },
    ]);
  });

  it("任务全部 done 但交付文件未齐套 → task_delivery_missing", async () => {
    const repo = new FakeGateRepository();
    const stats = new FakeTaskStats();
    stats.tasks = { total: 2, done: 2, deliveryReady: 1 };
    const result = await makeService(repo, stats).evaluateStageAdvance(TX, PROJECT, STAGE);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ type: "task_delivery_missing", total: 2, ready: 1 }]);
  });

  it("节点与任务全通过 → ok（无缺项）", async () => {
    const repo = new FakeGateRepository();
    const stats = new FakeTaskStats();
    repo.nodes = [{ id: "node-1", nodeKey: "presale.contract", name: "合同评审", status: "done" }];
    repo.requirements = [{ requirementType: "required_doc", docType: "合同", minCount: 1 }];
    repo.files = [{ docType: "合同", present: 1 }];
    stats.tasks = { total: 2, done: 2, deliveryReady: 2 };
    const result = await makeService(repo, stats).evaluateStageAdvance(TX, PROJECT, STAGE);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

describe("GateService.evaluateProjectCompletion（项目标记完成门禁）", () => {
  const PROJECT = "33333333-3333-4333-8333-333333333333";

  it("任务全完成且无交付缺项 → 通过（未配置成果类型的任务不要求文件）", async () => {
    const stats = new FakeTaskStats();
    stats.project = { total: 14, done: 14, deliveryReady: 14, issues: [] };
    const result = await makeService(new FakeGateRepository(), stats).evaluateProjectCompletion(TX, PROJECT);
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it("仍有未完成任务 → task_not_done", async () => {
    const stats = new FakeTaskStats();
    stats.project = { total: 14, done: 12, deliveryReady: 11, issues: [] };
    const result = await makeService(new FakeGateRepository(), stats).evaluateProjectCompletion(TX, PROJECT);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ type: "task_not_done", total: 14, done: 12 }]);
  });

  it("任务已完成但已配置成果文件未上传 → task_delivery_missing（带任务与类型）", async () => {
    const stats = new FakeTaskStats();
    stats.project = {
      total: 2,
      done: 2,
      deliveryReady: 1,
      issues: [
        {
          taskId: "task-1",
          taskTitle: "机械设计",
          stageKey: "design",
          docType: "CAD图纸",
          required: 1,
          present: 0,
        },
      ],
    };
    const result = await makeService(new FakeGateRepository(), stats).evaluateProjectCompletion(TX, PROJECT);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      {
        type: "task_delivery_missing",
        taskId: "task-1",
        taskTitle: "机械设计",
        stageKey: "design",
        docType: "CAD图纸",
        required: 1,
        present: 0,
      },
    ]);
  });
});
