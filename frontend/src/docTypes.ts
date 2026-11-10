/**
 * 输出成果文件（deliverableTypes）—— 内置十类只读清单（顺序 = 契约 DOC_TYPES；内置项不进字典接口，全站自定义名称由 deliverableType 字典提供）。
 * 出处：原 components/DeliverablePicker.tsx 内联常量（2026-10-08「文件输出成果也要可以选择」）；
 * Push 261 抽出为纯模块 —— 任务表 / 任务抽屉的成果选择器与「文件库」页的「类型」筛选 / 地址参数白名单共用一份。
 */
export const DOC_TYPE_OPTIONS = [
  "CAD图纸",
  "技术协议",
  "合同",
  "评审单",
  "设备清单",
  "物料总清单",
  "发货装箱单",
  "到货单",
  "安装完成证明",
  "验收单",
] as const;

/** 自定义成果类型名称上限（与服务端 DeliverableTypeSchema 同口径）。 */
export const DOC_TYPE_NAME_MAX = 50;

/** 单个任务最多选择的成果类型数（与 TaskCreateBody / TaskUpdateBody 同口径）。 */
export const DOC_TYPE_SELECTION_MAX = 20;

/** 自定义名称不含英文逗号（文件库筛选以逗号分隔多值）或换行；与 DeliverableTypeSchema 同口径。 */
export const DOC_TYPE_NAME_PATTERN = /^[^,\r\n]+$/;

/** 是否属于内置十类（自定义项不做界面字典翻译，按用户输入原文展示）。 */
export function isBuiltinDocType(value: string): value is (typeof DOC_TYPE_OPTIONS)[number] {
  return (DOC_TYPE_OPTIONS as readonly string[]).includes(value);
}
