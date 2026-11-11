/** stakeholder 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export { StakeholderModule } from "./stakeholder.module.js";
export { StakeholderService } from "./stakeholder.service.js";
export type {
  StakeholderInsertInput,
  StakeholderProjectRow,
  StakeholderRow,
  StakeholderUpdatePatch,
} from "./stakeholder.repository.js";
export { buildStakeholderFilter, isStakeholderProjectFilterVisible, matchesKeyword, parseStakeholderSort, stakeholderVisibility } from "./stakeholder.rules.js";
export type {
  StakeholderFilter,
  StakeholderListQueryInput,
  StakeholderSort,
  StakeholderSortField,
  StakeholderVisibility,
} from "./stakeholder.rules.js";
