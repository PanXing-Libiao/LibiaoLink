/** automation 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export {
  dedupeKey,
  evaluateCondition,
  evaluateOperator,
  evaluateRule,
  isoWeekKey,
  mondayOf,
  renderTemplate,
  resolveScheduleFire,
  REPLAY_SUBJECT_KINDS,
} from "./automation.rules.js";
export type {
  ConditionEvaluation,
  ReplaySubjectKind,
  RuleContext,
  RuleEvaluation,
  RuleEvaluationOptions,
  RuleFieldValue,
  ScheduleFire,
  ScheduleFireInput,
} from "./automation.rules.js";
export {
  BUILTIN_MESSAGE_TEMPLATES,
  BUILTIN_RULES,
  BUILTIN_RULE_SUBJECT_KINDS,
  MERGED_TEMPLATE_SPECS,
  R01_NOTE,
  SUBJECT_TEMPLATE_VARIABLES,
  findMergedSpec,
  findTemplate,
  subjectKindOf,
} from "./builtin-rules.js";
export type { MergedTemplateSpec } from "./builtin-rules.js";
export { cronTime, replayRules, toTaskSubject } from "./automation.replay.js";
export type {
  ReplayDetail,
  ReplayInput,
  ReplayMessage,
  ReplayReport,
  ReplaySkipReason,
  ReplaySubject,
  ReplaySubjectRecipient,
  ReplayTask,
} from "./automation.replay.js";
export {
  AUTOMATION_SCHEDULE_JOB_KIND,
  evaluateEventMessages,
  planWindowMessages,
  toProjectSubject,
  toProjectDaySubject,
  toReportMemberSubject,
  toStageSubject,
  toTodoSubject,
} from "./automation.runtime.js";
export type {
  EventEvaluationInput,
  ProjectDaySnapshot,
  ProjectSnapshot,
  ReportMemberSnapshot,
  RuntimeEvaluation,
  RuntimeDetail,
  RuntimeSkip,
  StageSnapshot,
  TodoSnapshot,
  WindowPlanInput,
} from "./automation.runtime.js";
export {
  AutomationRuleRepository,
  AutomationRunRepository,
  automationRuleFromRow,
} from "./automation.repository.js";
export type {
  AutomationRuleRow,
  AutomationRunFilter,
  AutomationRunInsert,
  AutomationRunRow,
} from "./automation.repository.js";
