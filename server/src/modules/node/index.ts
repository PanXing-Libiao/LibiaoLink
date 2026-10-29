/** node 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export { NodeModule } from "./node.module.js";
export { GateService } from "./gate.service.js";
export type { NodeGateMissing, ProjectCompletionMissingItem, StageGateMissingItem } from "./gate.service.js";
export type { RequirementRow, DocCountRow, StageNodeRow, StageProgressRow } from "./gate.repository.js";
