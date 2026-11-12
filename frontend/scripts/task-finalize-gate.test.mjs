import assert from "node:assert/strict";
import test from "node:test";

import { hasOutputDeliverables } from "../src/data/tasks.ts";

test("hasOutputDeliverables：只有设定输出成果文件类型才展示任务定档入口", () => {
  assert.equal(hasOutputDeliverables({ deliverableTypes: [] }), false);
  assert.equal(hasOutputDeliverables({ deliverableTypes: ["CAD图纸"] }), true);
  assert.equal(hasOutputDeliverables({ deliverableTypes: ["CAD图纸", "技术协议"] }), true);
});
