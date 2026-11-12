import assert from "node:assert/strict";
import test from "node:test";

import { hasOutputDeliverables, isTaskOwnerUnfinalizeLockedByPlannedEnd, taskFinalizeReadiness } from "../src/data/tasks.ts";

test("hasOutputDeliverables：只有设定输出成果文件类型才展示任务定档入口", () => {
  assert.equal(hasOutputDeliverables({ deliverableTypes: [] }), false);
  assert.equal(hasOutputDeliverables({ deliverableTypes: ["CAD图纸"] }), true);
  assert.equal(hasOutputDeliverables({ deliverableTypes: ["CAD图纸", "技术协议"] }), true);
});

const baseCapabilities = {
  level: "edit",
  canEditFields: true,
  canUpdateProgress: true,
  canComplete: true,
  canFinalize: true,
  canUpload: true,
  canAssignOwners: false,
  canDelete: false,
};

function finalizedTask(source, dueDate = "2026-11-11") {
  return {
    finalizedAt: "2026-11-10T02:00:00Z",
    dueDate,
    capabilities: { ...baseCapabilities, source },
  };
}

test("逾期取消定档时间闸只锁任务负责人，项目经理等项目编辑者仍可取消", () => {
  const now = new Date("2026-11-12T01:00:00Z");
  assert.equal(isTaskOwnerUnfinalizeLockedByPlannedEnd(finalizedTask("task_owner"), now), true);
  assert.equal(isTaskOwnerUnfinalizeLockedByPlannedEnd(finalizedTask("project_edit"), now), false);
  assert.equal(isTaskOwnerUnfinalizeLockedByPlannedEnd(finalizedTask("task_owner", "2026-11-12"), now), false);
  assert.equal(isTaskOwnerUnfinalizeLockedByPlannedEnd(finalizedTask("task_owner", ""), now), false);
  assert.equal(isTaskOwnerUnfinalizeLockedByPlannedEnd({ ...finalizedTask("task_owner"), finalizedAt: null }, now), false);
});


test("taskFinalizeReadiness：任务定档绑定完成态与任一已上传成果文件，不比较文件类型", () => {
  const base = { status: "已完成", deliverableTypes: ["CAD图纸", "技术协议"] };
  const cad = { docType: "CAD图纸", status: "draft" };
  const agreement = { docType: "技术协议", status: "final" };
  const unmatched = { docType: "合同", status: "final" };
  const blankType = { docType: null, status: "changed" };
  assert.equal(taskFinalizeReadiness({ ...base, status: "进行中" }, [cad, agreement]).blocker, "not-complete");
  assert.equal(taskFinalizeReadiness({ ...base, deliverableTypes: [] }, [cad]).blocker, "no-deliverables");
  assert.equal(taskFinalizeReadiness(base, null).blocker, "files-loading");
  assert.equal(taskFinalizeReadiness(base, [cad]).ready, true);
  assert.equal(taskFinalizeReadiness(base, [unmatched]).ready, true);
  assert.equal(taskFinalizeReadiness(base, [blankType]).ready, true);
  assert.deepEqual(taskFinalizeReadiness(base, []).missingDocTypes, ["CAD图纸", "技术协议"]);
  assert.equal(taskFinalizeReadiness(base, [{ docType: "CAD图纸", status: "archived" }]).blocker, "missing-files");
  assert.equal(taskFinalizeReadiness({ ...base, status: "提前完成" }, [blankType]).ready, true);
});
